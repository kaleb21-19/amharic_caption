#!/usr/bin/env python3
"""02_prep_waxal.py — turn downloaded WAXAL parquet shards into a dataset.

Each WAXAL ASR row is {id, speaker_id, transcription, language, gender,
audio}. audio is a dict with {"path","bytes","sampling_rate"}. This script:
  * reads every *.parquet under --shards,
  * skips chunks without a transcription,
  * resamples to 16 kHz mono,
  * writes each example as a .wav under --wavs,
  * appends one line to manifest.tsv:  path<TAB>speaker<TAB>text

The WAXAL Amharic rows are already mostly done/tuned so we keep them as-is;
the Amharic text uses the native Ge'ez script which matches the model vocab.

Usage:
  python3 tools/retrain/02_prep_waxal.py --shards tools/stage/waxal \
      --wavs tools/stage/waxal/wavs --manifest tools/stage/waxal/manifest.tsv
  # limit for a quick smoke:
  python3 ... --max-rows 200
"""
import argparse
import glob
import os
import sys
import wave

try:
    import pyarrow.parquet as pq
except ImportError:
    print("[fail] pip install pyarrow"); sys.exit(2)

SR = 16000


def wav_write(path, data, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)


def decode_audio(raw):
    """raw: bytes of ANY WAXAL audio encoding (mp3/wav/flac/opus). Returns
    float32 mono waveform + its true sample rate (soundfile decodes headers)."""
    import io
    import soundfile as sf
    w, sr = sf.read(io.BytesIO(raw), dtype="float32")
    if w.ndim > 1:
        w = w.mean(1)
    return w, int(sr)


def resample_f32(x, src_sr, dst_sr):
    """linear-interp resample of a float32 mono waveform to dst_sr."""
    import numpy as np
    if src_sr == dst_sr:
        return x
    n_out = int(round(len(x) * dst_sr / src_sr))
    idx = (np.arange(n_out) * src_sr / dst_sr)
    i0 = np.floor(idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = (idx - i0).astype(np.float32)
    return x[i0] * (1 - frac) + x[i1] * frac


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", default="tools/stage/waxal")
    ap.add_argument("--wavs", default="tools/stage/waxal/wavs")
    ap.add_argument("--manifest", default="tools/stage/waxal/manifest.tsv")
    ap.add_argument("--max-rows", type=int, default=None)
    ap.add_argument("--sample-rate", type=int, default=SR)
    args = ap.parse_args()

    os.makedirs(args.wavs, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.shards, "*.parquet")))
    if not files:
        print(f"[fail] no *.parquet under {args.shards}")
        sys.exit(2)

    manifest = open(args.manifest, "w", encoding="utf-8")
    n = 0
    for nf, pf in enumerate(files, 1):
        t = pq.read_table(pf)
        cols = t.column_names
        need = {"transcription", "id", "audio"}
        missing = need - set(cols)
        if missing:
            print(f"  [skip] {os.path.basename(pf)} missing {missing}")
            continue
        print(f"[{nf}/{len(files)}] {os.path.basename(pf)} rows={t.num_rows}")
        for row in t.to_pylist():
            if args.max_rows and n >= args.max_rows:
                manifest.close()
                print(f"[done] {n} rows")
                return
            text = (row.get("transcription") or "").strip()
            if not text:
                continue
            text = " ".join(text.split())
            audio = row.get("audio") or {}
            raw = audio.get("bytes")
            if not raw:
                continue
            try:
                y, a_sr = decode_audio(raw)
                x = resample_f32(y, a_sr, args.sample_rate)
            except Exception:
                continue
            if len(x) < args.sample_rate:  # <1s of audio — skip
                continue
            ident = str(row.get("id", f"row{n}"))
            wav = os.path.join(args.wavs, f"{ident}.wav")
            wav_write(wav, (x * 32767).astype("<i2").tobytes(), args.sample_rate)
            manifest.write(f"{wav}\t{row.get('speaker_id','')}\t{text}\n")
            n += 1
    manifest.close()
    print(f"[done] {n} rows -> {args.manifest}")


if __name__ == "__main__":
    main()