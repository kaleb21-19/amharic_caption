#!/usr/bin/env python3
"""Standalone pure-numpy Kaldi-style log-mel feature extractor for wav2vec2-bert.

This mirrors transformers' SeamlessM4TFeatureExtractor (the extractor the
Ethio-ASR model was trained with) using only numpy — no torch, no transformers,
no scipy at runtime. The mel filter bank + window are precomputed once at build
time (tools/make_model_ct2_int8.sh) and shipped as .npy files next to the model.

Pipeline (identical to HF SeamlessM4TFeatureExtractor for this model):
  1. Kaldi-style log-mel fbank              -> (T, 80)
  2. per-mel-bin normalization (ddof=1)     -> (T, 80)
  3. pad T up to even
  4. stride-2 reshape (T,80) -> (T//2, 160)
Output: input features of shape (1, T//2, 160) float32, as CTranslate2's
wav2vec2-bert encode() expects.
"""
import numpy as np
from pathlib import Path

__all__ = ["MelExtractor", "load_assets"]


def load_assets(asset_dir):
    """Load precomputed mel filter bank (257,80) + hann window (400,) as float32."""
    ad = Path(asset_dir)
    mel_filters = np.load(str(ad / "mel_filters.npy")).astype(np.float32)
    window = np.load(str(ad / "window.npy")).astype(np.float32)
    return mel_filters, window


def _log_mel_fbank(waveform, window, mel_filters):
    """Kaldi-style log-mel filterbank. waveform: mono 16k float32. -> (T, 80)."""
    frame_length = 400
    hop_length = 160
    fft_length = 512
    power = 2.0
    preemphasis = 0.97
    mel_floor = 1.192092955078125e-07

    sig = waveform.astype(np.float64) * (2 ** 15)  # Kaldi: 16-bit signed scaling
    n_frames = 1 + (len(sig) - frame_length) // hop_length
    if n_frames < 1:
        n_frames = 1
    frames = np.zeros((n_frames, frame_length), dtype=np.float64)
    for i in range(n_frames):
        s = i * hop_length
        fr = sig[s : s + frame_length]
        frames[i, : len(fr)] = fr

    # remove DC offset per frame
    frames = frames - frames.mean(axis=1, keepdims=True)
    # pre-emphasis
    pre = np.empty_like(frames)
    pre[:, 0] = frames[:, 0]
    pre[:, 1:] = frames[:, 1:] - preemphasis * frames[:, :-1]
    frames = pre
    # window (len == frame_length)
    frames = frames * window

    spec = np.fft.rfft(frames, n=fft_length, axis=1)   # (T, 257)
    mag = np.abs(spec) ** power
    mel = mag @ mel_filters                            # (T, 80)
    mel = np.maximum(mel, mel_floor)
    mel = np.log(mel)
    return mel.astype(np.float32)


class MelExtractor:
    def __init__(self, asset_dir):
        self.mel_filters, self.window = load_assets(asset_dir)

    def __call__(self, wav, sampling_rate=16000):
        wav = np.asarray(wav, dtype=np.float32).reshape(-1)
        mel = _log_mel_fbank(wav, self.window, self.mel_filters)  # (T,80)
        mel = (mel - mel.mean(axis=0)) / np.sqrt(mel.var(axis=0, ddof=1) + 1e-7)
        T = mel.shape[0]
        if T % 2 != 0:
            mel = np.pad(mel, ((0, 1), (0, 0)), mode="constant", constant_values=1.0)
            T += 1
        mel = mel.reshape(T // 2, -1)  # (T//2, 160)
        return mel[None].astype(np.float32)
