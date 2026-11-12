#!/usr/bin/env python3
"""Make the per-request tool allow-list a real execution boundary (vendored agent-httpd).

agent-httpd/ is vendored and gitignored, so this patch is applied by
scripts/patch_vendored_sources.sh before every build. It is idempotent: if the
marker `static int tool_allowed(` is already present, nothing changes.

Why (2026-11-12 audit): `req->tools` only filtered `filtered_schema`, i.e. the
tools the *model* sees. But tools_dispatch() / tools_exists() / tools_mentioned()
all walk the GLOBAL g_tools registry, and salvage_declared_call() could lift a
name out of the answer prose and `goto have_calls` to execute it. So a pinned
task was a hint, not a boundary: a read-only "publish inventory" chat really
called the write tool sidecar__juejin-draft (stopped only by the human approval
gate). This patch enforces the same exact-match allow-list at execution time.

It also fixes the ReAct tail: after a tool has actually run, the model often
quotes `tool sidecar__x({})` / `round N/8` lines in its final answer.
tools_mentioned() then found that name and nudged "please really call it",
which re-ran read-only tools and kept the stream open for ~147s without a done
frame. Once content follows a real execution we trust the prose: salvage and
nudge kind 1/2 are skipped; the kind-3 "summarize the tool results" nudge
(empty reply, no content) is kept.

Usage: patch_agent_httpd_tool_scope.py <path/to/agent.c>
"""
import sys

MARKER = 'static int tool_allowed(const ChatRequest *req'
IDEMPOTENCE_MARKERS = (MARKER, 'answered_after_tools', 'tool call refused by request allow-list')

# Each (old, new, label) must match EXACTLY ONCE in the post-steps-1..8 agent.c.
# The self-test builds a synthetic pre-patch file by joining the `old` strings,
# so they must also be mutually distinct.
STEPS = (
    (
        r'''    if (sigs[*n]) (*n)++;
}

const char *agent_system_default(void) {''',
        r'''    if (sigs[*n]) (*n)++;
}

/* Per-request tool allow-list: a HARD execution boundary, not just a schema
 * hint. tools_schema_json_filtered() uses exact strcmp, so this must use the
 * same rule — otherwise a tool can be hidden from the model but still be
 * callable by name. n_tools == 0 keeps the historical "expose everything"
 * behaviour (general chat / PSE). */
static int tool_allowed(const ChatRequest *req, const char *name) {
    if (!req || req->n_tools <= 0) return 1;
    if (!name || !name[0]) return 0;
    for (int i = 0; i < req->n_tools; i++) {
        if (strcmp(req->tools[i], name) == 0) return 1;
    }
    return 0;
}

const char *agent_system_default(void) {''',
        'tool_allowed helper',
    ),
    (
        r'''    char *exec_sigs[EXEC_SIG_MAX] = {0};
    int n_exec = 0;''',
        r'''    char *exec_sigs[EXEC_SIG_MAX] = {0};
    int n_exec = 0;    /* tools actually dispatched this request */
    int n_handled = 0; /* call signatures recorded (incl. refused calls) */''',
        'signature counters',
    ),
    (
        r'''                if (!exec_sig_seen(exec_sigs, n_exec, &rs.calls[i])) {''',
        r'''                if (!exec_sig_seen(exec_sigs, n_handled, &rs.calls[i])) {''',
        'stray-repeat guard',
    ),
    (
        r'''            if (out->ok && !final_round && rs.n_calls == 0 && rs.saw_content &&
                looks_like_tool_json(rs.spoken.p)) {''',
        r'''            /* After a tool actually ran, prose is the answer even when it
             * quotes a tool-call line or a JSON fragment. Salvaging/nudging
             * here used to re-run read-only tools for minutes. */
            int answered_after_tools = (n_exec > 0 && rs.saw_content);
            if (out->ok && !final_round && !answered_after_tools &&
                rs.n_calls == 0 && rs.saw_content &&
                looks_like_tool_json(rs.spoken.p)) {''',
        'prose salvage guard',
    ),
    (
        r'''                if (salvage_declared_call(rs.spoken.p, sname, sizeof sname, &sargs) &&
                    tools_exists(sname)) {''',
        r'''                if (salvage_declared_call(rs.spoken.p, sname, sizeof sname, &sargs) &&
                    tools_exists(sname) && tool_allowed(req, sname)) {''',
        'salvage allow-list check',
    ),
    (
        r'''                const char *missing = rs.saw_content ? tools_mentioned(rs.spoken.p) : NULL;''',
        r'''                const char *missing = (rs.saw_content && !answered_after_tools)
                    ? tools_mentioned(rs.spoken.p) : NULL;
                /* tools_mentioned() scans the global registry; never nudge the
                 * model into calling a tool this request forbid. */
                if (missing && !tool_allowed(req, missing)) missing = NULL;''',
        'nudge allow-list check',
    ),
    (
        r'''                } else if (rs.saw_content && looks_like_tool_json(rs.spoken.p)) {''',
        r'''                } else if (rs.saw_content && !answered_after_tools &&
                           looks_like_tool_json(rs.spoken.p)) {''',
        'nudge kind 2 guard',
    ),
    (
        r'''        for (int i = 0; i < rs.n_calls && out->ok; i++) {
            tools_dispatch(rs.calls[i].name.p ? rs.calls[i].name.p : "?",
                           rs.calls[i].args.p,
                           req->session_id[0] ? req->session_id : NULL,
                           &results[i]);
            exec_sig_record(exec_sigs, &n_exec, &rs.calls[i]);
        }''',
        r'''        for (int i = 0; i < rs.n_calls && out->ok; i++) {
            const char *tname = rs.calls[i].name.p ? rs.calls[i].name.p : "?";
            if (!tool_allowed(req, tname)) {
                /* Keep the message array well-formed (one role:"tool" reply
                 * per assistant tool_call) while refusing to execute it. */
                sb_str(&results[i],
                       "error: this tool is not in the current task's allow-list; "
                       "call refused. Answer using the tools exposed to you, or "
                       "tell the user the operation is out of scope.");
                sse_event(out, "note", "tool call refused by request allow-list");
                exec_sig_record(exec_sigs, &n_handled, &rs.calls[i]);
                continue;
            }
            tools_dispatch(tname,
                           rs.calls[i].args.p,
                           req->session_id[0] ? req->session_id : NULL,
                           &results[i]);
            n_exec++;
            exec_sig_record(exec_sigs, &n_handled, &rs.calls[i]);
        }''',
        'dispatch boundary',
    ),
    (
        r'''    for (int i = 0; i < n_exec; i++) free(exec_sigs[i]);''',
        r'''    for (int i = 0; i < n_handled; i++) free(exec_sigs[i]);''',
        'signature cleanup',
    ),
)


def apply(text):
    """Return (patched_text, error_or_None). Pure: used by the self-test."""
    for old, new, label in STEPS:
        count = text.count(old)
        if count != 1:
            return text, f'expected 1 occurrence of {label}, found {count}'
        text = text.replace(old, new)
    return text, None


def main(path):
    try:
        with open(path, encoding='utf-8') as f:
            s = f.read()
    except OSError as e:
        print(f'[patch] ERROR: cannot read {path}: {e}', file=sys.stderr)
        return 1
    if all(m in s for m in IDEMPOTENCE_MARKERS):
        print(f'[patch] {path}: request tool scope already enforced')
        return 0
    patched, err = apply(s)
    if err:
        print(f'[patch] ERROR: {path}: {err}', file=sys.stderr)
        print('[patch] upstream agent.c text changed; update the anchors in '
              'deploy/patch_agent_httpd_tool_scope.py', file=sys.stderr)
        return 1
    with open(path, 'w', encoding='utf-8') as f:
        f.write(patched)
    print(f'[patch] {path}: allow-list enforced at dispatch/salvage/nudge; '
          'post-tool prose no longer restarts the loop')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_tool_scope.py <agent.c>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
