#!/usr/bin/env python3
"""test_diarize.py — tests for amh_diarize.py (2-speaker labels).

Two layers:
  * PURE   — kmeans2 / assign_labels / the two-speaker gate. Always run; only
             need numpy.
  * MODEL  — end-to-end labels on fixtures/twospeaker.wav (a synthetic
             two-voice conversation). Skipped unless sherpa-onnx + the
             embedding model are both present.

Run:  python3 tools/test/test_diarize.py
Exit code is non-zero on failure. The public model is English, but speaker
embeddings are language-agnostic; the fixture only needs two distinct voices.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

# Point the module at the repo's dev model unless the caller overrides it.
if not os.environ.get("AMH_EMBED_MODEL"):
    _cand = os.path.join(ROOT, "tools", "embed", "nemo_en_titanet_small.onnx")
    if os.path.isfile(_cand):
        os.environ["AMH_EMBED_MODEL"] = _cand

pass_ = 0
fail = 0


def t(name, fn):
    global pass_, fail
    try:
        fn()
        pass_ += 1
        print("  [OK] " + name)
    except Exception as e:
        fail += 1
        print("  [FAIL] " + name + "\n        " + str(e))


def _pure():
    import numpy as np
    import amh_diarize as d

    # kmeans2: two clearly separable directions, interleaved order.
    a = np.array([1.0, 0.0], dtype=np.float32)
    b = np.array([0.0, 1.0], dtype=np.float32)
    embs = np.stack([a, b, a, b, a, b])
    lab, cent = d.kmeans2(embs)
    assert len(set(lab.tolist())) == 2, "expected two clusters"
    assert d.cluster_separation(embs, lab, cent) > 0.9, "should be well separated"
    assert d._two_speakers(embs, lab, cent, 0.10), "should pass the gate"

    # Single direction -> one cluster dominates -> gate rejects.
    one = np.stack([a, a, a, a, a, a])
    lab1, cent1 = d.kmeans2(one)
    assert not d._two_speakers(one, lab1, cent1, 0.10), "single speaker must be rejected"

    # assign_labels: S1 is whoever speaks first; overlap picks the dominant one.
    starts = np.array([0.0, 1.5], dtype=np.float32)
    lab2 = np.array([0, 1])
    cues = [("a", 0.0, 1.4), ("b", 1.6, 2.9), ("c", 1.4, 1.7)]
    out = d.assign_labels(cues, embs[:2], starts, lab2, cent)
    assert out[0][0] == "[S1] a", out
    assert out[1][0] == "[S2] b", out
    assert out[2][0] == "[S2] c", out  # 0.2s S2 vs 0.1s S1
    assert (out[0][1], out[0][2]) == (0.0, 1.4), "times must pass through"

    # Empty cues / no model are safe no-ops.
    assert d.label_cues([], np.zeros(16000, dtype=np.float32)) == []
    print("       pure: kmeans2 + gate + assign_labels OK")


def _model():
    import numpy as np
    import soundfile as sf
    import amh_diarize as d

    if not d.available():
        print("       model: skipped (sherpa-onnx or embedding model missing)")
        return
    wav = os.path.join(HERE, "fixtures", "twospeaker.wav")
    assert os.path.isfile(wav), "missing fixture " + wav
    x, sr = sf.read(wav, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    # The first speaker's turns are 2s each with 0.25s gaps (see the generator
    # in repo history); label cues that sit inside each turn.
    turns = [(0.0, 2.0), (2.25, 4.25), (4.5, 6.5),
             (6.75, 8.75), (9.0, 11.0), (11.25, 13.25)]
    cues = [("t%d" % i, s, e) for i, (s, e) in enumerate(turns)]
    out = d.label_cues(cues, x, sr)
    got = [c[0].split("]")[0] + "]" for c in out]
    want = ["[S1]", "[S2]", "[S1]", "[S2]", "[S1]", "[S2]"]
    assert got == want, "labels %s != %s" % (got, want)
    print("       model: twospeaker.wav labelled 6/6 turns correctly")


print("== amh_diarize tests ==")
t("pure clustering / labeling / gate", _pure)
t("end-to-end speaker labels", _model)

print("\n" + ("ALL PASS" if fail == 0 else "FAILURES: %d" % fail) +
      "  (%d passed, %d failed)" % (pass_, fail))
sys.exit(0 if fail == 0 else 1)
