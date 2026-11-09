#!/usr/bin/env python3
"""Salvage a tool call the model pasted into prose (vendored agent-httpd).

Small models sometimes answer with `{"name":"shell","arguments":{...}}` as
*text* instead of emitting a real tool_call. The loop used to nudge twice and,
if the model kept doing it, hand the raw JSON fragment back as the final
answer. This patch parses the declared call and dispatches it for real.

Runs *after* patch_agent_httpd_guards.py (it anchors on the guard block), and is
idempotent: `salvage_declared_call` present => nothing to do.

Usage: patch_agent_httpd_salvage.py <agent-httpd-dir>
"""
import pathlib
import sys

MARKER = 'salvage_declared_call('

HELPER = r'''

/* Pull the tool name and arguments object out of prose that contains a
 * tool-call JSON fragment, e.g. {"name":"shell","arguments":{"command":"ls"}}.
 * Only balanced objects are accepted; anything else returns 0 and the caller
 * falls back to the old nudge path. */
static int salvage_declared_call(const char *text, char *name, size_t ncap,
                                 sbuf *args) {
    const char *np = text ? strstr(text, "\"name\"") : NULL;
    if (!np) return 0;
    np = strchr(np, ':');
    if (!np) return 0;
    np++;
    while (*np == ' ') np++;
    if (*np != '"') return 0;
    np++;
    size_t i = 0;
    while (*np && *np != '"' && i + 1 < ncap) {
        if (*np == '\\' && np[1]) np++;
        name[i++] = *np++;
    }
    name[i] = '\0';
    if (*np != '"' || i == 0) return 0;

    const char *ap = strstr(text, "\"arguments\"");
    if (!ap) return 0;
    ap = strchr(ap, ':');
    if (!ap) return 0;
    ap++;
    while (*ap == ' ') ap++;
    if (*ap != '{') return 0;
    int depth = 0, instr = 0;
    const char *p = ap;
    for (; *p; p++) {
        if (instr) {
            if (*p == '\\' && p[1]) p++;
            else if (*p == '"') instr = 0;
            continue;
        }
        if (*p == '"') { instr = 1; continue; }
        if (*p == '{') depth++;
        else if (*p == '}') {
            depth--;
            if (depth == 0) { p++; break; }
        }
    }
    if (depth != 0) return 0;
    sb_mem(args, ap, (size_t)(p - ap));
    return 1;
}'''

WIRE = '''        if (!out->ok || rs.n_calls == 0) {
            /* The model pasted a tool call into prose: execute it ourselves.
             * Nudging costs rounds and, when it keeps failing, lets the raw
             * JSON fragment become the user-visible answer. */
            if (out->ok && rs.n_calls == 0 && rs.saw_content &&
                looks_like_tool_json(rs.spoken.p)) {
                char sname[TOOL_NAME_MAX + 1] = "";
                sbuf sargs = {0};
                if (salvage_declared_call(rs.spoken.p, sname, sizeof sname, &sargs) &&
                    tools_exists(sname)) {
                    RoundCall *sc = round_call(&rs, 0);
                    sb_str(&sc->name, sname);
                    sb_mem(&sc->args, sargs.p ? sargs.p : "{}",
                           sargs.p ? sargs.len : 2);
                    free(sargs.p);
                    sse_event(out, "note", "salvaged tool call from prose");
                    goto have_calls;
                }
                free(sargs.p);
            }
            if (out->ok && nudges < 2) {'''

TOOLS_EXISTS = '''/* Is this exact name registered? The salvage path (model pasted a tool call
 * into prose) must not dispatch a hallucinated name. */
int tools_exists(const char *name) {
    if (!name || !name[0]) return 0;
    for (int i = 0; i < g_ntools; i++) {
        if (strcmp(g_tools[i].name, name) == 0) return 1;
    }
    return 0;
}

'''

DECL = ('const char *tools_mentioned(const char *text);',
        'const char *tools_mentioned(const char *text);\n\n'
        '/** 1 when a tool with this exact name is registered. */\n'
        'int tools_exists(const char *name);')


def main(root):
    root = pathlib.Path(root)
    agent_c = root / 'src/agent/agent.c'
    tools_c = root / 'src/agent/tools.c'
    tools_h = root / 'src/agent/tools.h'
    for f in (agent_c, tools_c, tools_h):
        if not f.is_file():
            print(f'[patch] skip: {f} missing', file=sys.stderr)
            return 0

    a = agent_c.read_text(encoding='utf-8')
    if MARKER in a:
        print('[patch] agent-httpd prose tool-call salvage already present')
        return 0

    guard = '''static int looks_like_tool_json(const char *t) {
    return t && (strstr(t, "\\"arguments\\"") || strstr(t, "\\"tool_calls\\"") ||
                 strstr(t, "\\"function\\""));
}'''
    if a.count(guard) != 1:
        print('[patch] ERROR: agent.c guard block missing; run the guards patch first',
              file=sys.stderr)
        return 1
    a = a.replace(guard, guard + HELPER)

    wire_anchor = '''        if (!out->ok || rs.n_calls == 0) {
            if (out->ok && nudges < 2) {'''
    if a.count(wire_anchor) != 1:
        print('[patch] ERROR: agent.c nudge anchor: expected 1, found '
              f'{a.count(wire_anchor)}', file=sys.stderr)
        return 1
    a = a.replace(wire_anchor, WIRE)

    label = '        /* synthesize ids for providers that omit them */'
    if a.count(label) != 1:
        print('[patch] ERROR: agent.c synth-ids anchor not unique', file=sys.stderr)
        return 1
    a = a.replace(label, 'have_calls:;\n' + label)
    agent_c.write_text(a, encoding='utf-8')

    t = tools_c.read_text(encoding='utf-8')
    if 'int tools_exists(' not in t:
        anchor = 'int tools_dispatch('
        if t.count(anchor) != 1:
            print('[patch] ERROR: tools.c tools_dispatch anchor not unique', file=sys.stderr)
            return 1
        tools_c.write_text(t.replace(anchor, TOOLS_EXISTS + anchor), encoding='utf-8')

    h = tools_h.read_text(encoding='utf-8')
    if 'tools_exists' not in h:
        if h.count(DECL[0]) != 1:
            print('[patch] ERROR: tools.h declaration anchor not unique', file=sys.stderr)
            return 1
        tools_h.write_text(h.replace(DECL[0], DECL[1]), encoding='utf-8')

    print('[patch] agent-httpd: prose tool-call salvage installed')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_salvage.py <agent-httpd-dir>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
