#!/usr/bin/env python3
"""Is docs/agent/PROJECT_MAP.md still true? Every `file` must exist and every
`symbol` after "::" must still be in that file. Prints FRESH, or STALE with
the lines to fix (exit 1).

  python tools/agent/map_check.py
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAP = os.path.join(ROOT, "docs", "agent", "PROJECT_MAP.md")
LINE = re.compile(r"^- `([^`]+)`(?:\s*::\s*(?:`([^`]*)`)?)?")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    stale, n = [], 0
    with open(MAP, encoding="utf-8") as f:
        for no, line in enumerate(f, 1):
            m = LINE.match(line)
            if not m:
                continue
            n += 1
            path, sym = m.group(1), (m.group(2) or "").strip()
            full = os.path.join(ROOT, path)
            if not os.path.exists(full):
                stale.append("line %d: missing file %s" % (no, path))
                continue
            if sym and os.path.isfile(full):
                with open(full, encoding="utf-8", errors="replace") as g:
                    if sym not in g.read():
                        stale.append("line %d: %s no longer has `%s`" % (no, path, sym))
    if stale:
        print("STALE (%d of %d entries):" % (len(stale), n))
        for s in stale:
            print("  " + s)
        sys.exit(1)
    print("FRESH (%d entries)" % n)


if __name__ == "__main__":
    main()
