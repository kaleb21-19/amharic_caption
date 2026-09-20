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
        return "ab ab", [(0, 0, 100, 0.9), (2, 100, 110, 0.9), (0, 120, 220, 0.9),
                         (2, 220, 230, 0.9), (1, 240, 340, 0.9)], 1.0 / 16000.0


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

print("\nALL PASS" if fails == 0 else f"\n{fails} FAILED")
sys.exit(1 if fails else 0)
