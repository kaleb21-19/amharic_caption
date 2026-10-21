"""Make the Studio's sound effects (app/sfx/*.wav, 1.65).

    python tools/make_sfx.py

Every sound is synthesized here from noise, sine waves and filters — our own
work, no samples, no licence to carry. 48 kHz, 16-bit, mono, a few KB each.
The same script always makes the same files (fixed random seed).
"""
import os
import wave

import numpy as np

SR = 48000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "sfx")
rng = np.random.default_rng(1965)


def t_(sec):
    return np.arange(int(SR * sec)) / SR


def svf_bandpass(x, fc, q=1.2):
    """A state-variable band-pass whose centre moves (fc: one value per sample)."""
    y = np.zeros_like(x)
    lp = bp = 0.0
    for i in range(len(x)):
        f = 2 * np.sin(np.pi * min(fc[i], SR / 6) / SR)
        hp = x[i] - lp - bp / q
        bp += f * hp
        lp += f * bp
        y[i] = bp
    return y


def lowpass(x, fc):
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.zeros_like(x)
    s = 0.0
    for i in range(len(x)):
        s = (1 - a) * x[i] + a * s
        y[i] = s
    return y


def env(n, attack, release, shape=2.0):
    """0 -> 1 in `attack` of the length, then down to 0 (curved)."""
    u = np.linspace(0, 1, n)
    a = np.clip(u / max(1e-6, attack), 0, 1) ** shape
    r = np.clip((1 - u) / max(1e-6, release), 0, 1) ** shape
    return np.minimum(a, r)


def fade_edges(x, ms=3):
    k = int(SR * ms / 1000)
    x[:k] *= np.linspace(0, 1, k)
    x[-k:] *= np.linspace(1, 0, k)
    return x


def whoosh(sec=0.6, f0=350, f1=3200, f2=700):
    n = int(SR * sec)
    u = np.linspace(0, 1, n)
    peak = 0.55
    fc = np.where(u < peak, f0 * (f1 / f0) ** (u / peak), f1 * (f2 / f1) ** ((u - peak) / (1 - peak)))
    x = svf_bandpass(rng.standard_normal(n), fc, q=3.2)
    return x * env(n, peak, 1 - peak, 2.2)


def swish():
    return whoosh(0.28, 900, 6500, 1800)


def boom():
    t = t_(0.9)
    f = 58 * (0.7 ** (t / 0.9))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28)
    hit = lowpass(rng.standard_normal(len(t)), 350) * np.exp(-t / 0.04) * 6
    x = body + hit
    return np.tanh(1.8 * x)


def pop():
    t = t_(0.14)
    f = 300 + 900 * np.exp(-t / 0.02)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.035)
    return x


def click():
    t = t_(0.06)
    x = np.sin(2 * np.pi * 2300 * t) * np.exp(-t / 0.008) + 0.4 * rng.standard_normal(len(t)) * np.exp(-t / 0.003)
    return x


def ding():
    t = t_(1.4)
    x = np.zeros_like(t)
    for mult, amp, dec in ((1.0, 1.0, 0.9), (2.0, 0.5, 0.5), (3.01, 0.3, 0.35), (4.2, 0.18, 0.25), (5.4, 0.1, 0.18)):
        x += amp * np.sin(2 * np.pi * 1046.5 * mult * t) * np.exp(-t / dec)
    return x * np.clip(t / 0.003, 0, 1)


def riser():
    n = int(SR * 1.5)
    t = t_(1.5)
    u = t / 1.5
    tone = np.sin(2 * np.pi * np.cumsum(220 * (6 ** u)) / SR) * 0.35
    noise = svf_bandpass(rng.standard_normal(n), 500 * (10 ** u), q=1.0) * 0.8
    return (tone + noise) * (u ** 2.2) * np.clip((1 - u) / 0.03, 0, 1)


def tick():
    t = t_(0.045)
    return np.sin(2 * np.pi * 1800 * t) * np.exp(-t / 0.009) + np.sin(2 * np.pi * 3600 * t) * 0.3 * np.exp(-t / 0.004)


SOUNDS = {"whoosh": whoosh, "swish": swish, "boom": boom, "pop": pop, "click": click, "ding": ding, "riser": riser, "tick": tick}
LEVEL = {"whoosh": 0.7, "swish": 0.6, "boom": 0.9, "pop": 0.6, "click": 0.5, "ding": 0.45, "riser": 0.6, "tick": 0.5}


def write(name, x):
    x = fade_edges(np.asarray(x, dtype=np.float64))
    x = x / max(1e-9, np.max(np.abs(x))) * LEVEL[name]
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(os.path.join(OUT, name + ".wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, fn in SOUNDS.items():
        write(name, fn())
        print("app/sfx/%s.wav" % name)
