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
# Pin the source model revision. A moving `main` download makes a supposedly
# immutable per-commit CT2 release non-reproducible.
REVISION="${HF_REVISION:-edda1ab0af0d3cca4f4a6fd0b17ef3726bcce12a}"
PY="${PYTHON_BIN:-python3}"

REVISION_FILE="$DST/.hf_revision"
if [[ -f "$DST/config.json" && -f "$DST/model.safetensors" ]]; then
  have_revision="$(cat "$REVISION_FILE" 2>/dev/null || true)"
  if [[ "$have_revision" == "$REVISION" ]]; then
    echo "[skip] model already present at $DST (revision $REVISION)"
    exit 0
  fi
  echo "[step] replacing cached model with pinned revision $REVISION"
  rm -rf "$DST"
fi

"$PY" -c "import huggingface_hub" 2>/dev/null || {
  echo "[FAIL] PYTHON_BIN needs huggingface_hub: $PY"; exit 1
}

echo "[info] downloading $REPO -> $DST"
mkdir -p "$DST"
"$PY" - "$REPO" "$DST" "$REVISION" <<'PY'
import sys
from huggingface_hub import snapshot_download

repo, dst, revision = sys.argv[1], sys.argv[2], sys.argv[3]
out = snapshot_download(repo_id=repo, revision=revision, local_dir=dst, local_dir_use_symlinks=False)
print("[ok] downloaded model:", out)
PY

if [[ ! -f "$DST/config.json" ]]; then
  echo "[FAIL] model download incomplete: $DST"; exit 1
fi
printf '%s\n' "$REVISION" > "$REVISION_FILE"
echo "== model ready: $(du -sh "$DST" | cut -f1) (revision $REVISION) =="
