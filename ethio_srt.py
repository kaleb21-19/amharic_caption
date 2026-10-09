#!/usr/bin/env python3
"""Transcribe Amharic audio -> accurate text + SRT using the pinned production
snapwre/hohe-asr-amharic model (with the legacy badrex checkpoint still usable
for offline regression runs via AMH_MODEL_DIR).

Two engines, auto-selected by what the model directory contains:

  * CTranslate2 INT8  (default / shipped): model dir has model_meta.json.
      - tiny runtime (ctranslate2 + numpy + soundfile only; no torch)
      - per-frame CTC logits come straight out of CT2's Wav2Vec2Bert.encode()
      - mel features via amh_mel.MelExtractor (pure numpy)
  * Torch/transformers (dev fallback): model dir has config.json + safetensors.
      - original pipeline (AutoModelForCTC); kept so the dev repo and CI work
        without a pre-converted CT2 model.

CTC model has no native timestamps, so we derive word timings via CTC
frame-level forced alignment (collapse repeats, drop blank frames).
"""
import sys
import os
import re
import json
import warnings

warnings.filterwarnings("ignore")

# A persistent server (--server) holds the model in memory across requests; the
# heavyweight loaders print tqdm progress that would corrupt our JSON-line
# stdout protocol, so disable it up front.
os.environ.setdefault("TQDM_DISABLE", "1")

# ----- thread policy ---------------------------------------------------------
# numpy (OpenBLAS) and CTranslate2 (MKL/OpenMP on x64) can both spin up
# thread pools and thrash each other. Pin both to the same cap so inference
# stays efficient whether the panel spawns one or several workers. This must
# run BEFORE numpy/ctranslate2 import.
#
# The cap is os.cpu_count() — every core the OS advertises. Whether that is
# optimal is an OPEN QUESTION, not a settled one:
#   * On an M4 (4 performance + 6 efficiency cores), a 60s in-process benchmark
#     showed 4 threads ~15% FASTER than 10, consistent with efficiency cores
#     stalling the fast ones at each sync point.
#   * The same comparison on a 300s end-to-end run showed the OPPOSITE — 10
#     threads faster in both reps.
#   * Run-to-run drift on an identical config was ~28% (132s vs 169s), i.e.
#     larger than the effect. The box was thermally saturated.
# So macOS keeps the advertised count.
#
# Windows x64 (measured 2026-09-27, 8-core / 16-thread CPU, a real 5-minute
# recording, configs interleaved, 2 reps each after a warm-up):
#     16 threads  avg 122 s      8 threads  avg 100 s      4 threads  avg 135 s
# os.cpu_count() counts hyper-threads, and the int8 matmuls run best on the
# PHYSICAL cores (~18% faster), which also leaves half the CPU to Premiere.
# The stdlib cannot see physical cores, so on Windows with 8+ logical CPUs we
# assume 2-way SMT and halve. Smaller machines keep every thread.
#
# AMH_THREADS overrides the cap — for benchmarking (tools/test/bench_threads.py)
# and for users who want to leave CPU headroom for Premiere while a batch runs.
def _thread_cap():
    import os as _os
    try:
        env = _os.environ.get("AMH_THREADS", "").strip()
        if env:
            return max(1, int(env))
    except Exception:
        pass
    try:
        n = _os.cpu_count() or 4
        if hasattr(_os, "sched_getaffinity"):
            # cgroup/taskset limits are a hard ceiling — never exceed them.
            n = min(n, len(_os.sched_getaffinity(0)))
        if sys.platform == "win32" and n >= 8:
            n //= 2
        return max(1, n)
    except Exception:
        return 4


_THREADS = str(_thread_cap())
os.environ.setdefault("OMP_NUM_THREADS", _THREADS)
os.environ.setdefault("MKL_NUM_THREADS", _THREADS)
os.environ.setdefault("OPENBLAS_NUM_THREADS", _THREADS)

# Windows console/stdio may default to cp1252, which cannot encode the Amharic
# transcript we print to stdout. Force UTF-8 so the panel can read it back.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
try:
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402


def _find_model():
    """Locate the ASR model relative to this script. AMH_MODEL_DIR overrides."""
    env = os.environ.get("AMH_MODEL_DIR")
    if env and os.path.isdir(env):
        return env
    base = os.path.dirname(os.path.abspath(__file__))
    # Lite packages keep the model outside the extension (downloaded once into
    # a per-user folder); amh_model knows where, and rejects a stale bundle.
    try:
        import amh_model
        if amh_model.load_manifest(os.path.join(base, "model_manifest.json")):
            found = amh_model.resolve(base)
            if found:
                return found
    except Exception:
        pass
    for cand in ("model", "ethio-asr"):
        p = os.path.join(base, cand)
        if os.path.isfile(os.path.join(p, "config.json")) or os.path.isfile(
            os.path.join(p, "model_meta.json")
        ):
            return p
    return os.path.join(base, "model")


MODEL_DIR = _find_model()


# --------------------------------------------------------------------------
# engine selection
# --------------------------------------------------------------------------
def _use_ct2():
    return os.path.isfile(os.path.join(MODEL_DIR, "model_meta.json"))


# load numpy/ct2 lazily; torch only if needed (dev fallback keeps the repo's
# dev venv usable, but the shipped CT2 runtime never imports torch).
def _load_ct2():
    import ctranslate2  # noqa: E402
    return ctranslate2


def _load_torch():
    import torch  # noqa: E402
    from transformers import AutoProcessor, AutoModelForCTC  # noqa: E402
    return torch, AutoProcessor, AutoModelForCTC


def load_pipeline():
    """Return an engine handler object with a `.transcribe(wav)` method."""
    if _use_ct2():
        return _CT2Engine(MODEL_DIR)
    return _TorchEngine(MODEL_DIR)


def _preflight_audio(wav):
    """Reject audio that must not reach the network. Returns True when the
    buffer is effectively silence (caller returns an empty transcript).

    1. Clips shorter than one mel frame (35 ms) are a hard 'audio too short'
       error, mirroring MelExtractor's guard so behavior is identical whether
       the check fires here or in the mel stage. Every path (single-shot,
       windowed, server, batch) funnels through _transcribe_one, so the
       ordering is stable.
    2. Due to a Silero quirk, constant-zero input is VAD-flagged as 'active'
       (silence.wav -> [(0.0, dur)]), and the CTC model then hallucinates
       tokens on near-zero features. Energy floor: RMS below AMH_SILENCE_RMS
       (default 0.0001 ~ -80 dBFS) is treated as no speech and yields an empty
       transcript instead of fabricated captions.
    """
    from amh_mel import MelExtractor
    if len(wav) < MelExtractor.MIN_SAMPLES:
        raise ValueError(
            "audio too short (%d samples): need >= %d (400 frame + 160 hop) "
            "for at least two mel frames" % (len(wav), MelExtractor.MIN_SAMPLES))
    rms = float(np.sqrt((np.asarray(wav, dtype=np.float32) ** 2).mean()))
    floor = float(os.environ.get("AMH_SILENCE_RMS", "0.0001"))
    return rms < floor


class _CT2Engine:
    """CTranslate2 INT8 engine (shipped runtime)."""

    def __init__(self, model_dir):
        ctranslate2 = _load_ct2()
        from amh_mel import MelExtractor  # noqa: E402
        with open(os.path.join(model_dir, "model_meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.blank_id = int(meta.get("blank_id", 408))
        threads = max(1, int(_THREADS))
        self.workers = _workers_for(threads)
        self.model = ctranslate2.models.Wav2Vec2Bert(
            model_dir, device="cpu", compute_type="int8",
            inter_threads=self.workers,
            intra_threads=max(1, threads // self.workers),
        )
        self.prefetch = _Prefetch(self, self.workers) if self.workers > 1 else None
        self.mel = MelExtractor(model_dir)
        # lm_head projection (1024 hidden -> vocab logits): CT2's encode()
        # returns the final CTC logits directly on arm64 but raw 1024-wide
        # hidden states on x86_64/Windows, so we project whenever the last
        # dim is 1024 — checked by actual size, NOT by comparing against a
        # hardcoded vocab count (a model with a different vocab size, e.g.
        # a bigger multilingual checkpoint, would silently break that check).
        lw = os.path.join(model_dir, "lm_head_w.npy")
        lb = os.path.join(model_dir, "lm_head_b.npy")
        self.lm_w = np.load(lw).astype(np.float32) if os.path.isfile(lw) else None
        self.lm_b = np.load(lb).astype(np.float32) if os.path.isfile(lb) else None
        # glyph id<->token from the HF vocab.json (matches the model output ids)
        with open(os.path.join(model_dir, "vocab.json"), encoding="utf-8") as f:
            raw = json.load(f)
        self.glyphs = {int(tid): tok for tok, tid in raw.items()}
        self._skip = {"[PAD]", "[UNK]", "<s>", "</s>"}
        self._masked = _masked_token_ids(self.glyphs)
        # For the word-aware decoder: tokens that are never caption text
        # (padding, language tags, masked letters) and the word-space tokens.
        from ctc_beam import _is_control_glyph
        self._skip_ids = {t for t, g in self.glyphs.items()
                          if g in self._skip or _is_control_glyph(g)} | set(self._masked or [])
        self._space_ids = {t for t, g in self.glyphs.items() if g in ("|", "፠", "፡")}

    def transcribe(self, wav):
        # Very long audio (e.g. a 5-minute clip) makes the conformer attention
        # allocate O(T^2) memory and gets the process OOM-killed. Window it.
        return _windowed_transcribe(self, wav)

    def _encode(self, wav):
        """Mel features -> model -> CTC logits (1, T', vocab). Thread-safe:
        the parallel-window workers call it side by side."""
        _need_permit()
        ctranslate2 = _load_ct2()
        feats = self.mel(wav)  # (1, T', 160)
        out = self.model.encode(ctranslate2.StorageView.from_array(feats))
        logits = np.asarray(out, dtype=np.float32)  # (1, T', vocab) or (1, T', 1024)
        if logits.shape[-1] == 1024 and self.lm_w is not None:
            logits = logits @ self.lm_w.T + self.lm_b  # -> (1, T', vocab)
        return logits

    def _transcribe_one(self, wav):
        _need_permit()
        # Logits a parallel worker already computed for this piece (taken
        # FIRST so a scheduled piece is always collected, even when silent).
        ready = self.prefetch.take(wav) if self.prefetch is not None else None
        if _preflight_audio(wav):
            return "", [], 1.0 / 16000.0
        if ready is not None:
            return self._align(wav, ready)
        ctranslate2 = _load_ct2()
        trimmed, seg_table = _vad_trim(wav)
        if seg_table:
            feats = self.mel(trimmed)  # (1, T', 160)
            out = self.model.encode(ctranslate2.StorageView.from_array(feats))
            logits = np.asarray(out, dtype=np.float32)  # (1, T', vocab) or (1, T', 1024)
            if logits.shape[-1] == 1024 and self.lm_w is not None:
                logits = logits @ self.lm_w.T + self.lm_b  # -> (1, T', vocab)
            text, spans, frame_dur = self._align(trimmed, logits)
            # Remap the token frame indices from the VAD-trimmed buffer back
            # onto the ORIGINAL audio timeline so caption times stay correct:
            # each span (tok, s, e) in trimmed-frame space -> original samples.
            spans = _remap_spans(spans, frame_dur, seg_table)
            return text, spans, 1.0 / 16000.0
        return self._align(wav, self._encode(wav))

    def _align(self, wav, logits):
        _need_permit()
        _count_audio(len(wav))
        T = logits.shape[1]
        frame_dur = (len(wav) / 16000) / T
        if self._masked:
            logits = np.array(logits, dtype=np.float32)
            logits[..., self._masked] = -1e9
        # Decoding. Greedy argmax is the DEFAULT as of 2026-09-20, because
        # measuring beam search against it on the 19 real Common Voice clips
        # showed beam is not worth its cost:
        #     beam    1.95 s/clip   45.3% WER
        #     greedy  1.72 s/clip   44.6% WER
        # i.e. 13% slower for no accuracy gain (the 0.7pp is inside the noise
        # of 19 clips). Sweeping AMH_BEAM_TOP_K/AMH_BEAM_WIDTH across every
        # value changed the WER by exactly nothing, which says the CTC
        # posteriors are peaked enough that the search has nothing to find —
        # the acoustic model is the limit, not the decoder. Caption timing is
        # byte-identical either way (verified on real clips), so nothing else
        # regresses.
        #   AMH_BEAM=1       opts back into beam search.
        #   AMH_BEAM_TOP_K   bounds per-frame candidates (default 16).
        #   AMH_BEAM_WIDTH   beam width (default 24; smaller is faster).
        #   AMH_LM_LAMBDA    weight for word-LM shallow fusion at word
        #                    boundaries (default 0 = disabled; the LM isn't
        #                    even loaded unless this is > 0). Requires beam.
        if os.environ.get("AMH_BEAM", "0") != "0":
            try:
                from ctc_beam import ctc_beam_decode
                top_k = int(os.environ.get("AMH_BEAM_TOP_K", "16"))
                bwidth = int(os.environ.get("AMH_BEAM_WIDTH", "24"))
                lambda_lm = float(os.environ.get("AMH_LM_LAMBDA", "0"))
                lm = None
                if lambda_lm > 0:
                    from amh_lm import get_default_lm
                    lm = get_default_lm()
                beam_text, segs = ctc_beam_decode(
                    np.asarray(logits, dtype=np.float32),
                    self.blank_id,
                    glyphs=self.glyphs,
                    beam_width=bwidth,
                    top_k=top_k,
                    lm=lm,
                    lambda_lm=lambda_lm,
                )
                spans = list(segs)
                return beam_text, spans, frame_dur
            except Exception:
                # Fall back to greedy if beam search is unavailable/unexpected.
                pass
        # Word-aware decode (amh_decode): the best few letter sequences scored
        # with the Amharic word / word-pair list, then placed back on the
        # audio by forced alignment. Greedy is the fallback (and AMH_DECODE=
        # greedy), so a missing word list or any error changes nothing.
        try:
            from amh_decode import decode as _word_decode
            dec = _word_decode(logits, self.blank_id, self.glyphs, self._skip_ids, self._space_ids)
        except Exception:
            dec = None
        if dec is not None:
            toks, spans = dec
            text = "".join(" " if t in self._space_ids else self.glyphs.get(t, "") for t in toks)
            return " ".join(text.split()), _spans_with_conf(spans, logits), frame_dur
        argmax = np.argmax(logits[0], axis=-1).tolist()
        text = self._decode(argmax)
        spans, _ = ctc_align(logits, self.blank_id, frame_dur, None)
        return text, _spans_with_conf(spans, logits), frame_dur

    def _decode(self, ids):
        # CTC decoding: collapse consecutive identical tokens before joining.
        out = []
        prev = None
        for i in ids:
            t = self.glyphs.get(int(i), "")
            if t in self._skip or not t:
                prev = None
                continue
            if t == prev:
                continue
            prev = t
            out.append(t)
        s = "".join(out).replace("|", " ").replace("\u1360", " ").replace("\u1361", " ")
        return " ".join(s.split())


class _TorchEngine:
    """Original transformers/torch engine (dev fallback)."""

    def __init__(self, model_dir):
        torch, AutoProcessor, AutoModelForCTC = _load_torch()
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        # The dev fallback is still local-only. If a model directory is
        # incomplete, fail instead of letting transformers silently fetch
        # weights from the network during a transcription request.
        self.processor = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
        model = AutoModelForCTC.from_pretrained(model_dir, local_files_only=True)
        if os.environ.get("AMH_USE_FP32") != "1":
            model = model.half()
        self.model = model.to(self.device).eval()
        self.blank_id = self.processor.tokenizer.pad_token_id
        self.torch = torch
        self.glyphs = {
            int(tid): ch for ch, tid in self.processor.tokenizer.get_vocab().items()
        }

    def transcribe(self, wav):
        return _windowed_transcribe(self, wav)

    def _transcribe_one(self, wav):
        _need_permit()
        if _preflight_audio(wav):
            return "", [], 1.0 / 16000.0
        _count_audio(len(wav))
        inputs = self.processor(wav, sampling_rate=16000, return_tensors="pt")
        key = "input_features" if "input_features" in inputs else "input_values"
        feats = inputs[key].to(self.device)
        try:
            feats = feats.to(next(self.model.parameters()).dtype)
        except StopIteration:
            pass
        with self.torch.no_grad():
            logits = self.model(**{key: feats}).logits
        logits = logits.detach().cpu().numpy()
        T = logits.shape[1]
        frame_dur = (len(wav) / 16000) / T
        spans, _ = ctc_align(logits, self.blank_id, frame_dur, None)
        argmax = np.argmax(logits[0], axis=-1).tolist()
        text = self.processor.tokenizer.decode(argmax)
        return text, spans, frame_dur


# --------------------------------------------------------------------------
# SRT / timing helpers (identical for both engines)
# --------------------------------------------------------------------------
def format_ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms >= 1000:
        ms -= 1000
        seconds += 1
    s = int(seconds) % 60
    m = (int(seconds) // 60) % 60
    h = int(seconds) // 3600
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


_MASK_CLASSES = {
    "latin": lambda t: len(t) == 1 and "a" <= t <= "z",
    "digits": lambda t: len(t) == 1 and "0" <= t <= "9",
    "symbols": lambda t: t in set("!#$%&'*+,-.=?@€"),
}


def _masked_token_ids(glyphs):
    """Token ids the decoder may never emit.

    The vocab carries Latin a-z, 0-9 and ASCII symbols, and on Amharic speech
    the model reaches for them mid-word — "አምስት" came out as "5mሰት", the
    year as "boሁለትሺi0ህ". Nothing an Amharic caption needs lives there, so
    those columns are removed from the logits and the next-best (Ethiopic)
    token wins. AMH_TOKEN_MASK is a comma list of classes (latin, digits,
    symbols); empty disables the mask.
    """
    spec = os.environ.get("AMH_TOKEN_MASK", "latin,digits,symbols")
    tests = [_MASK_CLASSES[c] for c in (s.strip() for s in spec.split(",")) if c in _MASK_CLASSES]
    return sorted(tid for tid, tok in glyphs.items() if any(f(tok) for f in tests))


# ── "doubtful word" marks for the review screen ─────────────────────────────
# The model knows when it is unsure. Per letter we keep the best softmax
# probability of its CTC span; a word's confidence is its WEAKEST letter.
# Measured on the reference clips (2026-09-29): words under 0.6 were wrong
# 82% of the time and caught 42% of all errors, so the editor checks the
# orange words first. Costs <1% of transcription time; the caption TEXT is
# unchanged (the marks travel in a sidecar next to the SRT).
# Re-measured on 935 clips: under 0.6 marked only 5% of words (catching 15%
# of errors); under 0.75 marks ~10%, 61-83% of them wrong, catching 28-53%.
DOUBT_THRESHOLD = float(os.environ.get("AMH_DOUBT", "0.75"))


class Span(tuple):
    """(tok, start, end) that also carries the model's confidence (.conf).
    Unpacks as a normal 3-tuple, so every existing caller keeps working."""
    def __new__(cls, tok, s, e, conf=1.0):
        t = tuple.__new__(cls, (tok, s, e))
        t.conf = conf
        return t


class Cue(tuple):
    """(text, start, end) plus .doubt: the words in it the model was unsure of."""
    def __new__(cls, text, s, e, doubt=()):
        t = tuple.__new__(cls, (text, s, e))
        t.doubt = list(doubt)
        return t


def _span_conf(sp):
    return getattr(sp, "conf", 1.0)


def _cue_doubt(c):
    return getattr(c, "doubt", [])


def _spans_with_conf(spans, logits):
    """Attach each span's peak probability (softmax over the vocab)."""
    if not spans:
        return spans
    x = np.asarray(logits, dtype=np.float32)[0]
    x = x - x.max(axis=-1, keepdims=True)
    p = np.exp(x)
    top = p.max(axis=-1) / p.sum(axis=-1)
    return [Span(tok, s, e, float(top[s:e + 1].max())) for tok, s, e in spans]


def _unit_confs(spans, frame_dur, glyphs):
    """Letter-level (start_sec, end_sec, conf), sorted by start."""
    from ctc_beam import _is_control_glyph
    out = []
    for sp in spans:
        tok, s, e = sp
        ch = glyphs.get(tok)
        if ch is None or _is_control_glyph(ch) or ch in ("|", "\u1360", "\u1361"):
            continue
        out.append((s * frame_dur, (e + 1) * frame_dur, _span_conf(sp)))
    out.sort()
    return out


def _attach_doubts(cues, words, units):
    """Give every cue the list of its words whose weakest letter is below the
    threshold. Words and cues keep their (post-correction) times, so letters
    are matched by time, not by text."""
    import bisect
    if not units or not any(u[2] < DOUBT_THRESHOLD for u in units):
        return [Cue(t, s, e) for t, s, e in cues]
    starts = [u[0] for u in units]
    doubt_words = []  # (start, text)
    for text, ws, we in words:
        i = max(0, bisect.bisect_left(starts, ws) - 1)
        low = 1.0
        while i < len(units) and units[i][0] < we:
            us, ue, c = units[i]
            if ue > ws and c < low:
                low = c
            i += 1
        if low < DOUBT_THRESHOLD:
            doubt_words.append((ws, text.strip("።፣፤፥፦፧፨?!.,")))
    out = []
    for text, cs, ce in cues:
        d = [w for ws, w in doubt_words if cs - 1e-6 <= ws < ce + 1e-6 and w and w in text]
        out.append(Cue(text, cs, ce, d))
    return out


def ctc_align(logits, blank_id, frame_dur, text):
    """Return list of (char, start_sec, end_sec) from CTC logits + decoded text."""
    pred_ids = np.asarray(logits).argmax(axis=-1)[0].tolist()
    spans = []
    i = 0
    n = len(pred_ids)
    while i < n:
        tok = pred_ids[i]
        if tok == blank_id:
            i += 1
            continue
        start = i
        while i < n and pred_ids[i] == tok:
            i += 1
        end = i - 1
        spans.append((tok, start, end))
    return spans, frame_dur


def _lm_split_words(words, word_units):
    """Word-LM resegmentation of the decoded word stream (see amh_lm.py).

    Only rescues OOV glued tokens (e.g. "አሀይድጠብቁኝ" -> two words) where the
    bundled Amharic word-LM clearly prefers a split; known words are never
    touched. Disabled with AMH_LM=0 or when the LM file is absent.
    """
    if os.environ.get("AMH_LM", "1") != "1":
        return words
    try:
        from amh_lm import get_default_lm
        lm = get_default_lm()
        if not lm.available():
            return words
    except Exception:
        return words
    out = []
    n = len(words)
    for i, (text, s, e) in enumerate(words):
        left = words[i - 1][0] if i > 0 else None
        right = words[i + 1][0] if i + 1 < n else None
        parts = lm.split_word(text, left=left, right=right)
        if len(parts) == 1:
            out.append((text, s, e))
            continue
        units_this = word_units[i]
        pos = 0
        for p in parts:
            pl = len(p)
            seg = units_this[pos:pos + pl]
            if not seg:
                continue
            pos += pl
            out.append((p, seg[0][1], seg[-1][2]))
    return out


def get_words(spans, frame_dur, glyphs):
    from ctc_beam import _is_control_glyph
    units = []
    for tok, s, e in spans:
        ch = glyphs.get(tok)
        if ch is None or _is_control_glyph(ch):
            continue
        units.append((ch, s * frame_dur, (e + 1) * frame_dur))

    words = []
    word_units = []
    cur = ""
    cur_start = None
    cur_u = []
    for ch, s, e in units:
        # "|" is the CTC space token; U+1361 (፡) is the model's Ethiopic
        # word-space token. BOTH are word boundaries — treating only "|" as
        # a boundary glued "አማርኛ፡ቋንቋ" into one token. U+1360 (፠) is the
        # Ethiopic word-space alternative; never part of a real word either.
        if ch in ("|", "\u1360", "\u1361"):
            if cur:
                words.append((cur, cur_start, e))
                word_units.append(cur_u)
                cur = ""
                cur_start = None
                cur_u = []
            continue
        if cur_start is None:
            cur_start = s
        cur += ch
        cur_u.append((ch, s, e))
    if cur:
        words.append((cur, cur_start, units[-1][2]))
        word_units.append(cur_u + [])
    return _lm_split_words(words, word_units)


def group_word_cues(words, max_chars=200):
    max_chars = int(max_chars)
    cues = []
    MAX_DUR = 1.5
    for w_text, w_s, w_e in words:
        txt = w_text.strip()
        if not txt:
            continue
        if len(txt) > max_chars:
            txt = txt[:max_chars]
        if w_e - w_s > MAX_DUR:
            w_e = w_s + MAX_DUR
        cues.append((txt, w_s, w_e))
    return cues


def group_n_cues(words, n, max_chars=200):
    max_chars = int(max_chars)
    cues = []
    buf = []
    buf_start = None
    buf_end = None
    buf_chars = 0

    def flush():
        nonlocal buf, buf_start, buf_end, buf_chars
        if buf:
            cues.append((" ".join(buf), buf_start, buf_end))
        buf, buf_start, buf_end, buf_chars = [], None, None, 0

    for w_text, w_s, w_e in words:
        txt = w_text.strip()
        if not txt:
            continue
        if len(txt) > max_chars:
            txt = txt[:max_chars]
        if buf_chars > 0 and buf_chars + len(txt) > max_chars:
            flush()
        if buf_start is None:
            buf_start = w_s
        buf_end = w_e
        buf.append(txt)
        buf_chars += len(txt)
        if len(buf) >= n or buf_chars >= max_chars:
            flush()
    flush()
    return cues


def group_cues(words, frame_dur=None, text_chars=None, glyphs=None, max_chars=42):
    MAX_CHARS = int(max_chars)

    cues = []
    buf_words = []
    buf_chars = 0
    buf_start = None
    buf_end = None

    def is_sentence_end(txt):
        return txt and txt[-1] in "።.?!…"

    def flush():
        nonlocal buf_words, buf_chars, buf_start, buf_end
        if buf_words:
            cues.append((" ".join(buf_words), buf_start, buf_end))
        buf_words, buf_chars, buf_start, buf_end = [], 0, None, None

    for w_text, w_s, w_e in words:
        if buf_start is None:
            buf_start = w_s
        buf_end = w_e
        buf_words.append(w_text)
        buf_chars += len(w_text)
        if is_sentence_end(w_text) and buf_chars >= 12:
            flush()
        elif buf_chars >= MAX_CHARS:
            flush()
    flush()
    return cues


# ── background voice (TV, someone talking nearby) ─────────────────────────
# The model writes down a background voice correctly — which reads as random
# words in the captions. That voice is much QUIETER than the speaker around
# it. A word is dropped only when it is BG_DB quieter than the loud voice
# within +-BG_WIN s (75th percentile of the nearby words) AND it is part of a
# run of at least BG_RUN such words: a quieter real speaker (a guest further
# from the mic) is surrounded by their own words and is kept, and one quiet
# word (a trailing syllable) is never dropped.
# Measured 2026-09-30 (90 clips with a real second voice 16-24 dB down):
# background words -43..-47%, WER with a voice under the speaker 47.5 -> 37.0;
# clean FLEURS / WAXAL / CV +0.00 / +0.02 / +0.00; fixtures unchanged. Costs a
# few array reads per word. AMH_BG=0 disables.
BG_DB = float(os.environ.get("AMH_BG_DB", "14"))
BG_WIN = 5.0
BG_RUN = 3


def drop_background_words(words, wav, sr=16000):
    if os.environ.get("AMH_BG", "1") == "0" or wav is None or len(words) < BG_RUN:
        return words
    x = np.asarray(wav, dtype=np.float32)
    lv = []
    for w in words:
        a = max(0, int(w[1] * sr))
        b = min(len(x), max(int(w[2] * sr), a + 160))
        seg = x[a:b].astype(np.float64)
        lv.append(10 * np.log10(float(np.mean(seg * seg)) + 1e-12) if len(seg) else -120.0)
    mids = [(w[1] + w[2]) / 2 for w in words]
    glob_ref = float(np.median(lv))
    quiet = []
    lo = hi = 0
    n = len(words)
    for k in range(n):
        while mids[lo] < mids[k] - BG_WIN:
            lo += 1
        while hi + 1 < n and mids[hi + 1] <= mids[k] + BG_WIN:
            hi += 1
        near = [lv[j] for j in range(lo, hi + 1) if j != k]
        ref = float(np.percentile(near, 75)) if len(near) >= 3 else glob_ref
        quiet.append(lv[k] < ref - BG_DB)
    out = []
    k = 0
    while k < n:
        if not quiet[k]:
            out.append(words[k])
            k += 1
            continue
        j = k
        while j < n and quiet[j]:
            j += 1
        if j - k < BG_RUN:
            out.extend(words[k:j])   # a short quiet stretch is kept
        k = j
    return out


def make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=42, wav=None):
    # Pull the raw word stream ONCE and run the conservative post-correction
    # pass on it, so every caption mode (words/grouped/sentence) benefits and
    # the corrected words match the same timing as the original.
    raw_words = get_words(spans, frame_dur, glyphs)
    # `wav` is the audio on the SAME timeline as the spans (the whole clip —
    # windowed paths shift their spans back onto it).
    if wav is not None:
        raw_words = drop_background_words(raw_words, wav)
    units = _unit_confs(spans, frame_dur, glyphs)
    try:
        from amh_correct import correct_words
        words = correct_words(raw_words)
    except Exception:
        words = raw_words
    # One-letter spelling fix against the word list (በታም -> በጣም). Before the
    # number pass, so a misheard number word (ነጠኝ -> ዘጠኝ) still becomes a digit.
    try:
        from amh_correct import spell_fix_words
        words = spell_fix_words(words)
    except Exception:
        pass
    # Numeric normalization: the CTC space token can split one number into
    # separate digit tokens ("2 0 2 4", "፲ ፪"). Re-glue consecutive
    # ALL-DIGIT tokens into a single number so captions read 2024/፲፪, not
    # "2 0 2 4". Tokens containing letters (ቤት2) are never touched.
    ascii_digit = re.compile(r"^[0-9]+$")
    amharic_digit = re.compile(r"^[\u1369-\u1371\u1372-\u137c\u137d]+$")
    is_digit = lambda t: bool(ascii_digit.match(t)) or bool(amharic_digit.match(t))
    merged = []
    i = 0
    n = len(words)
    while i < n:
        tok, s, e = words[i]
        if is_digit(tok):
            run = tok
            run_s, run_e = s, e
            j = i + 1
            while j < n and is_digit(words[j][0]):
                run += words[j][0]
                run_e = words[j][2]
                j += 1
            merged.append((run, run_s, run_e))
            i = j
            continue
        merged.append((tok, s, e))
        i += 1
    words = merged
    # Stranded one-letter prefixes (በ ሁሉም -> በሁሉም), before the number pass
    # — the order it was measured in (see amh_correct.rejoin_prefixes).
    try:
        from amh_correct import rejoin_prefixes
        words = rejoin_prefixes(words)
    except Exception:
        pass
    # Spoken numbers -> digits (ሁለት ሺህ ሀያ ስድስት -> 2026). After the digit
    # re-glue on purpose: a counting run is emitted as separate tokens
    # ("1", "2", "3") and must not be glued back into "123".
    try:
        from amh_correct import numbers_to_digits
        words = numbers_to_digits(words)
    except Exception:
        pass
    # Rule-based punctuation from inter-word silence (VAD pauses surface here
    # as large gaps). Done AFTER digit re-gluing so "2024" stays whole, and
    # before grouping so sentence marks drive group_cues() flushing.
    try:
        from amh_correct import punctuate_words
        words = punctuate_words(words)
    except Exception:
        pass
    if mode == "words":
        cues = group_word_cues(words, max_chars=max_chars)
    elif mode == "grouped" and group_size > 0:
        cues = group_n_cues(words, group_size, max_chars=max_chars)
    else:
        cues = group_cues(words, frame_dur, None, glyphs, max_chars=max_chars)
    return enforce_min_duration(_attach_doubts(cues, words, units))


def enforce_min_duration(cues, min_dur=1.0, max_dur=5.0, tail_room=0.15):
    """Guarantee every caption stays on screen at least min_dur (readable)
    but never more than max_dur (so a last word with a long trailing CTC
    span doesn't hang on screen). The END of a too-short cue is extended to
    min_dur; a too-long cue is trimmed to max_dur. A small gap (tail_room)
    before the next cue prevents overlap. Returns a new (text, start, end)
    list.
    """
    min_dur = float(min_dur)
    max_dur = float(max_dur)
    tail_room = float(tail_room)
    n = len(cues)
    out = []
    for idx, cue in enumerate(cues):
        txt, s, e = cue
        if max_dur > 0 and e - s > max_dur:
            e = s + max_dur
        if e - s < min_dur:
            e = s + min_dur
        if idx + 1 < n:
            nxt_s = cues[idx + 1][1]
            limit = nxt_s - tail_room
            if limit > s:
                if e > limit:
                    e = limit
            elif e > nxt_s:
                # The next cue starts within tail_room of this one, so the gap
                # cannot be kept. Butt this cue up against the next instead of
                # leaving the min_dur extension in place -- the old guard gave
                # up here (`limit > s` was false) and shipped OVERLAPPING cues,
                # which put two captions on screen at once in Premiere. Seen on
                # 2/19 real clips in karaoke mode (TESTING.md 1.2k).
                e = max(s, nxt_s)
        out.append(Cue(txt, s, e, _cue_doubt(cue)))
    return out


def read_wav(path):
    """Read + resample any soundfile-supported file to 16k mono float32."""
    wav, sr = sf.read(path, dtype="float32")
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sr != 16000:
        ratio = 16000 / sr
        n = int(len(wav) * ratio)
        wav = np.interp(np.linspace(0, len(wav) - 1, n), np.arange(len(wav)), wav).astype("float32")
    return wav


def _vad_segments(wav):
    """Return list of (start_s, end_s) speech regions in the ORIGINAL audio
    timeline, or [] when VAD is disabled / unavailable (AMH_VAD=0) so callers
    keep the current whole-clip behavior."""
    if os.environ.get("AMH_VAD", "1") != "1":
        return []
    try:
        from amh_vad import speech_segments
        return speech_segments(wav) or []
    except Exception:
        return []


def _snap_boundary(wav, nominal, lo, hi, win=320, search=16000 * 2):
    """Return a sample index near `nominal` (clamped to [lo, hi]) sitting on a
    low-energy point, so a windowed long-audio cut lands in a pause instead of
    slicing a word in half. Falls back to `nominal` when there's no room."""
    a = max(lo, nominal - search)
    b = min(hi, nominal + search)
    if b - a < win * 2:
        return nominal
    seg = wav[a:b]
    n_frames = len(seg) // win
    if n_frames < 1:
        return nominal
    fr = seg[: n_frames * win].reshape(n_frames, win)
    energy = (fr * fr).mean(axis=1)
    k = int(np.argmin(energy))
    return a + k * win + win // 2


def _window_target_samples():
    # Re-checked 2026-10-07 (1.9.8). 10s windows are 13% faster and slightly
    # better on sentences with pauses between them (59 min FLEURS + WAXAL,
    # word-scored: WER 26.07 -> 25.78), but WORSE on continuous speech, where
    # more cuts land inside words (golden clips: interview WER 64 -> 80,
    # long5min 53.6 -> 57.6; all 7 scored clips 60.7 -> 63.0). Interviews
    # are continuous speech, so 20s stays. The speed now comes from running
    # windows side by side (_Prefetch), which leaves the output identical.
    # 20s, not 60s. Measured 2026-09-21/22 on the SHIPPED runtime (VAD on)
    # over 340s of concatenated real Amharic speech, 468 reference words.
    # Output is deterministic - the 60s run was reproduced byte-identically
    # on a later day, and three repeats at each size agreed exactly.
    #   60s -> WER 64.7%  CER 31.8%  2.84GB peak  105.8s
    #   30s -> WER 52.1%  CER 22.1%  2.00GB peak   82.3s
    #   20s -> WER 50.9%  CER 21.3%  1.52GB peak   78.5s  <- default
    #   15s -> WER 50.9%  CER 21.1%  1.57GB peak   76.3s
    # The curve flattens at 20s: 15s buys no accuracy and costs more cut
    # points and journal writes. Attention is O(T^2) in window length, so this
    # bounds memory too. Clips shorter than the target take a single window,
    # so short-clip output is unchanged (verified byte-identical at 6.6s).
    # NB: measure this on a runtime that HAS silero_vad.onnx. Without it VAD
    # silently degrades to one segment and every number above changes - see
    # TESTING.md 1.2j.
    secs = float(os.environ.get("AMH_WINDOW_SECS", "20"))
    return max(1, int(secs * 16000))


def _plan_windows(wav, target):
    """Split `wav` into [(start_sample, end_sample), ...] whose cuts fall at
    VAD silence boundaries wherever possible, so a long clip is transcribed in
    bounded ~target-length pieces WITHOUT slicing through speech.

    Strategy: greedily accumulate VAD speech regions until the next one would
    exceed `target`, then cut in the middle of the silence gap before it. Any
    remaining over-long stretch (no VAD, or one continuous region longer than
    target) is split at low-energy points via _snap_boundary so memory stays
    bounded regardless."""
    n = len(wav)
    if n <= target:
        return [(0, n)]
    bounds = [0]
    segs = _vad_segments(wav)  # [(start_s, end_s), ...] in original timeline
    if segs:
        cur = 0
        prev_end = 0
        for s, e in segs:
            s_i = max(0, int(round(s * 16000)))
            e_i = min(n, int(round(e * 16000)))
            if e_i - cur > target and prev_end > cur:
                cut = (prev_end + s_i) // 2 if s_i > prev_end else prev_end
                cut = max(cur + 1, min(cut, n))
                if cut > bounds[-1]:
                    bounds.append(cut)
                    cur = cut
            if e_i > prev_end:
                prev_end = e_i
    bounds.append(n)
    out = []
    for k in range(len(bounds) - 1):
        st, en = bounds[k], bounds[k + 1]
        while en - st > int(target * 1.3):
            cut = _snap_boundary(wav, st + target, st + target // 2, en)
            if cut <= st:
                cut = st + target
            cut = min(cut, en)
            out.append((st, cut))
            st = cut
        if en > st:
            out.append((st, en))
    return out


def _emit_progress(done, total):
    """Announce window progress on stderr as `[progress] done/total`.

    stderr (not stdout) because stdout carries the transcript. The panel
    parses these and drives its progress bar; anything that cannot parse them
    just sees an info line. Silent for single-window audio, where a bar would
    finish before it rendered. flush=True matters: python buffers stderr when
    it is a pipe, and a progress line that arrives after the work is done is
    worse than none.
    """
    if total <= 1:
        return
    try:
        print("[progress] %d/%d" % (done, total), file=sys.stderr, flush=True)
    except Exception:
        pass


# --------------------------------------------------------------------------
# parallel windows: run the model on the NEXT windows while this one finishes
# --------------------------------------------------------------------------
# One model call scales poorly past ~4 CPU threads, but several calls side by
# side keep every core busy. Measured on 2 min of real speech, 10 s windows
# (identical output in every layout, 14/14 windows bit-exact):
#     threads  1 call at a time   parallel
#        2       RTF 0.455        0.481 (2x1)  -> keep 1 worker
#        4           0.377        0.321 (2x2)  -> 2 workers, 15% faster
#        8+          0.355        0.252 (4x2)  -> 4 workers, 29% faster
# The model is created with `workers` CT2 workers of THREADS/workers threads.
# Callers schedule() the audio pieces they are about to transcribe; worker
# threads compute their logits ahead; _CT2Engine._logits() then takes the
# ready result for the same piece (matched by content) instead of computing
# it. Anything not scheduled is computed as before, so every path stays
# correct. AMH_WORKERS=1 turns it off.
def _workers_for(threads):
    try:
        env = os.environ.get("AMH_WORKERS", "").strip()
        if env:
            return max(1, min(8, int(env)))
    except Exception:
        pass
    if os.environ.get("AMH_VAD_TRIM", "0") == "1":
        return 1      # trimmed windows take their own path
    return min(4, threads // 2) if threads >= 4 else 1


class _Prefetch:
    def __init__(self, engine, workers):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        self.engine = engine
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="amh-model")
        self.ready = {}                       # key -> [future, ...] in order
        self.lock = threading.Lock()
        self.room = threading.Semaphore(workers * 3)   # bounded look-ahead
        self.queue = []
        self.pending = {}                     # key -> pieces queued or ready, not yet taken
        self.feeding = False

    @staticmethod
    def key(wav):
        import hashlib
        a = np.ascontiguousarray(wav, dtype=np.float32)
        return hashlib.sha1(a.tobytes()).hexdigest() + ":%d" % len(a)

    def schedule(self, pieces):
        """Queue audio pieces (in the order they will be transcribed)."""
        import threading
        keyed = [(self.key(p), p) for p in pieces]
        with self.lock:
            for k, p in keyed:
                if self.pending.get(k):
                    continue          # already scheduled (a batch clip, then its windows)
                self.pending[k] = 1
                self.queue.append((k, p))
            if self.feeding or not self.queue:
                return
            self.feeding = True
        threading.Thread(target=self._feed, daemon=True).start()

    def _feed(self):
        while True:
            self.room.acquire()          # bounded look-ahead: wait for a free slot
            with self.lock:
                if not self.queue:
                    self.feeding = False
                    self.room.release()
                    return
                # Taken off the queue and registered as ready in ONE step, so
                # take() never sees a piece that is in neither place.
                k, piece = self.queue.pop(0)
                self.ready.setdefault(k, []).append(self.pool.submit(self._compute, piece))

    def _compute(self, piece):
        if _preflight_audio(piece):      # silent: the caller returns early
            return None
        return self.engine._encode(piece)

    def take(self, wav):
        """The prefetched logits for this piece, or None (compute it here).
        Re-raises what the worker raised (e.g. "audio too short")."""
        k = self.key(wav)
        import time as _t
        waited = 0.0
        while True:
            with self.lock:
                queued = any(q[0] == k for q in self.queue)
            if not queued:
                break
            if waited > 30:
                return None       # never wait forever: compute it here instead
            _t.sleep(0.005)       # the feeder is about to submit it
            waited += 0.005
        with self.lock:
            futs = self.ready.get(k)
            fut = futs.pop(0) if futs else None
            if futs is not None and not futs:
                del self.ready[k]
            if fut is not None:
                self.pending.pop(k, None)
        if fut is None:
            return None
        try:
            return fut.result()
        finally:
            self.room.release()

    def clear(self):
        """Drop look-ahead that will not be used (e.g. a request failed)."""
        with self.lock:
            self.queue = []
            self.pending = {}
            stale = [f for fs in self.ready.values() for f in fs]
            self.ready = {}
        for f in stale:
            try:
                f.result()
            except Exception:
                pass
            self.room.release()


def _schedule(engine, pieces):
    pre = getattr(engine, "prefetch", None)
    if pre is not None:
        pre.schedule(pieces)


def _clear_prefetch(engine):
    pre = getattr(engine, "prefetch", None)
    if pre is not None:
        pre.clear()


def _pieces(wav, target=None):
    """The audio pieces engine.transcribe(wav) will run the model on."""
    target = target or _window_target_samples()
    if len(wav) <= target:
        return [wav]
    return [wav[st:en] for st, en in _plan_windows(wav, target)]


def _windowed_transcribe(engine, wav):
    """Transcribe arbitrary-length audio in bounded VAD-aligned windows so
    memory stays flat, merging per-window spans back onto the original timeline.

    Returns (text, spans, frame_dur) with spans in ORIGINAL sample-index space
    and frame_dur = 1/16000, matching the VAD path's contract (get_words uses
    s * frame_dur as seconds)."""
    n = len(wav)
    target = _window_target_samples()
    if n <= target:
        return engine._transcribe_one(wav)
    texts = []
    out_spans = []
    wins = _plan_windows(wav, target)
    _schedule(engine, [wav[st:en] for st, en in wins])
    # Per-window progress. The caller (the panel) shows a bar that otherwise
    # sits frozen for the whole transcription: a single clip used to jump to
    # 40% and not move again until it finished, which on a long interview
    # reads as a hang. One line per window is enough to drive a real bar.
    # Only emitted when there IS more than one window — a short clip finishes
    # before a progress bar would mean anything.
    _emit_progress(0, len(wins))
    for k, (st, en) in enumerate(wins):
        try:
            text, spans, fdur = engine._transcribe_one(wav[st:en])
        except ValueError as e:
            # A trailing window shorter than one mel frame (35ms) carries no
            # speech; skip it so it can't fail the rest of a long clip.
            if not str(e).startswith("audio too short"):
                raise
            print("[info] window %d-%d skipped: %s" % (st, en, e), file=sys.stderr)
            _emit_progress(k + 1, len(wins))
            continue
        if text:
            texts.append(text)
        for sp in spans:
            tok, s, e = sp
            ss = st + int(round(s * fdur * 16000))
            ee = st + int(round((e + 1) * fdur * 16000))
            out_spans.append(Span(tok, ss, max(ss, ee), _span_conf(sp)))
        _emit_progress(k + 1, len(wins))
    return " ".join(texts), out_spans, 1.0 / 16000.0


class _ClipsAhead:
    """Batch of clips (a Premiere work area): while clip n is transcribed,
    clip n+1 is already read and its model work started, so many short clips
    keep every worker busy too."""

    def __init__(self, engine, paths):
        self.engine = engine
        self.paths = paths
        self.wavs = {}

    def _load(self, i):
        if i in self.wavs or i >= len(self.paths) or i < 0:
            return
        p = self.paths[i]
        try:
            w = read_wav(p)
            self.wavs[i] = w
            if getattr(self.engine, "prefetch", None) is not None:
                _schedule(self.engine, _pieces(w))
        except Exception as e:
            self.wavs[i] = e

    def get(self, i, path):
        self._load(i)
        w = self.wavs.pop(i, None)
        pre = getattr(self.engine, "prefetch", None)
        for j in range(i + 1, i + 1 + (self.engine.workers if pre is not None else 1)):
            self._load(j)
        if isinstance(w, Exception):
            raise w
        return w if w is not None else read_wav(path)


def _audio_fp(wav):
    """Cheap fingerprint (length + first/last second) identifying a wav buffer
    across runs, so a resume journal is only trusted for the SAME audio."""
    import hashlib
    h = hashlib.sha1()
    arr = np.asarray(wav, dtype=np.float32)
    h.update(str(arr.shape[0]).encode())
    h.update(arr[:16000].tobytes())
    h.update(arr[-16000:].tobytes())
    return h.hexdigest()[:16]


def _win_cues(engine, wav, st, en, mode, group_size, max_chars):
    """Transcribe one window and return (text, cues) with cue times already on
    the ORIGINAL timeline (spans shifted out of window-relative space)."""
    try:
        text, spans, fdur = engine._transcribe_one(wav[st:en])
    except ValueError as e:
        # Degenerate sub-window (<35ms of audio): no speech, no cues. Skip it
        # so a long clip's tiny tail can't abort the whole transcription.
        if not str(e).startswith("audio too short"):
            raise
        print("[info] window %d-%d skipped: %s" % (st, en, e), file=sys.stderr)
        return "", []
    shifted = []
    for sp in spans:
        tok, s, e = sp
        ss = st + int(round(s * fdur * 16000))
        ee = st + int(round((e + 1) * fdur * 16000))
        shifted.append(Span(tok, ss, max(ss, ee), _span_conf(sp)))
    cues = make_cues(mode, group_size, shifted, 1.0 / 16000.0, text,
                     engine.glyphs, max_chars=max_chars, wav=wav)
    return text, cues


def _vad_trim(wav):
    """If VAD finds real speech gaps, build a trimmed buffer (concatenated
    speech segments + tiny pad) and a mapping back to the original timeline.
    Returns (wav, seg_table) where seg_table is a list of
    (trim_start_sample, orig_start_sample, seg_len) or (wav, None) to keep the
    default single-shot path (no meaningful cuts).

    OFF by default since 2026-09-23 (AMH_VAD_TRIM=1 restores it). Cutting the
    audio before the encoder cost accuracy everywhere it was measured: the
    50 ms margin clipped word onsets (ሁለት -> "ቡኡሁለት"), and on narrowband
    phone audio Silero misses speech outright. CER, trim on -> off:
        phone 66.4% -> 31.8%   music 27.1% -> 15.8%   clean 19.8% -> 16.6%
        numbers 31.0% -> 22.4%   long5min 16.9% -> 13.2%   reverb 48.4 -> 44.7
    No hallucinated captions appeared over 8s of music, crowd noise or room
    tone with trimming off, and wall time on long5min was unchanged. VAD
    still plans the long-audio window cuts (_plan_windows). TESTING.md 1.2o."""
    if os.environ.get("AMH_VAD_TRIM", "0") != "1":
        return wav, None
    try:
        segs = _vad_segments(wav)
        if len(segs) < 1:
            return wav, None
        sr = 16000
        total = len(wav)
        cleaned = []
        speech_samples = 0
        for s, e in segs:
            if (e - s) * sr < 0.15 * sr:
                continue
            s_i = max(0, int(round(s * sr)))
            e_i = min(total, int(round(e * sr)))
            cleaned.append((s_i, e_i))
            speech_samples += e_i - s_i
        # If VAD says there's almost no gap (<3% of the clip), trimming isn't
        # worth the risk and there'd be no real speed win anyway.
        if speech_samples >= 0.97 * total or not cleaned:
            return wav, None
        pad = int(0.05 * sr)  # short pad between concatenated segments
        parts = []
        seg_table = []
        trim_pos = 0
        for s_i, e_i in cleaned:
            if parts:
                parts.append(np.zeros(pad, dtype=np.float32))
                trim_pos += pad
            parts.append(wav[s_i:e_i])
            seg_table.append((trim_pos, s_i, e_i - s_i))
            trim_pos += e_i - s_i
        trimmed = np.concatenate(parts).astype(np.float32)
        return trimmed, seg_table
    except Exception:
        return wav, None


def _map_trim_to_orig(trim_sample, seg_table):
    """Original sample index for a sample index in the trimmed buffer. A few
    frames inside a pad gap get clamped to the nearest segment endpoint so
    tokens sitting right on a segment boundary are never lost or shifted."""
    if trim_sample < 0:
        return None
    prev_end = None
    for trim_start, orig_start, seg_len in seg_table:
        if trim_sample < trim_start:
            return prev_end if prev_end is not None else orig_start
        if trim_sample < trim_start + seg_len:
            return orig_start + int(trim_sample - trim_start)
        prev_end = orig_start + seg_len - 1
    if prev_end is not None:
        return prev_end
    # seg_table is never empty at call sites; keep a safe default anyway
    return seg_table[-1][1] if seg_table else None


def _remap_spans(spans, frame_dur, seg_table, sr=16000):
    """Remap token spans from the trimmed-buffer frame space back onto the
    ORIGINAL timeline. Returns spans whose (s, e) are original sample indices;
    combine with a frame_dur of 1/sr so downstream timing math stays correct."""
    out = []
    for sp in spans:
        tok, s, e = sp
        t0 = s * frame_dur
        t1 = (e + 1) * frame_dur
        o0 = _map_trim_to_orig(t0 * sr, seg_table)
        o1 = _map_trim_to_orig(t1 * sr, seg_table)
        if o0 is None or o1 is None:
            continue
        if o1 < o0:
            o1 = o0
        out.append(Span(tok, o0, o1, _span_conf(sp)))
    return out


def write_srt(out_path, cues, offset):
    idx = 0
    doubts = {}
    with open(out_path, "w", encoding="utf-8") as f:
        for cue in cues:
            text_cue, start, end = cue
            if not text_cue:
                continue
            idx += 1
            f.write(f"{idx}\n")
            f.write(f"{format_ts(start + offset)} --> {format_ts(end + offset)}\n")
            f.write(f"{text_cue}\n\n")
            if _cue_doubt(cue):
                doubts[str(idx)] = _cue_doubt(cue)
    # Doubtful-word marks for the review screen, keyed by SRT cue number.
    side = out_path + ".doubt.json"
    try:
        if doubts:
            with open(side, "w", encoding="utf-8") as f:
                json.dump(doubts, f, ensure_ascii=False)
        elif os.path.exists(side):
            os.remove(side)
    except OSError:
        pass
    return idx


def _glyphs_of(engine):
    return engine.glyphs


def _maybe_diarize(cues, wav):
    """Best-effort 2-speaker labels ("[S1] "/"[S2] " prefixes). Never raises:
    returns cues unchanged if the model/package is missing or the clip is not
    clearly two speakers (see amh_diarize.py)."""
    if not cues:
        return cues
    try:
        import amh_diarize
    except Exception as e:
        print("[info] speaker labelling unavailable: %s" % e, file=sys.stderr)
        return cues
    if not amh_diarize.available():
        print("[info] speaker labelling requested but no embedding model found",
              file=sys.stderr)
        return cues
    labelled = amh_diarize.label_cues(cues, wav)
    # Speaker prefixes rebuild the tuples: keep each cue's doubtful words.
    if len(labelled) == len(cues):
        labelled = [Cue(l[0], l[1], l[2], _cue_doubt(c)) for l, c in zip(labelled, cues)]
    return labelled


# --------------------------------------------------------------------------
# long jobs: keep the computer awake, say when it runs on battery
# --------------------------------------------------------------------------
# A laptop goes to sleep after 10-30 min without mouse/keyboard use even while
# the CPU is busy, which froze long videos half-way ("it can't handle a
# 10-minute video"). While a transcription runs we ask the OS not to sleep
# (the screen may still turn off); the request ends with the job, so the
# computer's normal sleep settings come back. AMH_KEEP_AWAKE=0 turns it off.
class keep_awake:
    def __enter__(self):
        self._proc = None
        self._win = False
        if os.environ.get("AMH_KEEP_AWAKE", "1") == "0":
            return self
        try:
            if sys.platform == "win32":
                import ctypes
                # ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep while set.
                self._win = bool(ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001))
            elif sys.platform == "darwin":
                import subprocess
                # -i: no idle sleep; -w: ends by itself if we die.
                self._proc = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        return self

    def __exit__(self, *exc):
        try:
            if self._win:
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
            if self._proc is not None:
                self._proc.terminate()
        except Exception:
            pass
        return False


def on_battery():
    """True when a laptop runs on battery (it is then 2-3x slower)."""
    try:
        if sys.platform == "win32":
            import ctypes

            class _SPS(ctypes.Structure):
                _fields_ = [("ACLineStatus", ctypes.c_ubyte), ("BatteryFlag", ctypes.c_ubyte),
                            ("BatteryLifePercent", ctypes.c_ubyte), ("SystemStatusFlag", ctypes.c_ubyte),
                            ("BatteryLifeTime", ctypes.c_ulong), ("BatteryFullLifeTime", ctypes.c_ulong)]
            s = _SPS()
            return bool(ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s))) and s.ACLineStatus == 0
        if sys.platform == "darwin":
            import subprocess
            r = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5)
            return "Battery Power" in r.stdout
    except Exception:
        pass
    return False


def _power_notice(seconds):
    """`[power] battery` on stderr for a long job on battery: the panel shows
    "plug in the charger". Short clips finish before it would matter."""
    if seconds >= 120 and on_battery():
        try:
            print("[power] battery", file=sys.stderr, flush=True)
        except Exception:
            pass


def _run_file(engine, wav, mode, group_size, max_chars, offset, out_srt=None,
              speakers=False):
    glyphs = engine.glyphs
    # Audio past the long-audio threshold is chunked at VAD boundaries AND
    # journaled to disk so an interrupted/crashed run resumes instead of
    # starting over (see _run_long). Shorter clips keep the single-shot path
    # (engine.transcribe still windows internally only past ~60s for memory).
    long_secs = float(os.environ.get("AMH_LONG_SECS", "300"))
    _power_notice(len(wav) / 16000.0)
    with keep_awake():
        try:
            if out_srt and len(wav) > int(long_secs * 16000):
                text, cues = _run_long(engine, wav, mode, group_size, max_chars, offset, out_srt)
            else:
                text, spans, frame_dur = engine.transcribe(wav)
                cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars, wav=wav)
        finally:
            _clear_prefetch(engine)
        if speakers:
            cues = _maybe_diarize(cues, wav)
    return text, cues


def _run_long(engine, wav, mode, group_size, max_chars, offset, out_srt):
    """Transcribe long audio window-by-window, writing a valid partial SRT to
    `out_srt` after EVERY window and a resume journal next to it. If the
    process is interrupted, a later run with the same out_srt + audio resumes
    from the last completed window (fingerprint-checked). Returns (text, cues)
    for the whole clip; the journal is removed on clean completion."""
    glyphs = engine.glyphs
    wins = _plan_windows(wav, _window_target_samples())
    total = len(wins)
    chk = out_srt + ".part.json"
    fp = _audio_fp(wav)
    cues = []
    texts = []
    done = 0
    if os.path.isfile(chk):
        try:
            with open(chk, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if saved.get("fp") == fp and saved.get("total") == total:
                done = int(saved.get("done", 0))
                cues = [tuple(c) for c in saved.get("cues", [])]
                texts = list(saved.get("texts", []))
                if done > total or done < 0:
                    done, cues, texts = 0, [], []
                elif out_srt and cues:
                    write_srt(out_srt, cues, offset)  # restore visible partial
                print("[info] resuming long audio: %d/%d windows already done"
                      % (done, total), file=sys.stderr)
        except Exception:
            done, cues, texts = 0, [], []
    _emit_progress(done, total)
    _schedule(engine, [wav[st:en] for st, en in wins[done:]])
    for k in range(done, total):
        st, en = wins[k]
        text, wcues = _win_cues(engine, wav, st, en, mode, group_size, max_chars)
        if text:
            texts.append(text)
        cues.extend(wcues)
        done = k + 1
        _emit_progress(done, total)
        if out_srt:
            write_srt(out_srt, cues, offset)  # partial, fully valid SRT
        try:
            with open(chk, "w", encoding="utf-8") as f:
                json.dump({"fp": fp, "total": total, "done": done,
                           "cues": [list(c) for c in cues], "texts": texts}, f)
        except Exception:
            pass
    try:
        os.remove(chk)
    except Exception:
        pass
    return " ".join(texts), cues


def main():
    if len(sys.argv) < 2:
        print("Usage: python ethio_srt.py <audio.wav|mp3|m4a> [out.srt] [--words] "
              "[--group NUM] [--speakers] "
              "[--batch requests.json out.srt] [--server]")
        sys.exit(1)

    if sys.argv[1] == "--server":
        return run_server()

    if sys.argv[1] == "--batch":
        return run_batch()

    audio_path = sys.argv[1]
    out_path = "captions.srt"
    mode = "grouped"
    group_size = 0
    offset = 0.0
    max_chars = 42
    speakers = False
    auth = {}
    i = 2
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == "--words":
            mode = "words"
        elif a == "--group":
            mode = "grouped"
            group_size = int(sys.argv[i + 1])
            i += 1
        elif a == "--max-chars":
            max_chars = int(sys.argv[i + 1])
            i += 1
        elif a == "--offset":
            offset = float(sys.argv[i + 1])
            i += 1
        elif a == "--speakers":
            speakers = True
        elif a in ("--lease", "--ticket") and i + 1 < len(sys.argv):
            auth[a[2:]] = sys.argv[i + 1]
            i += 1
        elif a == "--batch":
            mode = "batch"
        elif not a.startswith("-"):
            out_path = a
        i += 1

    if mode == "batch":
        return run_batch()

    try:
        require_license(auth.get("lease"), auth.get("ticket"))
    except LicenseRequired as e:
        print("[error] %s" % e, file=sys.stderr)
        sys.exit(3)
    engine = load_pipeline()
    print(f"[info] engine: {'CTranslate2 int8' if _use_ct2() else 'transformers/torch'}")
    print("[info] loading audio:", audio_path)
    wav, cut = _trial_cut(read_wav(audio_path))
    if cut is not None:
        print("[trial] cut %.2f" % cut, file=sys.stderr, flush=True)
    try:
        text, cues = _run_file(engine, wav, mode, group_size, max_chars, offset, out_path,
                               speakers=speakers)
    except ValueError as e:
        # A clip shorter than one mel frame (35 ms) is un-transcribable; report
        # it as a clean user-facing error instead of a traceback (batch/--server
        # paths already map this to a per-clip skip + skipped:N count).
        if str(e).startswith("audio too short"):
            print("[error] %s — clip is shorter than one mel frame (35 ms); "
                  "cannot transcribe." % e, file=sys.stderr)
            sys.exit(1)
        raise

    print("--- full transcription ---")
    print(text)
    idx = write_srt(out_path, cues, offset)
    print(f"[info] wrote {idx} cues to {out_path} (offset {offset:+.2f}s)")
    for text_cue, s, e in cues:
        if text_cue:
            print(f"{format_ts(s + offset)} --> {format_ts(e + offset)}  {text_cue}")


# --------------------------------------------------------------------------
# persistent worker (--server)
# --------------------------------------------------------------------------
# One-shot mode re-spawns Python (and re-loads the ASR model) for every
# transcription, which costs seconds each run and makes multi-clip batches
# re-load the model per process. --server keeps ONE warmly-loaded engine alive
# and serves requests over a line-delimited JSON protocol on stdin/stdout:
#
#   in : {"id":1,"wav":"clip.wav","out_srt":"clip.srt","mode":"words",
#         "group":0,"max_chars":42,"offset":2.5,"speakers":false}
#   out: {"id":1,"ok":true,"text":"...","cues":23,"transcript":"..."}
#   batch: {"id":2,"batch":[{"wav":...,"offset":...},...],"out_srt":"...",
#           "mode":"grouped","group":3,"max_chars":42,"speakers":true}
#          emits one {"id":2,"type":"prog","at":N,"of":M,"name":...} per clip
#          then the {"id":2,"ok":true,...} result line.
def run_server():
    engine = load_pipeline()
    out = sys.stdout
    emit(out, {"type": "ready", "engine": "ct2" if _use_ct2() else "torch"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit(out, {"ok": False, "error": "bad json: %s" % e})
            continue
        rid = req.get("id", 0)
        try:
            if req.get("type") == "ping":
                emit(out, {"id": rid, "ok": True, "pong": True})
            elif "batch" in req and isinstance(req["batch"], list):
                handle_server_batch(engine, req, rid, out)
            else:
                handle_server_one(engine, req, rid, out)
        except Exception as e:
            emit(out, {"id": rid, "ok": False, "error": str(e)})
        finally:
            end_permit()


def emit(out, obj):
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


# ── permission to transcribe (1.10.3) ─────────────────────────────────────────
# Every job the panel, the desktop app or the command line hands the engine
# must carry permission for THIS computer: the license lease (server-signed,
# bound to the Machine ID) or a server-signed trial ticket for one free
# caption. Before this, running this file directly — or a panel edited to
# skip its license check — gave free captions. (The SRT maker checks with the
# server itself before it hands over a file.)
#
# The model itself refuses to run without that permission (1.10.6): the
# engine's transcription functions check the permit the last successful
# require_license gave. Before, the front doors checked but the inside did
# not — loading the engine from Python (which ships with the program) and
# calling its functions directly made captions without a license.
class LicenseRequired(Exception):
    pass


# Free minutes (1.10.7): a trial ticket says how many seconds of audio this
# job may turn into text. The model counts every piece it transcribes (the
# pieces of one clip never overlap); the job paths shorten the audio to that
# length first (_trial_cut), so the count is only a backstop.
_PERMIT = {"ok": False, "samples": None, "used": 0}
_SAMPLE_SLACK = 16000          # one second of rounding


def _need_permit():
    if not _PERMIT["ok"]:
        raise LicenseRequired("license required: no license or free-caption ticket for this job")


def _count_audio(n):
    lim = _PERMIT["samples"]
    if lim is None:
        return
    _PERMIT["used"] += int(n)
    if _PERMIT["used"] > lim + _SAMPLE_SLACK:
        raise LicenseRequired("license required: the free minutes for this job are used up")


def permit_samples_left():
    """Samples of audio this job may still transcribe; None = no limit."""
    lim = _PERMIT["samples"]
    return None if lim is None else max(0, lim - _PERMIT["used"])


def _trial_cut(wav, budget=None):
    """(wav, cut_seconds): the audio shortened to what the free-minutes ticket
    allows. cut_seconds is None when nothing was cut."""
    left = permit_samples_left() if budget is None else budget
    if left is None or len(wav) <= left:
        return wav, None
    return wav[:left], left / 16000.0


def end_permit():
    """The job is over: the next one must be allowed again."""
    _PERMIT.update(ok=False, samples=None, used=0)


def require_license(lease=None, ticket=None):
    _PERMIT.update(ok=False, samples=None, used=0)
    try:
        import amh_license
    except Exception:
        raise LicenseRequired("license required: the license module is missing — reinstall")
    ok, why = amh_license.engine_auth(lease, ticket)
    if not ok:
        raise LicenseRequired("license required: " + why)
    secs = None
    if why == "trial" and ticket and hasattr(amh_license, "ticket_seconds"):
        secs = amh_license.ticket_seconds(ticket)
    _PERMIT.update(ok=True, samples=None if secs is None else int(secs) * 16000, used=0)


def handle_server_one(engine, req, rid, out):
    require_license(req.get("lease"), req.get("ticket"))
    wav_path = req.get("wav")
    if not wav_path or not os.path.isfile(wav_path):
        emit(out, {"id": rid, "ok": False, "error": "audio file not found: %s" % wav_path})
        return
    mode, group, max_chars = request_style(req)
    offset = float(req.get("offset", 0.0))
    speakers = bool(req.get("speakers", False))
    wav, cut = _trial_cut(read_wav(wav_path))
    out_srt = req.get("out_srt")
    text, cues = _run_file(engine, wav, mode, group, max_chars, offset, out_srt,
                           speakers=speakers)
    if out_srt:
        idx = write_srt(out_srt, cues, offset)
    else:
        idx = len(cues)
    res = {"id": rid, "ok": True, "cues": idx, "text": text}
    if cut is not None:
        res["trial_cut"] = round(cut, 2)
    emit(out, res)


# ── Work Area / Whole edit while it works (1.10.9) ───────────────────────────
# A batch request with "live": true (the panel sends it for long runs) writes
# its captions as it goes — after every clip, and after every window of a
# long clip — into out_srt, in the order they are made, with a resume journal
# next to it (<out_srt>.part.json). The review opens with the first captions,
# and a run stopped by sleep, a power cut or Cancel continues where it stopped
# (finished clips, and the finished windows of the clip in progress, are kept
# when their audio is the same).
def _cue_row(c):
    return [c[0], c[1], c[2], list(_cue_doubt(c))]


def _cue_from_row(r):
    return Cue(r[0], r[1], r[2], tuple(r[3]) if len(r) > 3 and r[3] else ())


def _batch_long_clip(engine, wav, mode, group_size, max_chars, fp, state, flush):
    """One long clip of a live batch, window by window (as _run_long does for
    a single clip); flush(cues_so_far) after each window."""
    wins = _plan_windows(wav, _window_target_samples())
    total = len(wins)
    cur = state.get("cur") or {}
    if cur.get("fp") == fp and cur.get("total") == total and 0 <= int(cur.get("done", 0)) <= total:
        done = int(cur.get("done", 0))
        cues = [_cue_from_row(r) for r in cur.get("cues", [])]
        texts = list(cur.get("texts", []))
        if done:
            print("[info] resuming a long clip: %d/%d windows already done" % (done, total), file=sys.stderr)
    else:
        done, cues, texts = 0, [], []
    _emit_progress(done, total)
    _schedule(engine, [wav[st:en] for st, en in wins[done:]])
    for k in range(done, total):
        st, en = wins[k]
        text, wcues = _win_cues(engine, wav, st, en, mode, group_size, max_chars)
        if text:
            texts.append(text)
        cues.extend(wcues)
        _emit_progress(k + 1, total)
        state["cur"] = {"fp": fp, "total": total, "done": k + 1,
                        "cues": [_cue_row(c) for c in cues], "texts": texts}
        flush(cues)
    state.pop("cur", None)
    return " ".join(texts), cues


def handle_server_batch(engine, req, rid, out):
    require_license(req.get("lease"), req.get("ticket"))
    batch = req["batch"]
    mode, group, max_chars = request_style(req)
    out_srt = req.get("out_srt")
    speakers = bool(req.get("speakers", False))
    all_cues = []
    all_text = []
    total = len(batch)
    skipped = 0
    ahead = _ClipsAhead(engine, [it.get("wav") for it in batch])
    budget = permit_samples_left()
    cut_at = None
    live = bool(req.get("live")) and bool(out_srt)
    jpath = (out_srt + ".part.json") if live else None
    state = {}
    if jpath and os.path.isfile(jpath):
        try:
            with open(jpath, "r", encoding="utf-8") as f:
                state = json.load(f)
            if state.get("n") != total or not isinstance(state.get("clips"), dict):
                state = {}
        except Exception:
            state = {}
    state["n"] = total
    state.setdefault("clips", {})
    long_samples = int(float(os.environ.get("AMH_LONG_SECS", "300")) * 16000)

    def flush(cur_cues=None, cur_off=0.0):
        rows = list(all_cues)
        for c in cur_cues or []:
            rows.append(Cue(c[0], c[1] + cur_off, c[2] + cur_off, _cue_doubt(c)))
        try:
            write_srt(out_srt, rows, 0.0)          # partial, fully valid SRT
            with open(jpath, "w", encoding="utf-8") as f:
                json.dump(state, f)
        except Exception:
            pass

    with keep_awake():
        for n, item in enumerate(batch, start=1):
            if budget is not None and budget <= 0:
                cut_at = cut_at or 0.0
                break
            wav_path = item.get("wav")
            name = item.get("name") or wav_path
            emit(out, {"id": rid, "type": "prog", "at": n, "of": total,
                       "name": item.get("name", "")})
            # One bad clip must never abort the whole work-area run: log it,
            # count it, and keep going. Failures are reported via the skipped count.
            if not wav_path or not os.path.isfile(wav_path):
                skipped += 1
                print("[batch] skip %d/%d (audio not found): %s" % (n, total, name),
                      file=sys.stderr)
                continue
            off = float(item.get("offset", 0.0))
            try:
                wav = ahead.get(n - 1, wav_path)
                if budget is not None:
                    wav, cut = _trial_cut(wav, budget)
                    budget -= len(wav)
                    if cut is not None:
                        cut_at = off + cut
                fp = _audio_fp(wav) if live else None
                saved = state["clips"].get(str(n)) if live else None
                if saved and saved.get("fp") == fp:
                    text = saved.get("text", "")
                    cues = [_cue_from_row(r) for r in saved.get("cues", [])]
                    print("[info] clip %d/%d already done (resumed)" % (n, total), file=sys.stderr)
                elif live and len(wav) > long_samples:
                    text, cues = _batch_long_clip(engine, wav, mode, group, max_chars, fp, state,
                                                  lambda cc, _o=off: flush(cc, _o))
                else:
                    text, spans, frame_dur = engine.transcribe(wav)
                    cues = make_cues(mode, group, spans, frame_dur, text, engine.glyphs,
                                     max_chars=max_chars, wav=wav)
                if speakers and not (saved and saved.get("fp") == fp):
                    cues = _maybe_diarize(cues, wav)
                if live:
                    state["clips"][str(n)] = {"fp": fp, "text": text, "cues": [_cue_row(c) for c in cues]}
            except Exception as e:
                _clear_prefetch(engine)
                skipped += 1
                print("[batch] skip %d/%d (transcribe failed): %s: %s"
                      % (n, total, name, e), file=sys.stderr)
                continue
            all_text.append(text)
            for c in cues:
                all_cues.append(Cue(c[0], c[1] + off, c[2] + off, _cue_doubt(c)))
            if live:
                flush()
    _clear_prefetch(engine)
    if jpath:
        try:
            os.remove(jpath)
        except Exception:
            pass
    if out_srt:
        idx = write_srt(out_srt, all_cues, 0.0)
    else:
        idx = len(all_cues)
    res = {"id": rid, "ok": True, "cues": idx, "skipped": skipped,
           "text": "\n\n".join(all_text)}
    if cut_at is not None:
        res["trial_cut"] = round(cut_at, 2)
    emit(out, res)


def request_style(req):
    mode = req.get("mode", "grouped")
    group = int(req.get("group", 0) or 0)
    max_chars = int(req.get("max_chars", 42) or 42)
    return mode, group, max_chars


def run_batch():
    req_path = None
    out_srt = None
    args = sys.argv[1:]
    for k, a in enumerate(args):
        if a == "--batch" and k + 1 < len(args):
            req_path = args[k + 1]
            if k + 2 < len(args) and not args[k + 2].startswith("-"):
                out_srt = args[k + 2]
            break

    if not req_path:
        print("[error] --batch requires a requests.json path", file=sys.stderr)
        sys.exit(2)
    try:
        lease = args[args.index("--lease") + 1] if "--lease" in args else None
        ticket = args[args.index("--ticket") + 1] if "--ticket" in args else None
        require_license(lease, ticket)
    except (LicenseRequired, IndexError) as e:
        print("[error] %s" % e, file=sys.stderr)
        sys.exit(3)

    with open(req_path, "r", encoding="utf-8") as f:
        import json as _json
        requests = _json.load(f)

    mode = "grouped"
    group_size = 0
    max_chars = 42
    if "--words" in args:
        mode = "words"
    elif "--group" in args:
        g = args.index("--group")
        if g + 1 < len(args):
            mode = "grouped"
            group_size = int(args[g + 1])
    if "--max-chars" in args:
        m = args.index("--max-chars")
        if m + 1 < len(args):
            max_chars = int(args[m + 1])
    speakers = "--speakers" in args

    engine = load_pipeline()
    glyphs = engine.glyphs
    total = len(requests)
    all_cues = []
    skipped = 0
    ahead = _ClipsAhead(engine, [r.get("wav") for r in requests])
    budget = permit_samples_left()
    with keep_awake():
        for n, req in enumerate(requests, start=1):
            if budget is not None and budget <= 0:
                print("[trial] cut %.2f" % float(req.get("offset", 0.0)), file=sys.stderr, flush=True)
                break
            print(f"\n[batch] % {n}/{total} {req.get('wav', '')}")
            # Never let one bad clip abort the whole work-area run.
            try:
                wav = ahead.get(n - 1, req["wav"])
                if budget is not None:
                    wav, cut = _trial_cut(wav, budget)
                    budget -= len(wav)
                    if cut is not None:
                        print("[trial] cut %.2f" % (float(req.get("offset", 0.0)) + cut), file=sys.stderr, flush=True)
                text, spans, frame_dur = engine.transcribe(wav)
                cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs,
                                 max_chars=max_chars, wav=wav)
                if speakers:
                    cues = _maybe_diarize(cues, wav)
            except Exception as e:
                _clear_prefetch(engine)
                skipped += 1
                # stderr so it never pollutes the stdout transcript parse.
                print(f"[batch] skip {n}/{total} (failed): {req.get('wav', '')}: {e}",
                      file=sys.stderr)
                continue
            off = float(req.get("offset") or 0.0)
            for c in cues:
                all_cues.append(Cue(c[0], c[1] + off, c[2] + off, _cue_doubt(c)))
            print("--- full transcription ---")
            print(text)

    if out_srt:
        idx = write_srt(out_srt, all_cues, 0.0)
        print(f"[info] wrote {idx} cues (merged {total} clips) to {out_srt}")
    else:
        print("[info] no output path given; skipped writing SRT")
    if skipped:
        print(f"[info] skipped {skipped}/{total} clip(s) that failed to decode/transcribe",
              file=sys.stderr)


if __name__ == "__main__":
    main()
