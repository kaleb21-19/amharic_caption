#!/usr/bin/env python3
"""split_by_speakers.py — split a WAXAL manifest by the FIXED speaker lists.

The held-out speakers live in tools/retrain/splits/ so every machine agrees on
them: the Kaggle run must never train on a voice the Mac later scores as the
final exam (holdout), or on the voices it watches during training (dev).
carve_dev.py picks speakers per run, so two machines would carve different
splits and leak into each other's gates; this is its fixed replacement.

The lists were drawn (2026-09-23) from speakers with 3-40 rows, so each set
spans many voices: holdout = 23 speakers / 314 rows, dev = 9 / 163.

  python3 tools/retrain/split_by_speakers.py --manifest M --out-dir D
  -> D/train.tsv  D/dev.tsv  D/holdout.tsv   (path<TAB>speaker<TAB>text)
"""
import argparse
import os
import random

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "splits")


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return {ln.strip() for ln in f if ln.strip()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    hold, dev = load("holdout_speakers.txt"), load("dev_speakers.txt")
    out = {"train": [], "dev": [], "holdout": []}
    with open(args.manifest, encoding="utf-8") as f:
        for ln in f:
            parts = ln.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            spk = parts[1]
            out["holdout" if spk in hold else "dev" if spk in dev else "train"].append(ln)
    # dev is scored in prefix order (--eval-rows), so shuffle it to span voices
    random.Random(1).shuffle(out["dev"])
    os.makedirs(args.out_dir, exist_ok=True)
    for k, rows in out.items():
        with open(os.path.join(args.out_dir, f"{k}.tsv"), "w", encoding="utf-8") as f:
            f.writelines(rows)
        print(f"[split] {k}: {len(rows)} rows")


if __name__ == "__main__":
    main()
