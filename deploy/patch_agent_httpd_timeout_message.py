#!/usr/bin/env python3
"""Quote the spent budget in agent-httpd's upstream-timeout error (vendored).

agent-httpd/ is vendored and gitignored, so this patch is applied by
scripts/patch_vendored_sources.sh before every build. It is idempotent: if the
message already carries the seconds, nothing changes.

Why: a bare "upstream timeout" reads like a defect and hides how long the
round actually waited, so a user cannot tell "the model is slow, raise
LLM_TIMEOUT" from "the gateway is broken". Print the effective budget
("upstream timeout (120s)") through one helper that also feeds curl --max-time,
so the quoted number and the real cap can never drift (2026-11-10: a round
carrying article-discover output burned the whole 60s default and the reply
was replaced by this message while the tool itself had succeeded).

Usage: patch_agent_httpd_timeout_message.py <path/to/agent.c>
"""
import sys

MARKER = 'upstream timeout (%ds)'

OLD_HELPER_ANCHOR = r'''/* Fork one curl round against the upstream. Streams content deltas as'''

NEW_HELPER = r'''/* Effective per-round upstream budget: LLM_TIMEOUT seconds, clamped to 1..600
 * with 60 as the default. One helper so the value handed to curl and the value
 * quoted in the failure message can never drift apart. */
static int llm_timeout_s(void) {
    int t = env_int("LLM_TIMEOUT", 60);
    if (t <= 0 || t > 600) t = 60;
    return t;
}

'''

OLD_BUDGET = r'''    int timeout_s = env_int("LLM_TIMEOUT", 60);
    if (timeout_s <= 0 || timeout_s > 600) timeout_s = 60;
'''

NEW_BUDGET = r'''    int timeout_s = llm_timeout_s();
'''

OLD_MESSAGE = r'''    case UP_ERR_TIMEOUT:
        snprintf(msg, sizeof msg, "upstream timeout");
        break;
'''

NEW_MESSAGE = r'''    case UP_ERR_TIMEOUT:
        /* Quote the budget that was actually spent: "timeout" alone reads like
         * a defect, while "(120s)" tells the user how long the round really
         * waited and whether raising LLM_TIMEOUT is worth it. */
        snprintf(msg, sizeof msg, "upstream timeout (%ds)", llm_timeout_s());
        break;
'''


def main(path):
    s = open(path, encoding='utf-8').read()
    if MARKER in s and 'static int llm_timeout_s(void)' in s:
        print(f'[patch] {path}: timeout message already quotes the budget')
        return 0
    steps = (
        (OLD_HELPER_ANCHOR, NEW_HELPER + OLD_HELPER_ANCHOR, 'agent_round comment'),
        (OLD_BUDGET, NEW_BUDGET, 'per-round budget'),
        (OLD_MESSAGE, NEW_MESSAGE, 'UP_ERR_TIMEOUT message'),
    )
    for old, new, label in steps:
        count = s.count(old)
        if count != 1:
            print(f'[patch] ERROR: {path}: expected 1 occurrence of {label}, found {count}',
                  file=sys.stderr)
            return 1
        s = s.replace(old, new)
    open(path, 'w', encoding='utf-8').write(s)
    print(f'[patch] {path}: upstream timeouts now report "upstream timeout (<Ns>)')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_agent_httpd_timeout_message.py <agent.c>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
