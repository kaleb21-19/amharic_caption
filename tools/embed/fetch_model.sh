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
# Portable across macOS (BSD tools), Linux, and Windows Git Bash.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${ROOT}/tools/embed/nemo_en_titanet_small.onnx"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
SIZE=40257283
SHA="ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e"


# Byte count that works on BSD/macOS, GNU/Linux AND Git Bash: `wc -c < file`
# prints only the number; strip any whitespace.
size_of() {
  wc -c < "$1" | tr -d '[:space:]'
}

sha_of() {
  # `shasum` exists on macOS but is absent from many Git Bash installs, where
  # GNU sha256sum is the standard tool; pick whichever is available.
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

if [[ -f "$DEST" ]]; then
  have=$(size_of "$DEST")
  if [[ "$have" == "$SIZE" ]]; then
    got_existing=$(sha_of "$DEST")
    if [[ "$got_existing" == "$SHA" ]]; then
      echo "[ok] model already present and verified: $DEST"
      exit 0
    fi
    echo "[step] existing model hash mismatch — re-fetching"
  else
    echo "[step] size mismatch ($have != $SIZE) — re-fetching"
  fi
fi

echo "[step] downloading speaker embedding model (~40MB)"
mkdir -p "$(dirname "$DEST")"
# Do not resume onto a known-corrupt file: a resumed wrong prefix can never
# become the pinned asset even when the upstream server supports ranges.
rm -f "$DEST"
curl -L --fail --retry 3 --retry-all-errors --retry-delay 4 --connect-timeout 30 --speed-time 120 --speed-limit 1024 -o "$DEST" "$URL"

have=$(size_of "$DEST")
if [[ "$have" != "$SIZE" ]]; then
  echo "[FAIL] bad size: got $have, expected $SIZE"; exit 1
fi
got=$(sha_of "$DEST")
if [[ "$got" != "$SHA" ]]; then
  echo "[FAIL] sha256 mismatch: got $got"; exit 1
fi
echo "[ok] $DEST"
