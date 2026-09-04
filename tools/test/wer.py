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
        print("ERROR: ground truth empty")
        raise SystemExit(2)

    rate = wer(ref, hyp)
    print(f"ref tokens: {len(ref)}  hyp tokens: {len(hyp)}  WER: {rate*100:.1f}%")
    if rate > 0.40:
        print("  -> FAIL: WER too high")
        raise SystemExit(1)
    print("  -> PASS" if rate <= 0.15 else "  -> WARNING")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
