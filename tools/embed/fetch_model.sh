#!/usr/bin/env bash
#
# fetch_model.sh
#
# Downloads the speaker-embedding model used for 2-speaker (interview) labels.
# It is NOT committed (40MB); run this once before building or running the
# diarization tests. Safe to re-run — a correct file is left untouched.
#
#   bash tools/embed/fetch_model.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${ROOT}/tools/embed/nemo_en_titanet_small.onnx"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
SIZE=40257283
SHA="ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e"

if [[ -f "$DEST" ]]; then
  have=$(stat -f%z "$DEST" 2>/dev/null || stat -c%s "$DEST")
  if [[ "$have" == "$SIZE" ]]; then
    echo "[ok] model already present: $DEST"
    exit 0
  fi
  echo "[step] size mismatch ($have != $SIZE) — re-fetching"
fi

echo "[step] downloading speaker embedding model (~40MB)"
mkdir -p "$(dirname "$DEST")"
curl -L --fail -C - -o "$DEST" "$URL"

have=$(stat -f%z "$DEST" 2>/dev/null || stat -c%s "$DEST")
if [[ "$have" != "$SIZE" ]]; then
  echo "[FAIL] bad size: got $have, expected $SIZE"; exit 1
fi
got=$(shasum -a 256 "$DEST" | awk '{print $1}')
if [[ "$got" != "$SHA" ]]; then
  echo "[FAIL] sha256 mismatch: got $got"; exit 1
fi
echo "[ok] $DEST"
