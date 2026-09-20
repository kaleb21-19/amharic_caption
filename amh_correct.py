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

    print("\nALL PASS" if ok else "\nSOME FAILED")
