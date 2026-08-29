#!/usr/bin/env python3
"""Transcribe Amharic audio -> accurate text + SRT using badrex/Ethio-ASR-amharic.

CTC model has no native timestamps, so we derive word timings via CTC
frame-level forced alignment (collapse repeats, drop blank frames).
"""
import sys
import os
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import torch  # noqa: E402
import soundfile as sf  # noqa: E402
from transformers import AutoProcessor, AutoModelForCTC  # noqa: E402

# Locate the ASR model relative to this script. The file layout differs
# between the dev repo (ethio_srt.py + ./ethio-asr) and the self-contained
# runtime bundle (ethio_srt.py + ./model). An explicit AMH_MODEL_DIR env var
# overrides everything (the panel can point it at an exact location).
def _find_model():
    env = os.environ.get("AMH_MODEL_DIR")
    if env and os.path.isdir(env):
        return env
    base = os.path.dirname(os.path.abspath(__file__))
    for cand in ("model", "ethio-asr"):
        p = os.path.join(base, cand)
        if os.path.isfile(os.path.join(p, "config.json")):
            return p
    return os.path.join(base, "model")

MODEL_DIR = _find_model()


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
    pred_ids = logits.argmax(dim=-1)[0].tolist()
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
    # Build final char sequence + per-char timing
    units = []
    for tok, s, e in spans:
        ch = glyphs.get(tok)
        if ch is None:
            continue
        units.append((ch, s * frame_dur, (e + 1) * frame_dur))

    # Group chars into words using the vocab's space token (encoded as "|")
    words = []  # (text, start, end)
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
    # One caption entry per word (karaoke style), each with its own timing.
    # Clamp each word's duration so trailing silence doesn't stretch a single
    # word across the whole remainder of the clip. Also truncate any single
    # word longer than max_chars so a very long word can't blow out a caption.
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
    # Group up to n words per caption entry, enforcing a hard max-chars cap:
    # flush before adding a word that would exceed the length, and truncate a
    # single over-long word so no caption ever exceeds max_chars.
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
        # A single word longer than the cap: truncate it to fit.
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


def transcribe_audio(model, processor, device, wav):
    """Run transcription on a 16k mono float32 ndarray. Returns (text, spans, frame_dur)."""
    inputs = processor(wav, sampling_rate=16000, return_tensors="pt")
    key = "input_features" if "input_features" in inputs else "input_values"
    feats = inputs[key].to(device)
    try:
        feats = feats.to(next(model.parameters()).dtype)
    except StopIteration:
        pass
    with torch.no_grad():
        logits = model(**{key: feats}).logits
    blank_id = processor.tokenizer.pad_token_id
    frame_dur = (len(wav) / 16000) / logits.shape[1]
    spans, _ = ctc_align(logits, blank_id, frame_dur, None)
    text = processor.batch_decode(logits.argmax(dim=-1))[0]
    return text, spans, frame_dur


def make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=42):
    """Build cues for the given mode once the model output is available."""
    if mode == "words":
        words = get_words(spans, frame_dur, glyphs)
        return group_word_cues(words, max_chars=max_chars)
    if mode == "grouped" and group_size > 0:
        return group_n_cues(get_words(spans, frame_dur, glyphs), group_size, max_chars=max_chars)
    return group_cues(spans, frame_dur, None, glyphs, max_chars=max_chars)


def load_pipeline():
    """Load the processor + model once (expensive) so callers can reuse it."""
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[info] device: {device}")
    print("[info] loading model from", MODEL_DIR)
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    model = AutoModelForCTC.from_pretrained(MODEL_DIR)
    if os.environ.get("AMH_USE_FP32") != "1":
        model = model.half()
    model = model.to(device)
    model.eval()
    return model, processor, device


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


# Gender-neutral helper: split a sentence-grouped pass into readable cues.
# MAX_CHARS caps how long a single caption gets so dense speech doesn't render
# as one huge wall of text (see A2).
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
        # break on sentence end OR when the cue is long enough to split
        if is_sentence_end(w_text) and buf_chars >= 12:
            flush()
        elif buf_chars >= MAX_CHARS:
            flush()
    flush()
    return cues


def write_srt(out_path, cues, offset):
    """Write cues as an SRT, applying the given time offset. Returns cue count."""
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


def main():
    if len(sys.argv) < 2:
        print("Usage: python ethio_srt.py <audio.wav|mp3|m4a> [out.srt] [--words] "
              "[--group NUM] [--batch requests.json out.srt]")
        sys.exit(1)

    # Batch mode is invoked with --batch in argv[1]; handle it before the
    # single-file parser (which starts scanning at argv[2]).
    if sys.argv[1] == "--batch":
        return run_batch()

    # --- single-file mode ---
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

    model, processor, device = load_pipeline()
    glyphs = {}
    for ch, tid in processor.tokenizer.get_vocab().items():
        glyphs[tid] = ch

    print("[info] loading audio:", audio_path)
    wav = read_wav(audio_path)
    text, spans, frame_dur = transcribe_audio(model, processor, device, wav)
    cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars)

    print("--- full transcription ---")
    print(text)
    idx = write_srt(out_path, cues, offset)
    print(f"[info] wrote {idx} cues to {out_path} (offset {offset:+.2f}s)")
    for text_cue, s, e in cues:
        if text_cue:
            print(f"{format_ts(s + offset)} --> {format_ts(e + offset)}  {text_cue}")


def run_batch():
    """--batch requests.json out.srt  (A1: one model load for many clips)

    requests.json is a JSON list of { wav, offset }. A single Python process
    loads the model exactly once, transcribes every clip, and writes one merged,
    timeline-aligned SRT (offsets applied per clip). Progress markers are
    printed on [batch] lines between blocks so the caller can show per-clip
    progress and keep the huge per-run model-load tax near zero.
    """
    # requested file path comes AFTER --batch: scan argv left-to-right.
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

    model, processor, device = load_pipeline()
    glyphs = {}
    for ch, tid in processor.tokenizer.get_vocab().items():
        glyphs[tid] = ch

    total = len(requests)
    all_cues = []
    for n, req in enumerate(requests, start=1):
        print(f"\n[batch] %% {n}/{total} {req.get('wav', '')}")
        wav = read_wav(req["wav"])
        text, spans, frame_dur = transcribe_audio(model, processor, device, wav)
        cues = make_cues(mode, group_size, spans, frame_dur, text, glyphs, max_chars=max_chars)
        # timeline offset for this clip
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
