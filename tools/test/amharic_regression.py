#!/usr/bin/env python3
"""
amharic_regression.py — Amharic output must never change by accident.

Transcribes every clip in tools/test/fixtures and tools/test/fixtures_real in
both caption modes (karaoke --words, grouped --group 3) with the production
model and compares the SRT text byte-for-byte against the recorded golden
copies in tools/test/golden_amharic/. Any difference fails, and the diff is
printed. Run it after ANY engine / decoding / post-processing change (e.g.
adding other languages), with the default settings a customer gets.

  python tools/test/amharic_regression.py            # check
  python tools/test/amharic_regression.py --update   # re-record (only after
                                                     # a deliberate, benchmarked
                                                     # Amharic improvement)
Needs the approved model (tools/stage/model-ct2-int8, see tools/model.lock) or
AMH_MODEL_DIR, and tools/vad/silero_vad.onnx.
"""
import difflib
import glob
import os
import shutil
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GOLDEN = os.path.join(REPO, "tools", "test", "golden_amharic")
os.environ.setdefault("AMH_MODEL_DIR", os.path.join(REPO, "tools", "stage", "model-ct2-int8"))
sys.path.insert(0, REPO)

# amh_vad loads silero_vad.onnx from its own folder (the runtime layout).
_vad_copy = os.path.join(REPO, "silero_vad.onnx")
_made_vad = False
if not os.path.exists(_vad_copy):
    shutil.copy(os.path.join(REPO, "tools", "vad", "silero_vad.onnx"), _vad_copy)
    _made_vad = True

try:
    import ethio_srt as es

    def srt_text(cues):
        out, idx = [], 0
        for text, s, e in cues:
            if not text:
                continue
            idx += 1
            out.append("%d\n%s --> %s\n%s\n" % (idx, es.format_ts(s), es.format_ts(e), text))
        return "\n".join(out)

    update = "--update" in sys.argv
    engine = es.load_pipeline()
    clips = sorted(glob.glob(os.path.join(REPO, "tools", "test", "fixtures", "*.wav")) +
                   glob.glob(os.path.join(REPO, "tools", "test", "fixtures_real", "*.wav")))
    os.makedirs(GOLDEN, exist_ok=True)
    changed = checked = 0
    for wav in clips:
        audio = es.read_wav(wav)
        for mode, group in (("words", 3), ("grouped", 3)):
            name = "%s.%s.srt" % (os.path.splitext(os.path.basename(wav))[0], mode)
            path = os.path.join(GOLDEN, name)
            try:
                _t, cues = es._run_file(engine, audio, mode, group, 42, 0.0, None)
                got = srt_text(cues)
            except ValueError as e:          # e.g. clip shorter than one frame
                got = "ERROR: %s\n" % e
            if update:
                with open(path, "w", encoding="utf-8", newline="\n") as f:
                    f.write(got)
                continue
            checked += 1
            try:
                want = open(path, encoding="utf-8").read()
            except FileNotFoundError:
                print("  [MISSING] %s (run with --update once to record)" % name)
                changed += 1
                continue
            if got != want:
                changed += 1
                print("  [CHANGED] " + name)
                for line in list(difflib.unified_diff(want.splitlines(), got.splitlines(),
                                                      "golden", "now", lineterm=""))[:12]:
                    print("      " + line)
    if update:
        print("recorded %d golden Amharic outputs in %s" % (len(clips) * 2, GOLDEN))
        sys.exit(0)
    print("\n" + ("AMHARIC UNCHANGED" if changed == 0 else "AMHARIC CHANGED: %d" % changed) +
          "  (%d outputs checked)" % checked)
    sys.exit(0 if changed == 0 else 1)
finally:
    if _made_vad:
        os.remove(_vad_copy)
