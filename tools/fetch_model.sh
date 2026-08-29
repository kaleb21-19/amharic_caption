#!/usr/bin/env bash
#
# fetch_model.sh
#
# Downloads the fp32 source model (badrex/Ethio-ASR-amharic) from Hugging Face
# into ./ethio-asr so it can be bundled or converted to fp16. CI has no local
# copy of the model, so this is the canonical way to obtain it.
#
#   PYTHON_BIN=python3 tools/fetch_model.sh
#     (PYTHON_BIN must have transformers + huggingface_hub)
#
# Set HF_MODEL to override the source repo id.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${ROOT}/ethio-asr"
REPO="${HF_MODEL:-badrex/Ethio-ASR-amharic}"
PY="${PYTHON_BIN:-python3}"

if [[ -f "$DST/config.json" && -f "$DST/model.safetensors" ]]; then
  echo "[skip] model already present at $DST"
  exit 0
fi

"$PY" -c "import huggingface_hub" 2>/dev/null || {
  echo "[FAIL] PYTHON_BIN needs huggingface_hub: $PY"; exit 1
}

echo "[info] downloading $REPO -> $DST"
mkdir -p "$DST"
"$PY" - "$REPO" "$DST" <<'PY'
import sys
from huggingface_hub import snapshot_download

repo, dst = sys.argv[1], sys.argv[2]
out = snapshot_download(repo_id=repo, local_dir=dst, local_dir_use_symlinks=False)
print("[ok] downloaded model:", out)
PY

if [[ ! -f "$DST/config.json" ]]; then
  echo "[FAIL] model download incomplete: $DST"; exit 1
fi
echo "== model ready: $(du -sh "$DST" | cut -f1) =="
