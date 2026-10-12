#!/usr/bin/env python3
"""Build tools/lm/orm_lm.json.gz, the Afaan Oromo word list that splits words
the speech model glued together ("sagantaakeenya" -> "sagantaa keenya").

Input: Oromo sentences, one per line (the 1.10.20 build used the
transcriptions of google/WaxalNLP orm_asr, TRAIN split, CC-BY-4.0 - never the
test split the accuracy numbers come from).

    python tools/build_lm_orm.py --corpus orm_train.txt --out tools/lm/orm_lm.json.gz

Same format as tools/build_lm.py (natural-log unigram / bigram, OOV floor),
read by amh_lm.AmharicLM with the Qubee word rule.
"""
import argparse
import collections
import gzip
import json
import math
import re

WORD = re.compile(r"^[a-z']+$")


def tokens(line):
    line = line.lower().replace("’", "'").replace("`", "'")
    for t in re.split(r"[^a-z']+", line):
        t = t.strip("'")
        if t and WORD.match(t):
            yield t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-count", type=int, default=2)
    ap.add_argument("--min-part-count", type=int, default=3)
    ap.add_argument("--min-margin", type=float, default=20.0)
    ap.add_argument("--max-bigrams", type=int, default=100000)
    ap.add_argument("--ending-ratio", type=float, default=2.0)
    a = ap.parse_args()

    uni, bi = collections.Counter(), collections.Counter()
    for line in open(a.corpus, encoding="utf-8"):
        toks = list(tokens(line))
        uni.update(toks)
        bi.update(zip(toks, toks[1:]))
    vocab = {w: c for w, c in uni.items() if c >= a.min_count and len(w) >= 2}
    total = sum(vocab.values())
    k = 0.5
    logp = {w: math.log((c + k) / (total + k * len(vocab))) for w, c in vocab.items()}
    oov = math.log(k / (total + k * len(vocab)))
    big = {}
    for (x, y), c in bi.most_common(a.max_bigrams):
        if x in vocab and y in vocab and c >= 2:
            big[x + "\t" + y] = math.log(c / vocab[x])
    # Oromo adds endings to words (-tti, -dhaan, -tee). A piece found far more
    # often at the end of other words than on its own is an ending, never a
    # word to split off ("barreeffamaatti" stays one word).
    ends = collections.Counter()
    for w, c in vocab.items():
        for i in range(1, len(w) - 2):
            ends[w[i:]] += c
    endings = sorted(p for p, c in vocab.items() if ends[p] > a.ending_ratio * c)
    out = {"unigram": logp, "counts": vocab, "bigram": big, "oov_logp": oov,
           "endings": endings,
           "min_margin": a.min_margin, "min_part_count": a.min_part_count,
           "boundary_cost": 1.0, "max_word_len": 20, "max_run_len": 34, "min_part_len": 3,
           "source": "google/WaxalNLP orm_asr train transcriptions (CC-BY-4.0)"}
    with gzip.open(a.out, "wt", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("words %d (of %d), bigrams %d, tokens %d, endings %d" % (len(vocab), len(uni), len(big), total, len(endings)))


if __name__ == "__main__":
    main()
