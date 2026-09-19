#!/usr/bin/env python3
"""test_mel_short.py — close TESTING.md §8 gap #4.

The mel extractor must fail CLEANLY (ValueError, not NaN) on audio too short to
form two mel frames, and must produce finite features above that threshold.
Assets are the real shipped ones (tools/stage/model-ct2-int8/*.npy).

    python3 tools/test/test_mel_short.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import amh_mel

ASSETS = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "stage", "model-ct2-int8")
if not all(os.path.isfile(os.path.join(ASSETS, n)) for n in ("mel_filters.npy", "window.npy")):
    print("[skip] model assets not staged (tools/stage/model-ct2-int8) — run prepare first")
    sys.exit(0)

fails = 0


def check(name, cond):
    global fails
    print(("  [OK] " if cond else "  [FAIL] ") + name)
    if not cond:
        fails += 1


mel = amh_mel.MelExtractor(ASSETS)

# ---- degenerate inputs must raise a clean, catchable error ----------------
for n in (0, 300, 559):
    try:
        mel(np.zeros(n, dtype=np.float32))
        check("len=%d raises ValueError" % n, False)
    except ValueError as e:
        check("len=%d raises ValueError" % n, str(e).startswith("audio too short"))
    except Exception as e:
        check("len=%d raises ValueError (got %r)" % (n, e), False)
print("  (MIN_SAMPLES = %d)" % amh_mel.MelExtractor.MIN_SAMPLES)

# ---- the minimum length works and yields exactly two frames ---------------
feats = mel(np.zeros(amh_mel.MelExtractor.MIN_SAMPLES, dtype=np.float32))
check("min length -> feature (1,1,160)", feats.shape == (1, 1, 160))
check("min length -> finite", bool(np.isfinite(feats).all()))

# ---- a normal 1s clip -> several frames, all finite (no NaN) --------------
wav = (np.random.RandomState(0).randn(16000) * 0.05).astype(np.float32)
feats = mel(wav)
check("1s clip -> (1,T//2,160)", feats.shape == (1, (feats.shape[1]) * 2 // 2, 160) and feats.shape[1] > 20)
check("1s clip -> all finite", bool(np.isfinite(feats).all()))

print()
print("ALL PASS" if fails == 0 else "%d FAILED" % fails)
sys.exit(0 if fails == 0 else 1)