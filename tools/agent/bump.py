#!/usr/bin/env python3
"""Change the product version in all five places at once and check them.

  python tools/agent/bump.py 1.16.3

Refuses a version that is not higher than the current one, or that is
already a release tag on GitHub (a published version can never be reused).
"""
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PLACES = [
    ("panel/CSXS/manifest.xml", r'(ExtensionBundleVersion=")([\d.]+)(")', 1),
    ("panel/CSXS/manifest.xml", r'(<Extension Id="com\.amharic\.captions\.panel" Version=")([\d.]+)(")', 1),
    ("panel/index.html", r'(<span id="panelVersion">)([\d.]+)(</span>)', 1),
    ("panel/js/main.js", r"(const APP_VERSION = ')([\d.]+)(';)", 1),
    ("tools/test/test_panel_dom.js", r"(p\.els\('panelVersion'\)\.textContent, ')([\d.]+)('\);)", 1),
]


def vt(v):
    return tuple(int(x) for x in v.split("."))


def main():
    if len(sys.argv) != 2 or not re.match(r"^\d+\.\d+\.\d+$", sys.argv[1]):
        sys.exit("usage: python tools/agent/bump.py X.Y.Z")
    new = sys.argv[1]
    found = []
    texts = {}
    for path, rx, _ in PLACES:
        if path not in texts:
            with open(os.path.join(ROOT, path), encoding="utf-8", newline="") as f:
                texts[path] = f.read()
        m = re.search(rx, texts[path])
        if not m:
            sys.exit("version not found in %s (pattern %s) - update tools/agent/bump.py" % (path, rx))
        found.append(m.group(2))
    cur = found[0]
    if len(set(found)) != 1:
        print("warning: the places disagree before the bump: %s" % found)
    if vt(new) <= vt(cur):
        sys.exit("refused: %s is not higher than the current %s" % (new, cur))
    tags = subprocess.run(["git", "ls-remote", "--tags", "origin", "v" + new], cwd=ROOT, capture_output=True, text=True).stdout
    if tags.strip():
        sys.exit("refused: v%s is already a release tag on GitHub - pick the next number" % new)
    for path, rx, _ in PLACES:
        texts[path] = re.sub(rx, lambda m: m.group(1) + new + m.group(3), texts[path], count=1)
    for path, text in texts.items():
        with open(os.path.join(ROOT, path), "w", encoding="utf-8", newline="") as f:
            f.write(text)
    # check
    for path, rx, _ in PLACES:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            assert re.search(rx, f.read()).group(2) == new, path
    print("version %s -> %s in %d places (manifest x2, index.html, main.js, test_panel_dom.js)" % (cur, new, len(PLACES)))


if __name__ == "__main__":
    main()
