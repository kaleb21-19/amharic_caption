#!/usr/bin/env python3
"""
test_no_speech.py — 1.94.56 (Studio S1): audio without speech (music, noise,
wind, a fan, drums) gives no captions instead of the model's made-up text
("ዘብ እ። እ።"). The rule is the model's own confidence and how sparse the
words are (Silero VAD marked every speech-free clip as speech); a caption the
model is sure of keeps everything; AMH_NOSPEECH=0 turns it off. The numbers
here are the ones measured on 20 speech-free clips and 30 speech clips
(CHANGELOG 1.94.56). No model, no audio.

  python tools/test/test_no_speech.py
"""
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
import numpy as np  # noqa: E402
import ethio_srt as es  # noqa: E402

passed = 0
FD = 0.02  # seconds a frame


def test(name, fn):
    global passed
    os.environ.pop("AMH_NOSPEECH", None)
    fn()
    passed += 1
    print("  PASS  " + name)


def spans_for(words, conf):
    """One span per word at its start, with the given confidence (a list or one number)."""
    cs = conf if isinstance(conf, list) else [conf] * len(words)
    return [es.Span(7, int(round(w[1] / FD)), int(round(w[2] / FD)), c) for w, c in zip(words, cs)]


def cues_of(words, conf, secs):
    """make_cues with this word stream (get_words / letter confidences stubbed)."""
    old_gw, old_uc = es.get_words, es._unit_confs
    es.get_words = lambda spans, fd, glyphs: list(words)
    es._unit_confs = lambda spans, fd, glyphs: []
    try:
        return es.make_cues("grouped", 0, spans_for(words, conf), FD, "", {}, wav=np.zeros(int(secs * 16000), dtype=np.float32))
    finally:
        es.get_words, es._unit_confs = old_gw, old_uc


# what the model wrote on the audit's 6 s noise clip, and on 20 s of pink noise
NOISE6 = [("ዘብ", 0.4, 0.8), ("እ።", 2.0, 2.2), ("እ።", 4.1, 4.3)]
PINK = [("መብ", 1.0, 1.4), ("እ።", 4.0, 4.2), ("እለ", 9.0, 9.3), ("እለ", 12.0, 12.3), ("ስለ።", 16.0, 16.4)]
DRUMS = [("ነ", 0.6 * k, 0.6 * k + 0.1) for k in range(27)]
# a real (short) sentence: 4 words in 2.3 s - the lowest-confidence speech clip measured (0.735)
SPEECH = [("ቆኒውንም", 0.1, 0.6), ("ማየት", 0.7, 1.0), ("ተመላ", 1.1, 1.5), ("አሉ።", 1.6, 2.0)]


def t_noise_dropped():
    assert cues_of(NOISE6, 0.628, 6.0) == [], "the audit's noise clip: no captions"
    assert cues_of(PINK, 0.624, 20.0) == []


def t_drums_dropped():
    # one letter over and over at 0.83 confidence - real text never is 80% one word
    assert cues_of(DRUMS, 0.833, 20.0) == []


def t_speech_kept():
    out = cues_of(SPEECH, 0.735, 2.3)
    assert out and " ".join(c[0] for c in out) == "ቆኒውንም ማየት ተመላ አሉ።", out


def t_counting_kept():
    # different words, sure of them: "1 2 3 ..." is never noise
    words = [(str(k), 0.5 * k, 0.5 * k + 0.3) for k in range(1, 11)]
    assert cues_of(words, 0.958, 6.0)


def t_sparse_but_sure_kept():
    # one clear sentence in 40 s of music: few words a second, but the model is sure of it
    junk = [("ዘብ", 1.0, 1.3)] + [("እ", 3.0 * k, 3.0 * k + 0.2) for k in range(2, 9)]
    words = junk + [(w, 30 + a, 30 + b) for w, a, b in SPEECH]
    conf = [0.5] * len(junk) + [0.99] * len(SPEECH)
    assert es.no_speech(spans_for(words, conf), words, 40.0) is True, "the average alone looks like noise..."
    assert cues_of(words, conf, 40.0), "...but a caption the model is sure of keeps everything"


def t_window_secs():
    # a long clip's window: the words a second are counted over the window, not the whole clip
    words = [("ሰላም", 0.1, 0.5), ("ናችሁ", 0.6, 1.0), ("ዛሬ", 1.1, 1.4)]
    spans = spans_for(words, 0.7)
    assert es.no_speech(spans, words, 2.0) is False, "1.5 words a second: speech"
    assert es.no_speech(spans, words, 600.0) is True, "the same 3 words over 10 minutes: sparse"


def t_switch_off():
    os.environ["AMH_NOSPEECH"] = "0"
    try:
        assert cues_of(NOISE6, 0.628, 6.0), "AMH_NOSPEECH=0: as before"
    finally:
        os.environ.pop("AMH_NOSPEECH", None)


def t_nothing():
    assert es.no_speech([], [], 10.0) is False
    assert es.no_speech(spans_for(NOISE6, 0.6), NOISE6, None) is False, "no length known: never drop"


for name, fn in [
    ("speech-free audio: the model's made-up words give no captions", t_noise_dropped),
    ("drums: one letter over and over gives no captions", t_drums_dropped),
    ("the least sure real sentence measured is kept, word for word", t_speech_kept),
    ("counting 1-10 is kept", t_counting_kept),
    ("a clear sentence among noise keeps everything", t_sparse_but_sure_kept),
    ("long clips: words a second counted over the window", t_window_secs),
    ("AMH_NOSPEECH=0 turns it off", t_switch_off),
    ("nothing to judge: never drops", t_nothing),
]:
    test(name, fn)

print("ALL PASS  (%d tests)" % passed)
