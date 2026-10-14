#!/usr/bin/env python3
"""Live facts about the product, read from the code (never stale). Short on
purpose: an agent runs this instead of opening big files.

  python tools/agent/facts.py            # local facts
  python tools/agent/facts.py --online   # + latest public release on GitHub
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPO = "kaleb21-19/amharic_caption"


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def git(*args):
    try:
        return subprocess.run(["git"] + list(args), cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except Exception:
        return "?"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    man = read("panel/CSXS/manifest.xml")
    ver = re.search(r'ExtensionBundleVersion="([\d.]+)"', man).group(1)
    app_ver = re.search(r"const APP_VERSION = '([\d.]+)'", read("panel/js/main.js")).group(1)
    w = read("tools/telegram-worker/src/worker.js")
    forever = re.search(r'AMH_PRICE_ETB = "(\d+)"', read("tools/telegram-worker/wrangler.toml"))
    plans = re.findall(r"(m\d): \{ days: (\d+), etb: (\d+), reward: (\d+)", w)
    st = read("amh_styles.py")
    styles = re.search(r"STYLES = \(([^)]*)\)", st, re.S).group(1)
    styles = re.findall(r'"(\w+)"', styles)
    fonts = re.findall(r'^    "(\w+)": "([^"]+)",', st, re.M)
    anims = re.findall(r'"(\w+)"', re.search(r"ANIMS = \(([^)]*)\)", st).group(1))
    migs = sorted(os.listdir(os.path.join(ROOT, "tools", "telegram-worker", "migrations")))
    print("version        %s%s" % (ver, "" if ver == app_ver else "  !! main.js says %s (run tools/check_versions.sh)" % app_ver))
    print("branch         %s%s" % (git("rev-parse", "--abbrev-ref", "HEAD"), " (uncommitted changes)" if git("status", "--porcelain") else ""))
    print("prices (ETB)   forever %s · %s" % (forever.group(1) if forever else "?",
          " · ".join("%s %s days %s (partner %s)" % (p, d, e, r) for p, d, e, r in plans)))
    print("styles (%d)     plain + %s" % (len(styles) + 1, ", ".join(styles)))
    print("fonts (%d)      %s" % (len(fonts), ", ".join("%s=%s" % f for f in fonts)))
    print("animations     %s" % ", ".join(anims))
    print("migrations     %d, latest %s" % (len(migs), migs[-1] if migs else "-"))
    if "--online" in sys.argv:
        try:
            with urllib.request.urlopen("https://api.github.com/repos/%s/releases/latest" % REPO, timeout=15) as r:
                rel = json.load(r)
            print("public release %s (%s, %d files)" % (rel["tag_name"], rel["published_at"][:10], len(rel["assets"])))
        except Exception as e:
            print("public release ? (%s)" % e)


if __name__ == "__main__":
    main()
