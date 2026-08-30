#!/usr/bin/env bash
#
# build.sh <target>
#
# Assembles the self-contained runtime for ONE target and zips the whole
# extension into dist/.   This step is PLATFORM-INDEPENDENT: it only copies
# pre-staged per-target artifacts, so it can run on any machine.
#
#   Targets:  mac-arm64 | mac-x64 | win-x64
#
# Staged inputs (must already exist — see tools/prepare_python.sh):
#   tools/stage/<target>/ffmpeg[.exe]     static ffmpeg for the target
#   tools/stage/<target>/python/          self-contained Python + ML deps
#
# The model (~/Documents/amharic-captions/ethio-asr) is bundled in automatically.
#
# Output:
#   dist/amharic-captions-<target>.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${ROOT}/tools/stage"
DIST="${ROOT}/dist"
NAME="com.amharic.captions"

TARGET="${1:-}"
case "$TARGET" in
  mac-arm64) FFSUFFIX="ffmpeg";     PYEXE="python/bin/python3";;
  mac-x64)   FFSUFFIX="ffmpeg";     PYEXE="python/bin/python3";;
  win-x64)   FFSUFFIX="ffmpeg.exe"; PYEXE="python/python.exe";;
  *) echo "usage: $0 <mac-arm64|mac-x64|win-x64>"; exit 1;;
esac

mkdir -p "$DIST"

# ---- 1. build the runtime into a staging copy of the extension -------------
BUILD_DIR="$(mktemp -d)"
RT="${BUILD_DIR}/${NAME}/runtime"
mkdir -p "${BUILD_DIR}/${NAME}" "$RT/bin" "$RT/python"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "== building runtime for: $TARGET =="

# ethio_srt.py + standalone numpy mel extractor
cp "$ROOT/ethio_srt.py" "$RT/ethio_srt.py"
cp "$ROOT/amh_mel.py" "$RT/amh_mel.py"
echo "  [ok] ethio_srt.py + amh_mel.py"

# model — prefer the CTranslate2 INT8 model (tools/make_model_ct2_int8.sh):
# ~600MB, no torch/transformers at runtime. Dev fallback: fp16/fp32.
if [[ -d "$ROOT/tools/stage/model-ct2-int8" && -f "$ROOT/tools/stage/model-ct2-int8/model_meta.json" ]]; then
  MODEL_SRC="$ROOT/tools/stage/model-ct2-int8"
  echo "  [model] CTranslate2 int8"
elif [[ -d "$ROOT/tools/stage/model-fp16" && -f "$ROOT/tools/stage/model-fp16/config.json" ]]; then
  MODEL_SRC="$ROOT/tools/stage/model-fp16"
  echo "  [model] fp16 source"
elif [[ -d "$ROOT/ethio-asr" && -f "$ROOT/ethio-asr/config.json" ]]; then
  MODEL_SRC="$ROOT/ethio-asr"
  echo "  [model] fp32 source"
else
  echo "  [FAIL] no model found (tools/stage/model-ct2-int8, model-fp16, or ethio-asr)"; exit 1
fi
mkdir -p "$RT/model"
cp -R "$MODEL_SRC/." "$RT/model/"
echo "  [ok] model ($(du -sh "$RT/model" | cut -f1))"

# ffmpeg
FF="${STAGE}/${TARGET}/${FFSUFFIX}"
if [[ -f "$FF" ]]; then
  cp "$FF" "$RT/bin/"
  echo "  [ok] ffmpeg ($(du -sh "$RT/bin" | cut -f1))"
else
  echo "  [FAIL] no static ffmpeg at $FF (run tools/prepare_python.sh or place it)"; exit 1
fi

# python
PY="${STAGE}/${TARGET}/python"
if [[ -d "$PY" ]]; then
  cp -R "$PY/." "$RT/python/"
  echo "  [ok] python ($(du -sh "$RT/python" | cut -f1))"
else
  echo "  [FAIL] no staged python at $PY (run tools/prepare_python.sh)"; exit 1
fi

# ---- 2. include the shared panel files ------------------------------------
# The small, cross-platform panel (same files for every target) lives in the
# project's panel/ folder. It is generated from the live CEP extension by
# tools/sync_panel.sh and committed/built from here so the build works the
# same on any OS (no machine-specific CEP path required).
PANEL_SRC="${ROOT}/panel"
if [[ ! -d "$PANEL_SRC" ]]; then
  echo "  [FAIL] shared panel not found at $PANEL_SRC (run tools/sync_panel.sh)"; exit 1
fi
cp -R "$PANEL_SRC/." "${BUILD_DIR}/${NAME}/"
echo "  [ok] panel files"

echo "== runtime + panel staged (total $(du -sh "${BUILD_DIR}/${NAME}" | cut -f1)) =="

# ---- 3. zip it ------------------------------------------------------------
ZIP="${DIST}/amharic-captions-${TARGET}.zip"
rm -f "$ZIP"
(
  cd "$BUILD_DIR"
  zip -r -q "$ZIP" "$NAME" -x "*.DS_Store"
)
echo "== wrote $ZIP ($(du -sh "$ZIP" | cut -f1)) =="
