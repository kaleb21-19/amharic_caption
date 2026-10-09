#!/usr/bin/env python3
"""Unit tests for the long-audio window planner + resumable journal, and the
rule-based punctuation pass. Uses a stub engine (no model load) so it runs in
under a second. Run:  .venv/bin/python3 tools/test/test_long.py
"""
import os
import sys
import json
import tempfile

os.environ["AMH_VAD"] = "0"  # deterministic: exercise the energy-split fallback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import numpy as np  # noqa: E402
import ethio_srt as E  # noqa: E402
from amh_correct import punctuate_words  # noqa: E402

fails = 0


def check(name, cond):
    global fails
    print(("  [OK] " if cond else "  [FAIL] ") + name)
    if not cond:
        fails += 1


# ---- 1. window planner covers the whole clip with no gaps/overlaps ---------
target = E._window_target_samples()
n = int(215 * 16000)
wav = np.zeros(n, dtype=np.float32)
wins = E._plan_windows(wav, target)
check("first window starts at 0", wins[0][0] == 0)
check("last window ends at EOF", wins[-1][1] == n)
check("windows are contiguous",
      all(wins[i][1] == wins[i + 1][0] for i in range(len(wins) - 1)))
check("windows bounded at <=1.3x target",
      all(en - st <= int(target * 1.3) for st, en in wins))
check("multi-window for 215s clip", len(wins) >= 3)


# ---- 2. resumable journal: resume skips completed windows ------------------
class StubEngine:
    glyphs = {0: "a", 1: "b", 2: "|"}
    def __init__(self):
        self.calls = 0
    def _transcribe_one(self, w):
        self.calls += 1
        return "ab ab", [(0, 0, 100), (2, 100, 110), (0, 120, 220), (2, 220, 230),
                         (1, 240, 340)], 1.0 / 16000.0


out = os.path.join(tempfile.mkdtemp(), "long.srt")
eng = StubEngine()
wins = E._plan_windows(wav, target)
total = len(wins)
# Seed a journal claiming the first 2 windows are already done.
seed = {"fp": E._audio_fp(wav), "total": total, "done": 2,
        "cues": [["ab ab", 0.0, 0.5]], "texts": ["ab ab", "ab ab"]}
with open(out + ".part.json", "w", encoding="utf-8") as f:
    json.dump(seed, f)
text, cues = E._run_long(eng, wav, "grouped", 0, 42, 0.0, out)
check("resume transcribes only remaining windows", eng.calls == total - 2)
check("resume keeps seeded cues", cues[0][0] == "ab ab")
check("partial SRT exists after run", os.path.isfile(out))
check("journal removed on clean completion", not os.path.isfile(out + ".part.json"))

# ---- 3. fresh run (no journal) does all windows and cleans up --------------
eng2 = StubEngine()
out2 = os.path.join(tempfile.mkdtemp(), "long2.srt")
E._run_long(eng2, wav, "words", 0, 42, 0.0, out2)
check("fresh run transcribes all windows", eng2.calls == total)
check("fresh run leaves no journal", not os.path.isfile(out2 + ".part.json"))

# ---- 4. punctuation from timing gaps --------------------------------------
aligned = [("አማርኛ", 0.0, 0.4), ("ቋንቋ", 0.4, 0.7), ("ነው", 0.75, 1.0),
           ("ግን", 1.7, 1.9), ("ቀላል", 1.9, 2.1), ("አይደለም።", 2.2, 2.5),
           ("ነው", 2.5, 2.6)]
got = [w for w, _, _ in punctuate_words(aligned)]
check("period at big gap, comma at medium gap, none when tight",
      got == ["አማርኛ", "ቋንቋ", "ነው።", "ግን", "ቀላል", "አይደለም።", "ነው።"])
default_punct = punctuate_words(aligned)
check("default AMH_PUNCT returns a NEW punctuated list",
      default_punct is not aligned and default_punct[-1][0] == "ነው።")
os.environ["AMH_PUNCT"] = "0"
check("AMH_PUNCT=0 returns input unchanged", punctuate_words(aligned) is aligned)
del os.environ["AMH_PUNCT"]

# ---- 5. degenerate (<1 mel frame) audio is a clean error, never NaN (gap #4) -
# The planner always appends full remainders, so sub-windows of a long clip are
# normally > one mel frame; guard the edge anyway. What matters in production:
# a WHOLE short clip on the single-shot path must raise a clean "audio too
# short" error (mapped to skip + skipped:N by the batch/--server callers), and
# a degenerate window must be skippable without a traceback.
class ShortTailEngine(StubEngine):
    def _transcribe_one(self, w):
        if len(w) < 560:  # mirrors the amh_mel.MelExtractor guard
            raise ValueError("audio too short (%d samples): need >= 560"
                             " (400 frame + 160 hop) for at least two mel frames" % len(w))
        return StubEngine._transcribe_one(self, w)


try:
    E._windowed_transcribe(ShortTailEngine(), np.zeros(300, dtype=np.float32))
    check("300-sample clip raises 'audio too short'", False)
except ValueError as e:
    check("300-sample clip raises 'audio too short'",
          str(e).startswith("audio too short"))
eng4 = ShortTailEngine()
got, wcues = E._win_cues(eng4, np.zeros(0, dtype=np.float32), 0, 0, "grouped", 0, 42)
check("_win_cues skips a too-short window cleanly", got == "" and wcues == [] and eng4.calls == 0)

# ---- 6. effective-silence energy floor (gap "silence hallucinations", §1.2f) --
# Digital silence passed through Silero VAD as 'active' and produced fabricated
# CTC tokens. _preflight_audio must deem zeros silent (empty transcript) while a
# real signal and a too-short buffer behave as before. Pure numpy — no model.
tone = (0.05 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype(np.float32)
check("8s zeros -> detected as silent", E._preflight_audio(np.zeros(8000, dtype=np.float32)))
check("440Hz tone -> NOT silent",
      not E._preflight_audio(tone))
check("silent tone at loud RMS is speech (env floor)",
      not E._preflight_audio((0.9 * tone)))
import os
prev = os.environ.get("AMH_SILENCE_RMS")
os.environ["AMH_SILENCE_RMS"] = "0.5"  # 50% rms floor: even the tone is 'silent'
check("AMH_SILENCE_RMS floor is honored",
      E._preflight_audio((0.9 * tone)))
if prev is None:
    os.environ.pop("AMH_SILENCE_RMS", None)
else:
    os.environ["AMH_SILENCE_RMS"] = prev
try:
    E._preflight_audio(np.zeros(300, dtype=np.float32))
    check("preflight 300-sample zeros raises 'audio too short'", False)
except ValueError as e:
    check("preflight 300-sample zeros raises 'audio too short'",
          str(e).startswith("audio too short"))

# ---- 7. enforce_min_duration never emits overlapping cues (1.2k) ----------
# The min_dur extension used to be left in place whenever the NEXT cue started
# within tail_room, because the old guard required `limit > s` and simply gave
# up otherwise -- shipping cues that overlap the following one. Karaoke mode
# (one word per cue) hits this on real audio: 2/19 Common Voice clips.

def _no_overlaps(cues):
    return all(cues[i][2] <= cues[i + 1][1] + 1e-9 for i in range(len(cues) - 1))

# the exact shape observed on cv_common_voice_am_37952747 (karaoke):
# cue at 1.372 extended to 2.372 by min_dur while the next starts at 1.492.
got = E.enforce_min_duration(
    [("\u1218\u1308\u122d", 0.814, 0.863),
     ("\u1208\u12ed", 1.372, 1.400),
     ("\u1270\u1230\u1240", 1.492, 1.520)],
    min_dur=1.0, max_dur=5.0, tail_room=0.15)
check("min_dur extension does not overlap a close next cue", _no_overlaps(got))
check("cue is butted against the next cue's start", abs(got[1][2] - 1.492) < 1e-9)

# a comfortable gap still keeps tail_room
got = E.enforce_min_duration(
    [("a", 0.0, 0.1), ("b", 5.0, 5.1)], min_dur=1.0, max_dur=5.0, tail_room=0.15)
check("roomy neighbours still get the full min_dur", abs(got[0][2] - 1.0) < 1e-9)

# clamping to tail_room still applies when there IS room for a gap
got = E.enforce_min_duration(
    [("a", 0.0, 0.1), ("b", 0.8, 0.9)], min_dur=1.0, max_dur=5.0, tail_room=0.15)
check("tail_room gap preserved when it fits", abs(got[0][2] - 0.65) < 1e-9)
check("no overlap in the tail_room case", _no_overlaps(got))

# max_dur trim still applies
got = E.enforce_min_duration([("a", 0.0, 90.0)], min_dur=1.0, max_dur=5.0)
check("max_dur still trims a long cue", abs(got[0][2] - 5.0) < 1e-9)

# ---- keep the computer awake during a job; battery notice ------------------
# A laptop that sleeps half-way through a long video froze the job ("can't
# handle a 10-minute video"). keep_awake() asks the OS not to idle-sleep while
# a job runs and gives that back afterwards.
if sys.platform == "win32":
    import ctypes
    STES = ctypes.windll.kernel32.SetThreadExecutionState
    STES.restype = ctypes.c_uint
    with E.keep_awake():
        inside = STES(0x80000000 | 0x00000001)   # returns the flags in force
    after = STES(0x80000000)
    check("Windows: no idle sleep while a job runs", inside & 0x1 == 0x1)
    check("Windows: normal sleep comes back after the job", after & 0x1 == 0)
elif sys.platform == "darwin":
    import subprocess
    with E.keep_awake() as ka:
        alive = ka._proc is not None and ka._proc.poll() is None
        args = subprocess.run(["ps", "-o", "args=", "-p", str(ka._proc.pid)], capture_output=True, text=True).stdout
    ka._proc.wait(timeout=10)
    check("Mac: caffeinate -i runs while a job runs", alive and "caffeinate -i -w %d" % os.getpid() in args)
    check("Mac: caffeinate ends with the job", ka._proc.poll() is not None)
os.environ["AMH_KEEP_AWAKE"] = "0"
with E.keep_awake() as ka:
    check("AMH_KEEP_AWAKE=0 turns it off", ka._proc is None and not ka._win)
os.environ.pop("AMH_KEEP_AWAKE")
check("on_battery() answers True/False", E.on_battery() in (True, False))
import io as _io
import contextlib
real = E.on_battery
try:
    E.on_battery = lambda: True
    buf = _io.StringIO()
    with contextlib.redirect_stderr(buf):
        E._power_notice(600)
        E._power_notice(30)
    check("long job on battery -> one [power] battery line; short clip -> none",
          buf.getvalue() == "[power] battery" + chr(10))
    E.on_battery = lambda: False
    buf = _io.StringIO()
    with contextlib.redirect_stderr(buf):
        E._power_notice(600)
    check("plugged in -> no power line", buf.getvalue() == "")
finally:
    E.on_battery = real

# ---- parallel windows (1.9.8): how many workers, and the look-ahead -------
os.environ.pop("AMH_WORKERS", None)
check("workers: 2 threads -> 1, 4 -> 2, 8 -> 4, 16 -> 4",
      [E._workers_for(t) for t in (1, 2, 4, 6, 8, 16)] == [1, 1, 2, 3, 4, 4])
os.environ["AMH_WORKERS"] = "1"
check("AMH_WORKERS=1 turns it off", E._workers_for(16) == 1)
os.environ.pop("AMH_WORKERS")
os.environ["AMH_VAD_TRIM"] = "1"
check("VAD trimming keeps one worker", E._workers_for(16) == 1)
os.environ.pop("AMH_VAD_TRIM")


class _StubEnc:
    def __init__(self):
        import threading
        self.calls = 0
        self.lock = threading.Lock()

    def _encode(self, piece):
        with self.lock:
            self.calls += 1
        return float(np.sum(piece))


rng = np.random.default_rng(1)
pieces = [rng.standard_normal(16000).astype(np.float32) * 0.1 for _ in range(6)]
st = _StubEnc()
pre = E._Prefetch(st, 3)
pre.schedule(pieces + [pieces[0]])          # a repeat is not computed twice
got = [pre.take(x) for x in pieces]
check("look-ahead returns each piece's own result",
      all(abs(g - float(np.sum(x))) < 1e-3 for g, x in zip(got, pieces)))
check("a piece scheduled twice is computed once", st.calls == 6)
check("not scheduled -> None (the caller computes it)", pre.take(rng.standard_normal(16000).astype(np.float32)) is None)
check("nothing left behind", not pre.ready and not pre.queue and not pre.pending)
pre.schedule(pieces[:4])
pre.clear()
check("clear() drops unused look-ahead", not pre.ready and not pre.queue and not pre.pending)
pre.schedule(pieces[:2])
check("still works after clear()", pre.take(pieces[0]) is not None and pre.take(pieces[1]) is not None)
silent = np.zeros(32000, dtype=np.float32)
pre.schedule([silent])
check("silent piece -> None from the worker (caller returns early)", pre.take(silent) is None)
tiny = np.zeros(100, dtype=np.float32)
pre.schedule([tiny])
try:
    pre.take(tiny)
    raised = False
except ValueError as e:
    raised = str(e).startswith("audio too short")
check("a worker error reaches the caller like before (audio too short)", raised)

# ---- Work Area / Whole edit while it works (1.10.9) ------------------------
# A "live" batch writes its captions as it goes (after every clip and every
# window of a long clip) and keeps a journal: a stopped run continues.
import io  # noqa: E402
import soundfile as sf  # noqa: E402
import amh_license  # noqa: E402
amh_license.engine_auth = lambda lease=None, ticket=None: (True, "test")


class BatchStub(StubEngine):
    prefetch = None

    def transcribe(self, w):
        return E._windowed_transcribe(self, w)


bdir = tempfile.mkdtemp()
rng2 = np.random.default_rng(7)
paths = []
for i, secs in enumerate((215, 30)):
    pth = os.path.join(bdir, "c%d.wav" % i)
    sf.write(pth, (rng2.standard_normal(secs * 16000) * 0.05).astype(np.float32), 16000)
    paths.append(pth)
breq = {"batch": [{"wav": paths[0], "offset": 0.0}, {"wav": paths[1], "offset": 220.0}],
        "mode": "grouped", "group": 0, "max_chars": 42, "live": True}
os.environ["AMH_LONG_SECS"] = "60"
bout = os.path.join(bdir, "seq.srt")
writes = []
real_write = E.write_srt
E.write_srt = lambda p_, c_, o_: (writes.append(len(c_)), real_write(p_, c_, o_))[1]
be = BatchStub()
E.handle_server_batch(be, dict(breq, out_srt=bout), 1, io.StringIO())
E.write_srt = real_write
full_calls = be.calls
check("live batch: captions written after every window and clip", len(writes) >= 3)
check("live batch: the partial file only grows", writes == sorted(writes))
check("live batch: journal removed when done", not os.path.isfile(bout + ".part.json"))
final = open(bout, encoding="utf-8").read()

# stopped after 3 windows -> the next run continues
bout2 = os.path.join(bdir, "seq2.srt")
real_win = E._win_cues
count = {"n": 0}


def stop_after_3(*a, **k):
    count["n"] += 1
    if count["n"] > 3:
        raise KeyboardInterrupt("power cut")
    return real_win(*a, **k)


E._win_cues = stop_after_3
try:
    E.handle_server_batch(BatchStub(), dict(breq, out_srt=bout2), 2, io.StringIO())
except KeyboardInterrupt:
    pass
E._win_cues = real_win
E.end_permit()
check("stopped run keeps its journal", os.path.isfile(bout2 + ".part.json"))
be2 = BatchStub()
E.handle_server_batch(be2, dict(breq, out_srt=bout2), 3, io.StringIO())
check("resumed run does only what was left (%d of %d)" % (be2.calls, full_calls), be2.calls == full_calls - 3)
check("resumed result is the same as an uninterrupted run", open(bout2, encoding="utf-8").read() == final)
# without "live": as before (one write at the end, no journal)
writes.clear()
E.write_srt = lambda p_, c_, o_: (writes.append(len(c_)), real_write(p_, c_, o_))[1]
E.handle_server_batch(BatchStub(), dict(breq, live=False, out_srt=os.path.join(bdir, "plain.srt")), 4, io.StringIO())
E.write_srt = real_write
check("not live: written once at the end", len(writes) == 1)
del os.environ["AMH_LONG_SECS"]
E.end_permit()

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
