#!/usr/bin/env python3
"""amh_dereverb.py — single-channel dereverberation (WPE), numpy only.

Why this exists: TESTING.md §1.2h measured the model at ~21 words correct per
100 in a reverberant hall, against ~55 on clean speech. Sermons, wedding-hall
speeches and conference footage are a large share of what Ethiopian editors
cut, so that is the single worst number the product has. This tries to fix it
before the audio ever reaches the model — no retraining, no new model file, and
it applies to every customer who has already installed the panel.

Method: weighted prediction error (WPE). Late reverberation is, to a good
approximation, a linear filter applied to the *past* of the signal. So for each
frequency band we fit a short linear predictor from frames delayed by `delay`
onwards, and subtract what it predicts. The `delay` is what keeps the direct
sound and early reflections intact — those carry speech information and are not
what hurts recognition; only the smeared tail is removed. The fit is weighted by
1/power so loud frames don't dominate, and iterated a few times using the
current estimate's power.

The runtime ships numpy and nothing else heavy (no scipy), so the STFT, the
solve and the overlap-add are all written out here.

Self-check:  python3 amh_dereverb.py
"""
import numpy as np

SR = 16000
N_FFT = 512
HOP = 128
_BLOCK = 1000          # frames per filter estimate (~8 s) — bounds memory


def _window():
    # periodic Hann: with 75 % overlap this gives constant overlap-add
    return np.hanning(N_FFT + 1)[:-1]


def _stft(x):
    """Real signal -> complex spectrogram (freq, time). Front-padded so the
    first samples get the same window treatment as the rest."""
    win = _window()
    xp = np.pad(np.asarray(x, dtype=np.float64), (N_FFT, N_FFT))
    n_frames = 1 + (len(xp) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    return np.fft.rfft(xp[idx] * win, n=N_FFT, axis=1).T


def _istft(S, length):
    """Inverse of _stft, trimmed back to `length` samples."""
    win = _window()
    frames = np.fft.irfft(S.T, n=N_FFT, axis=1)
    n_frames = frames.shape[0]
    out = np.zeros(N_FFT + HOP * (n_frames - 1))
    wsum = np.zeros_like(out)
    for i in range(n_frames):
        s = i * HOP
        out[s:s + N_FFT] += frames[i] * win
        wsum[s:s + N_FFT] += win * win
    out /= np.maximum(wsum, 1e-8)
    return out[N_FFT:N_FFT + length]


def _box(P, w, axis):
    """Centred moving average along one axis, via cumsum (O(n), no scipy)."""
    if w <= 1:
        return P
    lo = w // 2
    padding = [(0, 0), (0, 0)]
    padding[axis] = (lo, w - 1 - lo)
    c = np.cumsum(np.pad(P, padding, mode="edge"), axis=axis, dtype=np.float64)
    zeros = list(c.shape)
    zeros[axis] = 1
    c = np.concatenate([np.zeros(zeros), c], axis=axis)
    n = P.shape[axis]
    hi = [slice(None), slice(None)]
    lo_s = [slice(None), slice(None)]
    hi[axis] = slice(w, w + n)
    lo_s[axis] = slice(0, n)
    return (c[tuple(hi)] - c[tuple(lo_s)]) / w


def _power(D, wt=9, wf=3):
    """Weighting term for WPE: the signal power, SMOOTHED over neighbouring
    frames and bins.

    This smoothing is not cosmetic. Dividing by the instantaneous |D[f,t]|^2 —
    the power of the very sample being predicted — normalises away the
    correlation that WPE exists to find, and the fitted filter comes out at
    essentially zero (measured: |g| 0.01 vs 0.30, and the output is bit-for-bit
    the input). Smoothing keeps the intended benefit, which is that a loud
    vowel shouldn't dominate the fit, without that self-cancellation."""
    return np.maximum(_box(_box(np.abs(D) ** 2, wf, 0), wt, 1), 1e-10)


def _wpe(S, taps, delay, iterations):
    """Weighted prediction error on a (freq, time) spectrogram."""
    F, T = S.shape
    if T <= delay + taps + 8:
        return S                                  # too short to estimate anything
    S = S.astype(np.complex64)
    D = S.copy()
    pad = delay + taps
    Sp = np.concatenate([np.zeros((F, pad), np.complex64), S], axis=1)

    for _ in range(iterations):
        # power of the CURRENT estimate drives the weighting (that is the
        # "weighted" in WPE — it stops loud vowels dominating the fit)
        power = _power(D)
        for t0 in range(0, T, _BLOCK):
            t1 = min(t0 + _BLOCK, T)
            n = t1 - t0
            if n <= taps + 2:
                continue
            # Xr[f, k, t] = S[f, t - delay - k]
            Xr = np.empty((F, taps, n), np.complex64)
            for k in range(taps):
                sh = delay + k
                Xr[:, k, :] = Sp[:, t0 + pad - sh: t1 + pad - sh]
            W = Xr / power[:, None, t0:t1]
            R = np.einsum("fit,fjt->fij", W, Xr.conj())
            r = np.einsum("fit,ft->fi", W, S[:, t0:t1].conj())
            # ridge term, scaled per band, so a silent band stays solvable
            diag = np.einsum("fii->fi", R).real.mean(axis=1)
            R += (np.eye(taps, dtype=np.complex64)[None]
                  * (diag[:, None, None] * 1e-6 + 1e-8))
            try:
                # numpy>=2 wants a stack of matrices here, not a stack of vectors
                g = np.linalg.solve(R, r[:, :, None])[:, :, 0]
            except np.linalg.LinAlgError:
                continue                          # leave this block untouched
            D[:, t0:t1] = S[:, t0:t1] - np.einsum("fi,fit->ft", g.conj(), Xr)
    return D


def dereverb(wav, taps=10, delay=3, iterations=3):
    """Remove late reverberation from 16 kHz mono float32 speech.

    Returns a new array the same length as `wav`, at the same peak level, so
    callers can drop it in without rescaling. Any failure returns the input
    unchanged — this must never be the reason a transcription doesn't happen.
    """
    x = np.asarray(wav, dtype=np.float32)
    if x.ndim != 1 or len(x) < N_FFT * 4:
        return x
    peak_in = float(np.max(np.abs(x)))
    if peak_in <= 0.0:
        return x
    try:
        y = _istft(_wpe(_stft(x), taps, delay, iterations), len(x))
    except Exception:
        return x
    if not np.all(np.isfinite(y)):
        return x
    peak_out = float(np.max(np.abs(y)))
    if peak_out <= 0.0:
        return x
    return (y * (peak_in / peak_out)).astype(np.float32)


# ------------------------------------------------------------------ self-check
def _selftest():
    """Reverberate a synthetic signal, then check WPE actually moves it back
    toward the dry original. This asserts the thing works, not that it runs."""
    rng = np.random.default_rng(0)
    n = SR * 4
    t = np.arange(n) / SR

    # a crude voiced-speech stand-in: harmonic stack, amplitude-gated so there
    # are real pauses for the reverb tail to smear into
    f0 = 120 + 20 * np.sin(2 * np.pi * 2.0 * t)
    phase = 2 * np.pi * np.cumsum(f0) / SR
    dry = sum(np.sin(phase * h) / h for h in range(1, 12))
    gate = (np.sin(2 * np.pi * 1.6 * t) > -0.2).astype(float)
    gate = np.convolve(gate, np.ones(400) / 400, mode="same")
    dry = (dry * gate).astype(np.float32)
    dry /= np.max(np.abs(dry))

    rt60 = 0.5
    n_ir = int(rt60 * SR)
    ir = rng.standard_normal(n_ir) * np.exp(-np.arange(n_ir) / (rt60 * SR / 6.0))
    ir[0] += 1.0
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = np.convolve(dry, ir)[:n].astype(np.float32)
    wet = (wet / np.max(np.abs(wet))).astype(np.float32)

    # NOTE: call the core path unguarded. dereverb() returns the input on any
    # exception, which is right in production but would turn a genuine bug into
    # a silent "pass-through" that still looks like a working function here.
    TAPS, DELAY = 40, 2          # the setting §1.2i actually measured
    out = _istft(_wpe(_stft(wet), TAPS, DELAY, 3), len(wet)).astype(np.float32)
    out = (out / (np.max(np.abs(out)) + 1e-12)).astype(np.float32)
    assert np.allclose(out, dereverb(wet, taps=TAPS, delay=DELAY), atol=1e-4), \
        "guarded path diverged from the core path"

    def to_dry(sig):
        """Envelope correlation with the dry signal. Reverb scrambles phase, so
        comparing waveforms directly says little; what reverb actually destroys
        is the ENVELOPE — the gaps between syllables fill in. That is both what
        this measures and what the recogniser cares about."""
        def env(s):
            e = np.convolve(np.abs(s), np.ones(160) / 160, mode="same")
            return e - e.mean()
        a, b = env(sig), env(dry)
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))

    def tail_energy(sig):
        """Energy sitting in the pauses — that IS the smear we want gone."""
        quiet = gate < 0.05
        return float(np.mean(sig[quiet] ** 2) / (np.mean(sig ** 2) + 1e-12))

    c_wet, c_out = to_dry(wet), to_dry(out)
    e_wet, e_out = tail_energy(wet), tail_energy(out)
    print(f"  length preserved   {len(out) == len(wet)}")
    print(f"  peak preserved     {np.max(np.abs(out)):.3f} vs {np.max(np.abs(wet)):.3f}")
    print(f"  envelope vs dry    {c_wet:.3f} -> {c_out:.3f}")
    print(f"  energy in pauses   {e_wet*100:.2f}% -> {e_out*100:.2f}%")

    # Thresholds are effect SIZES, not "any improvement". An earlier version of
    # this check passed on a build where WPE was a complete no-op, because a
    # 0.01 % change still satisfies "strictly better". These bounds are set
    # below what the working implementation measures (env +0.032, pause -19 %
    # relative) and far above what a broken one can produce.
    ok = True
    if len(out) != len(wet):
        print("  [fail] length changed"); ok = False
    if c_out - c_wet < 0.02:
        print(f"  [fail] envelope barely moved ({c_out - c_wet:+.4f}, want >= +0.02)")
        ok = False
    if e_out > e_wet * 0.9:
        print(f"  [fail] reverb tail not reduced by >=10% relative "
              f"({e_out/e_wet - 1:+.1%})"); ok = False

    # must be harmless on audio that has no reverb at all
    c_clean = to_dry(dereverb(dry, taps=TAPS, delay=DELAY))
    print(f"  clean audio kept   {c_clean:.3f}")
    if c_clean < 0.95:
        print("  [fail] mangles already-clean audio"); ok = False

    # degenerate inputs must return, not raise
    for bad in (np.zeros(SR, np.float32), np.zeros(10, np.float32),
                np.ones(SR, np.float32) * 0.5):
        assert len(dereverb(bad)) == len(bad)
    print("  degenerate inputs  ok")
    print("[pass]" if ok else "[FAIL]")
    return 0 if ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(_selftest())
