#!/usr/bin/env python3
"""
test_et_conventions.py — Ethiopian conventions (1.94.45, roadmap V6).

  * spoken dates and times come out written the Ethiopian way:
    መስከረም 1, በሰኔ 30 ቀን 2018 ዓ.ም., ከጠዋቱ 3 ሰዓት ተኩል (116 generated cases);
  * a caption or a line never breaks inside a date / time / amount, and never
    starts with a punctuation mark - in the engine's grouping (group_n_cues,
    group_cues) and in every caption style, one line and two lines;
  * AMH_ET=0 switches it all off.
No model, no audio.

  python tools/test/test_et_conventions.py
"""
import importlib
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
import amh_correct as C  # noqa: E402
import amh_styles as A  # noqa: E402

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  [FAIL] " + msg)


def run(text):
    return " ".join(w for w, _, _ in C.numbers_to_digits([(t, i, i + 1) for i, t in enumerate(text.split())]))


# ── spoken numbers ─────────────────────────────────────────────────────────
UNITS = ["", "አንድ", "ሁለት", "ሶስት", "አራት", "አምስት", "ስድስት", "ሰባት", "ስምንት", "ዘጠኝ"]


def say(n):
    """1..30 and 2000..2030 as an Amharic speaker says them."""
    if n >= 2000:
        rest = n - 2000
        return "ሁለት ሺህ" + ("" if rest == 0 else " " + say(rest))
    if n < 10:
        return UNITS[n]
    if n == 10:
        return "አስር"
    if n < 20:
        return "አስራ " + UNITS[n - 10]
    tens = {20: "ሀያ", 30: "ሰላሳ"}[n - n % 10]
    return tens + ("" if n % 10 == 0 else " " + UNITS[n % 10])


MONTHS = ["መስከረም", "ጥቅምት", "ህዳር", "ታህሳስ", "ጥር", "የካቲት", "መጋቢት", "ሚያዝያ", "ግንቦት", "ሰኔ", "ሐምሌ", "ነሐሴ", "ጳጉሜ"]
cases = []
for m in MONTHS:
    for d in ([1, 3, 5] if m == "ጳጉሜ" else [1, 7, 15, 22, 30]):
        cases.append(("%s %s" % (m, say(d)), "%s %d" % (m, d)))
for k, m in enumerate(MONTHS):
    d, y = (1, 2016) if k % 2 else (1 + k, 2018)
    cases.append(("በ%s %s ቀን %s ዓመተ ምህረት" % (m, say(d), say(y)), "በ%s %d ቀን %d ዓ.ም." % (m, d, y)))
for tod in ("ከጠዋቱ", "ከቀኑ", "ከምሽቱ", "ከሌሊቱ"):
    for h in (1, 3, 6, 9, 12):
        cases.append(("%s %s ሰዓት" % (tod, say(h)), "%s %d ሰዓት" % (tod, h)))
        cases.append(("%s %s ሰዓት ተኩል" % (tod, say(h)), "%s %d ሰዓት ተኩል" % (tod, h)))
check(len(cases) >= 100, "at least 100 date/time cases (%d)" % len(cases))
bad = [(src, run(src), want) for src, want in cases if run(src) != want]
for b in bad[:10]:
    print("  [FAIL] %r -> %r (want %r)" % b)
check(not bad, "%d of %d date/time cases wrong" % (len(bad), len(cases)))
print("  dates/times: %d of %d right" % (len(cases) - len(bad), len(cases)))

# what must NOT change
for src, want in [
    ("አንድ ሰው መጣ", "አንድ ሰው መጣ"),                      # the article
    ("ዓመተ ምህረት ማለት", "ዓመተ ምህረት ማለት"),              # no year before it
    ("ሰባት ዓመተ ምህረት", "7 ዓመተ ምህረት"),                 # 7 is not a year
    ("ሁለት ሺህ አስራ ስምንት ዓ.ም", "2018 ዓ.ም."),          # the short form, written fully
    ("ሁለት ሺህ አስራ ስምንት ዓመተ ምህረት።", "2018 ዓ.ም."),    # one full stop, not ዓ.ም.።
    ("ከጠዋቱ ጀምሮ", "ከጠዋቱ ጀምሮ"),
    ("መስከረም ደግሞ አንድ ሰው", "መስከረም ደግሞ አንድ ሰው"),   # not right after the month
    ("ሁለት ሺህ አስራ ስምንት ዓመተ ምህረት፣ ደግሞ", "2018 ዓ.ም.፣ ደግሞ"),
]:
    check(run(src) == want, "%r -> %r (want %r)" % (src, run(src), want))

# ── where a caption / line may break ──────────────────────────────────────
K = C.keep_together
for a, b in [("በመስከረም", "17"), ("ሰኔ", "30"), ("ከጠዋቱ", "3"), ("17", "ቀን"), ("500", "ብር"),
             ("2018", "ዓ.ም."), ("3", "ሰዓት"), ("ሰዓት", "ተኩል"), ("20", "በመቶ"), ("1", "2018"),
             ("ነው", "።"), ("ነው", "፣"), ("\x01500", "ብር")]:
    check(K(a, b), "keep %r + %r" % (a, b))
for a, b in [("ቀን", "2018"), ("ነው።", "ሰኔ"), ("ዋጋው", "500"), ("500።", "ብር"), ("ሰኔ።", "30"),
             ("ቤት", "ብር"), ("", "17"), ("ሰኔ", "")]:
    check(not K(a, b), "may break %r | %r" % (a, b))

try:
    import ethio_srt as es
except Exception as e:  # numpy missing: the styles part still runs
    es = None
    print("  (ethio_srt not importable here: %s)" % e)
if es is not None:
    toks = "ዛሬ ስብሰባ በመስከረም 17 ቀን 2018 ዓ.ም. ይጀምራል ዋጋው 500 ብር ነው።".split()
    words = [(t, i * 0.5, i * 0.5 + 0.4) for i, t in enumerate(toks)]
    for n in (1, 2, 3, 4):
        cues = es.group_n_cues(words, n)
        for x, y in zip(cues, cues[1:]):
            if n > 1:   # one word per caption stays one word
                check(not K(x[0].split()[-1], y[0].split()[0]), "group_n_cues(%d) breaks %r | %r" % (n, x[0], y[0]))
        check(" ".join(c[0] for c in cues) == " ".join(toks), "group_n_cues(%d) keeps every word in order" % n)
        check(max(len(c[0].split()) for c in cues) <= (n + 3 if n > 1 else 1), "group_n_cues(%d) at most 3 words longer (1 stays 1)" % n)
    for mc in (12, 20, 30):
        cues = es.group_cues(words, max_chars=mc)
        for x, y in zip(cues, cues[1:]):
            check(not K(x[0].split()[-1], y[0].split()[0]), "group_cues(%d) breaks %r | %r" % (mc, x[0], y[0]))
        check(" ".join(c[0] for c in cues) == " ".join(toks), "group_cues(%d) keeps every word" % mc)

# every style, one and two lines: no line starts with a mark, no line break
# inside a date / amount (the sample has marks typed as their own words)
text = ("ዛሬ በመስከረም 17 ቀን 2018 ዓ.ም. ከጠዋቱ 3 ሰዓት ተኩል ላይ ስብሰባው ይጀምራል ። ዋጋው 500 ብር ነው ፣ "
        "ልጆች ግን በ250 ብር ይገባሉ። ሰኔ 30 ቀን የመጨረሻው ቀን ነው ከምሽቱ 4 ሰዓት ድረስ እንጠብቃለን። "
        "በአዲስ አበባ ሀምሌ 1 ደግሞ ሌላ ዝግጅት አለ ፤ 20 በመቶ ቅናሽ ይኖራል። የካቲት 23 ቀን አድዋ ነው።")
toks = text.split()
cues = [(" ".join(toks[i:i + 3]), i / 3 * 1.25, i / 3 * 1.25 + 1.2) for i in range(0, len(toks), 3)]
W = A.words_from_cues(cues)
check(not any(re.match(r"^[፡-፨.,;:!?]+$", w[0]) for w in W), "a mark typed as its own word joins the word before")
check([w[0] for w in W][:2] == ["ዛሬ", "በመስከረም"], "the words themselves unchanged")
punct_start = line_breaks = bad_breaks = 0
for st in A.STYLES:
    for lines in (1, 2):
        out = A.build(W, st, 1080, 1920, opts={"lines": lines})
        for l in out.splitlines():
            if not l.startswith("Dialogue"):
                continue
            txt = re.sub(r"\{[^}]*\}", "", l.split(",,0,0,0,,", 1)[-1])
            parts = [p.strip() for p in txt.split("\\N")]
            for p in parts:
                if p and p[0] in "።፣፤፥፦፧.,?!":
                    punct_start += 1
            for x, y in zip(parts, parts[1:]):
                if x.split() and y.split():
                    line_breaks += 1
                    if K(x.split()[-1], y.split()[0]):
                        bad_breaks += 1
                        print("  [FAIL] %s/%d lines: %r | %r" % (st, lines, x[-20:], y[:20]))
check(punct_start == 0, "%d lines start with a punctuation mark" % punct_start)
check(line_breaks > 100 and bad_breaks == 0, "%d of %d two-line breaks inside a date / amount" % (bad_breaks, line_breaks))
check(all(len(g) == 1 for g in A._phrases(W, 1, {"lines": 1})), "one word at a time stays one word (the word style draws g[0] only)")
for size in (2, 3, 4, 5):
    ph = A._phrases(W, size, {"lines": 1})
    split = [(a[-1][0], b[0][0]) for a, b in zip(ph, ph[1:]) if K(a[-1][0], b[0][0]) and b[0][1] - a[-1][2] <= A.GAP_HOLD]
    check(not split, "phrases of %d split %r" % (size, split[:3]))
print("  styles: %d two-line breaks, 0 inside a date/amount; 0 lines start with a mark" % line_breaks if not FAILS else "")

# ── AMH_ET=0: everything as before ────────────────────────────────────────
os.environ["AMH_ET"] = "0"
importlib.reload(C)
check(run("መስከረም አንድ") == "መስከረም አንድ", "off: day 1 stays a word")
check(run("ሁለት ሺህ አስራ ስምንት ዓመተ ምህረት") == "2018 ዓመተ ምህረት", "off: the era as said")
check(not C.keep_together("በመስከረም", "17"), "off: no keep-together")
del os.environ["AMH_ET"]
importlib.reload(C)

print("\nALL PASS" if not FAILS else "\nFAILURES: %d" % len(FAILS))
sys.exit(1 if FAILS else 0)
