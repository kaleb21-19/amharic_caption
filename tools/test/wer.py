#!/usr/bin/env python3
"""wer.py — Word Error Rate between a ground-truth transcript and an SRT/transcript.

Usage:
  python3 wer.py --truth truth.txt --hyp out.srt [--hyp-is-text]

Normalizes (lowercase, collapse whitespace, strip punctuation, canonicalize
Amharic homophone letter families) before comparing, and reports both WER and
CER. SRT input: extracts subtitle text lines and joins them.

Two Amharic-specific evaluations are folded in (see tools/retrain/IMPROVEMENTS.md
"eval hygiene", item 7):
  * WER uses homophone-canonicalized tokens: the merged Ethiopic letter series
    (ሐ/ኀ→ሀ, ሠ→ሰ, ፀ→ጸ, ዐ→አ) are genuine modern homophones, so a spelling that
    differs only there is not an ASR error.
  * CER is also printed — agglutinative Amharic word boundaries are not fixed
    (ነውአሉ vs ነው አሉ), so one glued word counts as one WER error but only a
    fraction of a CER error.
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

# Modern-Amharic homophone letter classes, mapped order-by-order to the
# surviving letter (ኀ merged into ሐ then ሀ; ሠ→ሰ; ፀ→ጸ; the ʿayn series ዐ-ዕ
# merged into the ʾalef series አ-እ). Same pronunciation today, so spelling
# differences here are NOT ASR errors.
_AMH_HOMOPHONE = str.maketrans(
    "ሐሑሒሓሔሕሖ"  # ḫ/ḥ -> h
    "ኀኁኂኃኄኅኆ"  # ḫ  -> h
    "ሠሡሢሣሤሥሦ"  # š  -> s
    "ፀፁፂፃፄፅፆ"  # ṡ  -> ts'
    "ዐዑዒዓዔዕ"  # ʿ  -> ʾ
    , "ሀሁሂሃሄህሆ"
      "ሀሁሂሃሄህሆ"
      "ሰሱሲሳሴስሦ"
      "ጸጹጺጻጼጽጾ"
      "አኡኢኣኤእ")


# Captions write numbers as digits (amh_correct.numbers_to_digits) while
# references spell them out. Scoring spells the caption's digits back out so
# WER/CER keep measuring RECOGNITION, comparable with every earlier run;
# whether the digits are formatted right is amh_correct's self-check's job.
_ONES = ["ዜሮ", "አንድ", "ሁለት", "ሶስት", "አራት", "አምስት", "ስድስት", "ሰባት", "ስምንት", "ዘጠኝ"]
_TENS = {10: "አስር", 20: "ሃያ", 30: "ሰላሳ", 40: "አርባ", 50: "ሃምሳ",
         60: "ስልሳ", 70: "ሰባ", 80: "ሰማንያ", 90: "ዘጠና"}


def _say_int(n: int) -> list:
    if n < 10:
        return [_ONES[n]]
    for scale, word in ((10 ** 9, "ቢሊዮን"), (10 ** 6, "ሚሊዮን"), (1000, "ሺህ")):
        if n >= scale:
            hi, lo = divmod(n, scale)
            return _say_int(hi) + [word] + (_say_int(lo) if lo else [])
    if n >= 100:
        hi, lo = divmod(n, 100)
        return ([] if hi == 1 else _say_int(hi)) + ["መቶ"] + (_say_int(lo) if lo else [])
    t, u = divmod(n, 10)
    if t == 1:
        return ["አስር"] if u == 0 else ["አስራ", _ONES[u]]
    return [_TENS[t * 10]] + ([_ONES[u]] if u else [])


def _say_number(tok: str) -> str:
    m = re.fullmatch(r"(\D*?)(\d+(?:[.-]\d+)?)(\W*)", tok)
    if not m:
        return tok
    prefix, num, trail = m.groups()
    if "." in num or "-" in num:
        a, sep, b = re.split(r"([.-])", num)
        mid = ["ነጥብ"] if sep == "." else []
        words = _say_int(int(a)) + mid + (_say_int(int(b)) if sep == "-" else [_ONES[int(d)] for d in b])
    elif num.startswith("0") and len(num) > 1:
        words = [_ONES[int(d)] for d in num]  # phone number / id: digit by digit
    else:
        words = _say_int(int(num))
    words[0] = prefix + words[0]
    return " ".join(words) + trail


def normalize(text: str) -> list:
    text = text.lower()
    text = " ".join(_say_number(t) for t in text.split())
    # Speaker labels ([S1]/[S2], "S1:", <v S1>) are engine markup, not content.
    text = re.sub(r"\[[sS][12]\]|(?:^|\s)[sS][12]:|<v[sS]\s*[12]>|</v>", " ", text)
    # Ethiopic punctuation (U+1360–U+1368: ፠፡።፣፤፥፦፧) lives INSIDE the
    # \u1200-\u137F keep-range, so strip it first — otherwise a caption word
    # like "ነው።" would not match the reference token "ነው". Ethiopic DIGITS
    # (U+1369–U+137C) are kept.
    text = re.sub(r"[\u1360-\u1368]", " ", text)
    text = re.sub(r"[^\w\s\u1200-\u137F]", " ", text)
    text = text.translate(_AMH_HOMOPHONE)
    tokens = re.findall(r"[\u1200-\u137F\w]+", text)
    return tokens


def read_srt_text(path: str) -> str:
    lines = []
    in_text = False
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if "-->" in line:
                in_text = True
                continue
            if not line.strip():
                # A blank line ends the cue. Cue indices are recognised by
                # position, not by "is all digits": a caption can now be just
                # "2026" (amh_correct.numbers_to_digits).
                in_text = False
                continue
            if in_text and line.strip():
                lines.append(line)
    return "\n".join(lines)


def _lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1,
                         prev[j - 1] + (ca != cb))
        prev = cur
    return prev[len(b)]


def wer(ref: list, hyp: list) -> float:
    # Levenshtein edit distance over tokens, then WER = dist / len(ref)
    n, m = len(ref), len(hyp)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    dist = dp[n][m]
    return (dist / n) if n else (0.0 if not m else 1.0)


def cer(ref: list, hyp: list) -> float:
    # Character error rate over the normalized streams joined by single spaces,
    # so word-boundary differences (glued/split morphemes) cost fractions, not 1.
    s_ref, s_hyp = " ".join(ref), " ".join(hyp)
    d = _lev(s_ref, s_hyp)
    return (d / len(s_ref)) if s_ref else (0.0 if not s_hyp else 1.0)


# ---- Option A: Amharic-aware "word-grid" scoring ------------------------------
# Plain WER matches the reference and hypothesis as space-delimited runs, so an
# agglutinative boundary disagreement ("ነውአሉ" vs "ነው አሉ") costs a full error
# even when the words are identical. The word grid re-segments BOTH sides with
# the product's own glued-word splitter (amh_lm.AmharicLM.split_word) along a
# real-corpus word list, so both spellings of the same utterance collapse to
# the same token stream and the boundary confound drops out of WER. Genuine
# misses still count: only confident splits are applied (every part a real
# corpus word with count >= min_part_count, min_margin nats of evidence; known
# tokens and non-Ethiopic tokens are never touched), so correct tokens survive.
#
# `--approx-vowel` (EXPERIMENT, never a default) additionally collapses the
# order-0 ("schwa") vs order-3 ("a") glyph of each letter family, e.g. ተ/ታ and
# ከ/ካ — the "vowel-length" spelling alternation behind ተዓምር/ታዕምር. These are
# partly contrastive in careful Amharic, so the flag is only a measurement of
# how much of today's WER is spelling-only; it must stay off in the gate.

# Order-0 ↔ order-3 of every main consonant family (families are consecutive
# 7-glyph Unicode runs: order1..6 follow the base glyph) — the schwa/"a"
# alternation (ተ↔ታ, ከ↔ካ, ሰ↔ሳ, ...) behind spelling variants like ተዓምር/ታዕምር.
# PLUS the glottal families' orders {0,3,5} collapse (አ↔ኣ↔እ, ሀ↔ሃ↔ህ): the
# homophone table maps ዓ/ዕ into ኣ/እ rather than a single glyph, so joining the
# three vowel-order spellings is what finally treats ተዓምር and ታዕምር as equal.
_AMH_VOWEL_APPROX = {}
# glottal three-ways: 0↔3↔5 all collapse to base order 0
for base in (0x1200, 0x12A0):            # ሀ-family, አ-family
    for order in (base, base + 3, base + 5):
        _AMH_VOWEL_APPROX[order] = base
# consonant two-ways: both order 0 and order 3 collapse to order 0
for base in (ord(c) for c in
             "ለሐመሠረሰሸቀቐበቨተቸኀነከኸወዐዘዠየደዸጀገጠጨጰጸፀፈፐ"):
    _AMH_VOWEL_APPROX[base] = base
    _AMH_VOWEL_APPROX[base + 3] = base
_AMH_VOWEL_APPROX = str.maketrans(_AMH_VOWEL_APPROX)


def _load_lm(path=None):
    """Return the bundled AmharicLM (tools/lm/amh_lm.json.gz, else the runtime's
    amh_lm module default), or None if neither loads (grid mode then degrades
    to plain word scoring with a warning)."""
    for cand in ([path] if path else [
            os.path.join(HERE, "..", "lm", "amh_lm.json.gz")]):
        cand = os.path.abspath(cand)
        if not os.path.isfile(cand):
            continue
        try:
            sys.path.insert(0, ROOT)   # repo amh_lm.py (paired with the json)
            from amh_lm import AmharicLM
        except ImportError:
            break
        try:
            return AmharicLM(lm_path=cand)
        except Exception:
            return None
    try:
        from amh_lm import get_default_lm
        return get_default_lm()
    except Exception:
        return None


def grid_tokens(tokens: list, lm, approx_vowel: bool = False) -> list:
    """Re-segment normalized tokens along the word-LM's grid, then (optionally,
    EXPERIMENT) collapse the vowel-length spelling alternation."""
    out = []
    for tok in tokens:
        try:
            out.extend(lm.split_word(tok))
        except Exception:
            out.append(tok)
    if approx_vowel:
        out = [t.translate(_AMH_VOWEL_APPROX) for t in out]
    return out


def cer_nospace(ref: list, hyp: list) -> float:
    """CER with ALL word breaks removed from both sides first.

    Amharic is agglutinative and its orthography does not fix where one word
    ends: "ነው አሉ" and "ነውአሉ" are the same utterance, but plain WER charges two
    errors for the disagreement and even CER still charges for the space.
    Dropping spaces entirely isolates the question that actually measures the
    acoustic model — "did it recognise the right letters?" — from the separate
    question of whether it segments the same way the reference transcriber did.

    Read it alongside WER, never instead of it: WER is still what a viewer
    experiences (wrong word breaks look wrong on screen). This number exists so
    a retrain/LM change can be judged on recognition alone, without segmentation
    disagreement masking whether the model actually got better.
    """
    s_ref = "".join(ref)
    s_hyp = "".join(hyp)
    d = _lev(s_ref, s_hyp)
    return (d / len(s_ref)) if s_ref else (0.0 if not s_hyp else 1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True, help="ground-truth .txt")
    ap.add_argument("--hyp", required=True, help="SRT or text file")
    ap.add_argument("--hyp-is-text", action="store_true")
    ap.add_argument("--max-wer", type=float, default=0.40,
                    help="hard gate; exits 1 above this WER (default 0.40)")
    ap.add_argument("--grid", action="store_true",
                    help="Option A: re-segment both sides along the bundled "
                         "word-LM grid before matching, so agglutinative "
                         "boundary disagreements stop costing WER errors")
    ap.add_argument("--approx-vowel", action="store_true",
                    help="EXPERIMENT (never a gate default): additionally "
                         "collapse the schwa/a vowel-length spelling "
                         "alternation (ተ/ታ, ከ/ካ, ...) to measure spelling-only "
                         "WER; implies --grid")
    ap.add_argument("--dict", default=None,
                    help="path to amh_lm.json.gz word-LM (default: repo "
                         "tools/lm/ or the runtime's amh_lm)")
    args = ap.parse_args()
    args.grid = args.grid or args.approx_vowel

    with open(args.truth, encoding="utf-8") as f:
        ref = normalize(f.read())
    if args.hyp_is_text:
        with open(args.hyp, encoding="utf-8") as f:
            hyp_src = f.read()
    else:
        hyp_src = read_srt_text(args.hyp)
    hyp = normalize(hyp_src)

    if args.grid:
        lm = _load_lm(args.dict)
        if lm is None:
            print("  [warn] word-LM not found; grid mode falls back to plain "
                  "word scoring")
        ref_g = grid_tokens(ref, lm, args.approx_vowel) if lm else ref
        hyp_g = grid_tokens(hyp, lm, args.approx_vowel) if lm else hyp
    else:
        ref_g = ref
        hyp_g = hyp

    # The blank clip rule (empty gold must yield empty hypothesis) is decided on
    # the RAW stream too, so a split that produces tokens is still a regression.
    if not ref:
        # Blank gold: the clip is expected to be silence. Only an equally empty
        # hypothesis passes; any generated tokens are a regression.
        if not hyp:
            print("ref tokens: 0  hyp tokens: 0  WER: 0.0% (blank-expected match)")
            raise SystemExit(0)
        print(f"ref tokens: 0  hyp tokens: {len(hyp)}  WER: n/a")
        print("  -> FAIL: blank audio produced text")
        raise SystemExit(1)

    # Score in BOTH worlds: the committed raw metrics (what the shipped gate
    # uses today) and, when --grid, the Option-A grid view side by side.
    rate = wer(ref, hyp)
    c_rate = cer(ref, hyp)
    cn_rate = cer_nospace(ref, hyp)
    print(f"ref tokens: {len(ref)}  hyp tokens: {len(hyp)}  "
          f"WER: {rate*100:.1f}%  CER: {c_rate*100:.1f}%  "
          f"CER-nospace: {cn_rate*100:.1f}%")
    gate = max(0.0, args.max_wer)
    chosen = rate
    if args.grid and lm is not None:
        g_rate = wer(ref_g, hyp_g)
        g_c_rate = cer(ref_g, hyp_g)
        g_cn_rate = cer_nospace(ref_g, hyp_g)
        print(f"grid tokens: {len(ref_g)}  hyp tokens: {len(hyp_g)}  "
              f"WER: {g_rate*100:.1f}%  CER: {g_c_rate*100:.1f}%  "
              f"CER-nospace: {g_cn_rate*100:.1f}%"
              + ("  [approx-vowel]" if args.approx_vowel else ""))
        chosen = g_rate
    if chosen > gate:
        print(f"  -> FAIL: {'grid ' if args.grid else ''}WER above gate "
              f"({chosen*100:.1f}% > {gate*100:.0f}%)")
        raise SystemExit(1)
    print("  -> PASS" if chosen <= 0.15 else "  -> WARNING")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
