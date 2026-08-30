#!/usr/bin/env bash
#
# prepare_python.sh
#
# The PLATFORM-SPECIFIC step. Run this ON the target OS/arch so the production
# runtime matches that machine. It:
#   1. detects the current machine's target (mac-arm64 | mac-x64 | win-x64)
#   2. downloads a RELOCATABLE CPython (python-build-standalone) for that target
#   3. pip-installs the tiny ML runtime: ctranslate2 + numpy + soundfile (~50MB)
#   4. prunes pip/setuptools so they don't ship in the bundle
#   5. fetches a STATIC ffmpeg for that target
#   6. verifies the key imports load
#
# A system `python3 -m venv` is NOT used because macOS's system/Xcode python
# is not relocatable (its bin/python3 symlinks to /Applications/Xcode.app) and
# breaks when the bundle is installed elsewhere. python-build-standalone ships
# a self-contained interpreter with relative loader paths, so it runs from any
# directory — required for a drop-in CEP extension.
#
# After this, run tools/build.sh <target> to assemble + zip the extension.
#
#   macOS:   bash tools/prepare_python.sh
#   Windows: run under Git-Bash / WSL bash (same script)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${ROOT}/tools/stage"

PBS_RELEASE="20260825"
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}"

# ---- 1. detect target + pick the matching relocatable python ---------------
# AMH_TARGET can override auto-detection so a target can be prepped cross-host
# (e.g. building mac-x64 on Apple Silicon via Rosetta when running x86_64, or
# staging the Windows runtime from a Mac). Choose deliberately; you cannot run
# the target runtime unless you are (or can execute) that OS/arch.
ON_HOST_OS="$(uname -s)"
if [[ -n "${AMH_TARGET:-}" ]]; then
  case "$AMH_TARGET" in
    mac-arm64) OS="Darwin"; ARCH="arm64";;
    mac-x64)   OS="Darwin"; ARCH="x86_64";;
    win-x64)   OS="MINGW"; ARCH="x86_64";;   # fake a Win-like detection
    *) echo "unsupported AMH_TARGET: $AMH_TARGET"; exit 1;;
  esac
else
  OS="$ON_HOST_OS"
  ARCH="$(uname -m)"
fi
# True only if we are ACTUALLY running on the target OS (not cross-staging).
case "$ON_HOST_OS" in
  MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=1;;
  *) ON_WINDOWS=0;;
esac
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)
        TARGET="mac-arm64"
        PBS_VARIANT="aarch64-apple-darwin";;
      x86_64)
        TARGET="mac-x64"
        PBS_VARIANT="x86_64-apple-darwin";;
      *) echo "unsupported Mac arch: $ARCH"; exit 1;;
    esac
    FFURL_BASE="https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip"; FFNAME="ffmpeg";;
  MINGW*|MSYS*|CYGWIN*)
    TARGET="win-x64"
    PBS_VARIANT="x86_64-pc-windows-msvc"
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

# ---- 2. download relocatable CPython --------------------------------------
PBS_NAME="cpython-3.11.16+${PBS_RELEASE}-${PBS_VARIANT}-install_only_stripped"
PBS_URL="${PBS_BASE}/${PBS_NAME}.tar.gz"
echo "  [step] downloading relocatable CPython ($PBS_NAME ~27MB)"
TMP="$(mktemp -d)"
curl -sL "$PBS_URL" -o "$TMP/py.tar.gz"
tar -xzf "$TMP/py.tar.gz" -C "$TMP"
mv "$TMP/python" "$PYDIR"
rm -rf "$TMP"
echo "  [ok] python at $PYDIR ($(du -sh "$PYDIR" | cut -f1))"

if [[ "$TARGET" == "win-x64" ]]; then
  PY="$PYDIR/python.exe"
else
  PY="$PYDIR/bin/python3"
fi

# ---- 3. install the tiny ML runtime ---------------------------------------
echo "  [step] installing deps (ctranslate2 + numpy + soundfile, ~50MB)"
if [[ "$TARGET" == "win-x64" && "$ON_WINDOWS" == "0" ]]; then
  # Cross-staging from a non-Windows host: we cannot execute python.exe, so
  # fetch the win_amd64 wheels and unpack them straight into site-packages.
  XTMP="$(mktemp -d)"
  "$ROOT/.venv/bin/python" -m pip download \
      --platform win_amd64 --only-binary=:all: \
      --python-version 311 --implementation cp --abi cp311 \
      "ctranslate2==4.8.1" "numpy" "soundfile" "cffi" "pycparser" \
      -d "$XTMP" -q
  SPW="${PYDIR}/Lib/site-packages"
  for w in "$XTMP"/*.whl; do
    (cd "$SPW" && unzip -o -q "$w")
  done
  rm -rf "$XTMP"
  echo "  [ok] cross-staged win_amd64 wheels (NOT runtime-verified here)"
else
  "$PY" -m pip install --quiet ctranslate2==4.8.1 numpy soundfile
  echo "  [ok] deps installed"
fi

# ---- 4. prune pip/setuptools (not needed at runtime) -----------------------
SP="${PYDIR}/lib/python3.11/site-packages"
[[ "$TARGET" == "win-x64" ]] && SP="${PYDIR}/Lib/site-packages"
if [[ -d "$SP" ]]; then
  echo "  [step] pruning pip/setuptools"
  cd "$SP"
  rm -rf pip pip-*.dist-info setuptools setuptools-*.dist-info 2>/dev/null || true
  cd "$ROOT"
fi

# ---- 5. static ffmpeg -------------------------------------------------------
FF="${TARGET_DIR}/${FFNAME}"
if [[ ! -f "$FF" ]]; then
  echo "  [step] fetching static ffmpeg for $TARGET"
  TMP="$(mktemp -d)"
  case "$TARGET" in
    mac-*)
      curl -sL "$FFURL_BASE" -o "$TMP/ff.zip"
      unzip -o -q "$TMP/ff.zip" -d "$TMP" 'ffmpeg' 2>/dev/null || true
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

# ---- 6. verify --------------------------------------------------------------
if [[ "$TARGET" == "win-x64" && "$ON_WINDOWS" == "0" ]]; then
  echo "  [step] skipping import check (cross-staged from non-Windows host;"
  echo "         cannot execute python.exe here — verify on a real Windows PC)"
else
  echo "  [step] verifying imports"
  PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")"
  "$PY" -c "import ctranslate2, numpy, soundfile; print('      core imports OK')"
fi
echo
echo "== prepared $TARGET =="
echo "  python: $PYDIR  ($(du -sh "$PYDIR" | cut -f1))"
echo "  ffmpeg: $FF"
echo "  next:   bash tools/build.sh ${TARGET}"
