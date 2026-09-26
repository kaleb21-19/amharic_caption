#!/usr/bin/env python3
"""
lang_eval.py — raw recognition accuracy of a model on a non-Amharic language.

  python tools/test/lang_eval.py orm [--model <ct2 model dir>]

Scores the decoder's own text (language tag like "[ORM]" removed) against the
WAXAL references in tools/test/fixtures_langs/<lang>/ (see fetch_lang_eval.py).
No Amharic post-processing runs here, so the number reflects the model itself.
Token masking per language: Oromo is written in Latin letters and uses the
apostrophe inside words, so nothing but digits is masked for it; Ethiopic-script
languages keep the Amharic mask (latin, digits, symbols).
"""
import argparse
import glob
import os
import re
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MASK = {"orm": "digits", "sid": "digits", "wal": "digits", "tir": "latin,digits,symbols",
        "amh": "latin,digits,symbols"}

ap = argparse.ArgumentParser()
ap.add_argument("lang")
ap.add_argument("--model", default=os.path.join(REPO, "tools", "stage", "model-ct2-int8"))
ap.add_argument("--show", type=int, default=2, help="print this many examples")
a = ap.parse_args()

os.environ["AMH_MODEL_DIR"] = a.model
os.environ["AMH_TOKEN_MASK"] = MASK.get(a.lang, "digits")
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(REPO, "tools", "test"))
import ethio_srt as es  # noqa: E402
import wer as W  # noqa: E402

TAG = re.compile(r"\[[A-Z]{3}\]")
engine = es.load_pipeline()
ws, cs, tags = [], [], {}
t0 = time.time()
for i, txt in enumerate(sorted(glob.glob(os.path.join(REPO, "tools", "test", "fixtures_langs", a.lang, "*.txt")))):
    audio = es.read_wav(txt[:-4] + ".wav")
    text, _spans, _fd = engine.transcribe(audio)
    for t in TAG.findall(text):
        tags[t] = tags.get(t, 0) + 1
    hyp_raw = TAG.sub(" ", text)
    ref = W.normalize(open(txt, encoding="utf-8").read())
    hyp = W.normalize(hyp_raw)
    ws.append(W.wer(ref, hyp))
    cs.append(W.cer(ref, hyp))
    if i < a.show:
        print("  REF: " + " ".join(ref))
        print("  HYP: " + " ".join(hyp))
print("%s  clips=%d  WER=%.1f%%  CER=%.1f%%  language tags emitted=%s  (%.0fs)  model=%s" % (
    a.lang, len(ws), 100 * sum(ws) / len(ws), 100 * sum(cs) / len(cs), tags, time.time() - t0,
    os.path.basename(a.model.rstrip("/\\"))))
