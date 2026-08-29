#!/usr/bin/env bash
#
# make_model_fp16.sh
#
# Builds the half-size fp16 model from the full fp32 source (ethio-asr) into
# tools/stage/model-fp16.  Shipping fp16 ~halves the bundle (2.3GB -> ~1.1GB)
# and the runtime applies .half() anyway, so accuracy is identical.
#
# Requires the dev venv (contains transformers + torch). Run from the repo root:
#   tools/make_model_fp16.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/ethio-asr"
DST="${ROOT}/tools/stage/model-fp16"
# Default to the dev venv if present, else use PYTHON_BIN (CI passes the staged
# runtime python which already bundles torch + transformers).
DEV_PY="${ROOT}/.venv/bin/python"
if [[ -x "$DEV_PY" ]]; then
  PY="${PYTHON_BIN:-$DEV_PY}"
else
  PY="${PYTHON_BIN:-python3}"
fi

if [[ ! -f "$SRC/config.json" ]]; then
  echo "[FAIL] fp32 source model not found at $SRC"; exit 1
fi
"$PY" -c "import torch, transformers" 2>/dev/null || {
  echo "[FAIL] python needs torch + transformers: $PY"; exit 1
}
echo "[info] using python: $PY"

"$PY" - "$SRC" "$DST" <<'PY'
import warnings, sys, os, shutil
warnings.filterwarnings("ignore")
from transformers import AutoModelForCTC

src, dst = sys.argv[1], sys.argv[2]
print("[info] loading fp32 from", src)
model = AutoModelForCTC.from_pretrained(src)
model = model.half()
model.eval()
os.makedirs(dst, exist_ok=True)
model.save_pretrained(dst)
for f in ("added_tokens.json", "merges.txt", "preprocessor_config.json",
          "special_tokens_map.json", "tokenizer_config.json", "vocab.json"):
    p = os.path.join(src, f)
    if os.path.isfile(p):
        shutil.copy(p, os.path.join(dst, f))
print("[ok] fp16 model written to", dst)
PY

echo "== done: $(du -sh "$DST" | cut -f1) =="
