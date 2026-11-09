#!/usr/bin/env python3
"""Lift lume-core's per-tool description cap (idempotent).

lume-core stores every `tool "name", "desc", ...` declaration in ToolRec:

    typedef struct {
        char name[65];
        char desc[161];
        ...
    } ToolRec;                       // lume-core/src/lume.h

`bridge_mcp.c` then serves that field verbatim as MCP `tools/list`
`description`, so 160 UTF-8 bytes was the true ceiling on how much guidance a
tool could carry — the sidecar generator's own 148 B budget existed only to fit
under it. With 99 tools exposed, one-sentence descriptions are what makes a
small model guess between `juejin-draft` / `juejin-publish` or `shell` / `make`.
Widen the field to 1024 B; every copy site uses sizeof/snprintf, so nothing else
needs to change.

Usage: patch_lume_core_tool_desc.py <lume-core-dir>
"""
import pathlib
import sys

MARKER = '/* lume patch: 1024 B tool descriptions'
OLD = '    char desc[161];'
NEW = ('''    /* lume patch: 1024 B tool descriptions -- 160 B truncated the guidance a
     * 99-tool surface needs ("use A, not B" distinctions were cut off). */
    char desc[1025];''')


def main(root):
    root = pathlib.Path(root)
    hdr = root / 'src/lume.h'
    if not hdr.is_file():
        print(f'[patch] skip: {hdr} missing', file=sys.stderr)
        return 0
    s = hdr.read_text(encoding='utf-8')
    if MARKER in s:
        print('[patch] lume-core tool desc already 1024 B')
        return 0
    if s.count(OLD) != 1:
        print(f'[patch] ERROR: lume.h: expected 1 "{OLD.strip()}", found {s.count(OLD)}',
              file=sys.stderr)
        return 1
    hdr.write_text(s.replace(OLD, NEW), encoding='utf-8')
    print('[patch] lume-core: ToolRec.desc 161 -> 1025 bytes')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: patch_lume_core_tool_desc.py <lume-core-dir>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
