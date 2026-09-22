#!/usr/bin/env python3
"""Transcribe Amharic audio -> accurate text + SRT using badrex/Ethio-ASR-amharic.

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
# thread pools and thrash each other. Pin both to the same cap (physical
# cores, best-effort) so inference stays efficient whether the panel spawns
# one or several workers. This must run BEFORE numpy/ctranslate2 import.
def _thread_cap():
    try:
        import os as _os
        n = _os.cpu_count() or 4
        if hasattr(_os, "sched_getaffinity"):
            n = min(n, len(_os.sched_getaffinity(0)))
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
        meta = json.load(open(os.path.join(model_dir, "model_meta.json")))
        self.blank_id = int(meta.get("blank_id", 408))
        self.model = ctranslate2.models.Wav2Vec2Bert(
            model_dir, device="cpu", compute_type="int8",
            intra_threads=max(1, int(_THREADS)),
        )
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
        raw = json.load(open(os.path.join(model_dir, "vocab.json")))
        self.glyphs = {int(tid): tok for tok, tid in raw.items()}
        self._skip = {"[PAD]", "[UNK]", "<s>", "</s>"}

    def transcribe(self, wav):
        # Very long audio (e.g. a 5-minute clip) makes the conformer attention
        # allocate O(T^2) memory and gets the process OOM-killed. Window it.
        return _windowed_transcribe(self, wav)

    def _transcribe_one(self, wav):
        if _preflight_audio(wav):
            return "", [], 1.0 / 16000.0
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
        feats = self.mel(wav)  # (1, T', 160)
        out = self.model.encode(ctranslate2.StorageView.from_array(feats))
        logits = np.asarray(out, dtype=np.float32)  # (1, T', vocab) or (1, T', 1024)
        if logits.shape[-1] == 1024 and self.lm_w is not None:
            logits = logits @ self.lm_w.T + self.lm_b  # -> (1, T', vocab)
        return self._align(wav, logits)

    def _align(self, wav, logits):
        T = logits.shape[1]
        frame_dur = (len(wav) / 16000) / T
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
        argmax = np.argmax(logits[0], axis=-1).tolist()
        text = self._decode(argmax)
        spans, _ = ctc_align(logits, self.blank_id, frame_dur, None)
        return text, spans, frame_dur

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
        self.processor = AutoProcessor.from_pretrained(model_dir)
        model = AutoModelForCTC.from_pretrained(model_dir)
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
        if _preflight_audio(wav):
            return "", [], 1.0 / 16000.0
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


def make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=42):
    # Pull the raw word stream ONCE and run the conservative post-correction
    # pass on it, so every caption mode (words/grouped/sentence) benefits and
    # the corrected words match the same timing as the original.
    raw_words = get_words(spans, frame_dur, glyphs)
    try:
        from amh_correct import correct_words
        words = correct_words(raw_words)
    except Exception:
        words = raw_words
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
    return enforce_min_duration(cues)


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
    for idx, (txt, s, e) in enumerate(cues):
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
        out.append((txt, s, e))
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
    for st, en in _plan_windows(wav, target):
        try:
            text, spans, fdur = engine._transcribe_one(wav[st:en])
        except ValueError as e:
            # A trailing window shorter than one mel frame (35ms) carries no
            # speech; skip it so it can't fail the rest of a long clip.
            if not str(e).startswith("audio too short"):
                raise
            print("[info] window %d-%d skipped: %s" % (st, en, e), file=sys.stderr)
            continue
        if text:
            texts.append(text)
        for tok, s, e in spans:
            ss = st + int(round(s * fdur * 16000))
            ee = st + int(round((e + 1) * fdur * 16000))
            out_spans.append((tok, ss, max(ss, ee)))
    return " ".join(texts), out_spans, 1.0 / 16000.0


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
    for tok, s, e in spans:
        ss = st + int(round(s * fdur * 16000))
        ee = st + int(round((e + 1) * fdur * 16000))
        shifted.append((tok, ss, max(ss, ee)))
    cues = make_cues(mode, group_size, shifted, 1.0 / 16000.0, text,
                     engine.glyphs, max_chars=max_chars)
    return text, cues


def _vad_trim(wav):
    """If VAD finds real speech gaps, build a trimmed buffer (concatenated
    speech segments + tiny pad) and a mapping back to the original timeline.
    Returns (wav, seg_table) where seg_table is a list of
    (trim_start_sample, orig_start_sample, seg_len) or (wav, None) to keep the
    default single-shot path (no meaningful cuts)."""
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
    for tok, s, e in spans:
        t0 = s * frame_dur
        t1 = (e + 1) * frame_dur
        o0 = _map_trim_to_orig(t0 * sr, seg_table)
        o1 = _map_trim_to_orig(t1 * sr, seg_table)
        if o0 is None or o1 is None:
            continue
        if o1 < o0:
            o1 = o0
        out.append((tok, o0, o1))
    return out


def write_srt(out_path, cues, offset):
    idx = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for text_cue, start, end in cues:
            if not text_cue:
                continue
            idx += 1
            f.write(f"{idx}\n")
            f.write(f"{format_ts(start + offset)} --> {format_ts(end + offset)}\n")
            f.write(f"{text_cue}\n\n")
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
    return amh_diarize.label_cues(cues, wav)


def _run_file(engine, wav, mode, group_size, max_chars, offset, out_srt=None,
              speakers=False):
    glyphs = engine.glyphs
    # Audio past the long-audio threshold is chunked at VAD boundaries AND
    # journaled to disk so an interrupted/crashed run resumes instead of
    # starting over (see _run_long). Shorter clips keep the single-shot path
    # (engine.transcribe still windows internally only past ~60s for memory).
    long_secs = float(os.environ.get("AMH_LONG_SECS", "300"))
    if out_srt and len(wav) > int(long_secs * 16000):
        text, cues = _run_long(engine, wav, mode, group_size, max_chars, offset, out_srt)
    else:
        text, spans, frame_dur = engine.transcribe(wav)
        cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars)
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
    for k in range(done, total):
        st, en = wins[k]
        text, wcues = _win_cues(engine, wav, st, en, mode, group_size, max_chars)
        if text:
            texts.append(text)
        cues.extend(wcues)
        done = k + 1
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
        elif a == "--batch":
            mode = "batch"
        elif not a.startswith("-"):
            out_path = a
        i += 1

    if mode == "batch":
        return run_batch()

    engine = load_pipeline()
    print(f"[info] engine: {'CTranslate2 int8' if _use_ct2() else 'transformers/torch'}")
    print("[info] loading audio:", audio_path)
    wav = read_wav(audio_path)
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


def emit(out, obj):
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


def handle_server_one(engine, req, rid, out):
    wav_path = req.get("wav")
    if not wav_path or not os.path.isfile(wav_path):
        emit(out, {"id": rid, "ok": False, "error": "audio file not found: %s" % wav_path})
        return
    mode, group, max_chars = request_style(req)
    offset = float(req.get("offset", 0.0))
    speakers = bool(req.get("speakers", False))
    wav = read_wav(wav_path)
    out_srt = req.get("out_srt")
    text, cues = _run_file(engine, wav, mode, group, max_chars, offset, out_srt,
                           speakers=speakers)
    if out_srt:
        idx = write_srt(out_srt, cues, offset)
    else:
        idx = len(cues)
    emit(out, {"id": rid, "ok": True, "cues": idx, "text": text})


def handle_server_batch(engine, req, rid, out):
    batch = req["batch"]
    mode, group, max_chars = request_style(req)
    out_srt = req.get("out_srt")
    speakers = bool(req.get("speakers", False))
    all_cues = []
    all_text = []
    total = len(batch)
    skipped = 0
    for n, item in enumerate(batch, start=1):
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
            wav = read_wav(wav_path)
            text, spans, frame_dur = engine.transcribe(wav)
            cues = make_cues(mode, group, spans, frame_dur, text, engine.glyphs,
                             max_chars=max_chars)
            if speakers:
                cues = _maybe_diarize(cues, wav)
        except Exception as e:
            skipped += 1
            print("[batch] skip %d/%d (transcribe failed): %s: %s"
                  % (n, total, name, e), file=sys.stderr)
            continue
        all_text.append(text)
        for c in cues:
            all_cues.append((c[0], c[1] + off, c[2] + off))
    if out_srt:
        idx = write_srt(out_srt, all_cues, 0.0)
    else:
        idx = len(all_cues)
    emit(out, {"id": rid, "ok": True, "cues": idx, "skipped": skipped,
               "text": "\n\n".join(all_text)})


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
    for n, req in enumerate(requests, start=1):
        print(f"\n[batch] % {n}/{total} {req.get('wav', '')}")
        # Never let one bad clip abort the whole work-area run.
        try:
            wav = read_wav(req["wav"])
            text, spans, frame_dur = engine.transcribe(wav)
            cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs,
                             max_chars=max_chars)
            if speakers:
                cues = _maybe_diarize(cues, wav)
        except Exception as e:
            skipped += 1
            # stderr so it never pollutes the stdout transcript parse.
            print(f"[batch] skip {n}/{total} (failed): {req.get('wav', '')}: {e}",
                  file=sys.stderr)
            continue
        off = float(req.get("offset") or 0.0)
        for c in cues:
            all_cues.append((c[0], c[1] + off, c[2] + off))
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
