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
import json
import warnings

warnings.filterwarnings("ignore")

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


class _CT2Engine:
    """CTranslate2 INT8 engine (shipped runtime)."""

    def __init__(self, model_dir):
        ctranslate2 = _load_ct2()
        from amh_mel import MelExtractor  # noqa: E402
        meta = json.load(open(os.path.join(model_dir, "model_meta.json")))
        self.blank_id = int(meta.get("blank_id", 408))
        self.model = ctranslate2.models.Wav2Vec2Bert(
            model_dir, device="cpu", compute_type="int8"
        )
        self.mel = MelExtractor(model_dir)
        # lm_head projection (1024 hidden -> 411 vocab): CT2's encode() returns
        # the CTC logits (411) on arm64 but raw hidden states (1024) on
        # x86_64/Windows, so we project whenever the last dim is 1024.
        lw = os.path.join(model_dir, "lm_head_w.npy")
        lb = os.path.join(model_dir, "lm_head_b.npy")
        self.lm_w = np.load(lw).astype(np.float32) if os.path.isfile(lw) else None
        self.lm_b = np.load(lb).astype(np.float32) if os.path.isfile(lb) else None
        # glyph id<->token from the HF vocab.json (matches the model output ids)
        raw = json.load(open(os.path.join(model_dir, "vocab.json")))
        self.glyphs = {int(tid): tok for tok, tid in raw.items()}
        self._skip = {"[PAD]", "[UNK]", "<s>", "</s>"}

    def transcribe(self, wav):
        ctranslate2 = _load_ct2()
        feats = self.mel(wav)  # (1, T', 160)
        out = self.model.encode(ctranslate2.StorageView.from_array(feats))
        logits = np.asarray(out, dtype=np.float32)  # (1, T', 411 or 1024)
        if logits.shape[-1] != 411 and self.lm_w is not None:
            logits = logits @ self.lm_w.T + self.lm_b  # -> (1, T', 411)
        return self._align(wav, logits)

    def _align(self, wav, logits):
        T = logits.shape[1]
        frame_dur = (len(wav) / 16000) / T
        spans, _ = ctc_align(logits, self.blank_id, frame_dur, None)
        argmax = np.argmax(logits[0], axis=-1).tolist()
        text = self._decode(argmax)
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
        s = "".join(out).replace("|", " ")
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


def get_words(spans, frame_dur, glyphs):
    units = []
    for tok, s, e in spans:
        ch = glyphs.get(tok)
        if ch is None:
            continue
        units.append((ch, s * frame_dur, (e + 1) * frame_dur))

    words = []
    cur = ""
    cur_start = None
    for ch, s, e in units:
        if ch == "|":
            if cur:
                words.append((cur, cur_start, e))
                cur = ""
                cur_start = None
            continue
        if cur_start is None:
            cur_start = s
        cur += ch
    if cur:
        words.append((cur, cur_start, units[-1][2]))
    return words


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


def group_cues(spans, frame_dur, text_chars, glyphs, max_chars=42):
    words = get_words(spans, frame_dur, glyphs)
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
    if mode == "words":
        return group_word_cues(get_words(spans, frame_dur, glyphs), max_chars=max_chars)
    if mode == "grouped" and group_size > 0:
        return group_n_cues(get_words(spans, frame_dur, glyphs), group_size, max_chars=max_chars)
    return group_cues(spans, frame_dur, None, glyphs, max_chars=max_chars)


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


def _run_file(engine, wav, mode, group_size, max_chars, offset):
    glyphs = engine.glyphs
    text, spans, frame_dur = engine.transcribe(wav)
    cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars)
    return text, cues


def main():
    if len(sys.argv) < 2:
        print("Usage: python ethio_srt.py <audio.wav|mp3|m4a> [out.srt] [--words] "
              "[--group NUM] [--batch requests.json out.srt]")
        sys.exit(1)

    if sys.argv[1] == "--batch":
        return run_batch()

    audio_path = sys.argv[1]
    out_path = "captions.srt"
    mode = "grouped"
    group_size = 0
    offset = 0.0
    max_chars = 42
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
    text, cues = _run_file(engine, wav, mode, group_size, max_chars, offset)

    print("--- full transcription ---")
    print(text)
    idx = write_srt(out_path, cues, offset)
    print(f"[info] wrote {idx} cues to {out_path} (offset {offset:+.2f}s)")
    for text_cue, s, e in cues:
        if text_cue:
            print(f"{format_ts(s + offset)} --> {format_ts(e + offset)}  {text_cue}")


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

    engine = load_pipeline()
    glyphs = engine.glyphs
    total = len(requests)
    all_cues = []
    for n, req in enumerate(requests, start=1):
        print(f"\n[batch] % {n}/{total} {req.get('wav', '')}")
        wav = read_wav(req["wav"])
        text, spans, frame_dur = engine.transcribe(wav)
        cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars)
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


if __name__ == "__main__":
    main()
