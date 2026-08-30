#!/usr/bin/env bash
#
# make_model_ct2_int8.sh
#
# Converts the fp32 source model (ethio-asr) into a CTranslate2 INT8 model at
# tools/stage/model-ct2-int8, alongside the standalone inference assets the
# runtime needs (numpy mel filter bank + window + HF vocab). Shipping CT2 int8
# lets the runtime drop torch/transformers entirely (~1.7GB -> ~50MB).
#
# Requires the dev venv (transformers + torch + ctranslate2 + scipy). Run from
# the repo root:
#   tools/make_model_ct2_int8.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/ethio-asr"
DST="${ROOT}/tools/stage/model-ct2-int8"

DEV_PY="${ROOT}/.venv/bin/python"
if [[ -x "$DEV_PY" ]]; then
  PY="${PYTHON_BIN:-$DEV_PY}"
else
  PY="${PYTHON_BIN:-python3}"
fi

if [[ ! -f "$SRC/config.json" ]]; then
  echo "[FAIL] fp32 source model not found at $SRC"; exit 1
fi
"$PY" -c "import ctranslate2, transformers, scipy, numpy, torch" 2>/dev/null || {
  echo "[FAIL] python needs ctranslate2+transformers+scipy+numpy+torch: $PY"; exit 1
}
echo "[info] using python: $PY"

"$PY" - "$SRC" "$DST" <<'PY'
import json, os, sys, shutil, warnings
warnings.filterwarnings("ignore")
import ctranslate2
import numpy as np

src, dst = sys.argv[1], sys.argv[2]

# ---------- 1. CTranslate2 int8 conversion -------------------------------
print("[1/3] converting to CTranslate2 int8 ...")
tmp = dst + ".tmp"
if os.path.exists(tmp):
    shutil.rmtree(tmp)
converter = ctranslate2.converters.TransformersConverter(
    src,
    copy_files=["preprocessor_config.json"],
)
converter.convert(tmp, quantization="int8", force=True)

os.makedirs(dst, exist_ok=True)
for f in os.listdir(tmp):
    shutil.move(os.path.join(tmp, f), os.path.join(dst, f))
shutil.rmtree(tmp, ignore_errors=True)

# ---------- 2. standalone mel assets (numpy, no transformers at runtime) --
print("[2/3] generating numpy mel filterbank + window ...")
from transformers import AutoFeatureExtractor
fe = AutoFeatureExtractor.from_pretrained(src)
mel_filters = np.asarray(fe.mel_filters, dtype=np.float32)
window = np.asarray(fe.window, dtype=np.float32)
np.save(os.path.join(dst, "mel_filters.npy"), mel_filters)
np.save(os.path.join(dst, "window.npy"), window)
print("    mel_filters", mel_filters.shape, "window", window.shape)

# HF vocab (id<->token) for the standalone decoder + alignment.
shutil.copy(os.path.join(src, "vocab.json"), os.path.join(dst, "vocab.json"))

# ---------- 3. write a marker + config ------------------------------------
print("[3/3] writing model metadata ...")
with open(os.path.join(dst, "model_meta.json"), "w") as f:
    json.dump({
        "engine": "ctranslate2",
        "compute_type": "int8",
        "blank_id": 408,          # [PAD] in the HF vocab (CTC blank)
        "sample_rate": 16000,
    }, f, indent=2)

# vocab size marker (CT2 model has vocabulary.json + lm_head)
print("[ok] CT2 int8 model written to", dst)
print("     size:", round(sum(
    os.path.getsize(os.path.join(dp, fn))
    for dp, _, fns in os.walk(dst) for fn in fns) / 1e6), "MB")
PY

echo "== done: $(du -sh "$DST" | cut -f1) =="
