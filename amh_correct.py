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
    """
    corrected = []
    for tok, s, e in words:
        fixed = correct_word(tok)
        if " " in fixed:
            for part in fixed.split():
                if part:
                    corrected.append((part, s, e))
        else:
            corrected.append((fixed, s, e))
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
