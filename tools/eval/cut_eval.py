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
    a = ap.parse_args(argv)

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
