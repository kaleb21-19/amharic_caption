#!/usr/bin/env python3
"""03_finetune_waxal.py — fine-tune the Ethio-ASR Amharic CTC model.

Loads the current best checkpoint (badrex/Ethio-ASR-amharic), fine-tunes the
CTC projection (and optionally the conformer trunk) on the WAXAL+real manifest
produced by 02_prep_waxal.py, and saves a brand-new transformers checkpoint in
the SAME layout make_model_ct2_int8.sh expects (config.json + model.safetensors
+ preprocessor_config.json + vocab + tokenizer files). Build_ct2 step that
follows then turns it into the runtime's CT2 int8 model — no network at runtime.

MUSAN robustness: pass --musan-dir and the script adds background
music/noise/speech-babble (from torchaudio's MUSAN loader / a local copy) on
the fly at a random SNR per batch so the model stops transcribing
background music as Amharic — the whole point of the "MUSAN data-swap".

Usage:
    # light fine-tune (head only) on a cloud box:
    python3 tools/retrain/03_finetune_waxal.py \
        --manifest tools/stage/waxal/manifest.tsv \
        --musan /data/musan --out tools/stage/model-retrained \
        --epochs 3 --batch-size 8 --lr 3e-4 --freeze-encoder
    # full-fidelity transfer on a big GPU:
        ... --epochs 6 --batch-size 4 --lr 1e-5
    # laptop smoke (a few steps, MPS/CUDA autodetect):
        ... --max-steps 3 --freeze-encoder --batch-size 1

Requires the dev venv (torch, transformers, pyarrow, soxr/librosa).
"""
import argparse
import os
import sys
import glob
import random

import torch

from transformers import Wav2Vec2BertForCTC, Wav2Vec2Processor

SR = 16000


def load_audio(path):
    import soundfile as sf
    w, sr = sf.read(path, dtype="float32")
    if w.ndim > 1:
        w = w.mean(1)
    if w.shape[0] == 0:
        raise ValueError("empty audio")
    return torch.from_numpy(w).float()


class WaxalDataset(torch.utils.data.Dataset):
    def __init__(self, manifest, processor, musan=None, max_rows=None, seed=0,
                 max_secs=30.0):
        import soundfile as sf
        self.rows = []
        with open(manifest, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                path, _spk, text = line.split("\t", 2)
                try:
                    info = sf.info(path)
                except Exception:
                    continue
                if info.duration > max_secs or info.duration < 0.3:
                    continue
                self.rows.append((path, text))
                if max_rows and len(self.rows) >= max_rows:
                    break
        self.processor = processor
        self.musan = musan
        rng = random.Random(seed)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        path, text = self.rows[i]
        audio = load_audio(path)
        if self.musan is not None:
            audio = mix_musan(audio, self.musan)
        labels = self.processor.tokenizer(text, return_tensors="pt")["input_ids"][0]
        return {"audio": audio, "labels": labels, "text": text}


class Collator:
    def __init__(self, processor):
        self.processor = processor

    def __call__(self, batch):
        audios = [b["audio"] for b in batch]
        labels = [b["labels"] for b in batch]
        feats = self.processor(audios, sampling_rate=SR, return_tensors="pt",
                               padding=True, return_attention_mask=True)
        max_lab = max(len(x) for x in labels)
        padded = torch.full((len(labels), max_lab), -100, dtype=torch.long)
        for i, x in enumerate(labels):
            padded[i, : len(x)] = x
        return {
            "input_features": feats["input_features"].squeeze(1)
            if "input_features" in feats else feats["input_values"],
            "attention_mask": feats.get("attention_mask"),
            "labels": padded,
        }


def mix_musan(audio, musan_dir, snr_range=(-2, 8)):
    """Add a random MUSAN track over the clip at a per-usec SNR."""
    from pathlib import Path
    tracks = glob.glob(os.path.join(musan_dir, "**", "*.wav"), recursive=True)
    if not tracks:
        return audio
    import torchaudio
    trk = random.choice(tracks)
    try:
        t, sr = torchaudio.load(trk)
        if sr != SR:
            t = torchaudio.functional.resample(t, sr, SR)
        t = t.mean(0)
        n = audio.shape[0]
        if t.shape[0] < n:
            reps = t.repeat((n + t.shape[0] - 1) // t.shape[0])[:n]
        else:
            off = random.randrange(0, t.shape[0] - n)
            reps = t[off:off + n]
        snr = random.uniform(*snr_range)
        p_s = audio.pow(2).mean().sqrt().clamp_min(1e-10)
        p_n = reps.pow(2).mean().sqrt().clamp_min(1e-10)
        gain = (p_s / p_n) * torch.pow(10.0, -snr / 20.0)
        return audio + gain * reps
    except Exception as e:
        print("  [musan] skipped track", trk, e, file=sys.stderr)
        return audio


class Trainer:
    def __init__(self, model, device, blank_id=0):
        self.model = model.to(device)
        self.device = device
        # CTC loss is not implemented on the MPS backend; run it on CPU tensors
        # so the gradient still flows (logits become requires_grad from MPS).
        self.loss_device = "cpu" if device in ("mps", "cuda") else device
        self.blank_id = blank_id

    def step(self, batch, optimizer, lr_sched=None):
        b = {k: v.to(self.device) if v is not None else None
             for k, v in batch.items()}
        out = self.model(input_features=b["input_features"],
                         attention_mask=b["attention_mask"])
        logits = out.logits  # (N, T, C)
        N, T, C = logits.shape
        import torch.nn.functional as F
        # torch 2.13 ctc_loss requires (T, N, C); MPS has no ctc_loss so compute
        # on CPU — gradient still flows because logits carry requires_grad.
        log_probs = F.log_softmax(logits, dim=-1).transpose(0, 1)  # (T,N,C)
        log_probs = log_probs.to(self.loss_device)
        labels = b["labels"].to(self.loss_device)
        if b["attention_mask"] is not None:
            inp_len = b["attention_mask"].sum(-1).to(self.loss_device)
            inp_len = inp_len.clamp(max=T)
        else:
            inp_len = torch.full((N,), T, device=self.loss_device,
                                 dtype=torch.long)
        tgt_len = (labels != -100).sum(-1)
        # ctc_loss takes a single concatenated target; strip the -100 pad cols
        parts = [row[row != -100].long() for row in labels]
        labels_flat = torch.cat(parts) if parts else torch.tensor(
            [], device=self.loss_device, dtype=torch.long)
        loss = F.ctc_loss(log_probs, labels_flat, inp_len, tgt_len,
                          blank=self.blank_id, zero_infinity=True) if N else \
            torch.tensor(0.0, requires_grad=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
        optimizer.step()
        optimizer.zero_grad()
        if lr_sched:
            lr_sched.step()
        return float(loss.detach()), logits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--dev-manifest", default=None,
                    help="held-out eval manifest. If given, training REFUSES to "
                         "start if any wav path (or, with a loud warning, any "
                         "speaker id) appears in both train and dev.")
    ap.add_argument("--src", default="ethio-asr",
                    help="existing transformers checkpoint to fine-tune from")
    ap.add_argument("--out", default="tools/stage/model-retrained")
    ap.add_argument("--musan", default=None)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--max-steps", type=int, default=None)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--max-train-rows", type=int, default=None)
    ap.add_argument("--max-secs", type=float, default=30.0,
                    help="drop manifest rows longer than this (default 30s)")
    ap.add_argument("--freeze-encoder", action="store_true",
                    help="keep trunk/folds frozen, train only the CTC head")
    ap.add_argument("--grad-accum", type=int, default=1)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else \
        ("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"[info] device={device}")

    # Leak guard (D3): if a dev manifest is supplied, the training manifest must
    # be disjoint from it. The carve script (carve_dev.py) guarantees this by
    # holding out WHOLE speakers; this check is the backstop that fails loudly
    # if a caller ever feeds the full (uncarved) manifest by mistake.
    if args.dev_manifest:
        def read_pairs(path):
            pairs = []
            with open(path, encoding="utf-8") as f:
                for ln in f:
                    if ln.strip():
                        p = ln.rstrip("\n").split("\t")
                        pairs.append(p[:2])
            return pairs
        train_rows = read_pairs(args.manifest)
        dev_rows = read_pairs(args.dev_manifest)
        train_paths = {p for p, _ in train_rows}
        dev_paths = {p for p, _ in dev_rows}
        shared_paths = train_paths & dev_paths
        shared_spks = {s for _, s in train_rows} & {s for _, s in dev_rows}
        if shared_paths:
            sys.exit(f"[FAIL] LEAK: {len(shared_paths)} wav path(s) appear in BOTH "
                     f"--manifest ({args.manifest}) and --dev-manifest "
                     f"({args.dev_manifest}). Re-carve with tools/retrain/carve_dev.py "
                     f"before training — the WER gate would otherwise be meaningless.")
        if shared_spks:
            print(f"[warn] {len(shared_spks)} speaker id(s) appear in BOTH train and "
                  f"dev manifests. Speaker-disjoint carve expected (carve_dev.py); "
                  f"path-level disjointness is guaranteed, but voice leakage may "
                  f"inflate the WER gate.")

    processor = Wav2Vec2Processor.from_pretrained(args.src)
    model = Wav2Vec2BertForCTC.from_pretrained(args.src)
    if args.freeze_encoder:
        for p in model.wav2vec2_bert.parameters():
            p.requires_grad = False
        print("[info] encoder frozen, training CTC head only")

    ds = WaxalDataset(args.manifest, processor, musan=args.musan,
                      max_rows=args.max_train_rows, seed=args.seed,
                      max_secs=args.max_secs)
    print(f"[info] {len(ds)} training rows")
    dl = torch.utils.data.DataLoader(
        ds, batch_size=args.batch_size, shuffle=True,
        collate_fn=Collator(processor), num_workers=2, persistent_workers=False)

    trainer = Trainer(model, device, blank_id=processor.tokenizer.pad_token_id)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[info] trainable params: {n_params / 1e6:.1f}M")
    total_steps = args.epochs * (len(ds) // (args.batch_size * args.grad_accum) + 1)
    if args.max_steps:
        total_steps = args.max_steps
    optim = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.LinearLR(optim, total_iters=max(total_steps, 1))

    step = 0
    for epoch in range(args.epochs):
        print(f"[epoch {epoch + 1}/{args.epochs}]")
        for bi, batch in enumerate(dl):
            loss, logits = trainer.step(batch, optim, sched)
            if step % 5 == 0 or loss < 1.0:
                print(f"  step {step}: loss={loss:.4f} lr={sched.get_last_lr()[0]:.2e}")
            step += 1
            if args.max_steps and step >= args.max_steps:
                break
        if args.max_steps and step >= args.max_steps:
            break

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    processor.save_pretrained(args.out)
    import shutil
    for extra in ("preprocessor_config.json", "special_tokens_map.json"):
        src = os.path.join(args.src, extra)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(args.out, extra))
    print(f"[ok] fine-tuned checkpoint -> {args.out}")


if __name__ == "__main__":
    main()