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
    --decode {greedy,beam}                  (default greedy; beam matches what
                                              the product actually ships —
                                              greedy-only scoring here can pass
                                              a candidate that regresses once
                                              deployed. See IMPROVEMENTS.md #3.)
"""
import argparse
import os
import re
import sys

import torch

from transformers import Wav2Vec2BertForCTC, Wav2Vec2Processor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from ctc_beam import ctc_beam_decode  # noqa: E402

SR = 16000


def load_audio(path):
    import soundfile as sf
    w, sr = sf.read(path, dtype="float32")
    if w.ndim > 1:
        w = w.mean(1)
    return w


# Modern-Amharic homophone letter classes, mapped order-by-order to the
# surviving letter (see tools/test/wer.py — keep the two in lockstep):
# ኀ,ሐ→ሀ ; ሠ→ሰ ; ፀ→ጸ ; the ʿayn series ዐ-ዕ → the ʾalef series አ-እ.
_AMH_HOMOPHONE = str.maketrans(
    "ሐሑሒሓሔሕሖኀኁኂኃኄኅኆሠሡሢሣሤሥሦፀፁፂፃፄፅፆዐዑዒዓዔዕ",
    "ሀሁሂሃሄህሆሀሁሂሃሄህሆሰሱሲሳሴስሦጸጹጺጻጼጽጾአኡኢኣኤእ")


def normalize(text: str) -> list:
    text = text.lower()
    # Ethiopic punctuation (U+1360–U+1368: ፠፡።፣፤፥፦፧) lives INSIDE the
    # \u1200-\u137F keep-range, so strip it first — otherwise a reference token
    # like "ነው።" never matches the model's "ነው". Ethiopic DIGITS are kept.
    # (Same normalizer as tools/test/wer.py — keep the two in lockstep.)
    text = re.sub(r"[\u1360-\u1368]", " ", text)
    text = re.sub(r"[^\w\s\u1200-\u137F]", " ", text)
    text = text.translate(_AMH_HOMOPHONE)
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


def cer(ref_tokens, hyp_tokens) -> float:
    def lev(a: str, b: str) -> int:
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i] + [0] * len(b)
            for j, cb in enumerate(b, 1):
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1,
                             prev[j - 1] + (ca != cb))
            prev = cur
        return prev[len(b)]
    s_ref, s_hyp = " ".join(ref_tokens), " ".join(hyp_tokens)
    d = lev(s_ref, s_hyp)
    return (d / len(s_ref)) if s_ref else (0.0 if not s_hyp else 1.0)


def cer_nospace(ref_tokens, hyp_tokens) -> float:
    """CER with all word breaks dropped from both sides — see the longer
    explanation in tools/test/wer.py (keep the two in lockstep). Amharic word
    boundaries aren't fixed, so this separates "recognised the right letters"
    from "segmented the same way the reference transcriber did"."""
    def lev(a: str, b: str) -> int:
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i] + [0] * len(b)
            for j, cb in enumerate(b, 1):
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1,
                             prev[j - 1] + (ca != cb))
            prev = cur
        return prev[len(b)]
    s_ref, s_hyp = "".join(ref_tokens), "".join(hyp_tokens)
    d = lev(s_ref, s_hyp)
    return (d / len(s_ref)) if s_ref else (0.0 if not s_hyp else 1.0)


def transcribe(processor, model, device, audio, decode="greedy"):
    """decode='greedy' matches the original argmax+processor.decode scoring.
    decode='beam' runs the SAME numpy CTC prefix beam search (ctc_beam.py,
    default beam_width/top_k) the shipped product actually uses, so this gate
    can't pass a candidate whose beam-search output regresses even though its
    greedy output looked fine (IMPROVEMENTS.md Tier 0 #3)."""
    blank_id = processor.tokenizer.pad_token_id
    glyphs = {int(tid): ch for ch, tid in processor.tokenizer.get_vocab().items()}
    out_txts = []
    for a in chunk_signal(audio, SR * 45):  # <=45s windows keep memory bounded
        feats = processor(a, sampling_rate=SR, return_tensors="pt",
                          padding=True, return_attention_mask=True)
        with torch.no_grad():
            out = model(
                input_features=feats["input_features"].to(device),
                attention_mask=feats.get("attention_mask").to(device)
                if feats.get("attention_mask") is not None else None)
        if decode == "beam":
            # Match the shipped defaults (ethio_srt.py / AMH_BEAM_TOP_K,
            # AMH_BEAM_WIDTH) exactly, not an unbounded full-vocab search —
            # otherwise this "matches production" gate would silently score a
            # slower, more thorough beam than what's actually deployed.
            logits = out.logits[0].float().cpu().numpy()
            text, _segs = ctc_beam_decode(
                logits, blank_id, glyphs=glyphs,
                beam_width=int(os.environ.get("AMH_BEAM_WIDTH", "24")),
                top_k=int(os.environ.get("AMH_BEAM_TOP_K", "16")))
            out_txts.append(text)
        else:
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
    ap.add_argument("--decode", choices=["greedy", "beam"], default="greedy",
                     help="greedy (original) or beam (matches the shipped "
                          "product's ctc_beam.py decoder — see IMPROVEMENTS.md #3)")
    args = ap.parse_args()

    device = args.device or \
        ("cuda" if torch.cuda.is_available() else
         ("mps" if torch.backends.mps.is_available() else "cpu"))
    print(f"[info] device={device}  decode={args.decode}")

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
    tot_cc = 0.0
    tot_nc = 0.0
    tot_cx = 0.0   # boundary-agnostic CER, current
    tot_nx = 0.0   # boundary-agnostic CER, candidate
    count = 0
    print(f"  {'row':>4}  {'(total) current':>16} {'(total) retrained':>17}  example")
    for i, (path, truth) in enumerate(rows):
        audio = load_audio(path)
        hy_c = transcribe(proc_c, model_c, device, audio, decode=args.decode)
        hy_n = transcribe(proc_n, model_n, device, audio, decode=args.decode)
        ref = normalize(truth)
        w_c = wer(ref, normalize(hy_c))
        w_n = wer(ref, normalize(hy_n))
        tot_c += w_c
        tot_n += w_n
        tot_cc += cer(ref, normalize(hy_c))
        tot_nc += cer(ref, normalize(hy_n))
        tot_cx += cer_nospace(ref, normalize(hy_c))
        tot_nx += cer_nospace(ref, normalize(hy_n))
        count += 1
        print(f"  {i:>4}  {w_c:>16.3f} {w_n:>17.3f}  "
              f"{'OK' if w_n <= w_c else 'REGRESS'}  {truth[:26]}")

    avg_c = tot_c / count if count else float("nan")
    avg_n = tot_n / count if count else float("nan")
    avg_cc = tot_cc / count if count else float("nan")
    avg_nc = tot_nc / count if count else float("nan")
    avg_cx = tot_cx / count if count else float("nan")
    avg_nx = tot_nx / count if count else float("nan")
    print(f"\n[result] mean WER  current={avg_c:.3f}  retrained={avg_n:.3f}")
    print(f"[result] mean CER  current={avg_cc:.3f}  retrained={avg_nc:.3f}")
    # Boundary-agnostic: recognition quality with word-break disagreement
    # removed. If WER moves but this doesn't, the change only re-segmented.
    print(f"[result] mean CER (no word breaks)  current={avg_cx:.3f}  retrained={avg_nx:.3f}")
    print(f"[result] 'retrained <= current' -> "
          f"{'KEEP (ship it)' if avg_n <= avg_c else 'REJECT (keep current)'}")
    sys.exit(0 if avg_n <= avg_c else 1)


if __name__ == "__main__":
    main()