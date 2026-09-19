#!/usr/bin/env bash
# run_engine.sh — run the offline transcription engine over a set of fixtures and
# score WER against ground truth, then validate SRT structure. Proves transcription
# correctness without Premiere.
#
# Usage:
#   RUNTIME=... tools/test/run_engine.sh --fixtures tools/test/fixtures
#
# RUNTIME must point at a built extension runtime containing python/bin/python3,
# ethio_srt.py and the CT2 int8 model (e.g. the installed extension's runtime/).
# A fixture is <name>.wav with ground truth <name>.txt; an EMPTY truth means the
# clip is expected to be blank (silence) and must produce an empty transcript.
# Every fixture is scored twice: karaoke (--words, one caption per word) and
# grouped (--group 3), each followed by a test_srt.py structural check.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"     # tools
FIX="$ROOT/test/fixtures"
RT="${RUNTIME:-$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime}"
PY="$RT/python/bin/python3"
SCRIPT="$RT/ethio_srt.py"

if [[ ! -x "$PY" || ! -f "$SCRIPT" ]]; then
  echo "[FAIL] runtime not found. Set RUNTIME=/path/to/com.amharic.captions/runtime"
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fixtures)
      FIX="${2:?--fixtures needs a directory argument}"
      shift 2
      ;;
    --max-wer)
      MAX_WER="${2:?--max-wer needs a value like 0.40}"
      shift 2
      ;;
    -h|--help)
      echo "usage: $0 [--fixtures DIR] [--max-wer 0.40]  (RUNTIME=/path)"; exit 0
      ;;
    *)
      echo "[FAIL] unknown argument: $1 (use --fixtures DIR)" >&2; exit 2
      ;;
  esac
done

[[ -d "$FIX" ]] || { echo "[FAIL] fixtures dir not found: $FIX"; exit 1; }

echo "engine: $PY $SCRIPT"
echo "fixtures dir: $FIX"

pass=0; fail=0; warn=0
for wav in "$FIX"/*.wav; do
  [[ -f "$wav" ]] || continue
  base="${wav%.wav}"
  truth="$base.txt"
  [[ -f "$truth" ]] || { echo "  [skip] $base (no .txt truth)"; continue; }
  tmp="$(mktemp -d)"
  echo "---------------- $base"
  blank=0
  [[ -s "$truth" ]] || blank=1
  for mode in karaoke grouped; do
    srt="$tmp/${mode:0:1}.srt"
    if [[ "$mode" == karaoke ]]; then
      args=("$wav" "$srt" --words --max-chars 42)
    else
      args=("$wav" "$srt" --group 3 --max-chars 42)
    fi
    name="[$mode]"

    if ! "$PY" "$SCRIPT" "${args[@]}" >/dev/null 2>&1; then
      echo "  $name [FAIL] engine error"
      fail=$((fail+1)); continue
    fi

    # Blank fixture: wer.py treats empty truth + empty hypothesis as PASS, so the
    # identical WER gate decides — silence producing any tokens is a FAIL.
    if ! "$ROOT/test/wer.py" --truth "$truth" --hyp "$srt" ${MAX_WER:+--max-wer "$MAX_WER"}; then
      fail=$((fail+1)); continue
    fi
    pass=$((pass+1))

    if [[ "$blank" -eq 0 ]] && ! "$ROOT/test/test_srt.py" "$srt" >/dev/null 2>&1; then
      echo "  $name [WARN] SRT structure check flagged a fault"
      warn=$((warn+1))
    fi
  done
  rm -rf "$tmp"
done

echo "===================="
echo "done: pass=$pass  fail=$fail  warn=$warn"
[[ "$fail" -eq 0 ]]