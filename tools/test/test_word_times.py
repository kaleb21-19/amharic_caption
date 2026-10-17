#!/usr/bin/env python3
"""
test_word_times.py — exact word times (1.16.26): every caption carries the
engine's own [start, end] of each of its words, and write_srt puts them next
to the SRT as <srt>.words.json (keyed by SRT cue number, like .doubt.json),
so the panel's ✂ cuts and 🔍 zooms land on the word itself. Nothing about the
captions themselves changes (amharic_regression.py proves that with the
model); this test needs no model.

  python tools/test/test_word_times.py
"""
import json
import os
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
import ethio_srt as es  # noqa: E402

passed = 0


def test(name, fn):
    global passed
    fn()
    passed += 1
    print("  PASS  " + name)


WORDS = [("ሰላም", 0.10, 0.42), ("ናችሁ", 0.50, 0.95), ("ዛሬ", 2.00, 2.30), ("ስለ", 2.35, 2.55), ("ቡና።", 2.60, 3.10)]
CUES = [("ሰላም ናችሁ", 0.10, 0.95), ("ዛሬ ስለ ቡና።", 2.00, 3.10)]


def t_attach():
    out = es._attach_doubts(CUES, WORDS, [])
    assert [c.wt for c in out] == [[[0.1, 0.42], [0.5, 0.95]], [[2.0, 2.3], [2.35, 2.55], [2.6, 3.1]]], [c.wt for c in out]
    assert [tuple(c) for c in out] == CUES, "the captions themselves are unchanged"


def t_mismatch():
    # a caption whose words cannot be matched one to one gets none (the panel estimates)
    out = es._attach_doubts([("ሰላም ናችሁ ሁላችሁም", 0.10, 0.95)], WORDS, [])
    assert out[0].wt == [], out[0].wt


def t_min_duration_and_shift():
    cues = es.enforce_min_duration(es._attach_doubts(CUES, WORDS, []))
    assert cues[0][2] >= 1.0, "a short caption is still made readable"
    assert cues[0].wt == [[0.1, 0.42], [0.5, 0.95]], "the words keep their real times"
    moved = es._shift_cue(cues[1], 10.0)
    assert moved.wt[0] == [12.0, 12.3] and abs(moved[1] - 12.0) < 1e-9


def t_journal():
    c = es._attach_doubts(CUES, WORDS, [])[1]
    back = es._cue_from_row(json.loads(json.dumps(es._cue_row(c))))
    assert back.wt == c.wt and tuple(back) == tuple(c)
    old = es._cue_from_row(["ሰላም", 0.0, 1.0, []])         # a journal from before 1.16.26
    assert old.wt == []


def t_write():
    d = tempfile.mkdtemp(prefix="amh_wt_")
    srt = os.path.join(d, "x.srt")
    cues = es._attach_doubts(CUES, WORDS, [])
    n = es.write_srt(srt, cues, 5.0)
    assert n == 2
    side = json.load(open(srt + ".words.json", encoding="utf-8"))
    assert side == {"1": [[5.1, 5.42], [5.5, 5.95]], "2": [[7.0, 7.3], [7.35, 7.55], [7.6, 8.1]]}, side
    # the SRT text is exactly what it always was
    assert "00:00:05,100 --> 00:00:05,950\nሰላም ናችሁ\n" in open(srt, encoding="utf-8").read()
    # written again without word times: the stale file goes
    es.write_srt(srt, [es.Cue("ሰላም", 0.0, 1.0)], 0.0)
    assert not os.path.exists(srt + ".words.json")


test("every caption carries the exact times of its own words", t_attach)
test("a caption that does not match its words one to one gets none", t_mismatch)
test("readable-length captions keep the real word times; batch shifts move them", t_min_duration_and_shift)
test("the resume journal keeps them (and reads an old journal)", t_journal)
test("<srt>.words.json next to the SRT, offset applied; the SRT itself unchanged", t_write)
print("ALL PASS  (%d tests)" % passed)
