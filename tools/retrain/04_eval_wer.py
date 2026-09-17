#!/usr/bin/env python3
"""04_eval_wer.py — WER gate: decide whether the retrained model is a keeper.

Computes Word Error Rate (with the same normalizer as tools/test/wer.py) for
BOTH the current production checkpoint and the retrained checkpoint on a
manifest of wav + reference text (WAXAL held-out rows, or any srt/txt truth),
then decides: exit 0 if the retrained model is at least as good as the current
one on the same eval set, exit 1 if it regressed. run_all.sh uses the exit
code so a bad retrain can never replace the working model.

    --manifest tools/stage/waxal/dev.tsv    (path<TAB>spk<TAB>text)
    --current ethio-asr                     (production HF checkpoint dir)
    --candidate tools/stage/model-retrained (proposed retrained checkpoint)
    --max-rows N                            (quick smoke)
"""
import argparse
import os
import re
import sys

import torch

from transformers import Wav2Vec2BertForCTC, Wav2Vec2Processor

SR = 16000


def load_audio(path):
    import soundfile as sf
    w, sr = sf.read(path, dtype="float32")
    if w.ndim > 1:
        w = w.mean(1)
    return w


def normalize(text: str) -> list:
    text = text.lower()
    text = re.sub(r"[^\w\s\u1200-\u137F]", " ", text)
    return re.findall(r"[\u1200-\u137F\w]+", text)


def wer(ref_tokens, hyp_tokens) -> float:
    n, m = len(ref_tokens), len(hyp_tokens)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = i
    for j in range(m + 1):
        dp[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            c = 0 if ref_tokens[i - 1] == hyp_tokens[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
                           dp[i - 1][j - 1] + c)
    return (dp[n][m] / n) if n else (0.0 if not m else 1.0)


def transcribe(processor, model, device, audio):
    out_txts = []
    for a in chunk_signal(audio, SR * 45):  # <=45s windows keep memory bounded
        feats = processor(a, sampling_rate=SR, return_tensors="pt",
                          padding=True, return_attention_mask=True)
        with torch.no_grad():
            out = model(
                input_features=feats["input_features"].to(device),
                attention_mask=feats.get("attention_mask").to(device)
                if feats.get("attention_mask") is not None else None)
        ids = torch.argmax(out.logits, dim=-1)[0].cpu()
        out_txts.append(processor.decode(ids))
    return " ".join(t for t in out_txts if t)


def chunk_signal(audio, max_len):
    for st in range(0, len(audio), max_len):
        yield audio[st:st + max_len]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--current", default="ethio-asr")
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--max-rows", type=int, default=None)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    device = args.device or \
        ("cuda" if torch.cuda.is_available() else
         ("mps" if torch.backends.mps.is_available() else "cpu"))
    print(f"[info] device={device}")

    rows = []
    with open(args.manifest, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            path, _spk, text = line.split("\t", 2)
            rows.append((path, text))
            if args.max_rows and len(rows) >= args.max_rows:
                break
    if not rows:
        print("[fail] empty manifest")
        sys.exit(2)

    print(f"[info] loading current model {args.current}")
    proc_c = Wav2Vec2Processor.from_pretrained(args.current)
    model_c = Wav2Vec2BertForCTC.from_pretrained(args.current).to(device).eval()
    print(f"[info] loading candidate model {args.candidate}")
    proc_n = Wav2Vec2Processor.from_pretrained(args.candidate)
    model_n = Wav2Vec2BertForCTC.from_pretrained(args.candidate).to(device).eval()

    tot_c = 0.0
    tot_n = 0.0
    count = 0
    print(f"  {'row':>4}  {'(total) current':>16} {'(total) retrained':>17}  example")
    for i, (path, truth) in enumerate(rows):
        audio = load_audio(path)
        hy_c = transcribe(proc_c, model_c, device, audio)
        hy_n = transcribe(proc_n, model_n, device, audio)
        ref = normalize(truth)
        w_c = wer(ref, normalize(hy_c))
        w_n = wer(ref, normalize(hy_n))
        tot_c += w_c
        tot_n += w_n
        count += 1
        print(f"  {i:>4}  {w_c:>16.3f} {w_n:>17.3f}  "
              f"{'OK' if w_n <= w_c else 'REGRESS'}  {truth[:26]}")

    avg_c = tot_c / count if count else float("nan")
    avg_n = tot_n / count if count else float("nan")
    print(f"\n[result] mean WER  current={avg_c:.3f}  retrained={avg_n:.3f}")
    print(f"[result] 'retrained <= current' -> "
          f"{'KEEP (ship it)' if avg_n <= avg_c else 'REJECT (keep current)'}")
    sys.exit(0 if avg_n <= avg_c else 1)


if __name__ == "__main__":
    main()