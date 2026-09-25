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

MAX_WER=""
MEAN_MAX_WER=""
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
    --mean-max-wer)
      MEAN_MAX_WER="${2:?--mean-max-wer needs a value like 0.40}"
      shift 2
      ;;
    -h|--help)
      echo "usage: $0 [--fixtures DIR] [--max-wer 0.40] [--mean-max-wer 0.40]  (RUNTIME=/path)"
      exit 0
      ;;
    *)
      echo "[FAIL] unknown argument: $1 (use --fixtures DIR)" >&2; exit 2
      ;;
  esac
done

if [[ -n "$MAX_WER" && -n "$MEAN_MAX_WER" ]]; then
  echo "[FAIL] use only one of --max-wer (per-clip) or --mean-max-wer (aggregate)" >&2
  exit 2
fi

WER_LOG="$(mktemp)"
trap 'rm -f "$WER_LOG"' EXIT

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

    # Score every run. --max-wer keeps the legacy per-clip gate; the production
    # gate uses --mean-max-wer, which collects raw WER values and checks their
    # arithmetic mean after the loop. The 1.0 ceiling here prevents an individual
    # clip from turning an aggregate policy into an accidental per-clip gate.
    score_args=()
    if [[ -n "$MAX_WER" ]]; then
      score_args=(--max-wer "$MAX_WER")
    elif [[ -n "$MEAN_MAX_WER" ]]; then
      score_args=(--max-wer 1.0)
    fi
    if ! score_output="$("$ROOT/test/wer.py" --truth "$truth" --hyp "$srt" "${score_args[@]}")"; then
      printf '%s\n' "$score_output"
      fail=$((fail+1)); continue
    fi
    printf '%s\n' "$score_output"
    if [[ -n "$MEAN_MAX_WER" ]]; then
      value="$(printf '%s\n' "$score_output" | sed -n 's/.*WER: \([0-9.][0-9.]*\)%.*/\1/p' | head -n 1)"
      if [[ -z "$value" ]]; then
        echo "  $name [FAIL] could not parse WER for aggregate gate"
        fail=$((fail+1)); continue
      fi
      printf '%s\n' "$value" >> "$WER_LOG"
    fi
    pass=$((pass+1))

    if [[ "$blank" -eq 0 ]] && ! "$ROOT/test/test_srt.py" "$srt" >/dev/null 2>&1; then
      echo "  $name [WARN] SRT structure check flagged a fault"
      warn=$((warn+1))
    fi
  done
  rm -rf "$tmp"
done

if [[ -n "$MEAN_MAX_WER" ]]; then
  n="$(wc -l < "$WER_LOG" | tr -d '[:space:]')"
  if [[ "$n" -eq 0 ]]; then
    echo "[FAIL] aggregate raw WER gate has no scored runs"
    fail=$((fail+1))
  else
    mean_pct="$(awk '{s += $1} END {printf "%.4f", s / NR}' "$WER_LOG")"
    echo "aggregate raw WER: ${mean_pct}%  (n=$n, gate <= $(awk -v g="$MEAN_MAX_WER" 'BEGIN {printf "%.0f", g * 100}')%)"
    if ! awk -v m="$mean_pct" -v g="$MEAN_MAX_WER" 'BEGIN {exit !(m <= g * 100)}'; then
      echo "[FAIL] aggregate raw WER ${mean_pct}% exceeds gate ${MEAN_MAX_WER}"
      fail=$((fail+1))
    fi
  fi
fi

echo "===================="
echo "done: pass=$pass  fail=$fail  warn=$warn"
[[ "$fail" -eq 0 ]]