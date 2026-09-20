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
                    top_k=None, max_frames=None, lm=None, lambda_lm=0.0):
    """Return (text, segments) from CTC frame logits.

    logits : (T, V) or (1, T, V). Raw logits are normalized to log-probs.
    glyphs : dict token_id -> char (used to render text; '|' becomes a space).
    lm     : AmharicLM instance or None. If provided (and lambda_lm > 0),
             shallow word-LM fusion adds a bonus at each word boundary for
             words the LM's OOV splitter (`lm.split_word`) can rescue —
             mirrors amh_correct's post-pass, but folded into beam scoring
             instead of applied after the fact. The utterance's last word
             (never followed by a space) is scored once at final selection.
    lambda_lm : weight for LM contribution (0 = pure acoustic, default 0.0;
             AMH_LM_LAMBDA=0 is the shipped default and reproduces plain
             acoustic-only decoding exactly — lm is never even consulted).
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

    # LM fusion helpers: track word-level LM score along the prefix.
    # A "word" in the token stream is a run of non-blank, non-space tokens.
    # When a space token (|) is added, the word is complete → score with LM.
    _SPACE_ID = None  # set below from glyphs
    if glyphs is not None:
        for _tid, _ch in glyphs.items():
            if _ch == " ":
                _SPACE_ID = _tid
                break
    _lambda = float(lambda_lm)

    def _word_lm_score(word_tokens):
        """Score a just-completed word (list of token IDs since the last
        space, NOT including the space itself) with the LM. Delegates the
        OOV-rescue decision entirely to `lm.split_word()` (the same vetted
        margin/boundary-cost logic used by amh_correct's post-pass) rather
        than re-deriving it here, so the two stay in lockstep. Returns a
        lambda-scaled log-prob bonus, or 0.0 if fusion is disabled, the LM
        is unavailable, or the word wasn't a rescuable OOV split."""
        if _lambda <= 0 or lm is None:
            return 0.0
        try:
            word_text = "".join(glyphs.get(t, "") for t in word_tokens if t != _SPACE_ID)
            if not word_text:
                return 0.0
            parts = lm.split_word(word_text)
            if len(parts) < 2:
                return 0.0  # LM didn't rescue this word; no bonus
            return _lambda * sum(lm.unigram_score(p) for p in parts)
        except Exception:
            return 0.0

    # beam: prefix-tuple -> [p_blank, p_noblank, alignment(list of (tok, start)), word_tokens]
    beam = {(): [_LOGZERO, 0.0, [], []]}  # prefix, [p_blank, p_noblank, align, word_tokens]

    for t in range(T):
        row = lp[t]
        nxt = {}
        for prefix, (pb, pnb, align, word_tokens) in beam.items():
            # -- blank: stays in current prefix --------------------------------
            p_blank_c = float(row[blank_id])
            if p_blank_c > _LOGZERO:
                cur = nxt.get(prefix)
                if cur is None:
                    cur = [_LOGZERO, _LOGZERO, align, word_tokens]
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
                        cur = [_LOGZERO, _LOGZERO, align, word_tokens]
                        nxt[prefix] = cur
                    cur[1] = _logadd(cur[1], pnb + pc)
                else:
                    # extend prefix with c
                    ext = prefix + (c,)
                    new_align = align + [(c, t)]
                    # Track word tokens for LM scoring (accumulate since last
                    # space). On a space, `word_tokens` (pre-extension) is the
                    # just-finished word: score it, then reset to [] so the
                    # NEXT word starts fresh instead of accumulating the whole
                    # utterance into one ever-growing "word".
                    lm_bonus = 0.0
                    if c == _SPACE_ID:
                        if _lambda > 0 and lm is not None and word_tokens:
                            lm_bonus = _word_lm_score(word_tokens)
                        new_word_tokens = []
                    else:
                        new_word_tokens = word_tokens + [c]
                    cur = nxt.get(ext)
                    if cur is None:
                        cur = [_LOGZERO, _LOGZERO, new_align, new_word_tokens]
                        nxt[ext] = cur
                    cur[1] = _logadd(cur[1], _logadd(pb, pnb) + pc + lm_bonus)

        # prune beam by total log-prob
        if len(nxt) > beam_width:
            scored = sorted(nxt.items(),
                            key=lambda kv: _logadd(kv[1][0], kv[1][1]),
                            reverse=True)
            nxt = {k: v for k, v in scored[:beam_width]}
        beam = nxt

    if not beam:
        return "", []

    # Final selection: a word never followed by another space (i.e. the last
    # word of the utterance) is never scored by the loop above, since LM
    # fusion only fires when a space token EXTENDS a prefix. Fold each
    # candidate's still-pending trailing word into the ranking key here (once,
    # at selection time only — it never affects mid-utterance pruning, which
    # is fine: there are no more frames left for it to have influenced).
    def _final_score(kv):
        pb, pnb, _align, word_tokens = kv[1]
        score = _logadd(pb, pnb)
        if _lambda > 0 and lm is not None and word_tokens:
            score += _word_lm_score(word_tokens)
        return score

    best = max(beam.items(), key=_final_score)
    prefix, (_, _, align, word_tokens) = best

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

    # Case 3: LM shallow fusion — safe default (lambda=0 never touches the
    # LM) + word-boundary reset (each word scored independently, not as one
    # ever-growing concatenation of the whole utterance — regression guard
    # for a bug where word_tokens was never cleared after a space) + the
    # trailing (last, space-less) word still gets scored at selection time.
    class _StubLM:
        def __init__(self):
            self.calls = []
        def split_word(self, word):
            self.calls.append(word)
            return [word, word]  # always "rescues" -> always a nonzero bonus
        def unigram_score(self, w):
            return -1.0

    glyphs3 = {408: "", 7: "ሀ", 12: "ለ", 300: " "}

    def c3():
        # top_k=1 below makes each frame's candidate set a single token, so
        # this is a fully deterministic single dominant path: word "ሀ",
        # space, word "ለ", space, word "ሀ" (the last "ሀ" has no trailing
        # space -> exercises the final-selection scoring path).
        l = np.random.default_rng(3).normal(size=(60, V)) * 0.02
        l[0:5, 7] += 9.0
        l[5:10, 300] += 9.0
        l[10:15, 12] += 9.0
        l[15:20, 300] += 9.0
        l[20:25, 7] += 9.0
        l[25:60, blank] += 9.0
        return l

    logits3 = c3()
    stub_off = _StubLM()
    text_a, segs_a = ctc_beam_decode(logits3, blank, glyphs=glyphs3,
                                     beam_width=1, top_k=1, lm=None, lambda_lm=0.0)
    text_b, segs_b = ctc_beam_decode(logits3, blank, glyphs=glyphs3,
                                     beam_width=1, top_k=1, lm=stub_off, lambda_lm=0.0)
    assert text_a == text_b and segs_a == segs_b, "FAIL: lambda_lm=0 must reproduce plain decode exactly"
    assert stub_off.calls == [], f"FAIL: LM must never be consulted when lambda_lm=0, got {stub_off.calls}"
    print("  -> LM safe-default (lambda_lm=0) PASS")

    # beam_width=1 keeps exactly one surviving hypothesis at every frame, so
    # (unlike a wide beam, which legitimately explores many alternate
    # never-took-the-space hypotheses in parallel) every LM call below can
    # only come from the one real lineage — isolating the reset behaviour
    # from beam search's normal low-probability exploration noise.
    stub_on = _StubLM()
    text_c, segs_c = ctc_beam_decode(logits3, blank, glyphs=glyphs3,
                                     beam_width=1, top_k=1, lm=stub_on, lambda_lm=2.0)
    toks_c = [t for t, _, _ in segs_c]
    assert toks_c == [7, 300, 12, 300, 7], f"FAIL: LM fusion changed an unambiguous decode: {toks_c}"
    assert stub_on.calls == ["ሀ", "ለ", "ሀ"], (
        f"FAIL: expected each word scored exactly once, independently, in order "
        f"(incl. the trailing word with no following space): {stub_on.calls}")
    print("  -> LM fusion word-boundary reset + trailing-word scoring PASS")

    print("ALL PASS")
