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
print("[2/4] generating numpy mel filterbank + window ...")
from transformers import AutoFeatureExtractor
fe = AutoFeatureExtractor.from_pretrained(src)
mel_filters = np.asarray(fe.mel_filters, dtype=np.float32)
window = np.asarray(fe.window, dtype=np.float32)
np.save(os.path.join(dst, "mel_filters.npy"), mel_filters)
np.save(os.path.join(dst, "window.npy"), window)
print("    mel_filters", mel_filters.shape, "window", window.shape)

# ---------- 3. lm_head projection weights -----------------------------------
# CTranslate2's Wav2Vec2Bert.encode() returns the CTC logits (411) on arm64 but
# the raw hidden states (1024) on x86_64/Windows. To decode correctly on every
# platform we always project through lm_head when the output dim is 1024, so we
# ship the projection matrix here.
print("[3/4] extracting lm_head projection weights ...")
from safetensors import safe_open
with safe_open(os.path.join(src, "model.safetensors"), framework="np") as f:
    lm_w = np.asarray(f.get_tensor("lm_head.weight"), dtype=np.float32)  # (411,1024)
    lm_b = np.asarray(f.get_tensor("lm_head.bias"), dtype=np.float32)    # (411,)
np.save(os.path.join(dst, "lm_head_w.npy"), lm_w)
np.save(os.path.join(dst, "lm_head_b.npy"), lm_b)
print("    lm_head_w", lm_w.shape, "lm_head_b", lm_b.shape, "vocab", lm_w.shape[0])
print("    (CT2 encode() returns 411 logits on arm64, 1024 hidden on x86_64;")
print("     runtime projects via lm_head whenever the last dim is 1024)")

# HF vocab (id<->token) for the standalone decoder + alignment.
shutil.copy(os.path.join(src, "vocab.json"), os.path.join(dst, "vocab.json"))

# ---------- 4. write a marker + config ------------------------------------
print("[4/4] writing model metadata ...")
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
