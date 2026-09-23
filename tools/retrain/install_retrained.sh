#!/usr/bin/env bash
#
# install_retrained.sh — ONE command to install a Kaggle retrain result back on
# the Mac, safely. Mirrors waxal_retrain.ipynb cell 11 but refuses to do
# anything destructive unless the gate said KEEP.
#
# Usage:
#   bash tools/retrain/install_retrained.sh /path/to/unzipped/retrain_output
#
# The bundle is `retrain_output.zip` from the Kaggle Output pane, unzipped. It
# must contain:
#   bundle/SUMMARY.txt                      the gate verdict line
#   bundle/model-retrained/                 HF transformers checkpoint
#   bundle/model-ct2-int8-retrain/          CTranslate2 int8 (what build.sh packs)
#
# Steps (all reversible):
#   1. refuses unless SUMMARY.txt says "gate verdict: KEEP"
#   2. backs up current tools/stage/model-ct2-int8 -> model-ct2-int8.prev
#   3. swaps in the retrained int8 model
#   4. re-scores it vs the old model on the WAXAL dev holdout (04_eval_wer.py,
#      the SAME script the Kaggle gate used) and REVERTS on regression
#   5. rebuilds mac-arm64, mac-x64, win-x64 zips
#   6. prints the honest-fixture re-run step (private 40 clips) that is the
#      final gate before you hand the new zip to a customer
#
# Exit codes: 0 = swapped+rebuilt; 2 = refused (REJECT/missing bundle); 1 = error.
# The 3 zip rebuilds pack ~1.5 GB of model+python each; allow ~25-30 min total.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE="${1:-}"
PY="${ROOT}/.venv/bin/python"
STAGE="${ROOT}/tools/stage"
CT2_CUR="${STAGE}/model-ct2-int8"
CT2_NEW_SRC="${BUNDLE}/bundle/model-ct2-int8-retrain"
HF_NEW="${BUNDLE}/bundle/model-retrained"
SUMMARY="${BUNDLE}/bundle/SUMMARY.txt"
# Final exam = the fixed held-out speakers (tools/retrain/splits/), which no
# Kaggle run trains on. Falls back to the old 352-row slice if absent.
HOLDOUT="${STAGE}/waxal_full/holdout.tsv"
[[ -f "$HOLDOUT" ]] || HOLDOUT="${STAGE}/waxal/dev.tsv"

if [[ -z "$BUNDLE" || ! -d "$BUNDLE" ]]; then
  echo "usage: $0 /path/to/unzipped/retrain_output"
  exit 2
fi

echo "== [1] gate verdict check =="
if [[ ! -f "$SUMMARY" ]]; then
  echo "[fail] $SUMMARY missing — wrong bundle?"; exit 2
fi
grep -qi "gate verdict: keep" "$SUMMARY" || {
  echo "[fail] SUMMARY.txt does not say KEEP — do NOT install a rejected model."
  echo "       Summary content:"; cat "$SUMMARY"; exit 2
}
echo "  [ok] verdict is KEEP"
# CT2_CUR is deliberately NOT in this gate: its absence is the legit
# fresh-install case (below), not a failure.
for p in "$CT2_NEW_SRC" "$PY"; do
  [[ -e "$p" ]] || { echo "[fail] missing: $p"; exit 2; }
done

echo "== [2] backup current int8 model =="
prev="${CT2_CUR}.prev"
rm -rf "$prev"
if [[ -d "$CT2_CUR" ]]; then
  mv "$CT2_CUR" "$prev"
  echo "  [ok] current model -> $(basename "$prev") (rollback: mv $prev $CT2_CUR)"
else
  echo "  [warn] no existing $CT2_CUR — installing fresh"
fi

echo "== [3] swap in retrained int8 model =="
cp -R "$CT2_NEW_SRC" "$CT2_CUR"
echo "  [ok] $CT2_NEW_SRC -> $CT2_CUR"

echo "== [4] WAXAL holdout re-score (old vs new) =="
if [[ -f "$HOLDOUT" ]]; then
  set +e
  "$PY" "$ROOT/tools/retrain/04_eval_wer.py" --manifest "$HOLDOUT" \
      --current "$ROOT/ethio-asr" --candidate "$HF_NEW" 2>/dev/null
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "[fail] WAXAL holdout regression vs previous model — reverting swap."
    rm -rf "$CT2_CUR"
    if [[ -d "$prev" ]]; then mv "$prev" "$CT2_CUR"; fi
    exit 1
  fi
  echo "  [ok] new model >= old model on WAXAL holdout"
else
  echo "  [warn] $HOLDOUT not found — skipping local re-score (Kaggle gate is the guard)"
fi

echo "== [5] rebuild product zips =="
bash "$ROOT/tools/build.sh" mac-arm64
bash "$ROOT/tools/build.sh" mac-x64
bash "$ROOT/tools/build.sh" win-x64

echo
echo "== done — DONE, but the FINAL gate is the honest fixture set =="
echo "Re-run the same private 40 real clips that gave WER 0.227 against the"
echo "new runtime (the zips just built). Keep the swap only if the honest WER"
echo "is at least as good as 0.227. Rollback anytime:"
echo "  rm -rf $CT2_CUR && mv $prev $CT2_CUR"
exit 0