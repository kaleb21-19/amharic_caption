# MUSAN / WAXAL retrain pipeline (offline product, cloud dev)

`tools/retrain/` retrains the Amharic CTC model with MUSAN noise-robust data
so it stops transcribing background music / noise as Amharic. **This has zero
effect on the shipped product's offline requirement** — the pipeline only runs
during development and produces the same CTranslate2 INT8 model file the build
packages today. End users never need internet.

## Hardware

- Full run: any CUDA GPU with ≥16 GB VRAM (A10G, L4, 4090, A100…). On a
  single A10G, fine-tune of just the CTC head over a few WAXAL Amharic shards
  is a matter of hours.
- Laptop (MPS/CPU): works but slow — use `--steps 3` for a smoke test.
- Storage: the full Amharic ASR split is ~10 GB of parquet; prep writes one
  .wav per row (<10 GB after validation). Keep ~30 GB free.

## Install (one-time, on the dev box)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -U torch torchaudio transformers pyarrow pandas soundfile ctranslate2
```

## Run the whole thing

```bash
bash tools/retrain/run_all.sh --wx tools/stage/waxal --musan /data/musan
```

Wrapping flags:

| flag | meaning |
|---|---|
| `--wx DIR` | waxal cache dir (parquet + wavs + manifest) |
| `--musan DIR` | MUSAN corpus root for on-the-fly noise/music mixing (optional) |
| `--max-shards N` | fetch only the first N train shards (fast smoke) |
| `--steps N` | cap fine-tune steps (smoke override) |
| `--no-freeze` | fine-tune the whole model, not just the CTC head |

The runner:
1. fetches the WAXAL Amharic ASR parquets (`amh_asr` config; ~490 MB/shard)
2. decodes rows to 16 kHz wavs + a `manifest.tsv` (`path\tid\ttext`), carving a
   held-out dev slice for the WER gate
3. baseline-WERs the **current** model on that dev slice
4. fine-tunes `tools/stage/model-retrained` (freeze encoder by default; MUSAN
   db/nos mix happens per-batch if `--musan` is given)
5. builds `tools/stage/model-ct2-int8-retrain` with the same converter used by
   the current build, then WER-gates the retrained model.

**A retrain NEVER replaces the current model automatically.** If WER is better,
it prints the swap commands (`mv` the ct2 dir, re-run `tools/build.sh`). If
WER regresses, it exits 1 and the current model stays put.

## Kaggle path (no GPU machine, free)

`kaggle/waxal_retrain.ipynb` runs the *same* pipeline on a free Kaggle T4 GPU
session — clone the public repo, pull a few WAXAL shards (fast from HF on
Kaggle), fine-tune the CTC head, WER-gate current-vs-retrained on a held-out
slice, and export CTranslate2 int8. Import it on kaggle.com, edit the CONFIG
cell, run all cells. Download `retrain_output.zip`, then:

```bash
rm -rf tools/stage/model-ct2-int8
cp -R bundle/model-ct2-int8-retrain tools/stage/model-ct2-int8
bash tools/build.sh mac-arm64   # then mac-x64, win-x64
```

Re-run the honest fixture set (the 40 clips that gave WER 0.227) before keeping
the swap — the notebook's gate is only the relative current-vs-retrained call.

## Manual steps if you don't use run_all.sh

```bash
# 1 — fetch (discovery mode to see sizes: add --list-only)
python3 tools/retrain/01_fetch_waxal.py --out tools/stage/waxal

# 2 — prep (a few shards for a smoke: --max-rows 200)
python3 tools/retrain/02_prep_waxal.py --shards tools/stage/waxal \
    --wavs tools/stage/waxal/wavs --manifest tools/stage/waxal/manifest.tsv

# 3 — fine-tune
python3 tools/retrain/03_finetune_waxal.py \
    --manifest tools/stage/waxal/manifest.tsv \
    --src ethio-asr --out tools/stage/model-retrained \
    --freeze-encoder --epochs 3 --batch-size 8 --lr 3e-4

# 4 — WER gate (also prints the baseline if you pass --candidate ethio-asr)
python3 tools/retrain/04_eval_wer.py \
    --manifest tools/stage/waxal/dev.tsv \
    --current ethio-asr --candidate tools/stage/model-retrained

# 5 — CT2 int8 (parameterized conversion; works with any HF checkpoint)
MODEL_SRC=tools/stage/model-retrained \
MODEL_DST=tools/stage/model-ct2-int8-retrain \
    bash tools/make_model_ct2_int8.sh
```

## Where each piece lives

| path | role |
|---|---|
| `tools/retrain/01_fetch_waxal.py` | chunked-range HF downloader (survives drops) |
| `tools/retrain/02_prep_waxal.py` | parquet → 16 kHz wavs + manifest |
| `tools/retrain/03_finetune_waxal.py` | CTC fine-tune (MPS/CUDA/CPU-safe loss) |
| `tools/retrain/04_eval_wer.py` | WER gate; exits nonzero on regression |
| `tools/retrain/run_all.sh` | end-to-end orchestrator |
| `tools/retrain/kaggle/waxal_retrain.ipynb` | same pipeline as a free-Kaggle notebook |
| `tools/make_model_ct2_int8.sh` | conversion (`MODEL_SRC` / `MODEL_DST` overridable) |

## About the data, honestly

- The current `badrex/Ethio-ASR-amharic` model was fine-tuned on the WAXAL
  Amharic subset; WAXAL is *the* right source to continue from (same domain,
  licensed CC-BY). A handful of its hundreds of hours already massively enlarges
  the vocabulary and the space of glued/compound words the word-LM can rescue.
- The two anchor glue-cases (`አሀይድጠብቁኝ`, `በቀሎበሪማች`) are covered by
  `amh_correct.SPLIT_FIXES` today; retraining does *not* remove those fixes —
  it only widens the real acoustic coverage underneath them.
- MUSAN mixing trains the model on speech-over-music at random SNRs, which is
  the fix for the "bread commercial" / TikTok background-music failures. If you
  point `--musan` at a MUSAN corpus root, tracks are mixed at `snr in (-2,8) dB`
  per batch.