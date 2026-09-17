#!/usr/bin/env bash
#
# run_all.sh — ONE command to run the entire MUSAN/WAXAL retrain pipeline on a
# cloud GPU box. Everything is offline afterwards: it only produces the new
# CTranslate2 INT8 model that build.sh packages into the extension. Nothing in
# this script is needed by end users at runtime.
#
# Exit codes:
#   0  new model built AND passed the WER gate (>= as good as current)
#   1  something failed, OR the retrained model regressed on WER (current
#      production model is left untouched either way)
#
# Usage (from repo root, in the dev venv):
#   bash tools/retrain/run_all.sh --wx /data/waxal --musan /data/musan
#
# Flags:
#   --wx DIR        waxal parquet + wavs cache dir (default tools/stage/waxal)
#   --musan DIR     MUSAN corpus root (optional; enables on-the-fly mixing)
#   --max-shards N  fetch only first N train shards (quick runs; default all)
#   --zap-etag      unused/reserved (fetch script has no etag confusion)
#   --steps N       cap fine-tune steps (smoke); default full epochs
#   --freeze-only   freeze encoder (face), keep CTC head trainable
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WX="tools/stage/waxal"
MUSAN=""
MAX_SHARDS=""
STEPS=""
FREEZE="--freeze-encoder"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wx) WX="$2"; shift 2;;
    --musan) MUSAN="$2"; shift 2;;
    --max-shards) MAX_SHARDS="$2"; shift 2;;
    --steps) STEPS="$2"; shift 2;;
    --no-freeze) FREEZE=""; shift;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done

PY="${ROOT}/.venv/bin/python"
command -v nvidia-smi >/dev/null 2>&1 && echo "[info] CUDA GPU detected" \
  || { echo "[warn] no nvidia-smi — fine-tune will run on MPS/CPU (slow)"; }

MANIFEST="${ROOT}/${WX}/manifest.tsv"
DEV_MANIFEST="${ROOT}/${WX}/dev.tsv"

echo "== [1/5] fetch WAXAL Amharic ASR parquets =="
shards=()
if [[ -n "$MAX_SHARDS" ]]; then shards+=(--max-shards "$MAX_SHARDS"); fi
"$PY" tools/retrain/01_fetch_waxal.py --out "${ROOT}/$WX" "${shards[@]}"

echo "== [2/5] prep manifest + wavs (train + a held-out dev slice) =="
"$PY" tools/retrain/02_prep_waxal.py --shards "${ROOT}/$WX" \
    --wavs "${ROOT}/$WX/wavs" --manifest "$MANIFEST"
# carve out the last 5% of the manifest as the eval set
"$PY" - "$MANIFEST" "$DEV_MANIFEST" <<'PY'
import sys
rows = open(sys.argv[1], encoding="utf-8").read().splitlines()
n = max(1, len(rows) // 20)
dev, keep = rows[-n:], rows[:-n]
open(sys.argv[1], "w", encoding="utf-8").write("\n".join(keep) + "\n")
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(dev) + "\n")
print(f"[split] train={len(keep)} dev={len(dev)} -> {sys.argv[2]}")
PY

echo "== [3/5] WER baseline of CURRENT model on the dev slice =="
"$PY" tools/retrain/04_eval_wer.py --manifest "$DEV_MANIFEST" \
    --candidate ethio-asr || true

echo "== [4/5] fine-tune retrained checkpoint =="
steps_flag=()
[[ -n "$STEPS" ]] && steps_flag+=(--max-steps "$STEPS")
musan_flag=()
[[ -n "$MUSAN" ]] && musan_flag+=(--musan "$MUSAN")
"$PY" tools/retrain/03_finetune_waxal.py --manifest "$MANIFEST" \
    --src ethio-asr --out "${ROOT}/tools/stage/model-retrained" \
    $FREEZE ${steps_flag[@]} ${musan_flag[@]}

echo "== [5/5] build CT2 int8 for the retrained model + WER gate =="
MODEL_SRC="${ROOT}/tools/stage/model-retrained" \
MODEL_DST="${ROOT}/tools/stage/model-ct2-int8-retrain" \
    bash tools/make_model_ct2_int8.sh
"$PY" tools/retrain/04_eval_wer.py --manifest "$DEV_MANIFEST" \
    --current ethio-asr --candidate "${ROOT}/tools/stage/model-retrained"
rc=$?

if [[ $rc -eq 0 ]]; then
  echo
  echo ">>> RETRAINED MODEL PASSED — swap it in:"
  echo "    rm -rf tools/stage/model-ct2-int8"
  echo "    mv tools/stage/model-ct2-int8-retrain tools/stage/model-ct2-int8"
  echo "    bash tools/build.sh <target>   # or the manual runtime copy + bump"
else
  echo
  echo ">>> RETRAIN FAILED WER — current model kept; delete model-ct2-int8-retrain."
fi
exit $rc