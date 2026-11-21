#!/usr/bin/env python3
"""
test_cut_eval.py - the measuring tool of the cut-quality work (phase 0) is
itself right: word-edge errors, cuts inside words, pauses removed, clicks.
Synthetic data only (no model, no real clips).
  python tools/test/test_cut_eval.py
"""
import json
import os
import sys
import tempfile
import wave

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "tools", "eval"))
import cut_eval as C  # noqa: E402

passed = 0


def test(name, fn):
    global passed
    fn()
    passed += 1
    print("  PASS  " + name)


TMP = tempfile.mkdtemp(prefix="amh_cut_eval_")


def f(name, text):
    p = os.path.join(TMP, name)
    with open(p, "w", encoding="utf-8", newline="\n") as h:
        h.write(text)
    return p


LABELS = f("labels.txt", "\\ ignored frequency line\n0.500\t0.900\tሰላም\n0.950\t1.400\tእንዴት\n2.600\t3.100\tናችሁ\n")


def t_labels():
    L = C.read_labels(LABELS)
    assert [w for _, _, w in L] == ["ሰላም", "እንዴት", "ናችሁ"], L
    assert L[0][:2] == (0.5, 0.9)


def t_draft_roundtrip():
    srt = f("a.srt", "1\n00:00:00,500 --> 00:00:01,400\nሰላም እንዴት\n\n2\n00:00:02,600 --> 00:00:03,100\nናችሁ\n")
    f("a.srt.words.json", json.dumps({"1": [[0.52, 0.88], [0.97, 1.38]], "2": [[2.6, 3.1]]}))
    words = C.engine_words(srt)
    assert [round(s, 2) for s, _, _ in words] == [0.52, 0.97, 2.6], words
    out = os.path.join(TMP, "draft.txt")
    assert C.main(["draft", srt, "-o", out]) == 0
    assert len(C.read_labels(out)) == 3


def t_estimate_without_words():
    srt = f("b.srt", "1\n00:00:00,000 --> 00:00:02,000\nአንድ ሁለት\n")
    words = C.engine_words(srt, os.path.join(TMP, "none.json"))
    assert len(words) == 2 and abs(words[0][1] - 1.0) < 1e-6, words      # even split by letters (equal lengths)


def t_edges():
    ref = [(0.5, 0.9, "ሰላም"), (0.95, 1.4, "እንዴት"), (62.0, 62.5, "ናችሁ")]
    hyp = [(0.52, 0.88, "ሰላም"), (1.0, 1.4, "እንዴት"), (62.1, 62.6, "ናችሁ"), (70.0, 70.2, "ተጨማሪ")]
    r = C.edge_errors(ref, hyp)
    assert r["matched"] == 3 and r["of"] == 3
    assert abs(r["median_ms"] - 35.0) < 0.6, r                           # errors 0,20,20,50,100,100
    assert set(r["per_minute"]) == {0, 1}, r


def t_midword():
    L = C.read_labels(LABELS)
    bad = C.midword_cuts(L, [(0.9, 0.95), (1.2, 2.0)])
    assert bad == [(1.2, "እንዴት")], bad
    assert C.midword_cuts(L, [(1.41, 2.59)]) == []


def t_pauses():
    L = C.read_labels(LABELS)
    ps = C.pauses(L, 5.0, 0.8)
    assert ps == [(1.4, 2.6), (3.1, 5.0)], ps                            # the start gap is 0.5 s: not a pause
    r = C.pause_coverage(L, [(1.55, 2.45)], 5.0, 0.8, 0.15)
    assert r["pauses"] == 2 and r["removed"] == 1 and r["missed"] == [(3.1, 5.0)], r


def write_wav(name, samples, rate=16000):
    import numpy as np
    p = os.path.join(TMP, name)
    a = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(p, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(a.tobytes())
    return p


def t_clicks():
    import numpy as np
    rate = 16000
    t = np.arange(rate) / rate
    smooth = 0.3 * np.sin(2 * np.pi * 220 * t)
    hard = smooth.copy()
    hard[8000:] = 0.3 * np.sin(2 * np.pi * 220 * t[8000:] + 2.5)          # a phase jump at 0.5 s = a click
    s, r = C.read_wav_mono(write_wav("smooth.wav", smooth))
    assert not any(x["click"] for x in C.clicks(s, r, [0.5])), "a smooth tone has no click"
    h, r = C.read_wav_mono(write_wav("hard.wav", hard))
    assert all(x["click"] for x in C.clicks(h, r, [0.5])), "a hard join clicks"
    fade = hard.copy()
    n = int(0.03 * rate)
    fade[8000 - n:8000] *= np.linspace(1, 0, n)
    fade[8000:8000 + n] *= np.linspace(0, 1, n)
    g, r = C.read_wav_mono(write_wav("fade.wav", fade))
    assert not any(x["click"] for x in C.clicks(g, r, [0.5])), "a 30 ms fade out / in removes the click"


def t_cli_limits():
    cuts = f("cuts.json", json.dumps([[1.2, 2.0]]))
    assert C.main(["midword", LABELS, cuts, "--max", "0"]) == 1
    assert C.main(["midword", LABELS, cuts]) == 0


for name, fn in [("Audacity labels are read (frequency lines skipped)", t_labels),
                 ("draft from SRT + words.json, and back", t_draft_roundtrip),
                 ("no words.json: even split by letters (the panel's fallback)", t_estimate_without_words),
                 ("word-edge error: median, per minute, extra words ignored", t_edges),
                 ("cut edges inside a word are found; edges in a gap are not", t_midword),
                 ("pauses incl. the end; removed only when nearly all of it is cut", t_pauses),
                 ("clicks: a hard join is found, a smooth one and a faded one are not", t_clicks),
                 ("limits make it a gate (exit 1)", t_cli_limits)]:
    test(name, fn)

print("ALL PASS  (%d)" % passed)
