#!/usr/bin/env python3
"""amh_numwords.py — spell digits out as Amharic number words.

The inverse of amh_correct.numbers_to_digits, for text that must be in WORDS:

  * scoring (tools/test/wer.py): captions write numbers as digits while
    references spell them out, so the caption's digits are spelled back out
    and WER/CER keep measuring recognition, comparable with earlier runs;
  * training (tools/retrain/03_finetune_waxal.py): ~2% of WAXAL transcripts
    write numbers as digits ("እስከ 6 መቶ", "ከ150 ብር") and the rest spell them
    out. Trained on both, the model learned to hover between "5" and "አምስት"
    and stitched the two into "5mሰት" (TESTING.md 1.2o). Spelling every
    transcript out teaches it one form.

  say_number("በ2016።") -> "በሁለት ሺህ አስራ ስድስት።"
  say_number("0911")   -> "ዜሮ ዘጠኝ አንድ አንድ"   (leading 0: digit by digit)
  say_number("4.5")    -> "አራት ነጥብ አምስት"
  say_number("2-3")    -> "ሁለት ሶስት"
"""
import re

_ONES = ["ዜሮ", "አንድ", "ሁለት", "ሶስት", "አራት", "አምስት", "ስድስት", "ሰባት", "ስምንት", "ዘጠኝ"]
_TENS = {10: "አስር", 20: "ሃያ", 30: "ሰላሳ", 40: "አርባ", 50: "ሃምሳ",
         60: "ስልሳ", 70: "ሰባ", 80: "ሰማንያ", 90: "ዘጠና"}


def say_int(n: int) -> list:
    if n < 10:
        return [_ONES[n]]
    for scale, word in ((10 ** 9, "ቢሊዮን"), (10 ** 6, "ሚሊዮን"), (1000, "ሺህ")):
        if n >= scale:
            hi, lo = divmod(n, scale)
            return say_int(hi) + [word] + (say_int(lo) if lo else [])
    if n >= 100:
        hi, lo = divmod(n, 100)
        return ([] if hi == 1 else say_int(hi)) + ["መቶ"] + (say_int(lo) if lo else [])
    t, u = divmod(n, 10)
    if t == 1:
        return ["አስር"] if u == 0 else ["አስራ", _ONES[u]]
    return [_TENS[t * 10]] + ([_ONES[u]] if u else [])


def say_number(tok: str) -> str:
    m = re.fullmatch(r"(\D*?)(\d+(?:[.-]\d+)?)(\W*)", tok)
    if not m:
        return tok
    prefix, num, trail = m.groups()
    if "." in num or "-" in num:
        a, sep, b = re.split(r"([.-])", num)
        mid = ["ነጥብ"] if sep == "." else []
        words = say_int(int(a)) + mid + (say_int(int(b)) if sep == "-" else [_ONES[int(d)] for d in b])
    elif num.startswith("0") and len(num) > 1:
        words = [_ONES[int(d)] for d in num]  # phone number / id: digit by digit
    else:
        words = say_int(int(num))
    words[0] = prefix + words[0]
    return " ".join(words) + trail


def say_digits_in(text: str) -> str:
    """Spell out every number in running text ("ከ 18 አመት" -> "ከ አስራ ስምንት
    አመት"). Thousands separators between digits are dropped first."""
    text = re.sub(r"(?<=\d),(?=\d{3})", "", text)
    return " ".join(say_number(t) for t in text.split())
