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

# A persistent server (--server) holds the model in memory across requests; the
# heavyweight loaders print tqdm progress that would corrupt our JSON-line
# stdout protocol, so disable it up front.
os.environ.setdefault("TQDM_DISABLE", "1")

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
        # CTC prefix beam search: better text than greedy argmax, and the
        # returned token segments (from the same winning path) give timing
        # that stays consistent with that text.
        #   AMH_BEAM=0       disables beam search (pure greedy, faster).
        #   AMH_BEAM_TOP_K   bounds per-frame candidates (default 16).
        #   AMH_BEAM_WIDTH   beam width (default 24; smaller is faster).
        if os.environ.get("AMH_BEAM", "1") != "0":
            try:
                from ctc_beam import ctc_beam_decode
                top_k = int(os.environ.get("AMH_BEAM_TOP_K", "16"))
                bwidth = int(os.environ.get("AMH_BEAM_WIDTH", "24"))
                beam_text, segs = ctc_beam_decode(
                    np.asarray(logits, dtype=np.float32),
                    self.blank_id,
                    glyphs=self.glyphs,
                    beam_width=bwidth,
                    top_k=top_k,
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
            if e > limit and limit > s:
                e = limit
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
              "[--group NUM] [--batch requests.json out.srt] [--server]")
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


# --------------------------------------------------------------------------
# persistent worker (--server)
# --------------------------------------------------------------------------
# One-shot mode re-spawns Python (and re-loads the ASR model) for every
# transcription, which costs seconds each run and makes multi-clip batches
# re-load the model per process. --server keeps ONE warmly-loaded engine alive
# and serves requests over a line-delimited JSON protocol on stdin/stdout:
#
#   in : {"id":1,"wav":"clip.wav","out_srt":"clip.srt","mode":"words",
#         "group":0,"max_chars":42,"offset":2.5}
#   out: {"id":1,"ok":true,"text":"...","cues":23,"transcript":"..."}
#   batch: {"id":2,"batch":[{"wav":...,"offset":...},...],"out_srt":"...",
#           "mode":"grouped","group":3,"max_chars":42}
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
    wav = read_wav(wav_path)
    text, cues = _run_file(engine, wav, mode, group, max_chars, offset)
    out_srt = req.get("out_srt")
    if out_srt:
        idx = write_srt(out_srt, cues, offset)
    else:
        idx = len(cues)
    emit(out, {"id": rid, "ok": True, "cues": idx, "text": text})


def handle_server_batch(engine, req, rid, out):
    batch = req["batch"]
    mode, group, max_chars = request_style(req)
    out_srt = req.get("out_srt")
    all_cues = []
    all_text = []
    total = len(batch)
    for n, item in enumerate(batch, start=1):
        wav_path = item.get("wav")
        if not wav_path or not os.path.isfile(wav_path):
            emit(out, {"id": rid, "ok": False,
                       "error": "audio file not found: %s" % (item.get("name") or wav_path)})
            return
        off = float(item.get("offset", 0.0))
        emit(out, {"id": rid, "type": "prog", "at": n, "of": total,
                   "name": item.get("name", "")})
        wav = read_wav(wav_path)
        text, spans, frame_dur = engine.transcribe(wav)
        all_text.append(text)
        cues = make_cues(mode, group, spans, frame_dur, text, engine.glyphs,
                         max_chars=max_chars)
        for c in cues:
            all_cues.append((c[0], c[1] + off, c[2] + off))
    if out_srt:
        idx = write_srt(out_srt, all_cues, 0.0)
    else:
        idx = len(all_cues)
    emit(out, {"id": rid, "ok": True, "cues": idx, "text": "\n\n".join(all_text)})


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
