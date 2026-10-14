#!/usr/bin/env python3
"""Before you release (or when CI says "release tag vX already points at"):
which version is on main, is it already published, and which merged commits
are not in any release yet.

  python tools/agent/release_state.py
"""
import re
import subprocess
import sys
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def git(*a):
    return subprocess.run(["git"] + list(a), cwd=ROOT, capture_output=True, text=True).stdout.strip()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    git("fetch", "-q", "origin", "--tags")
    man = git("show", "origin/main:panel/CSXS/manifest.xml")
    ver = re.search(r'ExtensionBundleVersion="([\d.]+)"', man).group(1)
    tag = "v" + ver
    tagged = git("rev-parse", "-q", "--verify", "refs/tags/%s^{commit}" % tag)
    print("main is at version %s" % ver)
    if not tagged:
        print("%s is NOT published yet -> merging main will publish it (if CI passes)" % tag)
        return
    behind = git("log", "--oneline", "%s..origin/main" % tag)
    print("%s is published (commit %s)" % (tag, tagged[:7]))
    if behind:
        n = len(behind.splitlines())
        print("%d commit(s) on main are NOT in any release:" % n)
        for line in behind.splitlines()[:12]:
            print("  " + line)
        parts = [int(x) for x in ver.split(".")]
        parts[2] += 1
        print("-> release them: new branch from origin/main + python tools/agent/bump.py %s" % ".".join(map(str, parts)))
    else:
        print("main = the published release; nothing waiting")


if __name__ == "__main__":
    main()
