#!/usr/bin/env python3
"""wer.py — Word Error Rate between a ground-truth transcript and an SRT/transcript.

Usage:
  python3 wer.py --truth truth.txt --hyp out.srt [--hyp-is-text]

Normalizes (lowercase, collapse whitespace, strip punctuation) before comparing.
SRT input: extracts subtitle text lines and joins them.
"""
import argparse
import re


def normalize(text: str) -> list:
    text = text.lower()
    # Speaker labels ([S1]/[S2], "S1:", <v S1>) are engine markup, not content.
    text = re.sub(r"\[[sS][12]\]|(?:^|\s)[sS][12]:|<v[sS]\s*[12]>|</v>", " ", text)
    # Ethiopic punctuation (U+1360–U+1368: ፠፡።፣፤፥፦፧) lives INSIDE the
    # \u1200-\u137F keep-range, so strip it first — otherwise a caption word
    # like "ነው።" would not match the reference token "ነው". Ethiopic DIGITS
    # (U+1369–U+137C) are kept.
    text = re.sub(r"[\u1360-\u1368]", " ", text)
    text = re.sub(r"[^\w\s\u1200-\u137F]", " ", text)
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
            if re.match(r"^\d{1,4}\s*$", line.strip()):
                in_text = False
                continue
            if in_text and line.strip():
                lines.append(line)
    return "\n".join(lines)


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True, help="ground-truth .txt")
    ap.add_argument("--hyp", required=True, help="SRT or text file")
    ap.add_argument("--hyp-is-text", action="store_true")
    ap.add_argument("--max-wer", type=float, default=0.40,
                    help="hard gate; exits 1 above this WER (default 0.40)")
    args = ap.parse_args()

    with open(args.truth, encoding="utf-8") as f:
        ref = normalize(f.read())
    if args.hyp_is_text:
        with open(args.hyp, encoding="utf-8") as f:
            hyp_src = f.read()
    else:
        hyp_src = read_srt_text(args.hyp)
    hyp = normalize(hyp_src)

    if not ref:
        # Blank gold: the clip is expected to be silence. Only an equally empty
        # hypothesis passes; any generated tokens are a regression.
        if not hyp:
            print("ref tokens: 0  hyp tokens: 0  WER: 0.0% (blank-expected match)")
            raise SystemExit(0)
        print(f"ref tokens: 0  hyp tokens: {len(hyp)}  WER: n/a")
        print("  -> FAIL: blank audio produced text")
        raise SystemExit(1)

    rate = wer(ref, hyp)
    gate = max(0.0, args.max_wer)
    print(f"ref tokens: {len(ref)}  hyp tokens: {len(hyp)}  WER: {rate*100:.1f}%")
    if rate > gate:
        print(f"  -> FAIL: WER above gate ({rate*100:.1f}% > {gate*100:.0f}%)")
        raise SystemExit(1)
    print("  -> PASS" if rate <= 0.15 else "  -> WARNING")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
