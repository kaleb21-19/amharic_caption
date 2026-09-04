#!/usr/bin/env bash
# run_engine.sh — run the offline transcription engine over a set of fixtures and
# score WER against ground truth. Proves transcription correctness without Premiere.
#
# Usage:
#   RUNTIME=... tools/test/run_engine.sh --fixtures tools/test/fixtures
#
# Fixtures: <name>.wav (16kHz mono Amharic speech) with ground truth in <name>.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"     # tools
FIX="${1:-$ROOT/test/fixtures}"
RT="${RUNTIME:-$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime}"
PY="$RT/python/bin/python3"
SCRIPT="$RT/ethio_srt.py"

if [[ ! -x "$PY" || ! -f "$SCRIPT" ]]; then
  echo "[FAIL] runtime not found. Set RUNTIME=/path/to/com.amharic.captions/runtime"
  exit 1
fi

echo "engine: $PY $SCRIPT"
echo "fixtures dir: $FIX"
pass=0; fail=0
for wav in "$FIX"/*.wav; do
  [[ -f "$wav" ]] || continue
  base="${wav%.wav}"
  truth="$base.txt"
  [[ -f "$truth" ]] || { echo "  [skip] $base (no .txt truth)"; continue; }
  tmp="$(mktemp -d)"
  echo "---- $base"
  # Karaoke
  "$PY" "$SCRIPT" "$wav" "$tmp/k.srt" --words --max-chars 42 >/dev/null 2>&1 || echo "  karaoke engine error"
  "$ROOT/test/wer.py" --truth "$truth" --hyp "$tmp/k.srt" || fail=$((fail+1))
  # Grouped
  "$PY" "$SCRIPT" "$wav" "$tmp/g.srt" --group 3 --max-chars 42 >/dev/null 2>&1 || echo "  grouped engine error"
  "$ROOT/test/wer.py" --truth "$truth" --hyp "$tmp/g.srt" || fail=$((fail+1))
  rm -rf "$tmp"
done
echo "===================="
echo "done (failures=$fail)"
[[ "$fail" -eq 0 ]]
