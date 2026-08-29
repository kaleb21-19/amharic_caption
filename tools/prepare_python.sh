#!/usr/bin/env bash
#
# prepare_python.sh
#
# The PLATFORM-SPECIFIC step. Run this ON the target OS/arch so the production
# runtime matches that machine. It:
#   1. detects the current machine's target (mac-arm64 | mac-x64 | win-x64)
#   2. builds a fresh venv with the ML deps
#   3. prunes the dead-weight packages that CTC inference never imports
#   4. fetches a STATIC ffmpeg for that target
#   5. verifies the key imports load
#
# After this, run tools/build.sh <target> to assemble + zip the extension.
#
#   macOS:   bash tools/prepare_python.sh
#   Windows: run under Git-Bash / WSL bash (same script)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${ROOT}/tools/stage"

# ---- 1. detect target -----------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) TARGET="mac-arm64";;
      x86_64) TARGET="mac-x64";;
      *) echo "unsupported Mac arch: $ARCH"; exit 1;;
    esac
    PY_BIN="python3"
    FFURL_BASE="https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip"; FFNAME="ffmpeg";;
  MINGW*|MSYS*|CYGWIN*)
    TARGET="win-x64"
    PY_BIN="py"      # python launcher on Windows
    FFURL_BASE="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    FFNAME="ffmpeg.exe";;
  *)
    echo "unsupported OS: $OS (expected macOS or Windows)"; exit 1;;
esac

echo "== preparing runtime for target: $TARGET =="
TARGET_DIR="${STAGE}/${TARGET}"
PYDIR="${TARGET_DIR}/python"
mkdir -p "$TARGET_DIR"
rm -rf "$PYDIR"

# ---- 2. build venv + deps ------------------------------------------------
echo "  [step] creating python venv + installing deps (this downloads ~1GB)"
if [[ "$TARGET" == "win-x64" ]]; then
  "$PY_BIN" -m venv "$PYDIR"
  PY="$PYDIR/Scripts/python.exe"
else
  "$PY_BIN" -m venv "$PYDIR"
  PY="$PYDIR/bin/python"
fi
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet torch transformers soundfile numpy
echo "  [ok] deps installed"

# ---- 3. prune dead-weight packages ---------------------------------------
SP="${PYDIR}/lib/python3.11/site-packages"
# Windows venv uses Lib/site-packages; Mac uses lib/pythonX.Y/site-packages
if [[ "$TARGET" == "win-x64" ]]; then
  SP="$PYDIR/Lib/site-packages"
fi
if [[ -d "$SP" ]]; then
  echo "  [step] pruning unused packages (scipy, sklearn, numba, llvmlite, torchaudio)"
  # NOTE: keep sympy/mpmath/networkx — torch.fx (used by transformers) needs them.
  cd "$SP"
  rm -rf scipy scipy-*.dist-info \
         sklearn scikit_learn-*.dist-info scikit-learn-*.dist-info \
         numba numba-*.dist-info llvmlite llvmlite-*.dist-info \
         torchaudio torchaudio-*.dist-info 2>/dev/null || true
  cd "$ROOT"
fi

# ---- 4. static ffmpeg ------------------------------------------------------
FF="${TARGET_DIR}/${FFNAME}"
if [[ ! -f "$FF" ]]; then
  echo "  [step] fetching static ffmpeg for $TARGET"
  TMP="$(mktemp -d)"
  case "$TARGET" in
    mac-*)
      curl -sL "$FFURL_BASE" -o "$TMP/ff.zip"
      unzip -o -q "$TMP/ff.zip" -d "$TMP" 'ffmpeg' 2>/dev/null || true
      find "$TMP" -type f -name 'ffmpeg' -o -name 'ffmpeg*' | head -1 >/dev/null
      FOUND="$(find "$TMP" -type f -name 'ffmpeg' -perm -111 | head -1)"
      [[ -z "$FOUND" ]] && FOUND="$(find "$TMP" -type f -name 'ffmpeg*' | head -1)"
      cp "$FOUND" "$FF";;
    win-x64)
      curl -sL "$FFURL_BASE" -o "$TMP/ff.zip"
      unzip -o -q "$TMP/ff.zip" -d "$TMP"
      FOUND="$(find "$TMP" -type f -name 'ffmpeg.exe' | head -1)"
      cp "$FOUND" "$FF";;
  esac
  rm -rf "$TMP"
else
  echo "  [ok] ffmpeg already staged at $FF"
fi

echo "  [ok] ffmpeg ($(du -sh "$FF" | cut -f1))"

# ---- 5. verify -------------------------------------------------------------
echo "  [step] verifying imports"
"$PY" -c "import torch, transformers, soundfile, numpy; print('      core imports OK')"
echo
echo "== prepared $TARGET =="
echo "  python: $PYDIR  ($(du -sh "$PYDIR" | cut -f1))"
echo "  ffmpeg: $FF"
echo "  next:   bash tools/build.sh ${TARGET}"
