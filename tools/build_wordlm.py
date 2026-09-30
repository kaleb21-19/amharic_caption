#!/usr/bin/env python3
"""Build tools/lm/amh_wordlm.json.gz — the bigger word list the decoder
(amh_decode.py) scores words with.

Sources (only word / word-pair COUNTS are shipped, never the text):
  * the shipped tools/lm/amh_lm.json.gz (40k sentences + dictionary)
  * AfriBERTa corpus, Amharic train split (Apache-2.0):
      https://huggingface.co/datasets/castorini/afriberta-corpus  amharic/train.zip
  * Amharic Wikipedia (CC BY-SA):
      https://dumps.wikimedia.org/amwiki/latest/amwiki-latest-pages-articles.xml.bz2
Every corpus sentence sharing a 5-word run with a TEST reference (FLEURS /
WAXAL / fixtures) is dropped first, so accuracy measurements stay honest.

Usage:
    python tools/build_wordlm.py --corpus DIR [--tests-tsv F ...] [--size S]
DIR holds afriberta/train.txt (unzipped) and amwiki.xml (bunzip2'ed).
Shipped 2026-10-01 as size S (240k words, 500k pairs, 11 MB), decoder
alpha 0.35 / gamma -4.5: held-out FLEURS 19.57 -> 18.93, WAXAL 25.41 -> 24.87
vs the plain amh_lm word list. Bigger sizes (M, L) measured no better.
"""
import argparse
import bz2
import collections
import glob
import gzip
import json
import math
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO, "tools"))
from build_lm import norm_token  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--corpus", required=True)
ap.add_argument("--tests-tsv", nargs="*", default=[], help="TSVs whose text columns are test references")
ap.add_argument("--size", choices=["S", "M", "L"], default="S")
ap.add_argument("--out", default=os.path.join(REPO, "tools", "lm", "amh_wordlm.json.gz"))
args = ap.parse_args()
CORP = args.corpus
NL, TAB = chr(10), chr(9)


def toks_of(text):
    return [t for t in (norm_token(x) for x in text.split()) if t]


refs = []
for tsv in args.tests_tsv:
    with open(tsv, encoding="utf-8") as f:
        for line in f:
            refs.extend(p for p in line.rstrip(NL).split(TAB) if len(p) > 20)
for t in glob.glob(os.path.join(REPO, "tools", "test", "fixtures*", "*.txt")):
    refs.append(open(t, encoding="utf-8").read())

ban = set()
for r in refs:
    tk = toks_of(r)
    for i in range(len(tk) - 4):
        ban.add(tuple(tk[i:i + 5]))
print("test refs", len(refs), "banned 5-grams", len(ban), flush=True)


# ── corpus sentences ───────────────────────────────────────────────────────
def afriberta():
    with open(os.path.join(CORP, "afriberta", "train.txt"), encoding="utf-8", errors="ignore") as f:
        for line in f:
            for s in re.split(r"[።!?፧]+", line):
                yield s


WIKI_DROP = [
    (re.compile(r"\{\{[^{}]*\}\}"), " "), (re.compile(r"\{\|.*?\|\}", re.S), " "),
    (re.compile(r"<ref[^>]*/>"), " "), (re.compile(r"<ref.*?</ref>", re.S), " "),
    (re.compile(r"<[^>]+>"), " "), (re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]"), r"\1"),
    (re.compile(r"\[https?://\S+\s*([^\]]*)\]"), r"\1"), (re.compile(r"'{2,}"), ""),
    (re.compile(r"^[=*#:;!|].*$", re.M), " "),
]


def wiki():
    xml = open(os.path.join(CORP, "amwiki.xml"), encoding="utf-8", errors="ignore").read()
    for m in re.finditer(r"<text[^>]*>(.*?)</text>", xml, re.S):
        t = m.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&amp;", "&")
        if t.lstrip().lower().startswith("#redirect") or t.lstrip().startswith("#መምሪያ"):
            continue
        for _ in range(3):
            for rx, rep in WIKI_DROP[:1]:
                t = rx.sub(rep, t)
        for rx, rep in WIKI_DROP[1:]:
            t = rx.sub(rep, t)
        for s in re.split(r"[።!?፧\n]+", t):
            yield s


uni = collections.Counter()
bi = collections.Counter()
stats = collections.Counter()
for name, gen in (("afriberta", afriberta), ("wiki", wiki)):
    for s in gen():
        tk = toks_of(s)
        if len(tk) < 2:
            continue
        if any(tuple(tk[i:i + 5]) in ban for i in range(len(tk) - 4)):
            stats[name + "_dropped_test_overlap"] += 1
            continue
        stats[name + "_sentences"] += 1
        uni.update(tk)
        bi.update(zip(tk, tk[1:]))
print(dict(stats), "tokens", sum(uni.values()), "types", len(uni), flush=True)

# ── the shipped LM's knowledge (counts + dictionary), as counts ────────────
old = json.load(gzip.open(os.path.join(REPO, "tools", "lm", "amh_lm.json.gz"), "rt", encoding="utf-8"))
old_counts = old.get("counts", {})
old_vocab = {w for w, _ in old["unigram"]}
for w in old_vocab:
    uni[w] += max(1, int(old_counts.get(w, 1)))
for k, lp in old["bigram"].items():
    a, b = k.split("\t")
    bi[(a, b)] += max(1, int(round(math.exp(lp) * max(1, old_counts.get(a, 1)))))
print("merged: types", len(uni), "bigram types", len(bi), flush=True)


def write(vmax, bmax, path):
    vocab = set(w for w, c in uni.most_common() if c >= 2)
    vocab |= old_vocab
    if len(vocab) > vmax:
        keep = [w for w, _ in uni.most_common() if w in vocab][:vmax]
        vocab = set(keep) | old_vocab
    total = float(sum(uni[w] for w in vocab))
    k = 0.5
    V = float(len(vocab))
    ulp = {w: math.log((uni[w] + k) / (total + k * V)) for w in vocab}
    oov = math.log(k / (total + k * V))
    cand = [((a, b), c) for (a, b), c in bi.items() if c >= 2 and a in vocab and b in vocab]
    cand.sort(key=lambda x: -x[1])
    cand = cand[:bmax]
    bg = {"%s\t%s" % (a, b): math.log(c / uni[a]) for (a, b), c in cand}
    payload = {"decoder": {"alpha": 0.35, "gamma": -4.5}, "unigram": [(w, ulp[w]) for w in sorted(vocab)], "counts": {w: int(uni[w]) for w in vocab},
               "bigram": bg, "oov_logp": oov, "n_sentences": int(sum(v for kk, v in stats.items() if kk.endswith("_sentences"))) + old.get("n_sentences", 0),
               "sources": "shipped amh_lm (40k sentences + dictionary) + AfriBERTa Amharic (Apache-2.0) + Amharic Wikipedia; test sentences removed"}
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print("wrote %s  vocab %d  bigrams %d  size %.1f MB" % (os.path.basename(path), len(vocab), len(bg), os.path.getsize(path) / 1e6), flush=True)


SIZES = {"S": (200000, 500000), "M": (300000, 1000000), "L": (500000, 2000000)}
write(SIZES[args.size][0], SIZES[args.size][1], args.out)
