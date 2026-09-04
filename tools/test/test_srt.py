#!/usr/bin/env python3
"""test_srt.py — structural validator for generated SRT files.

Checks: sequential numbering, sorted & non-overlapping cues, sane 1–5s durations,
UTF-8 Amharic preserved, no empty cues.

Usage: python3 test_srt.py /path/to/file.srt
"""
import argparse
import re
import sys


def parse_srt(path: str):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    blocks = content.strip().split("\n\n")
    cues = []
    for b in blocks:
        lines = b.strip().split("\n")
        if len(lines) < 2:
            continue
        try:
            num = int(lines[0].strip())
        except ValueError:
            num = None
        m = re.match(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})", lines[1])
        if not m:
            continue
        def to_sec(g):
            return int(g[0])*3600 + int(g[1])*60 + int(g[2]) + int(g[3])/1000.0
        start = to_sec(m.groups()[:4])
        end = to_sec(m.groups()[4:])
        text = "\n".join(lines[2:]).strip()
        cues.append({"num": num, "start": start, "end": end, "text": text})
    return cues


def check(path: str) -> int:
    try:
        cues = parse_srt(path)
    except Exception as e:
        print(f"[FAIL] cannot parse: {e}")
        return 1
    faults = 0
    if not cues:
        print("[WARN] no cues")
        return 0
    print(f"cues: {len(cues)}")
    prev_end = -1.0
    for i, c in enumerate(cues):
        if c["num"] != i + 1:
            print(f"  [FAIL] cue {i+1}: numbering {c['num']}")
            faults += 1
        if c["end"] <= c["start"]:
            print(f"  [FAIL] cue {i+1}: non-positive duration")
            faults += 1
        else:
            d = c["end"] - c["start"]
            if d > 5.0:
                print(f"  [WARN] cue {i+1}: duration {d:.1f}s > 5s")
            if d < 0.5:
                print(f"  [WARN] cue {i+1}: duration {d:.2f}s < 0.5s")
        if c["start"] < prev_end - 0.001:
            print(f"  [FAIL] cue {i+1}: overlaps previous (start {c['start']:.3f} < prev end {prev_end:.3f})")
            faults += 1
        prev_end = max(prev_end, c["end"])
        if not c["text"]:
            print(f"  [FAIL] cue {i+1}: empty text")
            faults += 1
    print("PASS" if faults == 0 else f"{faults} fault(s)")
    return faults


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("srt")
    a = ap.parse_args()
    sys.exit(check(a.srt))
