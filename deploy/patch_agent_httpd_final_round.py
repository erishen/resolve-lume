#!/usr/bin/env python3
"""Reserve the last ReAct round for the answer (vendored agent-httpd).

agent-httpd/ is vendored and gitignored, so this patch is applied by
scripts/patch_vendored_sources.sh before every build. It is idempotent: if the
marker `final_round` is already present, nothing changes.

Why: the loop simply stops after AGENT_MAX_ROUNDS, so a model that keeps calling
tools through the whole budget ends with zero prose. The user then sees
"本轮没有产生回答" even though the tools did real work (2026-11-10 trace: eight
rounds of article-discover / article-validate / shell / build-juejin, no text).
The last round now runs without a tool schema plus one wrap-up instruction,
and any tool_call it still hallucinates is ignored instead of executed.

Usage: patch_agent_httpd_final_round.py <path/to/agent.c>
"""
import sys

MARKER = 'const char *round_tools = tools_json;'

OLD_ROUND_STATE = r'''        RoundState rs;
        const char *finish = NULL;
'''

NEW_ROUND_STATE = r'''        RoundState rs;
        const char *finish = NULL;
        /* Last round is reserved for the answer, not for more tools. A model
         * that keeps calling tools through the whole budget used to end with
         * zero prose ("本轮没有产生回答") although the tools had done real work.
         * Withhold the schema on this round and, once something actually ran,
         * say so in-band so the model knows it must wrap up. */
        int final_round = (round == rounds);
        const char *round_tools = tools_json;
        const char *round_choice = NULL;
        if (final_round) {
            round_tools = NULL;
            if (n_exec > 0) {
                sse_event(out, "note", "final round: answering without tools");
                msgs_sep(&msgs);
                sb_str(&msgs, "{\"role\":\"user\",\"content\":");
                sb_json_str(&msgs,
                            "工具预算已用尽：不要再调用工具，直接用中文给用户结论——"
                            "完成了什么、得到的关键结果（数据/文件路径/项目名），"
                            "没做完的和需要用户决定的事点明。");
                sb_str(&msgs, "}");
            }
        }
'''

OLD_CALL = r'''            rc = agent_round(out, &msgs,
                             tools_json,
                             NULL, capture, &rs, &finish, &up_err,
'''

NEW_CALL = r'''            rc = agent_round(out, &msgs,
                             round_tools,
                             round_choice, capture, &rs, &finish, &up_err,
'''

OLD_SALVAGE = r'''            if (out->ok && rs.n_calls == 0 && rs.saw_content &&
                looks_like_tool_json(rs.spoken.p)) {
'''

NEW_SALVAGE = r'''            if (out->ok && !final_round && rs.n_calls == 0 && rs.saw_content &&
                looks_like_tool_json(rs.spoken.p)) {
'''

OLD_GATEWAY = r'''        /* 方案 A (gateway): we sent no local tool schema, so any tool_calls
'''

NEW_GATEWAY = r'''        /* Final round: the schema was withheld, so a tool_call here means the
         * model ignored the wrap-up instruction. Do not execute it — the budget
         * is gone and the user needs prose, not one more silent step. */
        if (final_round) {
            sse_event(out, "note", "final round: tool call ignored");
            round_free(&rs);
            break;
        }

        /* 方案 A (gateway): we sent no local tool schema, so any tool_calls
'''


def main(path):
    s = open(path, encoding='utf-8').read()
    if MARKER in s and 'final round: answering without tools' in s:
        print(f'[patch] {path}: final round already reserved for the answer')
        return 0
    steps = (
        (OLD_ROUND_STATE, NEW_ROUND_STATE, 'round state declarations'),
        (OLD_CALL, NEW_CALL, 'agent_round call'),
        (OLD_SALVAGE, NEW_SALVAGE, 'prose salvage guard'),
        (OLD_GATEWAY, NEW_GATEWAY, 'gateway branch anchor'),
    )
    for old, new, label in steps:
        count = s.count(old)
        if count != 1:
            print(f'[patch] ERROR: {path}: expected 1 occurrence of {label}, found {count}',
                  file=sys.stderr)
            return 1
        s = s.replace(old, new)
    open(path, 'w', encoding='utf-8').write(s)
    print(f'[patch] {path}: last round answers without tools instead of going silent')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_final_round.py <agent.c>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
