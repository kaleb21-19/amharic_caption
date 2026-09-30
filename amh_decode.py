#!/usr/bin/env python3
"""Word-aware CTC decoding for Amharic Captions.

Greedy decoding takes the single likeliest letter at every frame. This decoder
keeps the best few letter sequences (prefix beam search) and scores every
finished word with the Amharic word list / word-pair list in amh_lm.json.gz
(shallow fusion, the standard pyctcdecode-style score):

    score = log P_model(letters) + ALPHA * (log P_lm(word | prev) - log P_unknown) + GAMMA

so a word the model half-heard but that is a real Amharic word in context
beats a near-tie that is not; an unknown word (a name) is neutral. A partial
word that cannot start any known word pays UNK_PREFIX. Inside an unknown word
greedy's word breaks are kept (keep_greedy_breaks), so names are never glued.
Measured 2026-10-01, full product pipeline, tuned on 294 clips and CONFIRMED
on 498 clips it never saw (greedy -> this decoder, WER %):
    held-out FLEURS 21.65 -> 19.57   WAXAL 26.65 -> 25.41
    tuning   FLEURS 21.13 -> 19.40   WAXAL 26.53 -> 25.90   CV 39.32 -> 35.04
Stronger LM weights (ALPHA >= 0.5) hurt phone recordings (WAXAL), so the
weight is kept low. Decoding costs ~0.7% of the model's time.

Word timing: the chosen letters are placed back on the audio by CTC forced
alignment (Viterbi), so every letter gets the frames that best explain it.

Pure numpy + stdlib. AMH_DECODE=greedy turns it off.
"""
import gzip
import json
import math
import os
from collections import defaultdict

import numpy as np

# LM weight / per-word score. Each word-list file carries the pair tuned for
# it ("decoder": {"alpha", "gamma"}); these are the defaults for a file that
# does not, and AMH_LM_ALPHA / AMH_LM_GAMMA override both.
ALPHA = 0.35
GAMMA = -3.5
BEAM_WIDTH = int(os.environ.get("AMH_BEAM_WIDTH", "16"))
TOP_K = 8
UNK_PREFIX = -3.0
_PRUNE = -9.0          # a letter with log-prob below this at a frame is not tried
_NEG = -1e30

_LM = None


class _WordLM:
    def __init__(self, path):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            d = json.load(f)
        u = d["unigram"]
        self.uni = dict(u) if isinstance(u, list) else dict(u)
        self.bi = d.get("bigram", {})
        self.tri = d.get("trigram", {})     # "a\tb\tc" -> log P(c | a b), optional
        self.oov = float(d.get("oov_logp", -12.0))
        tuned = d.get("decoder") or {}
        self.alpha = float(os.environ.get("AMH_LM_ALPHA") or tuned.get("alpha", ALPHA))
        self.gamma = float(os.environ.get("AMH_LM_GAMMA") or tuned.get("gamma", GAMMA))
        self.path = path
        pre = set()
        for w in self.uni:
            for k in range(1, len(w) + 1):
                pre.add(w[:k])
        self.prefixes = pre

    def logp(self, prev, w, prev2=None):
        if prev2 is not None and prev is not None and self.tri:
            t = self.tri.get(prev2 + "\t" + prev + "\t" + w)
            if t is not None:
                return t
        if prev is not None:
            b = self.bi.get(prev + "\t" + w)
            if b is not None:
                return b
        return self.uni.get(w, self.oov)

    def word_score(self, prev, w, alpha, gamma, prev2=None):
        """What a finished word adds. A KNOWN word gets how much likelier it
        is than an unknown one (alpha * (log p - log p_oov) >= 0); an UNKNOWN
        word (a name, a new word) gets nothing — so gluing two unknown words
        into one never pays. (It did when every unknown word cost a fixed
        penalty: the decoder dropped the spaces between names.) gamma is the
        same for every word."""
        return alpha * max(0.0, self.logp(prev, w, prev2) - self.oov) + gamma


def get_lm():
    """The word LM (loaded once per process), or None if it is missing."""
    global _LM
    if _LM is None:
        # The decoder's own, bigger word list (amh_wordlm.json.gz: next to this
        # file in the runtime, tools/lm/ in the repo) when it is there;
        # otherwise the shared amh_lm.json.gz. AMH_WORDLM overrides.
        here = os.path.dirname(os.path.abspath(__file__))
        paths = [os.environ.get("AMH_WORDLM"),
                 os.path.join(here, "amh_wordlm.json.gz"),
                 os.path.join(here, "tools", "lm", "amh_wordlm.json.gz"),
                 os.path.join(here, "amh_lm.json.gz")]
        _LM = False
        for path in paths:
            if path and os.path.isfile(path):
                try:
                    _LM = _WordLM(path)
                    break
                except Exception:
                    continue
    return _LM or None


def _lse(a, b):
    if a < b:
        a, b = b, a
    if b <= _NEG:
        return a
    return a + math.log1p(math.exp(b - a))


def log_softmax(logits):
    x = np.asarray(logits, dtype=np.float32)
    x = x - x.max(-1, keepdims=True)
    return x - np.log(np.exp(x).sum(-1, keepdims=True))


def beam_decode(logp, blank, glyphs, skip, space, lm, alpha=None, gamma=None, width=BEAM_WIDTH):
    """Best token-id sequence (letters and word spaces, no blanks/repeats) for
    a (T, V) log-prob matrix. alpha / gamma default to the word list's own."""
    if alpha is None:
        alpha = getattr(lm, "alpha", ALPHA)
    if gamma is None:
        gamma = getattr(lm, "gamma", GAMMA)
    T, V = logp.shape
    k = min(TOP_K, V)
    # state: (finished words tuple, current word, last token) -> [p_blank, p_nonblank, lm score, token ids]
    beams = {((), "", None): [0.0, _NEG, 0.0, ()]}
    for t in range(T):
        row = logp[t]
        top = np.argpartition(-row, k - 1)[:k]
        cand = [int(c) for c in top if row[c] > _PRUNE and int(c) not in skip]
        if blank not in cand:
            cand.append(blank)
        nb = {}

        def slot(key, lms, ids):
            e = nb.get(key)
            if e is None:
                e = nb[key] = [_NEG, _NEG, lms, ids]
            return e

        for (words, cur, last), (pb, pnb, lms, ids) in beams.items():
            tot = _lse(pb, pnb)
            for c in cand:
                p = float(row[c])
                if c == blank:
                    e = slot((words, cur, last), lms, ids)
                    e[0] = _lse(e[0], tot + p)
                    continue
                if c == last:
                    e = slot((words, cur, last), lms, ids)
                    e[1] = _lse(e[1], pnb + p)
                    src = pb + p          # the same letter again, after a blank
                else:
                    src = tot + p
                if src <= _NEG:
                    continue
                if c in space:
                    if not cur:
                        e = slot((words, cur, c), lms, ids)
                        e[1] = _lse(e[1], src)
                        continue
                    prev = words[-1] if words else None
                    add = lm.word_score(prev, cur, alpha, gamma, words[-2] if len(words) > 1 else None)
                    e = slot((words + (cur,), "", c), lms + add, ids + (c,))
                    e[1] = _lse(e[1], src)
                else:
                    e = slot((words, cur + glyphs.get(c, ""), c), lms, ids + (c,))
                    e[1] = _lse(e[1], src)

        def rank(item):
            (words, cur, last), (pb, pnb, lms, ids) = item
            pen = 0.0 if (not cur or cur in lm.prefixes) else UNK_PREFIX
            return _lse(pb, pnb) + lms + pen

        beams = dict(sorted(nb.items(), key=rank, reverse=True)[:width])
    best, best_s = (), _NEG
    for (words, cur, last), (pb, pnb, lms, ids) in beams.items():
        s = _lse(pb, pnb) + lms
        if cur:
            s += lm.word_score(words[-1] if words else None, cur, alpha, gamma,
                               words[-2] if len(words) > 1 else None)
        if s > best_s:
            best_s, best = s, ids
    return list(best)


def forced_align(logp, tokens, blank):
    """CTC Viterbi alignment of `tokens` to the frames: [(tok, start, end)].
    Falls back to None when the sequence cannot fit the frames."""
    T = logp.shape[0]
    L = len(tokens)
    if L == 0:
        return []
    ext = [blank]
    for tk in tokens:
        ext += [tk, blank]
    S = len(ext)
    if 2 * L - 1 > T * 2:
        return None
    ext_a = np.asarray(ext)
    emit = logp[:, ext_a]                                  # (T, S)
    same = np.zeros(S, dtype=bool)                          # skip over blank allowed?
    for s in range(2, S):
        same[s] = ext[s] != blank and ext[s] != ext[s - 2]
    dp = np.full(S, _NEG, dtype=np.float64)
    dp[0] = emit[0, 0]
    if S > 1:
        dp[1] = emit[0, 1]
    back = np.zeros((T, S), dtype=np.int8)                  # 0 stay, 1 from s-1, 2 from s-2
    for t in range(1, T):
        stay = dp
        prev1 = np.concatenate(([_NEG], dp[:-1]))
        prev2 = np.concatenate(([_NEG, _NEG], dp[:-2]))
        prev2 = np.where(same, prev2, _NEG)
        best = np.maximum(np.maximum(stay, prev1), prev2)
        arg = np.where(best == stay, 0, np.where(best == prev1, 1, 2)).astype(np.int8)
        dp = best + emit[t]
        back[t] = arg
    s = S - 1 if S == 1 or dp[S - 1] >= dp[S - 2] else S - 2
    if dp[s] <= _NEG / 2:
        return None
    path = [0] * T
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= int(back[t, s])
    spans = []
    for t, s in enumerate(path):
        if s % 2 == 1:
            k = s // 2
            if spans and spans[-1][3] == k:
                spans[-1][2] = t
            else:
                spans.append([tokens[k], t, t, k])
    return [(tk, a, b) for tk, a, b, _ in spans]


def keep_greedy_breaks(lp, toks, spans, blank, glyphs, space, lm):
    """Inside an UNKNOWN word, put back every word break greedy decoding had.

    The decoder may join greedy's pieces into a real Amharic word (a common
    fix: "በ ሁሉም" -> "በሁሉም"), but it must never glue names or new words
    together ("ፋልማስተስፋየ ታሙት" -> one 16-letter blob on screen). Returns the
    token list with those spaces restored (or the input unchanged)."""
    greedy = np.argmax(lp, -1)
    breaks = [t for t in range(len(greedy)) if int(greedy[t]) in space]
    if not breaks or not spans:
        return toks
    sp_tok = next(iter(space))
    # the words of the beam output, as (first span index, last span index)
    words, cur = [], None
    for k, (tk, s, e) in enumerate(spans):
        if tk in space:
            if cur is not None:
                words.append(cur)
                cur = None
            continue
        cur = (cur[0], k) if cur is not None else (k, k)
    if cur is not None:
        words.append(cur)
    insert_after = set()        # span indices after which a space goes back
    for a, b in words:
        text = "".join(glyphs.get(spans[k][0], "") for k in range(a, b + 1))
        if lm.uni.get(text) is not None:
            continue            # a real word: the decoder's join stands
        for f in breaks:
            if spans[a][1] < f < spans[b][2]:
                # the last letter of this word that ends before the break
                k = max((j for j in range(a, b) if spans[j][2] < f), default=None)
                if k is not None:
                    insert_after.add(k)
    if not insert_after:
        return toks
    out = []
    for k, (tk, s, e) in enumerate(spans):
        out.append(tk)
        if k in insert_after:
            out.append(sp_tok)
    return out


def decode(logits, blank, glyphs, skip_ids, space_ids):
    """(token ids, spans) for the word-aware decode, or None to use greedy."""
    if os.environ.get("AMH_DECODE", "lm") == "greedy":
        return None
    lm = get_lm()
    if lm is None:
        return None
    lp = log_softmax(np.asarray(logits, dtype=np.float32)[0])
    toks = beam_decode(lp, blank, glyphs, skip_ids, space_ids, lm)
    spans = forced_align(lp, toks, blank)
    if spans is None:
        return None
    fixed = keep_greedy_breaks(lp, toks, spans, blank, glyphs, space_ids, lm)
    if fixed is not toks:
        spans2 = forced_align(lp, fixed, blank)
        if spans2 is not None:
            toks, spans = fixed, spans2
    return toks, spans


# ── self-check (CI): python amh_decode.py ──────────────────────────────────
if __name__ == "__main__":
    import sys
    fails = 0

    def check(cond, msg):
        global fails
        print(("  ok    " if cond else "  FAIL  ") + msg)
        if not cond:
            fails += 1

    # tiny vocab: 0 blank, 1 space, 2 'ሰ', 3 'ላ', 4 'ም', 5 'ማ'
    glyphs = {0: "[PAD]", 1: "|", 2: "ሰ", 3: "ላ", 4: "ም", 5: "ማ"}
    B, SP = 0, {1}

    def frames(seq, p=0.9):
        rows = []
        for tok in seq:
            r = np.full(6, (1 - p) / 5)
            r[tok] = p
            rows.append(r)
        return np.log(np.asarray(rows, dtype=np.float32))

    # forced alignment: every token lands on the frames that carry it
    lp = frames([0, 2, 2, 0, 3, 0, 4, 4, 0])
    al = forced_align(lp, [2, 3, 4], B)
    check(al == [(2, 1, 2), (3, 4, 4), (4, 6, 7)], "forced alignment places each letter on its frames: %s" % al)
    check(forced_align(lp, [], B) == [], "empty sequence -> no spans")

    # the word list decides a near-tie: last letter ም (0.52) vs ማ (0.48)
    class _Stub:
        prefixes = {"ሰ", "ሰላ", "ሰላም"}
        oov = -12.0

        def logp(self, prev, w):
            return -2.0 if w == "ሰላም" else -12.0

        def word_score(self, prev, w, alpha, gamma, prev2=None):
            return alpha * max(0.0, self.logp(prev, w) - self.oov) + gamma
    lp2 = frames([0, 2, 0, 3, 0, 5, 0])
    lp2[5] = np.log(np.asarray([0.0, 0.0, 0.0, 0.0, 0.52, 0.48], dtype=np.float32) + 1e-6)
    lp2[5, 4], lp2[5, 5] = math.log(0.48), math.log(0.52)   # greedy would pick ማ
    toks = beam_decode(lp2, B, glyphs, set(), SP, _Stub(), alpha=0.35, gamma=-1.0)
    word = "".join(glyphs[t] for t in toks)
    check(word == "ሰላም", "a real word beats a near-tie non-word: %s" % word)
    toks0 = beam_decode(lp2, B, glyphs, set(), SP, _Stub(), alpha=0.0, gamma=0.0)
    check("".join(glyphs[t] for t in toks0) == "ሰላማ", "without the word list it follows the model")

    os.environ["AMH_DECODE"] = "greedy"
    check(decode(lp2[None], B, glyphs, set(), SP) is None, "AMH_DECODE=greedy switches it off")
    print("\nALL PASS" if not fails else "\nFAILURES: %d" % fails)
    sys.exit(1 if fails else 0)
