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
# Release builds are strict by default. Set ALLOW_DEGRADED=1 only for a local
# diagnostic archive; a customer build must not silently lose diarization, LM,
# VAD, or the production model.
ALLOW_DEGRADED="${ALLOW_DEGRADED:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${ROOT}/tools/stage"
DIST="${ROOT}/dist"
NAME="com.amharic.captions"

TARGET="${1:-}"
case "$TARGET" in
  mac-arm64) FFSUFFIX="ffmpeg";;
  mac-x64)   FFSUFFIX="ffmpeg";;
  win-x64)   FFSUFFIX="ffmpeg.exe";;
  *) echo "usage: $0 <mac-arm64|mac-x64|win-x64>"; exit 1;;
esac

mkdir -p "$DIST"

# ---- 1. build the runtime into a staging copy of the extension -------------
BUILD_DIR="$(mktemp -d)"
RT="${BUILD_DIR}/${NAME}/runtime"
mkdir -p "${BUILD_DIR}/${NAME}" "$RT/bin" "$RT/python"
if [[ "$ALLOW_DEGRADED" == "1" ]]; then
  printf '%s\n' 'LOCAL/TEST DEGRADED BUILD — optional ML assets may be absent; NOT FOR RELEASE.' > "$BUILD_DIR/DEGRADED_BUILD.txt"
fi
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "== building runtime for: $TARGET =="

# ethio_srt.py + standalone numpy mel extractor + beam-search decoder + post-correction
cp "$ROOT/ethio_srt.py" "$RT/ethio_srt.py"
cp "$ROOT/amh_mel.py" "$RT/amh_mel.py"
cp "$ROOT/ctc_beam.py" "$RT/ctc_beam.py"
cp "$ROOT/amh_correct.py" "$RT/amh_correct.py"
echo "  [ok] ethio_srt.py + amh_mel.py + ctc_beam.py + amh_correct.py"

# 2-speaker diarization (interview labels). Pure-python engine + a small ONNX
# speaker-embedding model; runs on the bundled onnxruntime (no torch). Optional:
# if the model is missing the panel's "Label speakers" toggle is a no-op.
if [[ -f "$ROOT/tools/embed/nemo_en_titanet_small.onnx" ]]; then
  cp "$ROOT/amh_diarize.py" "$RT/amh_diarize.py"
  cp "$ROOT/tools/embed/nemo_en_titanet_small.onnx" "$RT/speaker_embed.onnx"
  echo "  [ok] amh_diarize.py + speaker_embed.onnx"
else
  if [[ "$ALLOW_DEGRADED" != "1" ]]; then echo "  [FAIL] speaker embedding model missing"; exit 1; fi
  echo "  [warn] tools/embed/nemo_en_titanet_small.onnx missing — speaker labels disabled"
fi

# Amharic word-LM (glue-word resegmentation after decoding). The model file is
# built offline by tools/build_lm.py. Optional: if missing, word-LM is skipped.
if [[ -f "$ROOT/tools/lm/amh_lm.json.gz" ]]; then
  cp "$ROOT/amh_lm.py" "$RT/amh_lm.py"
  cp "$ROOT/tools/lm/amh_lm.json.gz" "$RT/amh_lm.json.gz"
  echo "  [ok] amh_lm.py + amh_lm.json.gz"
else
  if [[ "$ALLOW_DEGRADED" != "1" ]]; then echo "  [FAIL] Amharic word-LM missing"; exit 1; fi
  echo "  [warn] tools/lm/amh_lm.json.gz missing — word-LM disabled"
fi

# Silero VAD (onnx) — speech-gap detector that skips music-only regions before
# the CT2 encode. Optional: if missing, ethio_srt.py degrades to whole-clip.
if [[ -f "$ROOT/tools/vad/silero_vad.onnx" ]]; then
  cp "$ROOT/tools/vad/silero_vad.onnx" "$RT/silero_vad.onnx"
  cp "$ROOT/amh_vad.py" "$RT/amh_vad.py"
  echo "  [ok] silero_vad.onnx + amh_vad.py"
else
  if [[ "$ALLOW_DEGRADED" != "1" ]]; then echo "  [FAIL] Silero VAD model missing"; exit 1; fi
  echo "  [warn] tools/vad/silero_vad.onnx missing — VAD disabled (whole-clip transcribe)"
fi

# model — prefer the CTranslate2 INT8 model (tools/make_model_ct2_int8.sh):
# ~600MB, no torch/transformers at runtime. Dev fallback: fp16/fp32.
if [[ -d "$ROOT/tools/stage/model-ct2-int8" && -f "$ROOT/tools/stage/model-ct2-int8/model_meta.json" ]]; then
  MODEL_SRC="$ROOT/tools/stage/model-ct2-int8"
  echo "  [model] CTranslate2 int8"
elif [[ "$ALLOW_DEGRADED" == "1" && -d "$ROOT/tools/stage/model-fp16" && -f "$ROOT/tools/stage/model-fp16/config.json" ]]; then
  MODEL_SRC="$ROOT/tools/stage/model-fp16"
  echo "  [model] fp16 source (degraded build)"
elif [[ "$ALLOW_DEGRADED" == "1" && -d "$ROOT/ethio-asr" && -f "$ROOT/ethio-asr/config.json" ]]; then
  MODEL_SRC="$ROOT/ethio-asr"
  echo "  [model] fp32 source (degraded build)"
else
  echo "  [FAIL] production CTranslate2 int8 model is missing"; exit 1
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

# ---- 1b. trim the bundled Python to runtime-only files ---------------------
# The staged interpreter ships build-time extras that are never importable at
# runtime and only bloat the zip (~15MB). Drop them from the bundle:
#   include/   C headers for building extensions
#   libs/      import libraries for embedding (Windows)
#   Scripts/   pip/console shims
#   ensurepip, venv, idlelib, lib2to3, pydoc_data, tkinter + tcl/tk, turtle*
# (tkinter is unused: the panel UI is HTML/JS. __pycache__ is left in place so
# first import stays fast.)
PYP="$RT/python"
LIBROOT="$PYP/Lib"
[[ -d "$LIBROOT" ]] || LIBROOT="$PYP/lib/python3.11"   # macOS layout
rm -rf "$PYP/include" "$PYP/libs" "$PYP/Scripts"
rm -rf "$LIBROOT/ensurepip" "$LIBROOT/idlelib" "$LIBROOT/lib2to3" \
       "$LIBROOT/pydoc_data" "$LIBROOT/tkinter" "$LIBROOT/turtledemo" \
       "$LIBROOT/venv"
rm -f  "$LIBROOT/turtle.py"
rm -rf "$PYP/tcl"
rm -rf "$PYP"/lib/libtcl* "$PYP"/lib/libtk* "$PYP"/lib/tcl* "$PYP"/lib/tk* 2>/dev/null || true
rm -f  "$PYP"/DLLs/_tkinter.pyd "$PYP"/DLLs/tcl*.dll "$PYP"/DLLs/tk*.dll 2>/dev/null || true
rm -f  "$LIBROOT"/lib-dynload/_tkinter* 2>/dev/null || true
echo "  [ok] python trimmed ($(du -sh "$RT/python" | cut -f1))"

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

# ---- 2b. one-click installer for this target -------------------------------
# Shipped at the zip ROOT (sibling of the extension folder) so "unzip, then
# double-click Install" is all the customer does. Each target gets the right
# one; both handle copy + debug-keys + (mac) quarantine automatically.
INSTALLERS="${ROOT}/tools/installers"
case "$TARGET" in
  win-*)
    # Guard: cmd.exe mis-parses non-CRLF batch files (a bare \r at EOF or LF
    # endings produce "': was unexpected at this time'" on the customer's
    # machine). refactor-proof the endings before it can ship again.
    python3 - "$INSTALLERS/Install.cmd" <<'PYEOF' || exit 1
import re, sys
b = open(sys.argv[1], "rb").read()
stray = len(re.findall(rb"\r(?!\n)", b)) + len(re.findall(rb"(?<!\r)\n", b))
if stray:
    print(f"[fail] Install.cmd has {stray} non-CRLF line ending(s); cmd.exe "
          f"will error with ': was unexpected at this time.' Fix the endings "
          f"(git attr: tools/installers/Install.cmd text eol=crlf).")
    sys.exit(1)
PYEOF
    cp "$INSTALLERS/Install.cmd" "${BUILD_DIR}/Install.cmd"
    echo "  [ok] Install.cmd (windows one-click installer)"
    # Window-runtime verification harness (customer-facing). Same CRLF rule:
    # silently shipping an LF-only .cmd would make cmd.exe mis-parse it.
    python3 - "$INSTALLERS/verify_win.cmd" <<'PYEOF' || exit 1
import re, sys
b = open(sys.argv[1], "rb").read()
stray = len(re.findall(rb"\r(?!\n)", b)) + len(re.findall(rb"(?<!\r)\n", b))
if stray:
    print(f"[fail] verify_win.cmd has {stray} non-CRLF line ending(s); "
          f"cmd.exe will mis-parse it (git attr: tools/installers/verify_win.cmd text eol=crlf).")
    sys.exit(1)
PYEOF
    cp "$INSTALLERS/verify_win.cmd" "${BUILD_DIR}/verify_win.cmd"
    cp "$INSTALLERS/VERIFY.md" "${BUILD_DIR}/VERIFY.md"
    echo "  [ok] verify_win.cmd + VERIFY.md (windows runtime verification harness)"
    ;;
  mac-*)
    cp "$INSTALLERS/Install.command" "${BUILD_DIR}/Install.command"
    chmod +x "${BUILD_DIR}/Install.command"
    echo "  [ok] Install.command (macOS one-click installer)"
    ;;
esac

# ---- 2c. licences + third-party notices ------------------------------------
# Mandatory, not cosmetic: the bundled ffmpeg is a GPL build, and the GPL
# requires the licence text and a written offer for corresponding source to
# accompany the binary. Shipped at the zip ROOT so a customer (or an auditor)
# sees it without opening the extension folder.
LICSRC="${ROOT}/tools/licenses"
LICDST="${BUILD_DIR}/licenses"
mkdir -p "$LICDST"
cp "$LICSRC/COPYING.GPLv2.txt" "$LICSRC/COPYING.GPLv3.txt" \
   "$LICSRC/COPYING.LGPLv2.1.txt" "$LICSRC/WRITTEN-OFFER.txt" "$LICDST/"
# Generated from the artefacts actually staged above, so the notice can never
# describe a different ffmpeg than the one in the zip. Hard-fails on a nonfree
# binary even if prepare_python.sh was skipped.
python3 "$LICSRC/gen_notices.py" \
  --ffmpeg "$RT/bin/$FFSUFFIX" \
  --runtime "$RT" \
  --target "$TARGET" \
  --out "$LICDST/THIRD-PARTY-NOTICES.md" || exit 1
echo "  [ok] licenses/ (GPL text + written offer + third-party notices)"

# ---- 2d. EULA + privacy + refund (consumer-facing) -----------------------
# Plain-text version of the legal page (website/app/legal). Shipped at the zip
# ROOT next to licenses/ so every customer sees them when they unzip.
LEGALSRC="${ROOT}/tools/legal"
for f in EULA.txt PRIVACY.txt REFUND.txt; do
  if [[ ! -f "$LEGALSRC/$f" ]]; then
    echo "  [FAIL] missing legal document: $LEGALSRC/$f"; exit 1
  fi
  cp "$LEGALSRC/$f" "${BUILD_DIR}/$f"
done
echo "  [ok] legal/ (EULA + privacy + refund)"

# ---- 3. zip it ------------------------------------------------------------
ZIP="${DIST}/amharic-captions-${TARGET}.zip"
rm -f "$ZIP"
ZIP_ENTRIES=("$NAME" licenses 'Install.*' verify_win.cmd VERIFY.md EULA.txt PRIVACY.txt REFUND.txt)
[[ -f "$BUILD_DIR/DEGRADED_BUILD.txt" ]] && ZIP_ENTRIES+=(DEGRADED_BUILD.txt)
(
  cd "$BUILD_DIR"
  zip -r -q "$ZIP" "${ZIP_ENTRIES[@]}" -x "*.DS_Store"
)
echo "== wrote $ZIP ($(du -sh "$ZIP" | cut -f1)) =="
