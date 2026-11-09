#!/usr/bin/env python3
"""Stamp the chat's sessionId onto every MCP tool call (vendored agent-httpd).

agent-httpd/ is vendored and gitignored, so this patch is applied by
scripts/patch_vendored_sources.sh before every build. It is idempotent: if the
marker `_lume_session` is already present, nothing changes.

Why: an MCP tools/call has no metadata channel, so the HTTP sidecar (which owns
the chat SSE streams, approval prompts and progress frames) could only guess
which conversation a tool call belonged to — "newest stream wins". Passing the
sessionId in the arguments lets the sidecar route exactly.

Usage: patch_agent_httpd_session.py <path/to/mcp.c>
"""
import sys

MARKER = '_lume_session'

OLD_RUNNER = r'''static void mcp_tool_runner(void *data, const char *args_json,
                            const char *session_id, sbuf *result) {
    (void)session_id;'''

NEW_RUNNER = r'''/* ---- chat correlation ------------------------------------------------
 * tools_dispatch already receives the chat request's sessionId, but an MCP
 * tools/call has no metadata channel. Append it to the arguments object as
 * "_lume_session": MCP argument validation ignores unknown keys, and the HTTP
 * sidecar strips it before executing the tool, using it to route approval
 * prompts and progress frames to the exact conversation (2026-11-09).
 */
static char *mcp_args_with_session(const char *args_json, const char *sid) {
    size_t i, n, len, end, avail;
    int empty = 1;
    char *out;
    if (!sid || !sid[0]) return NULL;
    for (i = 0; sid[i]; i++) {
        if (!((sid[i] >= 'a' && sid[i] <= 'z') || (sid[i] >= 'A' && sid[i] <= 'Z') ||
              (sid[i] >= '0' && sid[i] <= '9') || sid[i] == '-' || sid[i] == '_' ||
              sid[i] == '.' || sid[i] == ':'))
            return NULL;   /* unexpected id: never fabricate JSON with it */
    }
    n = strlen(sid);
    len = (args_json && args_json[0]) ? strlen(args_json) : 0;
    if (len == 0) {
        out = malloc(n + 24);
        if (!out) return NULL;
        snprintf(out, n + 24, "{\"_lume_session\":\"%s\"}", sid);
        return out;
    }
    if (args_json[len - 1] != '}') return NULL;   /* objects only */
    end = len - 1;                                /* insert before final brace */
    for (i = 1; i < end; i++) {
        if (!isspace((unsigned char)args_json[i])) { empty = 0; break; }
    }
    out = malloc(end + n + 32);
    if (!out) return NULL;
    memcpy(out, args_json, end);
    avail = n + 32;
    snprintf(out + end, avail, "%s\"_lume_session\":\"%s\"}",
             empty ? "" : ",", sid);
    return out;
}

static void mcp_tool_runner(void *data, const char *args_json,
                            const char *session_id, sbuf *result) {
    char *aug;'''

OLD_CALL = r'''        sb_str(result, "error: internal mcp tool index out of range");
        return;
    }
    mcp_call(g_tools[idx].mcp_name, args_json, result);
}'''

NEW_CALL = r'''        sb_str(result, "error: internal mcp tool index out of range");
        return;
    }
    aug = mcp_args_with_session(args_json, session_id);
    mcp_call(g_tools[idx].mcp_name, aug ? aug : args_json, result);
    free(aug);
}'''


def main(path):
    s = open(path, encoding='utf-8').read()
    if MARKER in s:
        print(f'[patch] {path}: session stamp already present')
        return 0
    for old, new, label in ((OLD_RUNNER, NEW_RUNNER, 'runner signature'),
                            (OLD_CALL, NEW_CALL, 'dispatch call')):
        count = s.count(old)
        if count != 1:
            print(f'[patch] ERROR: {path}: expected 1 occurrence of {label}, found {count}',
                  file=sys.stderr)
            return 1
        s = s.replace(old, new)
    open(path, 'w', encoding='utf-8').write(s)
    print(f'[patch] {path}: MCP calls now carry _lume_session')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_session.py <mcp.c>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
