#!/usr/bin/env bash
#
# prepare_python.sh
#
# The PLATFORM-SPECIFIC step. Run this ON the target OS/arch so the production
# runtime matches that machine. It:
#   1. detects the current machine's target (mac-arm64 | mac-x64 | win-x64)
#   2. downloads a RELOCATABLE CPython (python-build-standalone) for that target
#   3. pip-installs the tiny ML runtime: ctranslate2 + numpy + soundfile +
#      onnxruntime + sherpa-onnx (~120MB)
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
# FFURL_BASE is per-TARGET, never per-OS. A single Darwin-wide ffmpeg URL is
# what once put an x86_64 binary inside the Apple-Silicon bundle: both mac jobs
# run on the same macos-14 runner, so arch cannot be inferred from the host.
# FF_EXPECT_ARCH is asserted against the staged binary in step 5b below.
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)
        TARGET="mac-arm64"
        PBS_VARIANT="aarch64-apple-darwin"
        # osxexperts 7.1.1 arm64: --enable-gpl WITHOUT --enable-nonfree, and it
        # keeps libx264 + libass, which the burn-in filter chain needs. The
        # previous Darwin-wide evermeet URL served an x86_64 binary here.
        FFURL_BASE="${AMH_FFURL_MAC_ARM64:-https://www.osxexperts.net/ffmpeg711arm.zip}"
        FF_SHA256="${AMH_FFSHA_MAC_ARM64:-59e39a5cec2e5d2307ed079c53227a9181e64b87454ed4de998349e044bfdc70}"
        PY_SHA256_DEFAULT="a84adc050a29e0c7387c885ff13e6ac4b0027f9e841359e200d647313dbb5b03"
        FF_EXPECT_ARCH="arm64";;
      x86_64)
        TARGET="mac-x64"
        PBS_VARIANT="x86_64-apple-darwin"
        FFURL_BASE="${AMH_FFURL_MAC_X64:-https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip}"
        FF_SHA256="${AMH_FFSHA_MAC_X64:-5a1303c7babaffff3c32c141ff49c7f44bd3b3b3e7dcea992fd7d04b6558ef43}"
        PY_SHA256_DEFAULT="77bfa2b959edc0d653830f14f08ab8260156d4b5930368886d4e1c6a76f1d2d4"
        FF_EXPECT_ARCH="x86_64";;
      *) echo "unsupported Mac arch: $ARCH"; exit 1;;
    esac
    FFNAME="ffmpeg";;
  MINGW*|MSYS*|CYGWIN*)
    TARGET="win-x64"
    PBS_VARIANT="x86_64-pc-windows-msvc"
    FFURL_BASE="${AMH_FFURL_WIN_X64:-https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-24-14-14/ffmpeg-n8.1.3-win64-gpl-8.1.zip}"
    FF_SHA256="${AMH_FFSHA_WIN_X64:-7a7895e2e3b04e0b15f145dd349372451c88ff389bdbcdfd85a1992a10bb361a}"
    PY_SHA256_DEFAULT="f91242b07e318d2540f9da71162b92d494c39745abde9b994d7d906756453fc9"
    FF_EXPECT_ARCH="x86_64"
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
trap 'rm -rf "$TMP"' EXIT
# Atomic + verified: download to a temp dir, validate the gzip CRC (catches
# truncation/corruption before it overwrites the staged python), THEN move into
# place. A failed download never destroys a previously-good staging.
curl -fL --retry 3 --retry-all-errors --retry-delay 4 --connect-timeout 30 --speed-time 120 --speed-limit 1024 "$PBS_URL" -o "$TMP/py.tar.gz"
gzip -t "$TMP/py.tar.gz"
PY_SHA256="${AMH_PYTHON_SHA256:-$PY_SHA256_DEFAULT}"
if [[ -z "$PY_SHA256" || "$PY_SHA256" == "UNPINNED" ]]; then
  echo "  [FAIL] no pinned CPython SHA-256 for $TARGET (set AMH_PYTHON_SHA256 or use a reviewed pin)" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  PY_GOT="$(sha256sum "$TMP/py.tar.gz" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  PY_GOT="$(shasum -a 256 "$TMP/py.tar.gz" | awk '{print $1}')"
else
  echo "  [FAIL] no SHA-256 tool available for CPython verification" >&2
  exit 1
fi
[[ "$PY_GOT" == "$PY_SHA256" ]] || {
  echo "  [FAIL] CPython archive hash mismatch for $TARGET" >&2
  echo "         expected: $PY_SHA256" >&2
  echo "         actual:   $PY_GOT" >&2
  exit 1
}
echo "  [ok] CPython archive SHA-256 verified"
tar -xzf "$TMP/py.tar.gz" -C "$TMP"
mv "$TMP/python" "$PYDIR"
rm -rf "$TMP"
echo "  [ok] python at $PYDIR ($(du -sh "$PYDIR" | cut -f1))"

if [[ "$TARGET" == "win-x64" ]]; then
  PY="$PYDIR/python.exe"
else
  PY="$PYDIR/bin/python3"
fi

# Direct runtime dependencies are pinned. Transitive wheels are still selected
# by the package resolver, so release logs should archive the resulting
# `pip freeze` output when changing this list.
PY_DEPS=(
  "ctranslate2==4.8.1"
  "numpy==1.26.4"
  "soundfile==0.13.1"
  "cffi==1.17.1"
  "pycparser==2.22"
  "onnxruntime==1.20.1"
  "sherpa-onnx==1.13.8"
)

# ---- 3. install the tiny ML runtime ---------------------------------------
echo "  [step] installing deps (ctranslate2 + numpy + soundfile + onnxruntime + sherpa-onnx, ~120MB)"
if [[ "$TARGET" == "win-x64" && "$ON_WINDOWS" == "0" ]]; then
  # Cross-staging from a non-Windows host: we cannot execute python.exe, so
  # fetch the win_amd64 wheels and unpack them straight into site-packages.
  XTMP="$(mktemp -d)"
  "$ROOT/.venv/bin/python" -m pip download \
      --platform win_amd64 --only-binary=:all: \
      --python-version 311 --implementation cp --abi cp311 \
      "${PY_DEPS[@]}" \
      -d "$XTMP" -q
  SPW="${PYDIR}/Lib/site-packages"
  for w in "$XTMP"/*.whl; do
    (cd "$SPW" && unzip -o -q "$w")
  done
  rm -rf "$XTMP"
  echo "  [ok] cross-staged win_amd64 wheels (NOT runtime-verified here)"
else
  "$PY" -m pip install --quiet "${PY_DEPS[@]}"
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
FF_PIN="${FF}.pinned"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else printf '';
  fi
}
if [[ -f "$FF" && -f "$FF_PIN" ]]; then
  read -r FF_PIN_ARCHIVE FF_PIN_BINARY FF_PIN_URL < "$FF_PIN" || true
  FF_EXISTING_HASH="$(hash_file "$FF")"
  if [[ -n "$FF_EXISTING_HASH" && "$FF_PIN_ARCHIVE" == "${FF_SHA256:-UNPINNED}" && "$FF_PIN_BINARY" == "$FF_EXISTING_HASH" && "$FF_PIN_URL" == "$FFURL_BASE" ]]; then
    echo "  [ok] ffmpeg already staged and verified"

  else
    echo "  [step] staged ffmpeg pin/hash mismatch — re-fetching"
    rm -f "$FF" "$FF_PIN"
  fi
fi
if [[ ! -f "$FF" ]]; then
  if [[ -z "$FFURL_BASE" ]]; then
    echo "  [FAIL] no ffmpeg URL configured for $TARGET." >&2
    echo "         Set AMH_FFURL_MAC_ARM64 to a redistributable arm64 build." >&2
    exit 1
  fi
  echo "  [step] fetching static ffmpeg for $TARGET"
  TMP="$(mktemp -d)"
  curl -fL --retry 3 --retry-all-errors --retry-delay 4 --connect-timeout 30 --speed-time 120 --speed-limit 1024 "$FFURL_BASE" -o "$TMP/ff.zip"
  unzip -tq "$TMP/ff.zip" >/dev/null   # CRC-check the archive before use

  # Authenticity, not just integrity. The CRC above only proves the download
  # was not truncated; it cannot detect upstream replacing the binary. Where a
  # hash is pinned, a changed upstream fails the build loudly instead of
  # silently shipping a different ffmpeg. Same pattern as embed/fetch_model.sh.
  if [[ -n "$FF_SHA256" ]]; then
    if command -v shasum >/dev/null 2>&1; then
      FF_GOT="$(shasum -a 256 "$TMP/ff.zip" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then
      FF_GOT="$(sha256sum "$TMP/ff.zip" | awk '{print $1}')"
    else
      FF_GOT=""
    fi
    if [[ -z "$FF_GOT" ]]; then
      if [[ "${ALLOW_UNPINNED_RUNTIME:-0}" != "1" ]]; then
        echo "  [FAIL] no SHA-256 tool available to verify ffmpeg" >&2
        rm -rf "$TMP"; exit 1
      fi
      echo "  [warn] no sha256 tool available — hash NOT verified (explicitly allowed)"
    elif [[ "$FF_GOT" != "$FF_SHA256" ]]; then
      echo "  [FAIL] ffmpeg archive hash mismatch for $TARGET" >&2
      echo "         url:      $FFURL_BASE" >&2
      echo "         expected: $FF_SHA256" >&2
      echo "         actual:   $FF_GOT" >&2
      echo "         Upstream changed this file. Confirm the new build is the" >&2
      echo "         right arch and is NOT --enable-nonfree, then update the pin." >&2
      rm -rf "$TMP"; exit 1
    else
      echo "  [ok] archive sha256 verified"
    fi
  else
    if [[ "${ALLOW_UNPINNED_RUNTIME:-0}" != "1" ]]; then
      echo "  [FAIL] no pinned SHA-256 for FFmpeg target $TARGET" >&2
      rm -rf "$TMP"; exit 1
    fi
    echo "  [warn] no pinned sha256 for $TARGET (explicitly allowed)"
  fi

  case "$TARGET" in
    mac-*)
      # Extract only the exact 'ffmpeg' member, so the __MACOSX/._ffmpeg
      # AppleDouble entry some zips carry can never be mistaken for the binary.
      unzip -o -q "$TMP/ff.zip" -d "$TMP" 'ffmpeg' 2>/dev/null || true
      FOUND="$(find "$TMP" -type f -name 'ffmpeg' -perm -111 | head -1)"
      [[ -z "$FOUND" ]] && FOUND="$(find "$TMP" -type f -name 'ffmpeg' | head -1)"
      [[ -z "$FOUND" ]] && { echo "  [FAIL] no ffmpeg binary inside $FFURL_BASE" >&2; rm -rf "$TMP"; exit 1; }
      cp "$FOUND" "$FF"
      chmod +x "$FF";;
    win-x64)
      unzip -o -q "$TMP/ff.zip" -d "$TMP"
      FOUND="$(find "$TMP" -type f -name 'ffmpeg.exe' | head -1)"
      [[ -z "$FOUND" ]] && { echo "  [FAIL] no ffmpeg.exe inside $FFURL_BASE" >&2; rm -rf "$TMP"; exit 1; }
      cp "$FOUND" "$FF";;
  esac
  FF_BIN_GOT="$(hash_file "$FF")"
  if [[ -z "$FF_BIN_GOT" && "${ALLOW_UNPINNED_RUNTIME:-0}" != "1" ]]; then
    echo "  [FAIL] no SHA-256 tool available to verify staged ffmpeg" >&2
    rm -rf "$TMP"; exit 1
  fi
  printf '%s %s %s\n' "${FF_SHA256:-UNPINNED}" "$FF_BIN_GOT" "$FFURL_BASE" > "$FF_PIN"
  rm -rf "$TMP"
else
  echo "  [ok] ffmpeg already staged at $FF"
fi
echo "  [ok] ffmpeg ($(du -sh "$FF" | cut -f1))"

# ---- 5b. verify the staged ffmpeg is shippable ------------------------------
# This runs on BOTH paths — freshly downloaded AND already-staged. That matters:
# the "already staged" fast path above is precisely how a hand-placed
# --enable-nonfree arm64 build sat in tools/stage/mac-arm64/ for months while CI
# silently downloaded an x86_64 binary for the same target.
#
# Both checks read the binary rather than executing it, so they work when
# cross-staging (you cannot run an x86_64 ffmpeg on an arm64 host without
# Rosetta, and cannot run ffmpeg.exe on a Mac at all). ffmpeg embeds its full
# ./configure line as a plain string, so grep -a is sufficient and reliable.
echo "  [step] verifying ffmpeg is the right arch and is redistributable"

# (a) architecture — a wrong-arch binary fails at the customer's first export,
#     not at build time, so this must be a hard gate.
FF_FILE="$(file -b "$FF")"
case "$FF_EXPECT_ARCH" in
  arm64)  echo "$FF_FILE" | grep -q 'arm64'  || FF_ARCH_BAD=1;;
  x86_64) echo "$FF_FILE" | grep -q 'x86_64\|PE32+\|x86-64' || FF_ARCH_BAD=1;;
esac
if [[ "${FF_ARCH_BAD:-0}" == "1" ]]; then
  echo "  [FAIL] ffmpeg at $FF is the wrong architecture for $TARGET" >&2
  echo "         expected: $FF_EXPECT_ARCH" >&2
  echo "         actual:   $FF_FILE" >&2
  echo "         Delete it and re-run so the correct binary is fetched." >&2
  exit 1
fi

# (b) licence — FFmpeg's own policy is that --enable-nonfree builds may not be
#     redistributed under any circumstance. Shipping one is a hard legal stop,
#     so it is never overridable.
if grep -aq -- '--enable-nonfree' "$FF"; then
  echo "  [FAIL] $FF was built with --enable-nonfree." >&2
  echo "         FFmpeg forbids redistributing nonfree builds. This binary" >&2
  echo "         cannot ship. Replace it with an LGPL (or GPL, if you comply)" >&2
  echo "         build before building the bundle." >&2
  exit 1
fi

# (c) GPL — legal but obligating: shipping it requires the GPL text plus a
#     written offer for corresponding source in the bundle. Gated behind an
#     explicit opt-in so it is a deliberate choice, never an accident.
if grep -aq -- '--enable-gpl' "$FF"; then
  if [[ "${AMH_FFMPEG_ALLOW_GPL:-0}" != "1" ]]; then
    echo "  [FAIL] $FF is a GPL build (--enable-gpl)." >&2
    echo "         Shipping it obligates you to include the GPL text and a" >&2
    echo "         written offer for corresponding source in the bundle." >&2
    echo "         Use an LGPL build, or set AMH_FFMPEG_ALLOW_GPL=1 to accept" >&2
    echo "         those obligations deliberately." >&2
    exit 1
  fi
  echo "  [warn] GPL ffmpeg accepted via AMH_FFMPEG_ALLOW_GPL=1"
  echo "         — the bundle MUST carry the GPL text + written source offer."
  FF_LICENSE="GPL"
else
  FF_LICENSE="LGPL"
fi
echo "  [ok] ffmpeg verified: $FF_EXPECT_ARCH, $FF_LICENSE"

# ---- 6. verify --------------------------------------------------------------
if [[ "$TARGET" == "win-x64" && "$ON_WINDOWS" == "0" ]]; then
  echo "  [step] skipping import check (cross-staged from non-Windows host;"
  echo "         cannot execute python.exe here — verify on a real Windows PC)"
else
  echo "  [step] verifying imports"
  PY="$(cd "$(dirname "$PY")" && pwd)/$(basename "$PY")"
  "$PY" -c "import ctranslate2, numpy, soundfile, onnxruntime, sherpa_onnx; print('      core imports OK')"
fi
echo
echo "== prepared $TARGET =="
echo "  python: $PYDIR  ($(du -sh "$PYDIR" | cut -f1))"
echo "  ffmpeg: $FF"
echo "  next:   bash tools/build.sh ${TARGET}"
