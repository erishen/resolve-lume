#!/usr/bin/env python3
"""Per-tool MCP deny list: MCP_TOOL_DENY (idempotent).

MCP_ALLOW trims whole servers. That is too coarse for the git bridge: the agent
needs read-only inspection plus local add/commit, but the server registers 28
tools (push / reset / clean / rebase / worktree / ...). Every schema costs prompt
space and adds one more near-identical name for a small model to confuse; those
side-effectful ones are reachable through `shell` under human approval anyway.

This patch adds `mcp_tool_denied()` and skips matching tools at registration, so
a denied tool never reaches the tools/list the model sees.

Usage: patch_agent_httpd_mcp_tool_filter.py <agent-httpd-dir>
"""
import pathlib
import sys

MARKER = 'mcp_tool_denied('

HELPER = (r'''static int mcp_allowed(const char *id) {''', r'''/* Per-tool deny list: MCP_TOOL_DENY="git__git_push,git__git_reset,..." matched
 * against the registered backend name (serverId__toolName). Server-level
 * MCP_ALLOW trims whole servers; this trims individual tools that only add
 * schema noise (e.g. the git server's 28 tools where the agent needs 9). */
static int mcp_tool_denied(const char *mcp_name) {
    const char *deny = getenv("MCP_TOOL_DENY");
    if (!deny || !deny[0] || !mcp_name || !mcp_name[0]) return 0;
    char buf[1024];
    set_str(buf, sizeof buf, deny);
    for (char *tok = strtok(buf, ","); tok; tok = strtok(NULL, ",")) {
        while (*tok == ' ' || *tok == '\t') tok++;
        char *e = tok + strlen(tok);
        while (e > tok && (e[-1] == ' ' || e[-1] == '\t')) *--e = '\0';
        if (*tok && strcmp(tok, mcp_name) == 0) return 1;
    }
    return 0;
}

static int mcp_allowed(const char *id) {''')

SKIP = (r'''        char mcp_name[TOOL_NAME_MAX + 1];
        snprintf(mcp_name, sizeof mcp_name, "%s__%s", s->id, name);''', r'''        char mcp_name[TOOL_NAME_MAX + 1];
        snprintf(mcp_name, sizeof mcp_name, "%s__%s", s->id, name);
        /* Deny-listed tools are neither registered nor advertised. */
        if (mcp_tool_denied(mcp_name)) {
            q = jws(q);
            if (*q == ',') q = jws(q + 1);
            else break;
            continue;
        }''')


def main(root):
    root = pathlib.Path(root)
    src = root / 'src/agent/mcp.c'
    if not src.is_file():
        print(f'[patch] skip: {src} missing', file=sys.stderr)
        return 0
    s = src.read_text(encoding='utf-8')
    if MARKER in s:
        print('[patch] agent-httpd MCP tool deny list already present')
        return 0
    for old, new, label in ((HELPER[0], HELPER[1], 'mcp_tool_denied'), (SKIP[0], SKIP[1], 'registration skip')):
        if s.count(old) != 1:
            print(f'[patch] ERROR: mcp.c {label}: expected 1 occurrence, found {s.count(old)}',
                  file=sys.stderr)
            return 1
        s = s.replace(old, new)
    src.write_text(s, encoding='utf-8')
    print('[patch] agent-httpd: MCP_TOOL_DENY per-tool filter installed')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_mcp_tool_filter.py <agent-httpd-dir>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
