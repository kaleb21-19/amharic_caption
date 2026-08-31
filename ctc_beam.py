#!/usr/bin/env python3
"""CTC prefix beam search for Amharic Captions.

Improves on greedy argmax by searching over whole label prefixes and keeping
the top beam_size candidates. For a CTC model (the Ethio-ASR-amharic
Wav2Vec2Bert we ship) context resolves many near-ties per-frame argmax gets
wrong, typically raising word accuracy several points.

The winning path yields both the decoded text AND the per-character frame
segments, so word timing stays consistent with the rendered text.

Pure numpy. No scipy, no torch -> safe in the tiny CTranslate2 runtime.

Implementation follows the canonical prefix beam search (Hannun et al. / the
Kevin Hu CTC-prefix-beam-search gist):
  * each beam entry = (label_prefix, p_blank, p_noblank, alignment)
  * blank always stays in current prefix (p_blank)
  * a repeated final label MERGES into the current prefix (p_noblank)
  * any other label EXTENDS the prefix (new entry)
Alignment (start frame per label) is carried along each winning beam path.

Usage:
    from ctc_beam import ctc_beam_decode
    text, segments = ctc_beam_decode(logits_2d, blank_id, glyphs)

    segments: list[(token_id, start_frame, end_frame)] along the best path
    text    : decoded string (glyphs joined, '|' -> space)

Standalone self-check:
    python ctc_beam.py
"""
import sys

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

_LOGZERO = -float("inf")


def _logadd(a, b):
    if a == _LOGZERO:
        return b
    if b == _LOGZERO:
        return a
    if a < b:
        a, b = b, a
    return a + float(__import__("math").log1p(__import__("math").exp(b - a)))


def ctc_beam_decode(logits, blank_id, glyphs=None, beam_width=50,
                    top_k=None, max_frames=None):
    """Return (text, segments) from CTC frame logits.

    logits : (T, V) or (1, T, V). Raw logits are normalized to log-probs.
    glyphs : dict token_id -> char (used to render text; '|' becomes a space).
    """
    logits = np.asarray(logits, dtype=np.float32)
    if logits.ndim == 3:
        logits = logits[0]
    if logits.ndim != 2:
        raise ValueError("logits must be (T, V) or (1, T, V)")
    T, V = logits.shape
    if max_frames is not None:
        T = min(T, int(max_frames))

    # stable per-frame log-probabilities
    mx = logits[:T].max(axis=1, keepdims=True)
    logp = logits[:T] - mx
    logp = logp - np.log(np.exp(logp).sum(axis=1, keepdims=True) + 1e-12)

    # Precompute normalized frame probabilities as floats (T, V).
    lp = logp

    # list of candidate token indices per frame (all V unless top_k given)
    cands = []
    for t in range(T):
        if top_k is not None and top_k < V:
            k = min(top_k, V)
            idx = np.argpartition(-lp[t], k - 1)[:k]
            cands.append([int(i) for i in idx])
        else:
            cands.append(list(range(V)))

    # beam: prefix-tuple -> [p_blank, p_noblank, alignment(list of (tok, start))]
    beam = {(): [_LOGZERO, 0.0, []]}

    for t in range(T):
        row = lp[t]
        nxt = {}
        for prefix, (pb, pnb, align) in beam.items():
            # -- blank: stays in current prefix --------------------------------
            p_blank_c = float(row[blank_id])
            if p_blank_c > _LOGZERO:
                cur = nxt.get(prefix)
                if cur is None:
                    cur = [_LOGZERO, _LOGZERO, align]
                    nxt[prefix] = cur
                cur[0] = _logadd(cur[0], _logadd(pb, pnb) + p_blank_c)

            # -- non-blank candidates ------------------------------------------
            last = prefix[-1] if prefix else None
            for c in cands[t]:
                if c == blank_id:
                    continue
                pc = float(row[c])
                if pc == _LOGZERO:
                    continue
                if c == last:
                    # repeat of final label -> merge (no new char)
                    cur = nxt.get(prefix)
                    if cur is None:
                        cur = [_LOGZERO, _LOGZERO, align]
                        nxt[prefix] = cur
                    cur[1] = _logadd(cur[1], pnb + pc)
                else:
                    # extend prefix with c
                    ext = prefix + (c,)
                    new_align = align + [(c, t)]
                    cur = nxt.get(ext)
                    if cur is None:
                        cur = [_LOGZERO, _LOGZERO, new_align]
                        nxt[ext] = cur
                    cur[1] = _logadd(cur[1], _logadd(pb, pnb) + pc)

        # prune beam by total log-prob
        if len(nxt) > beam_width:
            scored = sorted(nxt.items(),
                            key=lambda kv: _logadd(kv[1][0], kv[1][1]),
                            reverse=True)
            nxt = {k: v for k, v in scored[:beam_width]}
        beam = nxt

    if not beam:
        return "", []

    best = max(beam.items(),
               key=lambda kv: _logadd(kv[1][0], kv[1][1]))
    prefix, (_, _, align) = best

    # build end frames for each label from its neighbour's start
    segments = []
    for i, (tok, s) in enumerate(align):
        e = align[i + 1][1] - 1 if i + 1 < len(align) else T - 1
        if e < s:
            e = s
        segments.append((tok, s, e))

    if glyphs is None:
        text = "".join(str(tok) for tok, _, _ in segments)
    else:
        chars = []
        for tok, _, _ in segments:
            ch = glyphs.get(tok, "")
            chars.append(" " if ch == "|" else ch)
        text = "".join(chars)
        text = " ".join(text.split())
    return text, segments


if __name__ == "__main__":
    V = 411
    blank = 408

    def run_case(name, build):
        logits = build()
        glyphs = {408: "", 7: "ሀ", 12: "ለ", 200: "ም"}
        text, segs = ctc_beam_decode(logits, blank, glyphs=glyphs,
                                     beam_width=50)
        toks = [t for t, _, _ in segs]
        print(f"[{name}] toks={toks}  text={text!r}")
        return toks, text

    # Case 1: strong repeated token 7 across frames 0..4 must MERGE to one 7.
    def c1():
        l = np.random.default_rng(1).normal(size=(40, V)) * 0.05
        l[0:5, 7] += 8.0
        l[5:15, blank] += 8.0
        l[15:18, 12] += 8.0
        l[18:40, blank] += 8.0   # silence the tail so only 7 and 12 survive
        return l
    toks1, _ = run_case("repeat-merge", c1)
    assert toks1 == [7, 12], f"FAIL: expected [7, 12], got {toks1}"
    print("  -> repeat-merge PASS")

    # Case 2: greedy splits a tie badly; beam should pick total best path.
    def c2():
        l = np.random.default_rng(2).normal(size=(30, V)) * 0.02
        # token A (7) strong 0..2, token B (200) close 3..4, token A strong 5..6
        l[0:3, 7] += 6.0
        l[3:5, 200] += 5.5
        l[5:7, 7] += 6.0
        l[7:30, blank] += 8.0
        return l
    toks2, text2 = run_case("context", c2)
    print("  -> context decoded:", toks2, repr(text2), "(informational)")
    # two 7-runs separated by 200 must stay two 7s (NOT merged across a
    # different token): correct CTC order is [7, 200, 7].
    assert toks2 == [7, 200, 7], f"FAIL: {toks2}"
    print("  -> context PASS")

    print("ALL PASS")
