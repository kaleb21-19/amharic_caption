#!/usr/bin/env python3
"""
cut_eval.py - measure the cut features against hand-labelled Amharic clips
(phase 0 of the silence-cut / edit-with-text rebuild, docs/agent/CHANGELOG
1.94.23). Pure Python + numpy (already in the runtime); no model, no network.

The truth is a word label file in Audacity's label format (one word per line:
"start<TAB>end<TAB>word", seconds). An editor corrects a DRAFT made from the
engine's own word times (see `draft`), so labelling 10 clips takes an hour, not
a day. Everything below compares something against those labels.

  draft   SRT [--words SRT.words.json] -o LABELS.txt
          the engine's words as an Audacity label file, to be corrected by hand
  edges   LABELS.txt SRT [--words SRT.words.json]
          word-edge error of the engine: median / p95 of |start| and |end| error
          (ms), and the median error per minute (drift over a long video)
  midword LABELS.txt CUTS.json [--tol 0.02]
          how many cut edges land INSIDE a word (beyond the tolerance)
  pauses  LABELS.txt CUTS.json --audio-len SECONDS [--min 0.8] [--keep 0.15]
          of the pauses longer than --min (between words, and before the first /
          after the last word), how many were removed by the cuts
  clicks  AUDIO.wav --joins T1,T2,... | --joins-file CUTS.json
          a sudden sample jump at a join (an audible click): the largest
          sample-to-sample step within +-5 ms of each join, compared with the
          typical step around it

The quick way for the silence cut (1.94.34) - label only the PAUSES, not every
word (2-3 minutes a clip):
  prepare VIDEO -o DIR [--ffmpeg PATH]
          DIR/audio.wav (for Audacity), DIR/env.json (the loudness exactly as
          the panel measures it) and DIR/pauses.txt: the quiet parts the
          program hears, as Audacity labels to be corrected by hand
  detect  DIR [--min 0.8] [-o CUTS.json]
          the panel's own silence detection (a line-by-line copy of
          core.js findSilences) on that clip -> the cuts it would offer
  score   DIR [--min 0.8] [--keep 0.15] [--tol 0.02] [--method loud|vad|both]
          detect, then compare with the corrected DIR/pauses.txt: cuts that
          reach into speech, and pauses longer than --min that were removed.
          --method vad = the speech detector the program already ships
          (Silero, amh_vad.py, run with the program's own Python) instead of
          loudness: phase 3 is chosen by these numbers, not by guessing.

CUTS.json is a list of [start, end] in seconds of the ORIGINAL timeline (what
the panel removes). For `clicks` the joins are times in the EXPORTED audio.
Every subcommand prints one summary line and exits 1 when its --max /
--min-ratio limit (if given) is not met, so it can become a gate.
"""
import argparse
import json
import math
import os
import re
import statistics
import sys
import wave


# ----------------------------------------------------------------- reading

def read_labels(path):
    """Audacity labels -> [(start, end, word)] sorted by start. Region labels
    only (a point label has start == end and is skipped)."""
    out = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            if not line.strip() or line.startswith("\\"):
                continue                                   # Audacity's frequency lines
            parts = line.rstrip("\r\n").split("\t")
            if len(parts) < 2:
                continue
            try:
                s, e = float(parts[0]), float(parts[1])
            except ValueError:
                continue
            w = parts[2].strip() if len(parts) > 2 else ""
            if e > s:
                out.append((s, e, w))
    out.sort(key=lambda x: x[0])
    return out


def write_labels(path, words):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for s, e, w in words:
            f.write("%.3f\t%.3f\t%s\n" % (s, e, w))


_TS = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def _secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / (10 ** len(ms))


def read_srt(path):
    """[(start, end, text)] in file order."""
    cues = []
    with open(path, encoding="utf-8-sig") as f:
        blocks = re.split(r"\n\s*\n", f.read().replace("\r\n", "\n"))
    for b in blocks:
        lines = [x for x in b.strip().split("\n") if x.strip()]
        for i, ln in enumerate(lines):
            m = _TS.search(ln)
            if m:
                g = m.groups()
                cues.append((_secs(*g[:4]), _secs(*g[4:]), " ".join(lines[i + 1:]).strip()))
                break
    return cues


def engine_words(srt_path, words_path=None):
    """The engine's words [(start, end, word)]: the exact times from
    <srt>.words.json when they match the caption's word count, otherwise an
    even split by letters (what the panel falls back to - core.js)."""
    cues = read_srt(srt_path)
    wt = {}
    wp = words_path or (srt_path + ".words.json")
    if os.path.exists(wp):
        try:
            with open(wp, encoding="utf-8") as f:
                wt = json.load(f) or {}
        except (OSError, ValueError):
            wt = {}
    out = []
    for n, (s, e, text) in enumerate(cues, 1):
        parts = [p for p in re.split(r"\s+", text.replace("~", "")) if p]
        if not parts:
            continue
        times = wt.get(str(n)) if isinstance(wt, dict) else None
        if isinstance(times, list) and len(times) == len(parts):
            for p, t in zip(parts, times):
                out.append((float(t[0]), float(t[1]), p))
            continue
        weight = [len(p) + 1 for p in parts]
        tot = float(sum(weight)) or 1.0
        t = s
        for p, w in zip(parts, weight):
            d = (e - s) * w / tot
            out.append((t, t + d, p))
            t += d
    return out


def read_cuts(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    cuts = []
    for c in d:
        if isinstance(c, dict):
            c = [c.get("start"), c.get("end")]
        s, e = float(c[0]), float(c[1])
        if e > s:
            cuts.append((s, e))
    return sorted(cuts)


def read_wav_mono(path):
    """(samples as floats -1..1, rate). 16-bit PCM WAV (ffmpeg -c:a pcm_s16le)."""
    import numpy as np
    with wave.open(path, "rb") as w:
        rate, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit("clicks: need a 16-bit PCM WAV (ffmpeg -i in.mp4 -ac 1 -c:a pcm_s16le out.wav)")
    a = np.frombuffer(raw, dtype="<i2").astype("float64") / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, rate


# ------------------------------------------- the panel's silence detection
# A line-by-line copy of panel/js/core.js silenceLevels + findSilences (1.94.28)
# so a clip is scored with exactly what the panel would offer. A test checks
# both give the same answer.

def silence_levels(env):
    db = (env or {}).get("db") or []
    if len(db) < 10:
        return {"flat": False, "short": True}
    s = sorted(db)
    pct_ = lambda q: s[min(len(s) - 1, int(math.floor(q * len(s))))]
    floor, loud = pct_(0.1), pct_(0.95)
    return {"floor": floor, "loud": loud, "flat": loud - floor < 12, "short": False}


def find_silences(env, min_len=0.7, pad=0.15):
    db = (env or {}).get("db") or []
    lv = silence_levels(env)
    if lv["short"] or lv["flat"]:
        return []
    thr = lv["floor"] + max(6, 0.3 * (lv["loud"] - lv["floor"]))
    t0, step = float(env.get("t0", 0)), float(env.get("step", 0.02))
    out, run = [], -1
    for i in range(len(db) + 1):
        quiet = i < len(db) and db[i] < thr
        if quiet and run < 0:
            run = i
        if not quiet and run >= 0:
            s, e = t0 + run * step, t0 + i * step
            pa = 0 if run == 0 else pad
            pb = 0 if i == len(db) else pad
            if e - s >= min_len and e - s - pa - pb >= 0.2:
                out.append((s + pa, e - pb))
            run = -1
    return out


def envelope_from_s16(raw, per=80, step=0.02):
    """Loudness 50 times a second, as panel main.js audioEnvelope: mono 4 kHz
    16-bit samples, 80 per frame, dB = 20*log10(rms/32768 + 1e-6)."""
    import numpy as np
    a = np.frombuffer(raw[: len(raw) - len(raw) % 2], dtype="<i2").astype("float64")
    n = len(a) // per
    if n <= 0:
        return {"t0": 0.0, "step": step, "db": []}
    fr = a[: n * per].reshape(n, per)
    rms = np.sqrt((fr * fr).mean(axis=1))
    db = 20 * np.log10(rms / 32768.0 + 1e-6)
    return {"t0": 0.0, "step": step, "db": [round(float(x), 3) for x in db]}


def find_ffmpeg(given=None):
    if given:
        return given
    cands = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        cands.append(os.path.join(appdata, "Adobe", "CEP", "extensions", "com.amharic.captions", "runtime", "bin", "ffmpeg.exe"))
    home = os.path.expanduser("~")
    cands.append(os.path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions", "com.amharic.captions", "runtime", "bin", "ffmpeg"))
    for c in cands:
        if os.path.isfile(c):
            return c
    return "ffmpeg"


def prepare(video, out_dir, ffmpeg=None, draft_min=0.3):
    import subprocess
    ff = find_ffmpeg(ffmpeg)
    os.makedirs(out_dir, exist_ok=True)
    wav = os.path.join(out_dir, "audio.wav")
    subprocess.run([ff, "-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], check=True)
    raw = subprocess.run([ff, "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "-"],
                         check=True, stdout=subprocess.PIPE).stdout
    env = envelope_from_s16(raw)
    with open(os.path.join(out_dir, "env.json"), "w", encoding="utf-8") as h:
        json.dump(env, h)
    # the draft: every quiet run of 0.3 s or more, edges unpadded (a pause = the silence itself)
    quiet = find_silences(env, draft_min, 0.0)
    write_labels(os.path.join(out_dir, "pauses.txt"), [(s, e, "pause") for s, e in quiet])
    return {"wav": wav, "seconds": round(len(env["db"]) * env["step"], 2), "pauses": len(quiet),
            "flat": silence_levels(env)["flat"]}


# ------------------------------------- phase 3 candidate: the speech detector
def find_runtime(given=None):
    """The installed program's runtime folder (its Python has onnxruntime,
    and amh_vad.py + silero_vad.onnx sit there)."""
    cands = [given] if given else []
    appdata = os.environ.get("APPDATA")
    if appdata:
        cands.append(os.path.join(appdata, "Adobe", "CEP", "extensions", "com.amharic.captions", "runtime"))
    cands.append(os.path.join(os.path.expanduser("~"), "Library", "Application Support", "Adobe", "CEP", "extensions",
                              "com.amharic.captions", "runtime"))
    for c in cands:
        if not c:
            continue
        py = os.path.join(c, "python", "python.exe") if os.name == "nt" else os.path.join(c, "python", "bin", "python3")
        if os.path.isfile(py) and os.path.isfile(os.path.join(c, "amh_vad.py")) and os.path.isfile(os.path.join(c, "silero_vad.onnx")):
            return c, py
    return None, None


_VAD_CODE = (
    "import sys, json, wave\n"
    "import numpy as np\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "import amh_vad\n"
    "w = wave.open(sys.argv[2], 'rb')\n"
    "a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype('float32') / 32768.0\n"
    "if amh_vad._load_session() is None: print('NO-VAD'); sys.exit(0)\n"
    # speech_segments answers 'speech everywhere' when it finds NONE (its no-detector
    # fallback): here no speech must mean no speech, so the windows are checked first
    "pr = amh_vad._probabilities(a)\n"
    "if pr is None or len(pr[0]) == 0 or float(pr[0].max()) < amh_vad._THRESHOLD: print('[]'); sys.exit(0)\n"
    "print(json.dumps([[round(s, 3), round(e, 3)] for s, e in amh_vad.speech_segments(a, 16000)]))\n"
)


def vad_speech(d, runtime=None):
    """Speech segments of DIR/audio.wav from the shipped detector, cached in
    DIR/vad.json. None when the program (and so the detector) is not here."""
    cache = os.path.join(d, "vad.json")
    if os.path.isfile(cache):
        with open(cache, encoding="utf-8") as h:
            return [tuple(x) for x in json.load(h)]
    import subprocess
    rt, py = find_runtime(runtime)
    if not rt:
        return None
    out = subprocess.run([py, "-c", _VAD_CODE, rt, os.path.join(d, "audio.wav")],
                         capture_output=True, text=True, check=True).stdout.strip()
    if out == "NO-VAD":
        return None
    segs = json.loads(out)
    with open(cache, "w", encoding="utf-8") as h:
        json.dump(segs, h)
    return [tuple(x) for x in segs]


def pauses_from_speech(speech, length, min_len=0.8, pad=0.15):
    """The panel's rule on the detector's speech segments: every gap of
    min_len or more is a cut, keeping `pad` of breath on each side - except
    at the very start / end of the clip (cut to the edge)."""
    out, prev = [], 0.0
    gaps = []
    for s, e in sorted(speech):
        if s > prev:
            gaps.append((prev, s))
        prev = max(prev, e)
    if length > prev:
        gaps.append((prev, length))
    for s, e in gaps:
        pa = 0 if s <= 1e-6 else pad
        pb = 0 if e >= length - 1e-6 else pad
        if e - s >= min_len and e - s - pa - pb >= 0.2:
            out.append((s + pa, e - pb))
    return out


def load_clip(d):
    with open(os.path.join(d, "env.json"), encoding="utf-8") as h:
        env = json.load(h)
    length = len(env.get("db") or []) * float(env.get("step", 0.02))
    return env, length


def speech_from_pauses(pause_labels, length):
    """The parts between the labelled pauses = speech, as [(start, end, 'speech')]."""
    out, prev = [], 0.0
    for s, e, _ in sorted(pause_labels):
        if s > prev:
            out.append((prev, s, "speech"))
        prev = max(prev, e)
    if length > prev:
        out.append((prev, length, "speech"))
    return out


def clip_cuts(d, method="loud", min_len=0.8):
    env, length = load_clip(d)
    if method == "vad":
        speech = vad_speech(d)
        if speech is None:
            raise SystemExit("score: the speech detector needs the installed program (its runtime folder) on this computer")
        return pauses_from_speech(speech, length, min_len, 0.15)
    return find_silences(env, min_len, 0.15)


def score(d, min_len=0.8, keep=0.15, tol=0.02, method="loud"):
    env, length = load_clip(d)
    cuts = clip_cuts(d, method, min_len)
    truth = read_labels(os.path.join(d, "pauses.txt"))
    speech = speech_from_pauses(truth, length)
    into = midword_cuts(speech, cuts, tol)
    cov = pause_coverage(speech, cuts, length, min_len, keep)
    return {"cuts": len(cuts), "into_speech": len(into), "into": into[:10],
            "pauses": cov["pauses"], "removed": cov["removed"], "missed": cov["missed"][:10],
            "flat": silence_levels(env)["flat"]}


# -------------------------------------------------------------- measuring

def _norm(w):
    return re.sub(r"[\s፡-፨.,!?;:\"'()\[\]~*-]+", "", str(w))


def match_words(ref, hyp):
    """Pairs (ref_i, hyp_j) of the same word in order (difflib on the
    normalised words), so a missed or extra word does not shift the rest."""
    import difflib
    a = [_norm(x[2]) for x in ref]
    b = [_norm(x[2]) for x in hyp]
    pairs = []
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            pairs.append((blk.a + k, blk.b + k))
    return pairs


def pct(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    k = (len(s) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (k - lo)


def edge_errors(ref, hyp):
    """{matched, of, median_ms, p95_ms, per_minute: {minute: median_ms}} over
    start AND end errors of the matched words."""
    pairs = match_words(ref, hyp)
    errs, by_min = [], {}
    for i, j in pairs:
        for k in (0, 1):
            ms = abs(hyp[j][k] - ref[i][k]) * 1000.0
            errs.append(ms)
            by_min.setdefault(int(ref[i][0] // 60), []).append(ms)
    return {
        "matched": len(pairs), "of": len(ref),
        "median_ms": round(statistics.median(errs), 1) if errs else float("nan"),
        "p95_ms": round(pct(errs, 0.95), 1) if errs else float("nan"),
        "per_minute": {m: round(statistics.median(v), 1) for m, v in sorted(by_min.items())},
    }


def midword_cuts(labels, cuts, tol=0.02):
    """Cut edges that fall inside a word by more than `tol` seconds on both
    sides: [(edge_time, word)]."""
    bad = []
    for s, e in cuts:
        for t in (s, e):
            for ws, we, w in labels:
                if ws + tol < t < we - tol:
                    bad.append((round(t, 3), w))
                    break
    return bad


def pauses(labels, audio_len, min_len):
    """Pauses longer than min_len: gaps between labelled words, plus the gap
    before the first word and after the last one."""
    out = []
    prev = 0.0
    for s, e, _ in labels:
        if s - prev >= min_len:
            out.append((prev, s))
        prev = max(prev, e)
    if audio_len - prev >= min_len:
        out.append((prev, audio_len))
    return out


def pause_coverage(labels, cuts, audio_len, min_len=0.8, keep=0.15):
    """A pause counts as removed when the cuts take out all of it except up to
    `keep` seconds of breathing room on each side."""
    ps = pauses(labels, audio_len, min_len)
    done = 0
    missed = []
    for a, b in ps:
        need = max(0.0, (b - a) - 2 * keep - 0.05)
        got = sum(max(0.0, min(b, ce) - max(a, cs)) for cs, ce in cuts)
        if got >= need:
            done += 1
        else:
            missed.append((round(a, 2), round(b, 2)))
    return {"pauses": len(ps), "removed": done, "missed": missed}


def clicks(samples, rate, joins, win_ms=5.0, ratio=8.0):
    """At each join: the largest sample-to-sample step within +-win_ms,
    against the median step of the surrounding 200 ms. A join whose step is
    `ratio` times the usual (and above an absolute floor) is a click."""
    import numpy as np
    d = np.abs(np.diff(samples))
    out = []
    w = max(1, int(rate * win_ms / 1000.0))
    ctx = int(rate * 0.1)
    for t in joins:
        i = int(round(t * rate))
        a, b = max(0, i - w), min(len(d), i + w)
        if b <= a:
            continue
        peak = float(d[a:b].max())
        c0, c1 = max(0, i - ctx), min(len(d), i + ctx)
        around = np.concatenate([d[c0:a], d[b:c1]])
        typ = float(np.median(around)) if len(around) else 0.0
        bad = peak > max(0.02, ratio * max(typ, 1e-4))
        out.append({"t": round(t, 3), "step": round(peak, 4), "typical": round(typ, 5), "click": bool(bad)})
    return out


# ---------------------------------------------------------------- the CLI

def main(argv=None):
    # Amharic words in the output: never crash on a Windows console (cp1252)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Measure the cut features against hand-labelled clips.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("draft"); p.add_argument("srt"); p.add_argument("--words"); p.add_argument("-o", required=True)
    p = sub.add_parser("edges"); p.add_argument("labels"); p.add_argument("srt"); p.add_argument("--words")
    p.add_argument("--max-median", type=float); p.add_argument("--max-p95", type=float)
    p = sub.add_parser("midword"); p.add_argument("labels"); p.add_argument("cuts"); p.add_argument("--tol", type=float, default=0.02)
    p.add_argument("--max", type=int)
    p = sub.add_parser("pauses"); p.add_argument("labels"); p.add_argument("cuts"); p.add_argument("--audio-len", type=float, required=True)
    p.add_argument("--min", type=float, default=0.8); p.add_argument("--keep", type=float, default=0.15)
    p.add_argument("--min-ratio", type=float)
    p = sub.add_parser("clicks"); p.add_argument("audio"); p.add_argument("--joins"); p.add_argument("--joins-file")
    p.add_argument("--max", type=int)
    p = sub.add_parser("prepare"); p.add_argument("video"); p.add_argument("-o", required=True); p.add_argument("--ffmpeg")
    p = sub.add_parser("detect"); p.add_argument("dir"); p.add_argument("--min", type=float, default=0.8); p.add_argument("-o")
    p = sub.add_parser("score"); p.add_argument("dir"); p.add_argument("--min", type=float, default=0.8)
    p.add_argument("--keep", type=float, default=0.15); p.add_argument("--tol", type=float, default=0.02)
    p.add_argument("--method", choices=["loud", "vad", "both"], default="loud")
    a = ap.parse_args(argv)

    if a.cmd == "prepare":
        r = prepare(a.video, a.o, a.ffmpeg)
        print("prepare: %.1f s, %d pause(s) pre-marked -> %s%s" % (r["seconds"], r["pauses"], os.path.join(a.o, "pauses.txt"),
              "  (music/noise as loud as the voice: the program hears no pauses - mark them yourself)" if r["flat"] else ""))
        return 0
    if a.cmd == "detect":
        env, _ = load_clip(a.dir)
        cuts = [[round(s, 3), round(e, 3)] for s, e in find_silences(env, a.min, 0.15)]
        if a.o:
            with open(a.o, "w", encoding="utf-8") as h:
                json.dump(cuts, h)
        print("detect: %d cut(s)%s" % (len(cuts), (" -> " + a.o) if a.o else (": " + json.dumps(cuts[:10]))))
        return 0
    if a.cmd == "score":
        for m in (["loud", "vad"] if a.method == "both" else [a.method]):
            r = score(a.dir, a.min, a.keep, a.tol, m)
            print("score [%s]: %d cut(s), %d reach into speech%s; pauses >= %.1f s removed %d/%d%s%s" % (
                m, r["cuts"], r["into_speech"], (" " + json.dumps(r["into"])) if r["into"] else "", a.min, r["removed"], r["pauses"],
                ("  missed " + json.dumps(r["missed"])) if r["missed"] else "",
                "  [flat: music/noise as loud as the voice]" if (r["flat"] and m == "loud") else ""))
        return 0

    if a.cmd == "draft":
        words = engine_words(a.srt, a.words)
        write_labels(a.o, words)
        print("draft: %d words -> %s (correct the edges in Audacity: File > Import > Labels)" % (len(words), a.o))
        return 0
    if a.cmd == "edges":
        r = edge_errors(read_labels(a.labels), engine_words(a.srt, a.words))
        print("edges: matched %d/%d words  median %.1f ms  p95 %.1f ms  per minute %s" % (
            r["matched"], r["of"], r["median_ms"], r["p95_ms"], json.dumps(r["per_minute"])))
        bad = (a.max_median is not None and not r["median_ms"] <= a.max_median) or \
              (a.max_p95 is not None and not r["p95_ms"] <= a.max_p95)
        return 1 if bad else 0
    if a.cmd == "midword":
        bad = midword_cuts(read_labels(a.labels), read_cuts(a.cuts), a.tol)
        print("midword: %d cut edge(s) inside a word%s" % (len(bad), (": " + ", ".join("%.3f %s" % x for x in bad[:10])) if bad else ""))
        return 1 if (a.max is not None and len(bad) > a.max) else 0
    if a.cmd == "pauses":
        r = pause_coverage(read_labels(a.labels), read_cuts(a.cuts), a.audio_len, a.min, a.keep)
        ratio = (r["removed"] / float(r["pauses"])) if r["pauses"] else 1.0
        print("pauses: removed %d/%d (%.0f%%)%s" % (r["removed"], r["pauses"], ratio * 100,
              ("  missed " + json.dumps(r["missed"][:10])) if r["missed"] else ""))
        return 1 if (a.min_ratio is not None and ratio < a.min_ratio) else 0
    if a.cmd == "clicks":
        if a.joins_file:
            joins = [s for s, _ in read_cuts(a.joins_file)]
        else:
            joins = [float(x) for x in (a.joins or "").split(",") if x.strip()]
        samples, rate = read_wav_mono(a.audio)
        r = clicks(samples, rate, joins)
        n = sum(1 for x in r if x["click"])
        print("clicks: %d of %d join(s) click%s" % (n, len(r), (": " + ", ".join(str(x["t"]) for x in r if x["click"])) if n else ""))
        return 1 if (a.max is not None and n > a.max) else 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
