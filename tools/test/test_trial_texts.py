#!/usr/bin/env python3
"""
test_trial_texts.py — the free trial must be ONE story everywhere.

The live length of the free trial is the D1 setting `trial_free_minutes` (the
owner raised it from 20 to 30 on 2026-10-14). Every customer-visible copy that
pins a number goes stale the moment he changes it again, so this test checks:

  1. no customer-facing file still carries a legacy promise
     ("2 captions free" / "2 ካፕሽን በነጻ", "20 minutes free" / "20 ደቂቃ በነጻ"),
     except lines that name an old version on purpose (history, not a promise);
  2. every promise of trial minutes names the SAME number (dev docs that quote
     old numbers on purpose are exempt — see DEV_DOCS below);
  3. the panel builds that promise from the LIVE number (never a literal, and
     the translations use a (\d+) pattern);
  4. the in-zip guide says where the free minutes come from (the Telegram bot).

The bot's own texts are computed from the setting; that side is covered by
tools/telegram-worker/test/e2e.mjs (the "trial_free_minutes = 30" scenario).

  python tools/test/test_trial_texts.py
"""
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Customer-facing copy. Tests are NOT scanned: they may legitimately assert the
# panel's fallback or a fake server's own setting.
SCAN_DIRS = ["website", "tools/installers", "panel"]
SCAN_FILES = ["README.md", "TESTING.md",
              "tools/telegram-worker/DEPLOY.md",
              "tools/telegram-worker/src/worker.js",
              "tools/telegram/POSTS.md", "tools/telegram/selling.md",
              "amh_standalone.py"]
SKIP_DIRS = {"node_modules", ".next", "dist", "runtime", "test", "__pycache__", ".git", "build"}
EXT = {".jsx", ".js", ".tsx", ".ts", ".html", ".md", ".py", ".json", ".txt", ".css"}
# Dev docs that quote old numbers on purpose (history tables, "before 1.10.7"
# notes): they are scanned for legacy promises, but what they say about the
# trial number is not a promise to a customer.
DEV_DOCS = {"TESTING.md", "tools/telegram-worker/DEPLOY.md"}

# Promises that were true before 1.10.7 (2 captions) or before 2026-10-14 (20 minutes).
LEGACY = ["2 ካፕሽን", "2 captions free", "2 free captions", "20 minutes free",
          "20 ደቂቃ በነጻ", "20 min free", "try 2 free", "2 free, then"]
# A line that names an old version is history, not a promise (the note often
# starts on the line above, so the lines around it count too).
HISTORIC = re.compile(r"before\s+1\.10|1\.10\.[0-6]\b|legacy|decommissioned|no longer|older", re.I)
# The panel's placeholder before the server answers; renderFreeMinBox() overwrites
# it with the live number and the box stays hidden until the server has answered.
FALLBACK = "freeMinTitle"
# The panel must build that title from the server's number.
LIVE_TITLE = re.compile(r"title\.textContent\s*=\s*L\('Try '\s*\+\s*trialMinutes\(\)")
# A literal number in the panel's translation of the trial title would go stale.
I18N_TRIAL = re.compile(r"Try \(\\d\+\) minutes free|ደቂቃ በነጻ ይሞክሩ")

# A number *promised* as trial minutes: "30 minutes free", "30 ደቂቃ በነጻ",
# "free on your own footage - 30 minutes", "free minutes of transcription (30".
# The gap between "free" and the number may only hold prose characters, so a
# promise is not "found" across JS code ($1, quotes, brackets) or sentences.
GAP = r"[\w\s\u1200-\u137F\u2013\u2014-]"
PROMISE = re.compile(
    r"(?<![\d:$])(\d+)\s*(?:minutes?|min\b|ደቂቃ)\s*(?:of\s+)?(?:በ?ነጻ|free)"
    r"|(?:በ?ነጻ|free)" + GAP + r"{0,45}?(?<![\d:$])(\d+)\s*(?:minutes?|min\b|ደቂቃ)"
    r"|free minutes of transcription\s*\(\s*(\d+)", re.I)


def files():
    out = []
    for d in SCAN_DIRS:
        for root, dirs, names in os.walk(os.path.join(REPO, d)):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
            out += [os.path.join(root, n) for n in names if os.path.splitext(n)[1] in EXT]
    out += [os.path.join(REPO, f) for f in SCAN_FILES]
    return sorted(out)


def text_of(path):
    try:
        return open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    problems, checked, numbers = [], 0, {}
    files_ = files()
    for path in files_:
        rel = os.path.relpath(path, REPO).replace("\\", "/")
        text = text_of(path)
        lines = text.splitlines()
        for i, line in enumerate(lines, 1):
            checked += 1
            if FALLBACK in line:          # the one allowed fallback (see FALLBACK above)
                continue
            window = " ".join(lines[max(0, i - 2):i + 1])
            low = line.lower()
            for bad in LEGACY:
                if bad.lower() in low and not HISTORIC.search(window):
                    problems.append("%s:%d still promises %r:\n     %s" % (rel, i, bad, line.strip()[:160]))
        # one number everywhere: a promise may wrap a line, so scan the whole text
        # (with the panel's allowed fallback placeholder masked out)
        if rel in DEV_DOCS:
            continue
        flat = re.sub(r"\s+", " ", re.sub(r'(id="freeMinTitle">)[^<]*', r"\1X", text))
        for m in PROMISE.finditer(flat):
            numbers.setdefault(next(g for g in m.groups() if g), []).append(rel)
    print("checked %d lines in %d files" % (checked, len(files_)))

    if len(numbers) > 1:
        detail = "; ".join("%s minutes in %s" % (n, ", ".join(sorted(set(v))[:4])) for n, v in sorted(numbers.items()))
        problems.append("the free trial is promised with different numbers: " + detail)
    else:
        print("OK  the free trial is promised as one number everywhere: %s minutes"
              % (list(numbers)[0] if numbers else "-"))

    # the panel must show the live number, and the translations must take it as a pattern
    main_js = text_of(os.path.join(REPO, "panel", "js", "main.js"))
    if not LIVE_TITLE.search(main_js):
        problems.append("panel/js/main.js no longer builds the free-minutes title from "
                        "trialMinutes() - a literal number there goes stale silently")
    if not I18N_TRIAL.search(text_of(os.path.join(REPO, "panel", "js", "i18n.js"))):
        problems.append("panel/js/i18n.js no longer maps the trial title as a pattern - "
                        "a literal number there would not follow the setting")

    # the in-zip guide must say where the free minutes come from
    guide = text_of(os.path.join(REPO, "tools", "installers", "START HERE.html"))
    trial_lines = [l for l in guide.splitlines() if "ደቂቃ በነጻ" in l or "minutes free" in l]
    if not trial_lines:
        problems.append("tools/installers/START HERE.html no longer mentions the free trial")
    elif not any("ቴሌግራም" in l or "Telegram" in l for l in trial_lines):
        problems.append("START HERE.html promises free minutes without saying they come "
                        "from the Telegram bot")

    if problems:
        print("FAILURES (%d):" % len(problems))
        for p in problems:
            print("  !! " + p)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
