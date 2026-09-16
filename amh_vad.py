#!/usr/bin/env python3
"""Streaming speech-segment detector (Silero VAD v4 ONNX, CPU-only).

Exposes a single `speech_segments(wav, sr=16000, threshold=0.5)` that returns
a list of (start_s, end_s) speech regions in the ORIGINAL audio timeline. It
is a zero-torch, numpy + onnxruntime reimplementation of the silero-vad
get_speech_timestamps() loop so the shipped runtime keeps its tiny footprint.

Used by ethio_srt.py to (a) skip music-only / silence regions before CT2
encode (the encode is ~88% of runtime) and (b) avoid hallucinated captions
over non-speech. On any missing dependency the module degrades to
`speech_segments` returning the whole clip ([0, dur]) — the no-VAD behavior.
"""
import os

import numpy as np

_MODEL_HINTS = (
    os.environ.get("AMH_VAD_MODEL"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "silero_vad.onnx"),
    "silero_vad.onnx",
)

_WINDOW = 512  # 512 samples @16kHz = 32ms
_THRESHOLD = float(os.environ.get("AMH_VAD_THRESHOLD", "0.5"))

_session = None


def _load_session():
    """Load the ONNX session once (lazy, thread-safe enough for a single
    worker). Returns None if the model file or onnxruntime is unavailable."""
    global _session
    if _session is not None:
        return _session
    try:
        import onnxruntime as ort  # noqa: E402
    except Exception:
        _session = False
        return None
    for cand in _MODEL_HINTS:
        if cand and os.path.isfile(cand):
            try:
                opts = ort.SessionOptions()
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                opts.intra_op_num_threads = max(1, int(os.environ.get("AMH_VAD_THREADS", "1")))
                _session = ort.InferenceSession(
                    cand, opts, providers=["CPUExecutionProvider"]
                )
                return _session
            except Exception:
                continue
    _session = False
    return None


def _probabilities(wav):
    """Run the VAD over the whole signal; return (probs, n_windows, window_s)."""
    sess = _load_session()
    if sess is None:
        return None
    total = len(wav)
    n = 0
    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros((2, 1, 64), dtype=np.float32)
    out = []
    pos = 0
    while pos < total:
        chunk = wav[pos:pos + _WINDOW]
        n = len(chunk)
        if n < _WINDOW:
            chunk = np.pad(chunk, (0, _WINDOW - n))
        chunk = chunk.reshape(1, _WINDOW).astype(np.float32)
        sr = np.array(16000, dtype=np.int64)
        o, hn, cn = sess.run(None, {"input": chunk, "sr": sr, "h": h, "c": c})
        h = hn
        c = cn
        out.append(float(o[0, 0]))
        pos += _WINDOW
    return np.asarray(out, dtype=np.float32), len(out), _WINDOW


def speech_segments(wav, sr=16000, threshold=None, min_speech=0.20,
                    min_silence=0.10, margin=0.05):
    """Return list of (start_s, end_s) in the original timeline, or [0, len/sr]
    when VAD is unavailable so callers keep current behavior. `wav` must be
    float32 mono, ideally 16kHz (an interp to 16k happens if sr != 16000).
    """
    if sr != 16000:
        ratio = 16000 / float(sr)
        n = int(len(wav) * ratio)
        wav = np.interp(
            np.linspace(0, len(wav) - 1, n), np.arange(len(wav)), wav
        ).astype(np.float32)
        sr = 16000
    res = _probabilities(wav)
    if res is None:
        return [(0.0, len(wav) / float(sr))]
    probs, n_windows, window_s = res
    threshold = threshold if threshold is not None else _THRESHOLD

    max_silence_s = float(min_silence)
    min_speech_s = float(min_speech)
    margin_s = float(margin)

    silence_win = max(1, int(round(max_silence_s / (window_s / float(sr)))))
    speech_win = max(1, int(round(min_speech_s / (window_s / float(sr)))))

    triggered = False
    speech_win_i = 0
    segments = []
    silence_run = 0

    for i, p in enumerate(probs):
        if not triggered:
            if p >= threshold:
                triggered = True
                speech_win_i = i
            continue
        if p >= threshold:
            silence_run = 0
            continue
        silence_run += 1
        if silence_run < silence_win:
            continue
        # enough consecutive silence: close the segment if it is long enough
        last_speech_i = i - silence_run  # index of the last speech window
        seg_len_s = (last_speech_i - speech_win_i + 1) * window_s / float(sr)
        if seg_len_s >= min_speech_s:
            segments.append((
                speech_win_i * window_s / float(sr),
                (last_speech_i + 1) * window_s / float(sr),
            ))
        triggered = False
        silence_run = 0

    if triggered:
        seg_len_s = (len(probs) - speech_win_i) * window_s / float(sr)
        if seg_len_s >= min_speech_s:
            segments.append((
                speech_win_i * window_s / float(sr),
                len(probs) * window_s / float(sr),
            ))

    if not segments:
        return [] if len(wav) == 0 else [(0.0, len(wav) / float(sr))]

    # pad each segment by margin and merge overlapping/nearby segments
    merged = []
    for s, e in segments:
        s = max(0.0, s - margin_s)
        e = min(len(wav) / float(sr), e + margin_s)
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged