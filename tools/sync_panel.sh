#!/usr/bin/env bash
#
# sync_panel.sh
# Copies the live, working CEP extension's PANEL files (the small cross-platform
# part — not the big runtime/) into the project's panel/ folder. panel/ is the
# canonical shared source used by tools/build.sh for every target zip.
#
# Runtime (python, ffmpeg, model) is NOT synced — that is per-platform and is
# handled by tools/prepare_python.sh + tools/build.sh.
#
# Only run on a machine where Premiere has the extension installed.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="${HOME}/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions"
PANEL="${ROOT}/panel"

if [[ ! -d "$EXT" ]]; then
  echo "  [FAIL] CEP extension not found at $EXT (is Premiere installed?)"; exit 1
fi

rm -rf "$PANEL"
mkdir -p "$PANEL"
cp -R "$EXT/CSXS" "$EXT/index.html" "$EXT/js" "$EXT/jsx" "$PANEL/"

echo "  [ok] synced panel from: $EXT"
echo "       -> $PANEL"
