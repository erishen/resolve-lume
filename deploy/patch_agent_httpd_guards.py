#!/usr/bin/env python3
"""Studio-style loop guards for vendored agent-httpd (idempotent).

resolve-studio keeps a small model on rails with these guards:
  * findDeclaredToolCall: the model writes "用 X 做 Y" in prose but never emits a
    tool-call -> push a corrective user turn and retry (bounded).
  * a nudge for tool-call JSON pasted into prose (small models do this too).
  * emptyReplyFallback: a round after tool results that streams no content.

agent-httpd drops streamed content at the end of each round, so the guards need
it: this patch adds `sbuf spoken` to RoundState (capped at 4 KiB), a
`tools_mentioned()` helper, and the two bounded guards.

Usage: patch_agent_httpd_guards.py <agent-httpd-dir>
"""
import pathlib
import sys

MARKER = 'lume_declared_nudge'


HUNK_HEADER = (r'''typedef struct {
    RoundCall calls[AGENT_TOOL_CALLS_MAX];
    int n_calls;
    int saw_content; /* round streamed at least one content delta */
    int saw_error;   /* round carried a JSON "error" object (already surfaced) */
} RoundState;''', r'''typedef struct {
    RoundCall calls[AGENT_TOOL_CALLS_MAX];
    int n_calls;
    int saw_content; /* round streamed at least one content delta */
    int saw_error;   /* round carried a JSON "error" object (already surfaced) */
    /* Content streamed this round, bounded to 4 KiB. The loop guards need the
     * prose back after the deltas are already on the wire: a model that only
     * *describes* a tool step must be nudged to really call it. */
    sbuf spoken;
} RoundState;''')

FREE = (r'''void round_free(RoundState *rs) {
    for (int i = 0; i < AGENT_TOOL_CALLS_MAX; i++) {
        free(rs->calls[i].id.p);
        free(rs->calls[i].name.p);
        free(rs->calls[i].args.p);
    }
    rs->n_calls = 0;
}''', r'''void round_free(RoundState *rs) {
    for (int i = 0; i < AGENT_TOOL_CALLS_MAX; i++) {
        free(rs->calls[i].id.p);
        free(rs->calls[i].name.p);
        free(rs->calls[i].args.p);
    }
    free(rs->spoken.p);
    rs->spoken.p = NULL;
    rs->spoken.len = rs->spoken.cap = 0;
    rs->n_calls = 0;
}''')

SPOKEN = (r'''                if (*s) {
                    *content_started = 1;
                    sse_event(out, "delta", s);''', r'''                /* Bounded copy for the guards below: the deltas are already
                 * streamed, but a later round decision needs the prose. */
                if (*s && rs->spoken.len < 4096) {
                    size_t need = strlen(s);
                    size_t room = 4096 - rs->spoken.len;
                    sb_mem(&rs->spoken, s, need > room ? room : need);
                }
                if (*s) {
                    *content_started = 1;
                    sse_event(out, "delta", s);''')

LOOKS_LIKE = (r'''static RoundCall *round_call(RoundState *rs, long index) {''', r'''/* Tool-call JSON pasted into prose ("{"name":"shell","arguments":...}").
 * Small models sometimes do this instead of emitting a real tool-call; nudge
 * once instead of treating the fragment as a final answer. */
static int looks_like_tool_json(const char *t) {
    return t && (strstr(t, "\"arguments\"") || strstr(t, "\"tool_calls\"") ||
                 strstr(t, "\"function\""));
}

static RoundCall *round_call(RoundState *rs, long index) {''')

NUDGES_VAR = (r'''    int rounds = max_rounds > 0 ? max_rounds : agent_max_rounds();''',
r'''    int rounds = max_rounds > 0 ? max_rounds : agent_max_rounds();
    /* Bounded nudges for "described but never called" / text-as-JSON / empty. */
    int nudges = 0;''')

NO_CALL = (r'''        /* no tool calls -> the final answer already streamed; done */
        if (!out->ok || rs.n_calls == 0) {
            round_free(&rs);
            break;
        }''', r'''        /* no tool calls -> final answer, unless it is not an answer at all.
         * resolve-studio nudges twice here; we bound it the same way so a
         * stubborn model still terminates. */
        if (!out->ok || rs.n_calls == 0) {
            if (out->ok && nudges < 2) {
                const char *missing = rs.saw_content ? tools_mentioned(rs.spoken.p) : NULL;
                char msg[512];
                int kind = 0;
                if (missing) {
                    snprintf(msg, sizeof msg,
                             "你上一条回复只是在描述计划，并没有真正发出工具调用。"
                             "请立即调用工具 `%s` 执行它（参数按工具说明），"
                             "不要只输出 JSON 文本或命令文本；执行完再汇报结果。",
                             missing);
                    kind = 1;
                } else if (rs.saw_content && looks_like_tool_json(rs.spoken.p)) {
                    snprintf(msg, sizeof msg,
                             "你上一条回复把工具调用写成了正文 JSON，系统不会执行它。"
                             "请改用真正的 tool-call 发出调用，参数按工具 schema；"
                             "如果没有对应工具，如实说明该能力不存在，不要编造工具名。");
                    kind = 2;
                } else if (!rs.saw_content && n_exec > 0) {
                    snprintf(msg, sizeof msg, "请用中文总结以上工具结果，不要再调用工具。");
                    kind = 3;
                }
                if (kind) {
                    nudges++;
                    sse_event(out, "note",
                              kind == 3 ? "empty reply after tool results"
                                        : "model wrote a tool call as text");
                    msgs_sep(&msgs);
                    sb_str(&msgs, "{\"role\":\"user\",\"content\":");
                    sb_json_str(&msgs, msg);
                    sb_str(&msgs, "}");
                    round_free(&rs);
                    continue;
                }
            }
            round_free(&rs);
            break;
        }''')

TOOLS_DECL = (r'''int tools_dispatch(const char *name, const char *args_raw,
                   const char *session_id, sbuf *result);''', r'''int tools_dispatch(const char *name, const char *args_raw,
                   const char *session_id, sbuf *result);

/* First registered tool mentioned in prose, or NULL. The agent loop uses it to
 * nudge a model that described a tool step without emitting a tool-call. */
const char *tools_mentioned(const char *text);''')

TOOLS_HELPER = (r'''int tools_dispatch(const char *name, const char *args_raw,
                   const char *session_id, sbuf *result) {''', r'''const char *tools_mentioned(const char *text) {
    if (!text || !text[0]) return NULL;
    for (int i = 0; i < g_ntools; i++) {
        const char *name = g_tools[i].name;
        if (strstr(text, name)) return name;
        const char *sep = strstr(name, "__");
        if (sep && sep[2]) {
            const char *hit = strstr(text, sep + 2);
            if (hit && (hit == text ||
                        !(isalnum((unsigned char)hit[-1]) || hit[-1] == '_')))
                return name;   /* "shell" hits "sidecar__shell" */
        }
    }
    return NULL;
}

int tools_dispatch(const char *name, const char *args_raw,
                   const char *session_id, sbuf *result) {''')

UNKNOWN = (r'''    sb_str(result, "error: unknown tool '");
    sb_str(result, name);
    sb_str(result, "'");
    return -1;''', r'''    sb_str(result, "error: unknown tool '");
    sb_str(result, name);
    sb_str(result, "'");
    /* Name the closest registered tools so a model that invented a name can
     * self-correct next round instead of repeating the hallucination. */
    {
        int shown = 0;
        for (int i = 0; i < g_ntools && shown < 3; i++) {
            const char *cand = g_tools[i].name;
            const char *sep = strstr(cand, "__");
            const char *suf = (sep && sep[2]) ? sep + 2 : cand;
            if (!strstr(cand, name) && !strstr(name, suf)) continue;
            sb_str(result, shown ? ", " : " (did you mean: ");
            sb_str(result, cand);
            shown++;
        }
        if (shown) sb_str(result, "?)");
    }
    return -1;''')

MCP_UNKNOWN = (r'''    if (!t) {
        sb_str(result, "error: unknown mcp tool '");
        sb_str(result, mcp_name);
        sb_str(result, "'");
        return;
    }''', r'''    if (!t) {
        sb_str(result, "error: unknown mcp tool '");
        sb_str(result, mcp_name);
        sb_str(result, "'");
        /* Candidate names: the model invented or mistyped one; naming the
         * closest registered tools lets it self-correct next round. */
        {
            int shown = 0;
            for (int i = 0; i < g_ntools && shown < 3; i++) {
                const char *cand = g_tools[i].mcp_name;
                const char *sep = strstr(cand, "__");
                const char *suf = (sep && sep[2]) ? sep + 2 : cand;
                if (!strstr(cand, mcp_name) && !strstr(mcp_name, suf)) continue;
                sb_str(result, shown ? ", " : " (did you mean: ");
                sb_str(result, cand);
                shown++;
            }
            if (shown) sb_str(result, "?)");
        }
        return;
    }''')


def patch_file(path, hunks):
    s = path.read_text(encoding='utf-8')
    for old, new, label in hunks:
        count = s.count(old)
        if count != 1:
            print(f'[patch] ERROR: {path.name} {label}: expected 1 occurrence, found {count}',
                  file=sys.stderr)
            return False
        s = s.replace(old, new)
    path.write_text(s, encoding='utf-8')
    print(f'[patch] {path.name}: {"loop guards" if path.suffix != ".c" or path.name != "tools.c" else "tool hints"} installed')
    return True


def main(root):
    root = pathlib.Path(root)
    if not root.is_dir():
        print(f'[patch] skip: {root} missing', file=sys.stderr)
        return 0
    agent_c = root / 'src/agent/agent.c'
    if MARKER in agent_c.read_text(encoding='utf-8'):
        print('[patch] agent loop guards already present')
        return 0
    ok = patch_file(root / 'src/agent/agent.h', [(HUNK_HEADER[0], HUNK_HEADER[1], 'RoundState spoken')])
    if ok:
        ok = patch_file(agent_c, [
            (FREE[0], FREE[1], 'round_free'),
            (SPOKEN[0], SPOKEN[1], 'content capture'),
            (LOOKS_LIKE[0], LOOKS_LIKE[1], 'tool-json detector'),
            (NUDGES_VAR[0], NUDGES_VAR[1], 'nudge counter'),
            (NO_CALL[0], NO_CALL[1], 'nudge guard'),
        ])
    if ok:
        ok = patch_file(root / 'src/agent/tools.h', [(TOOLS_DECL[0], TOOLS_DECL[1], 'tools_mentioned decl')])
    if ok:
        ok = patch_file(root / 'src/agent/mcp.c', [
            (MCP_UNKNOWN[0], MCP_UNKNOWN[1], 'mcp unknown tool hints'),
        ])
    if ok:
        ok = patch_file(root / 'src/agent/tools.c', [
            (TOOLS_HELPER[0], TOOLS_HELPER[1], 'tools_mentioned'),
            (UNKNOWN[0], UNKNOWN[1], 'unknown tool hints'),
        ])
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_guards.py <agent-httpd-dir>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
