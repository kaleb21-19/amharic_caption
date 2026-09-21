#!/usr/bin/env python3
"""robustness_report.py — how much worse is the model on REAL editing jobs?

The accuracy gate (tools/test/fixtures_real) is clean, single-speaker, read
speech. Amharic Captions is sold nationwide to editors cutting every kind of
content — weddings and events with a music bed, outdoor shoots with crowd
noise, phone-recorded vlogs, sermons in a reverberant hall, interviews with
two speakers. A model can look fine on read speech and still fall apart on
all of that, so this measures each condition separately.

No ground truth is invented: every condition is a DEGRADATION of a clip whose
transcript is already verified, so the reference text is unchanged and exact.
The one exception is `twospeaker`, which concatenates two verified clips with
a gap — the reference is simply the two transcripts joined, which is what a
turn-taking interview actually is.

    python3 tools/test/robustness_report.py                    # all conditions
    python3 tools/test/robustness_report.py --max-clips 5      # quick pass
    python3 tools/test/robustness_report.py --snr 5            # harsher mix
    python3 tools/test/robustness_report.py --keep-audio /tmp/rb   # listen

Needs a model: set AMH_MODEL_DIR (or run from an installed runtime).
Everything is seeded, so repeated runs degrade the audio identically.
"""
import argparse
import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

SR = 16000


# ---------------------------------------------------------------- degradations
def _rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))


def _mix_at_snr(speech, noise, snr_db):
    """Scale `noise` so speech sits `snr_db` above it, then mix and guard clipping."""
    if len(noise) < len(speech):
        noise = np.tile(noise, int(np.ceil(len(speech) / len(noise))))
    noise = noise[:len(speech)]
    target = _rms(speech) / (10.0 ** (snr_db / 20.0))
    mixed = speech + noise * (target / _rms(noise))
    peak = np.max(np.abs(mixed))
    return (mixed / peak * 0.97) if peak > 0.97 else mixed


def _pink_noise(n, rng):
    """1/f noise — a good stand-in for room tone, crowd rumble, HVAC, wind."""
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    scale = np.ones_like(freqs)
    scale[1:] = 1.0 / np.sqrt(freqs[1:])
    return np.fft.irfft(spec * scale, n=n).astype(np.float32)


def _music_bed(n, rng):
    """Synthetic music bed: a slow chord progression with harmonics, vibrato and
    a soft beat. NOT real music — it is a stand-in that reproduces what actually
    hurts ASR (sustained tonal energy overlapping the speech band, plus periodic
    transients). Treat the absolute numbers as indicative, the ranking as real."""
    t = np.arange(n) / SR
    out = np.zeros(n, dtype=np.float64)
    # I-vi-IV-V in A minor, two seconds per chord
    progression = [(220.0, 261.63, 329.63), (196.0, 246.94, 293.66),
                   (174.61, 220.0, 261.63), (164.81, 207.65, 246.94)]
    chord_len = int(2.0 * SR)
    for start in range(0, n, chord_len):
        end = min(start + chord_len, n)
        seg = slice(start, end)
        tt = t[seg] - t[start]
        chord = progression[(start // chord_len) % len(progression)]
        env = np.minimum(1.0, tt * 8.0) * np.exp(-tt * 0.35)   # pluck + decay
        for root in chord:
            for harm, amp in ((1, 1.0), (2, 0.45), (3, 0.22)):
                vib = 1.0 + 0.003 * np.sin(2 * np.pi * 5.0 * tt)
                out[seg] += amp * env * np.sin(2 * np.pi * root * harm * tt * vib)
    # soft kick every half second
    beat = np.zeros(n, dtype=np.float64)
    for k in range(0, n, SR // 2):
        dur = min(int(0.09 * SR), n - k)
        tt = np.arange(dur) / SR
        beat[k:k + dur] += np.sin(2 * np.pi * 60.0 * tt) * np.exp(-tt * 28.0)
    out = out / (np.max(np.abs(out)) + 1e-9) * 0.8 + beat * 0.25
    return (out + rng.standard_normal(n) * 0.002).astype(np.float32)


def _bandlimit_phone(x):
    """Narrowband 300-3400 Hz plus mild soft-clipping — a phone/handheld mic."""
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / SR)
    spec[(freqs < 300.0) | (freqs > 3400.0)] = 0.0
    y = np.fft.irfft(spec, n=len(x))
    y = np.tanh(y * 2.2) / 2.2                      # cheap handset compression
    return (y / (np.max(np.abs(y)) + 1e-9) * 0.9).astype(np.float32)


def _reverb(x, rng, rt60=0.45):
    """Convolve with a synthetic exponentially-decaying impulse response —
    a hall/church/large-room sound (sermons, event venues)."""
    n_ir = int(rt60 * SR)
    ir = rng.standard_normal(n_ir) * np.exp(-np.arange(n_ir) / (rt60 * SR / 6.0))
    ir[0] += 1.0                                     # keep the direct sound
    ir /= np.sqrt(np.sum(ir ** 2))
    y = np.convolve(x, ir)[:len(x)]
    return (y / (np.max(np.abs(y)) + 1e-9) * 0.9).astype(np.float32)


def build_conditions(speech, rng, snr_db):
    """Return {condition_name: degraded_audio} for one clip."""
    n = len(speech)
    return {
        "clean":  speech,
        "music":  _mix_at_snr(speech, _music_bed(n, rng), snr_db),
        "noise":  _mix_at_snr(speech, _pink_noise(n, rng), snr_db),
        "phone":  _bandlimit_phone(speech),
        "reverb": _reverb(speech, rng),
    }


# --------------------------------------------------------------------- reporting
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", default=os.path.join(HERE, "fixtures_real"))
    ap.add_argument("--max-clips", type=int, default=None)
    ap.add_argument("--snr", type=float, default=10.0,
                    help="speech-to-interference ratio in dB for music/noise "
                         "(default 10 — a typical music bed under narration)")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--keep-audio", default=None,
                    help="also write the degraded wavs here so you can listen")
    ap.add_argument("--dereverb", action="store_true",
                    help="run amh_dereverb.dereverb() on every clip before "
                         "transcribing, to measure whether it earns its place")
    ap.add_argument("--taps", type=int, default=40)
    ap.add_argument("--delay", type=int, default=2)
    ap.add_argument("--grid", action="store_true",
                    help="score with the Amharic-aware word-grid tokenizer "
                         "(wer.py --grid): agglutinative boundary disagreements "
                         "stop costing WER errors")
    ap.add_argument("--approx-vowel", action="store_true",
                    help="EXPERIMENT (not a gate default): also collapse the "
                         "schwa/a vowel-length spelling alternation; implies "
                         "--grid")
    args = ap.parse_args()

    import ethio_srt as E
    from wer import normalize, wer, cer, cer_nospace
    if args.grid or args.approx_vowel:
        from wer import grid_tokens, _load_lm
        args.grid = True
        _lm = _load_lm()
        if _lm is None:
            print("[warn] word-LM not found; grid mode falls back to plain "
                  "word scoring")
        tokenize = (lambda toks: grid_tokens(toks, _lm, args.approx_vowel)
                    if _lm else toks)
    else:
        tokenize = (lambda toks: toks)

    pre = (lambda a: a)
    if args.dereverb:
        import amh_dereverb
        pre = lambda a: amh_dereverb.dereverb(a, taps=args.taps, delay=args.delay)

    clips = sorted(g for g in os.listdir(args.fixtures) if g.endswith(".wav"))
    pairs = []
    for name in clips:
        wav_p = os.path.join(args.fixtures, name)
        txt_p = wav_p[:-4] + ".txt"
        if not os.path.isfile(txt_p):
            continue                      # no verified transcript -> unusable
        truth = open(txt_p, encoding="utf-8").read().strip()
        if truth:
            pairs.append((name, wav_p, truth))
    if args.max_clips:
        pairs = pairs[:args.max_clips]
    if not pairs:
        print("[fail] no clips with ground truth in " + args.fixtures)
        raise SystemExit(2)

    if args.keep_audio:
        os.makedirs(args.keep_audio, exist_ok=True)

    print(f"[info] {len(pairs)} verified clips x 5 conditions "
          f"(music/noise mixed at {args.snr:g} dB SNR, seed {args.seed})"
          + (f" [DEREVERB taps={args.taps} delay={args.delay}]"
             if args.dereverb else "")
          + ("  scorer: Amharic word-grid"
             + (" + vowel-length approx [EXPERIMENT]" if args.approx_vowel
                else "") if args.grid else ""))
    engine = E.load_pipeline()

    order = ["clean", "music", "noise", "phone", "reverb", "twospeaker"]
    acc = {c: {"wer": 0.0, "cer": 0.0, "nos": 0.0, "n": 0} for c in order}

    def score(cond, truth, audio, tag):
        audio = pre(audio)
        text, spans, fdur = engine.transcribe(audio)
        cues = E.make_cues("grouped", 3, spans, fdur, text, engine.glyphs, max_chars=42)
        hyp = " ".join(c[0] for c in cues)
        r, h = tokenize(normalize(truth)), tokenize(normalize(hyp))
        a = acc[cond]
        a["wer"] += wer(r, h); a["cer"] += cer(r, h); a["nos"] += cer_nospace(r, h)
        a["n"] += 1
        if args.keep_audio:
            sf.write(os.path.join(args.keep_audio, f"{tag}__{cond}.wav"), audio, SR)

    for i, (name, wav_p, truth) in enumerate(pairs):
        rng = np.random.default_rng(args.seed + i)   # per-clip, still deterministic
        speech = E.read_wav(wav_p)
        for cond, audio in build_conditions(speech, rng, args.snr).items():
            score(cond, truth, audio, name[:-4])
        print(f"  [{i+1}/{len(pairs)}] {name}", flush=True)

    # Two-speaker turn-taking: clip A, a beat of silence, then clip B. The
    # reference is both transcripts joined — exactly what an interview is.
    gap = np.zeros(int(0.35 * SR), dtype=np.float32)
    for i in range(0, len(pairs) - 1, 2):
        (_, wav_a, ta), (nb, wav_b, tb) = pairs[i], pairs[i + 1]
        both = np.concatenate([E.read_wav(wav_a), gap, E.read_wav(wav_b)])
        score("twospeaker", ta + " " + tb, both, f"pair{i//2}")

    print("\n  condition     clips     WER      CER   CER-nospace   vs clean")
    print("  " + "-" * 62)
    base = None
    for cond in order:
        a = acc[cond]
        if not a["n"]:
            continue
        w, c, x = a["wer"]/a["n"], a["cer"]/a["n"], a["nos"]/a["n"]
        if cond == "clean":
            base = w
            delta = "     —"
        else:
            delta = f"{(w - base) * 100:+6.1f} pp"
        print(f"  {cond:<12} {a['n']:>5}   {w*100:5.1f}%   {c*100:5.1f}%   "
              f"{x*100:9.1f}%   {delta}")
    print("\n  Read the 'vs clean' column: that is how much accuracy a real")
    print("  editing job costs you versus the clean read speech in the gate.")
    if args.keep_audio:
        print(f"\n  degraded audio written to {args.keep_audio}")


if __name__ == "__main__":
    main()
