#!/usr/bin/env python3
"""
test_cmd_syntax.py — catch the cmd.exe parse error that broke Install.cmd in
1.8.9/1.8.10 (": was unexpected at this time.").

cmd.exe reads a whole `if ... ( ... )` / `for ... do ( ... )` block before
running any of it. An unescaped ")" inside that block — e.g.
`echo WARNING(9): ...` — ends the block early, so the rest of the line is
parsed as a new command and the WHOLE script stops, even when the branch
would never run. This walks every .cmd/.bat we ship, tracks block depth and
flags any ")" in echo/rem text inside a block that is not escaped as ^).

  python tools/test/test_cmd_syntax.py
"""
import glob
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FILES = sorted(glob.glob(os.path.join(REPO, "tools", "installers", "*.cmd")) +
               glob.glob(os.path.join(REPO, "tools", "installers", "*.bat")))


def strip_quoted(s):
    return re.sub(r'"[^"]*"', '""', s)


def check(path):
    problems = []
    depth = 0
    for no, raw in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
        line = raw.rstrip("\r\n")
        body = line.strip()
        low = body.lower()
        if not body or low.startswith("rem ") or low == "rem" or body.startswith("::"):
            if depth and body.startswith("::"):
                problems.append((no, "'::' comment inside a ( ) block breaks cmd parsing", line))
            continue
        # Text printed by echo: a bare ")" here closes the enclosing block.
        m = re.search(r'(?i)(?:^|[\s&>])echo[ .:](.*)$', body)
        if m and depth:
            text = m.group(1)
            if re.search(r'(?<!\^)\)', strip_quoted(text)):
                problems.append((no, "unescaped ')' in echo inside a ( ) block — write ^) or move it out", line))
        code = strip_quoted(body)
        if m:
            code = code[:code.lower().find("echo")]
        code = re.sub(r"\^.", "", code)
        depth += code.count("(") - code.count(")")
        if depth < 0:
            depth = 0
    return problems


bad = 0
for f in FILES:
    for no, why, line in check(f):
        bad += 1
        print("%s:%d: %s\n    %s" % (os.path.relpath(f, REPO), no, why, line.strip()))
if bad:
    print("\nFAILED: %d problem(s) in installer scripts" % bad)
    sys.exit(1)
print("ALL PASS  (%d installer scripts checked)" % len(FILES))
