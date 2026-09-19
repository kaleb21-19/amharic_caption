#!/usr/bin/env python3
"""Offline builder for the compact Amharic word-LM used by amh_lm.py.

Reads an Amharic TEXT corpus (one sentence per row) plus optional Amharic
dictionary wordlists, and emits tools/lm/amh_lm.json.gz — a small file that
ships inside the runtime so the caption decoder can rescore word boundaries
(unigram + bigram over real Amharic, with an OOV floor and a dictionary
supplement so inflected/rare forms still count as words).

ALL probabilities are stored in NATURAL LOG-SPACE: unigram_logp, oov_logp and
every bigram entry, because amh_lm.py adds them (never multiplies). An early
build stored bigram as raw P (c / unigrams[a]); a legacy artifact shipped with
that corruption. To migrate such a file WITHOUT the corpus:

    python3 - <<'PY'
    import gzip, json, math
    p = "tools/lm/amh_lm.json.gz"
    d = json.load(gzip.open(p, "rt", encoding="utf-8"))
    d["bigram"] = {k: math.log(v) for k, v in d["bigram"].items()}
    json.dump(d, gzip.open(p, "wt", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    PY

Usage:
    python3 tools/build_lm.py \
        --corpus /tmp/amh_lm/amharic_train.csv \
        --out tools/lm/amh_lm.json.gz \
        [--dict-dir /tmp/amh_lm] [--min-count 2] [--max-bigrams 150000]

  --dict-dir: a directory containing aa/, dtw/, kbt/ subfolders (geezorg/data)
              with the *_WordLists txt files; col1 = Amharic token, '+' = repeat.
  --min-count: corpus words with fewer occurrences are dropped UNLESS they are
               dictionary words (they keep a floor count of 1).
  --min-part-count: minimum corpus count a split part must have (default 5;
               higher keeps rare dictionary syllables from being split into).
"""
import argparse
import collections
import csv
import glob
import gzip
import json
import math
import os
import re
import sys

# Ethiopic script ranges (letters incl. ፐ-era extensions are inside 1200-137F).
ETHIOPIC = re.compile(r"^[\u1200-\u137f]+$")
# A digit-only token never needs LM splitting (Arabic or Ge'ez numerals).
DIGIT_ONLY = re.compile(r"^(?:[0-9]+|[\u1369-\u137c]+)$")
# Sentence/clause punctuation frequently stuck to token edges in raw text.
_EDGE_PUNCT = "\u1360\u1361\u1362\u1363\u1364\u1365\u1366\u1367\u1368\u1369" \
              "\u136a\u136b\u136c\u136d\u136e\u136f\u1370\u1371" \
              ".,!?;:()\"'…“”‘’`-"


def norm_token(tok):
    t = tok.strip().strip(_EDGE_PUNCT)
    if not t:
        return None
    if not (ETHIOPIC.match(t) or DIGIT_ONLY.match(t)):
        return None
    return t


def read_corpus(path, max_rows=None):
    """Yield normalized token lists (sentences) from a UTF-8 CSV/TSV file.

    The text column is auto-detected (the column with the largest total char
    mass on the first rows); a header row is skipped.""" 
    unigrams = collections.Counter()
    bigrams = collections.Counter()
    n_sentences = 0
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        sample = f.read(2048)
        f.seek(0)
        delimiter = "," if ("," in sample and sample.count(",") > 1) else "\t"
        reader = csv.reader(f, delimiter=delimiter)
        probe = [r for _, r in zip(range(2000), reader)]
        skip = 0
        if probe and probe[0] and str(probe[0][0]).strip().lower() in ("name", "text", "sentence"):
            skip = 1
        col_len = []
        for r in probe[skip:]:
            for ci, cell in enumerate(r):
                if ci >= len(col_len):
                    col_len.append(0)
                col_len[ci] += len(str(cell))
        text_col = max(range(len(col_len)), key=lambda ci: col_len[ci]) if col_len else 0
        f.seek(0)
        reader = csv.reader(f, delimiter=delimiter)
        for i, row in enumerate(reader):
            if i < skip:
                continue
            if max_rows is not None and i - skip >= max_rows:
                break
            text = row[text_col] if text_col < len(row) else (row[-1] if row else "")
            if not text:
                continue
            toks = [t for t in (norm_token(x) for x in text.split()) if t]
            if not toks:
                continue
            n_sentences += 1
            unigrams.update(toks)
            bigrams.update(zip(toks, toks[1:]))
    return unigrams, bigrams, n_sentences


def read_dictionaries(dict_dir):
    """Extract single-token Amharic words from geezorg AA/DTW/KBT wordlists."""
    words = set()
    patterns = [
        os.path.join(dict_dir, "aa", "*"),
        os.path.join(dict_dir, "dtw", "*"),
        os.path.join(dict_dir, "kbt", "*"),
    ]
    seen_files = set()
    for pat in patterns:
        for p in sorted(glob.glob(pat)):
            if p in seen_files or not p.lower().endswith(".txt"):
                continue
            seen_files.add(p)
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        col = line.split("\t", 1)[0].strip()
                        if col in ("+", "", "-"):
                            continue
                        # single Ethiopic token only (skip space-separated phrases)
                        if ETHIOPIC.match(col):
                            words.add(col)
            except Exception:
                continue
    return words


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="Amharic sentence corpus file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--dict-dir", default=None)
    ap.add_argument("--min-count", type=int, default=3)
    ap.add_argument("--max-bigrams", type=int, default=150000)
    ap.add_argument("--max-rows", type=int, default=None)
    ap.add_argument("--min-part-count", type=int, default=5)
    args = ap.parse_args()

    unigrams, bigrams, n_sentences = read_corpus(args.corpus, args.max_rows)
    if not unigrams:
        print("ERROR: no usable tokens from corpus", args.corpus, file=sys.stderr)
        sys.exit(1)

    dict_words = set()
    if args.dict_dir:
        dict_words = read_dictionaries(args.dict_dir)

    # keep frequent words + all dictionary words (floor count 1)
    vocab = {w for w, c in unigrams.items() if c >= args.min_count}
    vocab |= dict_words

    # ---- unigram probabilities (add-k smoothing over vocab + OOV) -------
    total = float(sum(unigrams[w] for w in vocab if w in unigrams) or 0.0)
    vocab_total = float(len(vocab))
    k = 0.5
    known_counts = {}
    unigram_logp = {}
    for w in vocab:
        c = float(unigrams.get(w, 1))
        known_counts[w] = int(c)
        p = (c + k) / (total + k * vocab_total)
        unigram_logp[w] = _log(p)
    # unseen word mass = single k discount shared by all OOV tokens
    oov_logp = _log(k / (total + k * vocab_total))

    # ---- bigram probabilities with unigram backoff --------------------------
    bigram_logp = {}
    by_first = collections.defaultdict(float)
    for (a, b), c in bigrams.items():
        if a in vocab and b in vocab and c >= 2:
            by_first[a] += c
            bigram_logp[(a, b)] = c
    # keep the most common bigrams (bounded size)
    if len(bigram_logp) > args.max_bigrams:
        keep = {k for k, _ in collections.Counter(bigram_logp).most_common(args.max_bigrams)}
        bigram_logp = {k: v for k, v in bigram_logp.items() if k in keep}
    bg = {}
    for (a, b), c in bigram_logp.items():
        # CONDITIONAL LOG-PROBABILITY. amh_lm.py sums these into a log-prob
        # chain (unigram_logp/oov_logp are already log). Storing the raw
        # probability here (as a buggy early build did) poisons every score:
        # a 0.03 raw prob added into a sum of logs is a huge positive spike.
        if unigrams[a] > 0:
            p = _log(c / unigrams[a])
        else:
            p = unigram_logp[b]
        bg["%s\t%s" % (a, b)] = p
    bigram_logp = bg

    # ---- serialize -----------------------------------------------------------
    payload = {
        "unigram": [(w, unigram_logp[w]) for w in sorted(vocab)],
        "counts": known_counts,
        "bigram": bigram_logp,
        "oov_logp": oov_logp,
        "min_margin": 4.0,
        "min_part_count": args.min_part_count,
        "boundary_cost": 1.0,
        "n_sentences": n_sentences,
    }
    out = args.out
    if not out.endswith(".gz"):
        out = out + ".gz"
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {out}")
    print(f"  vocab={len(vocab)}  bigrams={len(bigram_logp)}  "
          f"dict_words={len(dict_words)}  sentences={n_sentences}")


def _log(x):
    if x <= 0:
        return -20.0
    return math.log(x)


if __name__ == "__main__":
    main()