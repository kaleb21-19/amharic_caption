#!/usr/bin/env python3
"""01_fetch_waxal.py — discover + download the WAXAL Amharic ASR parquet shards.

Pulls google/WaxalNLP config amh_asr from HuggingFace. The dataset is large
(each ASR parquet ~500 MB audio + transcription), so this mirrors the chunked
range downloader used for the rcade word corpus: each shard is fetched in
3 MB ranges with resume, so a dropped connection never restarts from zero.

Usage (run from repo root, or pass --out):
    python3 tools/retrain/01_fetch_waxal.py --out /data/waxal
    python3 tools/retrain/01_fetch_waxal.py --out /data/waxal --only test
    python3 tools/retrain/01_fetch_waxal.py --out /data/waxal --only train \
        --max-shards 4 --max-total-bytes 2G

  --only: train | test | unlabeled  (default: train)
  --max-shards: cap how many shards to pull (default: all). Shards are pulled
                in order 00000, 00001, ... so --max-shards 2 means the two
                earliest train shards.
  --max-total-bytes: hard cap (e.g. 4G, 2000M) — stops once reached, for
                quick smoke runs / bandwidth budget on a laptop.
  --list-only: just print the discovery results (no download).
"""
import argparse
import json
import os
import sys
import time
import urllib.request

API = "https://huggingface.co/api/datasets/google/WaxalNLP/tree/main/data/ASR/amh"
BASE = "https://huggingface.co/datasets/google/WaxalNLP/resolve/main/data/ASR/amh"
CH = 3 * 1024 * 1024  # 3 MB ranges — small enough to survive mid-file drops
TRIES = 8


def hf_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "amh-captions-retrain/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def discover():
    """Return {shard_name: bytes} for the requested split files."""
    entries = hf_json(API)
    out = {}
    for e in entries:
        if e["type"] != "file":
            continue
        name = os.path.basename(e["path"])  # e.g. amh-train-00000.parquet
        if not name.endswith(".parquet"):
            continue
        tag = name.split("-", 2)[2].split("-", 1)[0]  # train/test/unlabeled
        out[name] = e.get("size", 0)
    return out


def human(n):
    for u in ("B", "K", "M", "G"):
        if n < 1024 or u == "G":
            return f"{n:.1f}{u}" if n >= 100 else f"{n:.0f}{u}"
        n /= 1024


def fetch_range(url, start, end, timeout=120):
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download_one(name, size, outdir):
    dst = os.path.join(outdir, name)
    have = os.path.getsize(dst) if os.path.exists(dst) else 0
    have = min(have, size)
    if have >= size:
        return True, 0
    url = f"{BASE}/{name}"
    t0 = time.time()
    while have < size:
        end = min(have + CH, size) - 1
        got = None
        for attempt in range(TRIES):
            try:
                got = fetch_range(url, have, end)
            except Exception as e:
                print(f"    retry {attempt + 1}/{TRIES} @{human(have)}: {e}", flush=True)
                time.sleep(3 + attempt * 2)
                continue
            if len(got) > 0:
                break
        if got is None or len(got) == 0:
            return False, have
        with open(dst, "ab") as f:
            f.write(got)
        have += len(got)
        rate = have / max(time.time() - t0, 0.01)
        print(f"  {name}: {have / size * 100:5.1f}%  {human(have)}/{human(size)}  "
              f"({human(rate)}/s)", flush=True)
    return True, have


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="tools/stage/waxal")
    ap.add_argument("--only", default="train", choices=["train", "test", "unlabeled"])
    ap.add_argument("--max-shards", type=int, default=None)
    ap.add_argument("--max-total-bytes", default=None, help="e.g. 2G, 1500M, 500000000")
    ap.add_argument("--list-only", action="store_true")
    args = ap.parse_args()

    files = discover()
    wanted = {k: v for k, v in files.items() if f"-{args.only}-" in k}
    wanted = dict(sorted(wanted.items()))
    if args.max_shards:
        wanted = dict(list(wanted.items())[: args.max_shards])

    total = sum(wanted.values())
    print(f"[info] found {len(wanted)} '{args.only}' shards, total {human(total)}")
    for k, v in wanted.items():
        print(f"    {k}  {human(v)}")
    if args.list_only:
        return

    cap = None
    if args.max_total_bytes:
        cap = int(args.max_total_bytes.rstrip("GMK")).__mul__(
            {"G": 1024 ** 3, "M": 1024 ** 2, "K": 1024}.get(
                args.max_total_bytes[-1].upper(), 1))
    os.makedirs(args.out, exist_ok=True)

    budget = cap if cap is not None else total
    fetched = 0
    failed = 0
    for name, size in wanted.items():
        if budget - fetched <= 0:
            print(f"[stop] byte cap reached ({human(fetched)})")
            break
        ok, have = download_one(name, size, args.out)
        fetched += have
        if not ok:
            failed += 1
            print(f"[warn] shard {name} incomplete @{human(have)}"
                  f" — re-run resumes (exit 2)")
    if failed:
        # non-zero so an overnight supervisor loop knows to relaunch
        sys.exit(2)


if __name__ == "__main__":
    main()