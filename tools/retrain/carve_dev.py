#!/usr/bin/env python3
"""carve_dev.py — speaker-disjoint held-out split for the WAXAL retrain.

Splits a manifest (`path  speaker  text`, tab-separated as 02_prep_waxal.py
writes it) into a train manifest and a dev manifest such that NO WAV/SPEAKER
appears on both sides. This is the correctness guarantee the WER gate depends
on: a row-order tail carve (the old approach) puts the same speaker in train AND
dev, so the model can memorize that voice and the "held-out" number stops being
honest.

  # hold out ~5% of rows (whole speaker groups), rewriting manifest.tsv in-place
  python3 tools/retrain/carve_dev.py --manifest data/manifest.tsv --dev data/dev.tsv

  # fixed-size holdout instead of a fraction
  python3 tools/retrain/carve_dev.py --manifest M --dev D --max-dev-rows 150

Speakers are assigned to dev in decreasing row-count order, so the gate slice
covers as distinct speakers as possible; every speaker is kept whole (no
speaker shares rows across the split). If the corpus has a SINGLE speaker, this
degrades to a row-order tail carve (impossible to be speaker-disjoint) with a
loud warning — you cannot get an honest WER gate from one-voice data.
"""
import argparse
import random
import sys


def read_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            if not ln:
                continue
            parts = ln.split("\t")
            if len(parts) < 3:
                print(f"[warn] skipping malformed line: {ln[:80]!r}", file=sys.stderr)
                continue
            path_, spk, text = parts[0], parts[1], parts[2]
            rows.append((path_, spk, text))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True, help="input manifest.tsv (rewritten in place to train-only)")
    ap.add_argument("--dev", required=True, help="output dev.tsv (held-out rows)")
    ap.add_argument("--fraction", type=float, default=0.05, help="fraction of rows to hold out (default 0.05)")
    ap.add_argument("--max-dev-rows", type=int, default=None, help="hard cap on dev rows (overrides fraction if smaller)")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rows = read_rows(args.manifest)
    total = len(rows)
    if total == 0:
        print("[FAIL] manifest empty")
        sys.exit(1)

    target = int(round(total * args.fraction))
    if args.max_dev_rows:
        target = min(target, args.max_dev_rows)
    target = max(1, target)

    # Group whole speakers; assign them to dev in decreasing row-count order.
    by_spk = {}
    for r in rows:
        by_spk.setdefault(r[1], []).append(r)
    speaker_order = sorted(by_spk, key=lambda s: (-len(by_spk[s]), s))

    if len(by_spk) == 1:
        # One-voice corpus: cannot be speaker-disjoint. Fall back to a row-order
        # tail carve and say so — the WER gate on such data is NOT trustworthy.
        n = min(target, total)
        dev_rows = rows[-n:]
        train_rows = rows[:-n]
        print(f"[warn] single speaker in corpus ({list(by_spk)[0]}) — "
              f"carving by row order; dev is NOT speaker-disjoint")
    else:
        dev_rows = []
        for s in speaker_order:
            if len(dev_rows) >= target:
                break
            dev_rows.extend(by_spk[s])
        dev_spks = {r[1] for r in dev_rows}
        train_rows = [r for r in rows if r[1] not in dev_spks]
        overlap = train_rows and dev_spks.intersection({r[1] for r in train_rows})
        assert not overlap, "invariant: dev and train share a speaker"
        print(f"[split] held out {len(dev_rows)} rows / {len(dev_spks)} speakers "
              f"(target ~{target})")

    write_tab = lambda rs: "".join("\t".join(r) + "\n" for r in rs)
    with open(args.manifest, "w", encoding="utf-8") as f:
        f.write(write_tab(train_rows))
    with open(args.dev, "w", encoding="utf-8") as f:
        f.write(write_tab(dev_rows))

    print(f"[split] train={len(train_rows)} dev={len(dev_rows)} -> {args.dev}")
    # Hard guarantee: the file a later training run receives must be disjoint.
    train_paths = {r[0] for r in train_rows}
    dev_paths = {r[0] for r in dev_rows}
    shared = train_paths & dev_paths
    if shared:
        print(f"[FAIL] dev and train share {len(shared)} wav files", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()