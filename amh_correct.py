#!/usr/bin/env python3
"""Post-correction pass for Amharic ASR transcripts.

The beam-search CTC model is strong but still slips on a few *observable*
classes of error. This pass fixes only the highest-confidence cases so it
never degrades words the model already got right:

  1) GLUED WORDS (missing space): a very common CTC slip where two frequent
     words are emitted as one token (e.g. አሀይድጠብቁኝ -> አሀይድ ጠብቁኝ).
     Fixed ONLY for verified (left-right) pairs in SPLIT_FIXES so we never
     arbitrarily split a legitimate compound token.

  2) EXACT-WORD replacements in WORD_FIXES: only include entries verified
     against real audio ground truth; otherwise a wrong entry is worse than
     no entry at all.

There is deliberately NO aggressive character de-duplication here: Ethiopic
words legitimately contain repeated characters, and a blanket "collapse
doubles" rule would corrupt many correct words.

Every entry should be validated on real Amharic before being enabled (see
the MEHARI_VERIFIED block, sourced from a real test clip).

Usage (library):
    from amh_correct import correct_words, correct_word
    corrected = correct_words([(word, start, end), ...])
"""
import os

# ---------------------------------------------------------------------------
# EXACT-WORD replacements: {bad -> good}. ONLY verified entries.
# Verified on the real mehari.mp3 clip: "በጠቅላላ" is the standard Amharic
# phrase ("in general"); the ASR emitted the truncated "በጠቅላ".
# ---------------------------------------------------------------------------
WORD_FIXES = {
    "በጠቅላ": "በጠቅላላ",
}

# ---------------------------------------------------------------------------
# GLUED-WORD splits: {glued_token -> [word_a, word_b]}. Verified on real
# mehari.mp3 where the speaker says two separate words but ASR glued them.
# ---------------------------------------------------------------------------
SPLIT_FIXES = {
    "አሀይድጠብቁኝ": ["አሀይድ", "ጠብቁኝ"],
    "በቀሎበሪማች": ["በቀሎ", "በሪማች"],
}

# Optional: point AMH_CORRECT_EXTRA at a JSON file of extra rules to extend
# the dictionaries without editing this file. Format:
#   {"WORDS": {"bad": "good"}, "SPLITS": {"glued": ["a", "b"]}}
_EXTRA = os.environ.get("AMH_CORRECT_EXTRA")
if _EXTRA and os.path.isfile(_EXTRA):
    import json
    try:
        with open(_EXTRA, "r", encoding="utf-8") as f:
            _extra = json.load(f)
        WORD_FIXES.update(_extra.get("WORDS", {}))
        SPLIT_FIXES.update(_extra.get("SPLITS", {}))
    except Exception:
        pass


# ---------------------------------------------------------------------------
# RULE-BASED PUNCTUATION
# The CTC model emits no punctuation, so captions read as one long run-on.
# The aligned word stream already carries timings, and a pause in the audio
# shows up as a gap between consecutive words — the same silence the VAD
# detector uses. We map that back to Ethiopic punctuation:
#
#   gap >= period_gap  -> ።  (sentence end; a VAD-scale pause)
#   gap >= comma_gap   -> ፣  (clause break; a short breath)
#
# Punctuation is APPENDED to the preceding word (not inserted as its own
# token) so it travels with that word through cue grouping instead of becoming
# a stray one-character caption. Tokens that already end in punctuation are
# left untouched. Set AMH_PUNCT=0 to disable; tune the two gaps with
# AMH_PUNCT_PERIOD_GAP / AMH_PUNCT_COMMA_GAP (seconds).
# ---------------------------------------------------------------------------
_SENT_END = "።፧፤?!…."
_CLAUSE_END = "፣፥፤:"


def punctuate_words(words, period_gap=None, comma_gap=None):
    """Insert Ethiopic punctuation into an aligned [(word, start, end), ...]
    stream from inter-word timing gaps. Returns a NEW list; a word that ends a
    sentence/clause carries the mark appended to its text (timing preserved).

    Each entry may carry extra fields after (word, start, end) — e.g. a
    confidence score from ethio_srt.get_words() — which ride through
    unchanged (this function only ever reads fields 0-2). Arity-agnostic on
    purpose so plain 3-tuple callers (tests, other scripts) keep working.
    """
    if not words or os.environ.get("AMH_PUNCT", "1") == "0":
        return words
    if period_gap is None:
        period_gap = float(os.environ.get("AMH_PUNCT_PERIOD_GAP", "0.6"))
    if comma_gap is None:
        comma_gap = float(os.environ.get("AMH_PUNCT_COMMA_GAP", "0.3"))
    out = []
    n = len(words)
    for i, w in enumerate(words):
        tok, s, e, rest = w[0], w[1], w[2], tuple(w[3:])
        mark = ""
        if tok and tok[-1] not in (_SENT_END + _CLAUSE_END):
            if i + 1 >= n:
                mark = "።"
            else:
                gap = words[i + 1][1] - e
                if gap >= period_gap:
                    mark = "።"
                elif gap >= comma_gap:
                    mark = "፣"
        out.append((tok + mark, s, e) + rest if mark else (tok, s, e) + rest)
    return out


# ---------------------------------------------------------------------------
# SPOKEN NUMBERS -> DIGITS
# Editors write numbers as digits (ዓመቱ 2026 ነው, ስልክ 0911234567), but the
# model spells them out, and since 2026-09-23 it is forbidden to emit digit
# tokens at all (ethio_srt._masked_token_ids — it used to mangle them into
# "5mሰት"). So the digits are produced here, from the spelled-out words.
#
#   ሁለት ሺህ ሀያ ስድስት -> 2026      አስራ አምስት -> 15     ሦስት መቶ -> 300
#   ዜሮ ዘጠኝ አንድ አንድ ... -> 0911...   አራት ነጥብ አምስት -> 4.5
#   በሁለት ሺህ አስራ ስድስት -> በ2016   (a leading በ/ከ/የ/ለ/እስከ stays attached)
#
# Deliberately left as words:
#   * a lone "አንድ" — it is usually the article "a" (አንድ ሰው), not a count
#   * counting runs (አንድ ሁለት ሦስት -> "1 2 3", never "123"); a pair of
#     units is a range (ሁለት ሦስት ቀን -> "2-3 ቀን")
#   * anything with a suffix (ሁለቱ, ሁለተኛ, ሺዎች) — only exact number words match
# AMH_DIGITS=0 disables the pass.
# ---------------------------------------------------------------------------
_NUM_UNITS = {"ዜሮ": 0, "አንድ": 1, "ሁለት": 2, "ሶስት": 3, "ሦስት": 3, "አራት": 4,
              "አምስት": 5, "ስድስት": 6, "ሰባት": 7, "ስምንት": 8, "ዘጠኝ": 9}
_NUM_TEEN = {"አስራ", "አሥራ"}  # አስራ + unit = 11..19
_NUM_TENS = {"አስር": 10, "አሥር": 10, "ሀያ": 20, "ሃያ": 20, "ሐያ": 20,
             "ሰላሳ": 30, "ሠላሳ": 30, "አርባ": 40, "ሀምሳ": 50, "ሃምሳ": 50,
             "ስልሳ": 60, "ስድሳ": 60, "ሰባ": 70, "ሰማንያ": 80, "ዘጠና": 90}
_NUM_HUNDRED = {"መቶ"}
_NUM_SCALES = {"ሺ": 1000, "ሺህ": 1000, "ሽህ": 1000, "ሚሊዮን": 10 ** 6,
               "ሚልዮን": 10 ** 6, "ቢሊዮን": 10 ** 9}
_NUM_POINT = {"ነጥብ"}
_NUM_PREFIXES = ("እስከ", "በ", "ከ", "የ", "ለ")
_NUM_TRAIL = "።፣፤፥፦፧.,?!"


def _num_tile_words():
    """All single number words, longest first, for splitting glued tokens."""
    return sorted(set(_NUM_UNITS) | _NUM_TEEN | set(_NUM_TENS) | _NUM_HUNDRED
                  | set(_NUM_SCALES), key=len, reverse=True)


_NUM_TILE = _num_tile_words()


def _split_num_glue(core):
    """If `core` is a token glued from number words — ሁለትሺህ, ዜሮዘጠኝአንድ,
    አስራአምስት, መቶሁለት — return its token list, else None.

    The CTC model frequently joins number words it hears as one token; an
    exact-word match in _num_kind() then misses them and the number stays
    spelled out. A real Amharic word is essentially never a full tiling of
    number vocabulary, so converting these is low-risk. Only whole-core tilings
    of >=2 number words count (a single word is handled by _num_kind).
    """
    if not core:
        return None
    toks = []
    i = 0
    n = len(core)
    while i < n:
        matched = None
        for v in _NUM_TILE:
            if core.startswith(v, i):
                matched = v
                break
        if matched is None:
            return None
        toks.append(matched)
        i += len(matched)
    return toks if len(toks) >= 2 else None


def _num_kind(core):
    if core in _NUM_UNITS:
        return "unit"
    if core in _NUM_TEEN:
        return "teen"
    if core in _NUM_TENS:
        return "tens"
    if core in _NUM_HUNDRED:
        return "hundred"
    if core in _NUM_SCALES:
        return "scale"
    return None


def _split_trail(tok):
    core = tok.rstrip(_NUM_TRAIL)
    return core, tok[len(core):]


def _cardinals(cores):
    """Split a run of number words into cardinal values. A word that cannot
    continue the current number (e.g. a unit straight after a unit) closes it
    and starts the next, so "ዘጠኝ አስር" is 9 then 10, not 19."""
    out = []                      # [(value, n_words)]
    total = cur = 0
    last = None
    n = 0

    def close():
        nonlocal total, cur, last, n
        if n:
            out.append((total + cur, n))
        total = cur = 0
        last = None
        n = 0

    for c in cores:
        k = _num_kind(c)
        ok = {
            "unit": last in (None, "tens", "teen", "hundred", "scale"),
            "teen": last in (None, "hundred", "scale"),
            "tens": last in (None, "hundred", "scale"),
            "hundred": last in (None, "unit", "scale") and cur < 10,
            "scale": last != "scale",
        }[k]
        if not ok:
            close()
        if k == "unit":
            cur += _NUM_UNITS[c]
        elif k == "teen":
            cur += 10
        elif k == "tens":
            cur += _NUM_TENS[c]
        elif k == "hundred":
            cur = (cur or 1) * 100
        else:
            total += (cur or 1) * _NUM_SCALES[c]
            cur = 0
        last = k
        n += 1
    close()
    return out


def _render_run(cores):
    """Digit strings for one run of number words -> [(text, n_words)]."""
    vals = [_NUM_UNITS.get(c) for c in cores]
    if len(cores) >= 2 and all(v is not None for v in vals):
        counting = all(b == a + 1 for a, b in zip(vals, vals[1:]))
        if vals[0] == 0 or (len(vals) >= 3 and not counting):
            return [("".join(str(v) for v in vals), len(cores))]  # phone / id
        if len(vals) == 2:
            return [("%d-%d" % tuple(vals), 2)]  # ሁለት ሦስት ቀን = "2-3 days"
        return [(str(v), 1) for v in vals]
    return [(str(v), k) for v, k in _cardinals(cores)]


def numbers_to_digits(words):
    """Rewrite spelled-out numbers in an aligned [(word, start, end, ...)]
    stream as digits. A merged number spans its first word's start to its
    last word's end; extra fields ride along from the first word."""
    if not words or os.environ.get("AMH_DIGITS", "1") == "0":
        return words
    out = []
    i, n = 0, len(words)
    while i < n:
        core, trail = _split_trail(words[i][0])
        prefix = ""
        if _num_kind(core) is None:
            for p in _NUM_PREFIXES:
                rest = core[len(p):]
                if core.startswith(p) and (_num_kind(rest) in ("unit", "teen", "tens")
                                           or _split_num_glue(rest)):
                    prefix, core = p, rest
                    break
        if _num_kind(core) is None:
            glued = _split_num_glue(core)
            if glued:
                # One token = one merged number (ሁለትሺህ -> 2000).
                text = prefix + _render_run(glued)[0][0] + trail
                out.append((text, words[i][1], words[i][2]) + tuple(words[i][3:]))
            else:
                out.append(words[i])
            i += 1
            continue
        # Gather the run: number words, stopping after any word that carries
        # punctuation (a sentence/clause break ends the number).
        cores, trails = [core], [trail]
        j = i + 1
        while j < n and not trails[-1]:
            c, t = _split_trail(words[j][0])
            if _num_kind(c) is None:
                break
            cores.append(c)
            trails.append(t)
            j += 1
        # Lone "አንድ" is the article "a", not a count.
        if len(cores) == 1 and cores[0] == "አንድ":
            out.append(words[i])
            i += 1
            continue
        k = i
        for text, used in _render_run(cores):
            first, last = words[k], words[k + used - 1]
            if k == i:
                text = prefix + text
            text += trails[k - i + used - 1]
            out.append((text, first[1], last[2]) + tuple(first[3:]))
            k += used
        i = j
    return _join_decimals(out)


def _join_decimals(words):
    """"4 ነጥብ 5" -> "4.5" (ነጥብ = point, only between two digit tokens)."""
    out = []
    i = 0
    while i < len(words):
        w = words[i]
        if (out and w[0] in _NUM_POINT and i + 1 < len(words)
                and out[-1][0].isdigit() and words[i + 1][0].rstrip(_NUM_TRAIL).isdigit()):
            prev, nxt = out.pop(), words[i + 1]
            out.append((prev[0] + "." + nxt[0], prev[1], nxt[2]) + tuple(prev[3:]))
            i += 2
            continue
        out.append(w)
        i += 1
    return out


def correct_word(word):
    """Return the corrected form of a token.

    May return a string containing a space (from a verified split fix).
    """
    w = word.strip()
    if not w:
        return word
    if w in WORD_FIXES:
        return WORD_FIXES[w]
    if w in SPLIT_FIXES:
        return " ".join(SPLIT_FIXES[w])
    return word


def correct_words(words):
    """Correct a list of (token, start_sec, end_sec) aligned words.

    Returns a NEW list with corrected tokens (timing preserved). A split fix
    produces two entries sharing the original timing span.

    Each entry may carry extra fields after (token, start, end) — e.g. a
    confidence score from ethio_srt.get_words() — which ride through
    unchanged (duplicated onto every part when a split fix fires, since we
    don't have finer-than-word confidence at this text-only stage). Arity
    -agnostic on purpose so plain 3-tuple callers (tests, other scripts)
    keep working.
    """
    corrected = []
    for w in words:
        tok, s, e, rest = w[0], w[1], w[2], tuple(w[3:])
        fixed = correct_word(tok)
        if " " in fixed:
            for part in fixed.split():
                if part:
                    corrected.append((part, s, e) + rest)
        else:
            corrected.append((fixed, s, e) + rest)
    return corrected


if __name__ == "__main__":
    tests = [
        ("በጠቅላ", "በጠቅላላ"),
        ("አሀይድጠብቁኝ", "አሀይድ ጠብቁኝ"),
        ("በቀሎበሪማች", "በቀሎ በሪማች"),
        ("አማርኛ", "አማርኛ"),      # untouched
        ("ተሸነፈ", "ተሸነፈ"),      # untouched
    ]
    ok = True
    for got, want in tests:
        r = correct_word(got)
        status = "OK" if r == want else "FAIL"
        if r != want:
            ok = False
        print(f"  [{status}] {got!r} -> {r!r} (want {want!r})")
    print("\nALL PASS" if ok else "\nSOME FAILED")

    # Punctuation: large gap -> ።, medium gap -> ፣, tight -> nothing; a token
    # that already ends in punctuation is left alone; last word gets ።.
    aligned = [
        ("አማርኛ", 0.0, 0.4),
        ("ቋንቋ", 0.4, 0.7),      # gap 0.05 -> nothing
        ("ነው", 0.75, 1.0),      # gap 0.05 -> nothing
        ("ግን", 1.7, 1.9),       # gap 0.7  -> ።
        ("ቀላል", 1.9, 2.1),     # gap 0.0  -> nothing
        ("አይደለም።", 2.2, 2.5),  # already punctuated -> untouched
    ]
    p = punctuate_words(aligned)
    pgot = [w for w, _, _ in p]
    pwant = ["አማርኛ", "ቋንቋ", "ነው።", "ግን", "ቀላል", "አይደለም።"]
    pok = pgot == pwant
    if not pok:
        ok = False
    print(f"  [{'OK' if pok else 'FAIL'}] punctuate_words -> {pgot}")

    # Spoken numbers -> digits.
    num_cases = [
        ("ዓመቱ ሁለት ሺህ ሀያ ስድስት ነው።", "ዓመቱ 2026 ነው።"),
        ("ስልክ ዜሮ ዘጠኝ አንድ አንድ ሁለት ሦስት", "ስልክ 091123"),
        ("አራት ነጥብ አምስት በመቶ", "4.5 በመቶ"),
        ("በሁለት ሺህ አስራ ስድስት", "በ2016"),
        ("አምስት መቶ ሃምሳ ሺህ ብር", "550000 ብር"),
        ("ከአምስት እስከ ሰባት", "ከ5 እስከ 7"),
        ("ሁለት ሦስት ቀን", "2-3 ቀን"),
        ("አንድ ሁለት ሦስት አራት", "1 2 3 4"),
        ("ዘጠኝ አስር።", "9 10።"),
        ("አንድ ሰው", "አንድ ሰው"),            # article, not a count
        ("ሁለቱም ሁለተኛ በመቶ", "ሁለቱም ሁለተኛ በመቶ"),  # suffixed / not numbers
        # Glued number tokens (the model joins number words into one token).
        ("አመቱ በሁለትሺህ ነው", "አመቱ በ2000 ነው"),      # prefix + glued scale
        ("ስልክ ዜሮዘጠኝአንድአንድ ነው", "ስልክ 0911 ነው"),  # glued phone run
        ("አስራአምስት ቀን ነበር", "15 ቀን ነበር"),        # teen+unit glued
        ("መቶሁለት ተማሪዎች", "102 ተማሪዎች"),          # hundred+unit glued
        # Real words that merely START with number words must NOT split.
        ("አንድነት", "አንድነት"),        # unity — not "1 ነት"
        ("ሁለተኛ", "ሁለተኛ"),          # second
        ("አስረኛ", "አስረኛ"),          # tenth
        ("መቶኛ", "መቶኛ"),            # hundredth
    ]
    for src, want in num_cases:
        got = " ".join(w for w, _, _ in numbers_to_digits(
            [(t, i, i + 1) for i, t in enumerate(src.split())]))
        good = got == want
        ok = ok and good
        print(f"  [{'OK' if good else 'FAIL'}] {src!r} -> {got!r} (want {want!r})")

    print("\nALL PASS" if ok else "\nSOME FAILED")
