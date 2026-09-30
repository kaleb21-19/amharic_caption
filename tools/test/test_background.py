"""drop_background_words: a quiet background voice between the speaker's words
is dropped; a single quiet word, and a quieter REAL speaker (a guest further
from the mic), are kept. No model needed — synthetic audio with known levels.

    python tools/test/test_background.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import ethio_srt as E  # noqa: E402

SR = 16000
rng = np.random.default_rng(3)


def clip(layout):
    """layout: [(start_s, end_s, level_dbfs)] -> audio + one word per entry."""
    n = int(max(e for _, e, _ in layout) * SR) + SR
    x = np.zeros(n, np.float32)
    words = []
    for k, (s, e, db) in enumerate(layout):
        a, b = int(s * SR), int(e * SR)
        x[a:b] = rng.standard_normal(b - a).astype(np.float32) * (10 ** (db / 20))
        words.append(("w%d" % k, s, e))
    return x, words


def names(ws):
    return [w[0] for w in ws]


fails = 0


def check(cond, msg):
    global fails
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        fails += 1


# Speaker at -12 dB; a background voice at -34 dB (22 dB down) for 4 words
# in the middle; one quiet trailing word at -30 dB later on.
lay = [(t * 0.5, t * 0.5 + 0.35, -12) for t in range(8)]              # w0..w7 speaker
lay += [(4.0 + t * 0.5, 4.35 + t * 0.5, -34) for t in range(4)]       # w8..w11 background
lay += [(6.0 + t * 0.5, 6.35 + t * 0.5, -12) for t in range(6)]       # w12..w17 speaker
lay += [(9.0, 9.35, -30)]                                              # w18 one quiet word
lay += [(9.5 + t * 0.5, 9.85 + t * 0.5, -12) for t in range(4)]       # w19..w22 speaker
x, words = clip(lay)
os.environ["AMH_BG"] = "1"
kept = names(E.drop_background_words(words, x))
check(not any(w in kept for w in ("w8", "w9", "w10", "w11")), "background run between the speaker's words is dropped")
check("w18" in kept, "a single quiet word is kept")
check(all(("w%d" % k) in kept for k in list(range(8)) + list(range(12, 18)) + list(range(19, 23))), "every speaker word is kept")

# A quieter REAL second speaker: 12 words at -30 dB, more than 5 s after the
# first speaker stops — surrounded by their own words, so all kept.
lay2 = [(t * 0.5, t * 0.5 + 0.35, -12) for t in range(10)]
lay2 += [(11.0 + t * 0.5, 11.35 + t * 0.5, -30) for t in range(12)]
x2, words2 = clip(lay2)
check(len(E.drop_background_words(words2, x2)) == len(words2), "a quieter real speaker (guest far from the mic) is kept")

# Off switch, no audio, too few words.
os.environ["AMH_BG"] = "0"
check(len(E.drop_background_words(words, x)) == len(words), "AMH_BG=0 disables it")
os.environ["AMH_BG"] = "1"
check(E.drop_background_words(words, None) == words, "no audio -> unchanged")
check(E.drop_background_words(words[:2], x) == words[:2], "two words -> unchanged")

print("\nALL PASS" if not fails else "\nFAILURES: %d" % fails)
sys.exit(1 if fails else 0)
