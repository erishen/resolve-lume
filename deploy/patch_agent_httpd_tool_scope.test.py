#!/usr/bin/env python3
"""Self-test for deploy/patch_agent_httpd_tool_scope.py (no vendored tree needed).

The C source is vendored/gitignored, so the *committed* artefact is the patch
script. This test proves the script still applies to the exact upstream text it
was written against, is idempotent, fails loudly when an anchor drifts, and is
actually wired into scripts/patch_vendored_sources.sh in the right order.

A synthetic pre-patch file is built by concatenating the script's own OLD
anchors, so no agent-httpd checkout is required to run `make check`.
"""
import importlib.util
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'deploy/patch_agent_httpd_tool_scope.py'
HOOK = ROOT / 'scripts/patch_vendored_sources.sh'
VENDORED = ROOT / 'agent-httpd/src/agent/agent.c'

spec = importlib.util.spec_from_file_location('tool_scope_patch', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def fail(msg):
    print(f'✗ patch_agent_httpd_tool_scope: {msg}', file=sys.stderr)
    sys.exit(1)


def run(path):
    return subprocess.run([sys.executable, str(SCRIPT), str(path)],
                          capture_output=True, text=True)


def fixture():
    parts = []
    for old, _new, label in mod.STEPS:
        parts.append(f'/* anchor: {label} */\n{old}')
    text = '\n'.join(parts) + '\n'
    # Every anchor must occur exactly once in the synthetic pre-patch file;
    # overlapping anchors would make the test pass while real C text drifts.
    for old, _new, label in mod.STEPS:
        if text.count(old) != 1:
            fail(f'fixture anchor {label!r} is not unique ({text.count(old)})')
    return text


def main():
    hook = HOOK.read_text(encoding='utf-8')
    if 'patch_agent_httpd_tool_scope.py' not in hook:
        fail('patch script is not wired into scripts/patch_vendored_sources.sh')
    if hook.index('patch_agent_httpd_tool_scope.py') < hook.index('patch_agent_httpd_final_round.py'):
        fail('tool-scope patch must run AFTER the final-round patch (anchor order)')

    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / 'agent.c'
        pre = fixture()
        p.write_text(pre, encoding='utf-8')

        r = run(p)
        if r.returncode != 0:
            fail(f'patch failed on pristine anchors: {r.stderr.strip()}')
        patched = p.read_text(encoding='utf-8')
        for _old, new, label in mod.STEPS:
            if new not in patched:
                fail(f'patched output misses {label!r} replacement')
        for m in mod.IDEMPOTENCE_MARKERS:
            if m not in patched:
                fail(f'patched output misses idempotence marker {m!r}')

        # Hard invariants: the three global-registry paths must all consult the
        # request allow-list, and post-tool prose must skip salvage/nudge.
        for needle in (
            'if (!tool_allowed(req, tname)) {',
            'tools_exists(sname) && tool_allowed(req, sname)',
            'if (missing && !tool_allowed(req, missing)) missing = NULL;',
            'int answered_after_tools = (n_exec > 0 && rs.saw_content);',
            'rs.saw_content && !answered_after_tools',
            'for (int i = 0; i < n_handled; i++) free(exec_sigs[i]);',
        ):
            if needle not in patched:
                fail(f'missing invariant: {needle}')

        # Idempotence: a second run changes nothing and still succeeds.
        r2 = run(p)
        if r2.returncode != 0 or p.read_text(encoding='utf-8') != patched:
            fail('second run is not a no-op')

        # Negative: one mutated anchor must fail loudly, not silently skip.
        bad = pathlib.Path(td) / 'agent-drifted.c'
        drifted = pre.replace(mod.STEPS[-2][0], '/* upstream changed this loop */')
        bad.write_text(drifted, encoding='utf-8')
        r3 = run(bad)
        if r3.returncode == 0 or 'expected 1 occurrence' not in r3.stderr:
            fail('drifted anchor did not fail loudly')
        if bad.read_text(encoding='utf-8') != drifted:
            fail('failed patch still modified its input')

    # Behavioural check: compile the patched C helper against a stub ChatRequest
    # and prove the boundary semantics (no filter = all, otherwise exact match).
    # Skipped when no C compiler is installed, so `make check` stays portable.
    cc = shutil.which('cc') or shutil.which('gcc')
    if cc:
        helper = mod.STEPS[0][1]
        start = helper.index('static int tool_allowed(')
        end = helper.index('\n}\n', start) + 3
        fn = helper[start:end]
        harness = r'''#include <stdio.h>
#include <string.h>
typedef struct {
    int n_tools;
    char tools[32][65];
} ChatRequest;
''' + fn + r'''
int main(void) {
    ChatRequest r;
    memset(&r, 0, sizeof r);
    if (!tool_allowed(&r, "sidecar__juejin-draft")) return 1;
    r.n_tools = 2;
    strcpy(r.tools[0], "sidecar__publish-pending");
    strcpy(r.tools[1], "sidecar__capabilities");
    if (!tool_allowed(&r, "sidecar__publish-pending")) return 2;
    if (tool_allowed(&r, "sidecar__juejin-draft")) return 3;
    if (tool_allowed(&r, "publish-pending")) return 4;
    if (tool_allowed(&r, "")) return 5;
    if (tool_allowed(&r, NULL)) return 6;
    if (!tool_allowed(NULL, "sidecar__juejin-draft")) return 7;
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as td:
            src = pathlib.Path(td) / 'scope.c'
            exe = pathlib.Path(td) / 'scope'
            src.write_text(harness, encoding='utf-8')
            c = subprocess.run([cc, '-Wall', '-Wextra', '-Werror', str(src), '-o', str(exe)],
                               capture_output=True, text=True)
            if c.returncode != 0:
                fail(f'tool_allowed helper did not compile: {c.stderr.strip()}')
            x = subprocess.run([str(exe)], capture_output=True, text=True)
            if x.returncode != 0:
                fail(f'tool_allowed behaviour assertion #{x.returncode} failed')

    # When a vendored tree is present, make sure the working copy really is the
    # patched state (a plain `docker compose build` does NOT run the patch hook).
    if VENDORED.is_file():
        real = VENDORED.read_text(encoding='utf-8')
        if 'final round: answering without tools' in real:
            for m in mod.IDEMPOTENCE_MARKERS:
                if m not in real:
                    fail(f'vendored agent.c is stale (missing {m!r}); '
                         'run `make vendor` or scripts/patch_vendored_sources.sh')

    print('✓ patch_agent_httpd_tool_scope: anchors, idempotence, negative case, '
          'hook order, C boundary behaviour, vendored state')
    return 0


if __name__ == '__main__':
    sys.exit(main())
