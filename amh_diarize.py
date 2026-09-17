#!/usr/bin/env python3
"""amh_diarize.py — optional 2-speaker labelling for interview captions.

Approach (offline, CPU): slide short analysis windows over the clip, compute a
speaker embedding for each with a small ONNX model via sherpa-onnx (onnxruntime),
then cosine k-means (k=2). Each cue is labelled by embedding a short window on
the cue itself and picking the nearer centroid (accurate across speaker-change
boundaries), with a window-overlap fallback for low-confidence cues. Labels are
returned as a "[S1] "/"[S2] " prefix on the cue text, S1 = the speaker who talks
first.

Safe by design: label_cues() returns the cues UNCHANGED when
  * the embedding model or sherpa-onnx is missing, or
  * the clip looks like a single speaker, or
  * the two clusters are not well separated (below AMH_DIARIZE_SEP).
So enabling it never makes captions worse than not enabling it.

Env knobs:
  AMH_EMBED_MODEL    path to the speaker-embedding .onnx
                     (default: speaker_embed.onnx next to this file)
  AMH_DIARIZE_SEP    min separation = mean intra-cluster cosine - inter-centroid
                     cosine (default 0.10)
"""
import os
import sys

SR = 16000
WIN_S = 1.5
HOP_S = 0.75


def _model_path():
    env = os.environ.get("AMH_EMBED_MODEL")
    if env and os.path.isfile(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.join(here, "speaker_embed.onnx")
    return cand if os.path.isfile(cand) else None


def available():
    if _model_path() is None:
        return False
    try:
        import numpy  # noqa: F401
        import sherpa_onnx  # noqa: F401
        return True
    except Exception:
        return False


def _l2(v):
    import numpy as np
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


def _resample_16k(samples, sr):
    import numpy as np
    if not sr or sr == SR:
        return np.asarray(samples, dtype=np.float32)
    n = int(round(len(samples) * SR / float(sr)))
    xo = np.linspace(0.0, 1.0, len(samples), endpoint=False)
    xn = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(xn, xo, samples).astype(np.float32)


def extract_embeddings(samples, sr=SR, model=None, ex=None):
    """Return (embeddings[N,dim] L2-normalised, window_start_secs[N])."""
    import numpy as np
    import sherpa_onnx
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    samples = _resample_16k(samples, sr)
    if ex is None:
        model = model or _model_path()
        ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=2))
    win = int(WIN_S * SR)
    hop = int(HOP_S * SR)
    embs, starts = [], []
    for s in range(0, max(1, len(samples) - win + 1), hop):
        seg = samples[s:s + win]
        if len(seg) < win:
            seg = np.pad(seg, (0, win - len(seg)))
        embs.append(_embed_segment(ex, seg))
        starts.append(s / float(SR))
    if not embs:
        return np.zeros((0, 0), dtype=np.float32), np.zeros((0,), dtype=np.float32)
    return np.asarray(embs), np.asarray(starts, dtype=np.float32)


def _embed_segment(ex, seg):
    import numpy as np
    st = ex.create_stream()
    st.accept_waveform(SR, seg)
    st.input_finished()
    return _l2(np.asarray(ex.compute(st), dtype=np.float32))


def _make_extractor(model=None):
    import sherpa_onnx
    return sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=model or _model_path(), num_threads=2))


def kmeans2(embs, iters=25):
    """Cosine k-means with k=2, initialised from the two most-distant windows.
    Returns (labels[N], centroids[2,dim]) or None if fewer than 2 windows."""
    import numpy as np
    if len(embs) < 2:
        return None
    sim = embs @ embs.T
    i, j = np.unravel_index(int(np.argmin(sim)), sim.shape)
    cent = np.stack([embs[i], embs[j]])
    lab = np.full(len(embs), -1, dtype=int)
    for _ in range(iters):
        new = np.argmax(embs @ cent.T, axis=1)
        if np.array_equal(new, lab):
            break
        lab = new
        for k in range(2):
            m = embs[lab == k]
            if len(m):
                cent[k] = _l2(m.mean(axis=0))
    return lab, cent


def cluster_separation(embs, lab, cent):
    import numpy as np
    intra = np.mean([float(np.mean(embs[lab == k] @ cent[k]))
                     for k in range(2) if (lab == k).any()])
    inter = float(cent[0] @ cent[1])
    return intra - inter


def _two_speakers(embs, lab, cent, min_sep):
    import numpy as np
    n = len(lab)
    n0, n1 = int((lab == 0).sum()), int((lab == 1).sum())
    # Both speakers must be present with a non-trivial share of the clip.
    if min(n0, n1) < max(2, int(0.15 * n)):
        return False
    return cluster_separation(embs, lab, cent) >= min_sep


def assign_labels(cues, embs, starts, lab, cent):
    """Return a new (text, start, end) list with "[Sx] " prefixes. Pure: no
    model/IO. Speaker ids are ordered by first appearance (S1 talks first)."""
    order = []
    for l in lab:
        li = int(l)
        if li not in order:
            order.append(li)
    remap = {}
    for k, li in enumerate(order[:2]):
        remap[li] = "S" + str(k + 1)
    if not remap:
        return list(cues)
    win_s = [float(t) for t in starts]
    win_e = [t + WIN_S for t in win_s]
    out = []
    for cue in cues:
        text, s, e = cue
        if not text:
            out.append(cue)
            continue
        overlap = {}
        for wi in range(len(win_s)):
            o = min(e, win_e[wi]) - max(s, win_s[wi])
            if o > 0:
                spk = remap.get(int(lab[wi]), "S1")
                overlap[spk] = overlap.get(spk, 0.0) + o
        if overlap:
            spk = max(overlap.items(), key=lambda kv: kv[1])[0]
            out.append(("[%s] %s" % (spk, text), s, e))
        else:
            out.append(cue)
    return out


def _cue_window(x, s, e, win):
    """A win-sample slice of x centred on the cue, clamped and padded."""
    import numpy as np
    n = len(x)
    mid = int((((s + e) / 2.0) if e > s else s) * SR)
    a = max(0, min(mid - win // 2, max(0, n - win)))
    seg = x[a:a + win]
    if len(seg) < win:
        seg = np.pad(seg, (0, win - len(seg)))
    return seg


def _cue_overlap_cluster(cue, starts, lab):
    """Fallback: cluster of the window that overlaps the cue the most."""
    s, e = cue[1], cue[2]
    best, best_o = None, 0.0
    for wi in range(len(starts)):
        o = min(e, starts[wi] + WIN_S) - max(s, starts[wi])
        if o > best_o:
            best_o, best = o, int(lab[wi])
    return best


def classify_cues(cues, samples, sr, ex, cent, starts, lab, min_conf=0.05):
    """Label each cue by embedding a window on the cue itself and picking the
    nearer centroid. This is far more accurate at speaker-change boundaries than
    whole-window overlap voting. Low-confidence cues fall back to overlap; cues
    that are ambiguous both ways are left unlabelled. S1 = first to speak.

    Confident cues are labelled `[S1] `/`[S2] `; this returns a new cue list."""
    import numpy as np
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = _resample_16k(x, sr)
    first = int(lab[0])
    other = 1 - first
    cent2 = np.stack([cent[first], cent[other]])   # row 0 = S1, row 1 = S2
    win = int(WIN_S * SR)
    out = []
    for cue in cues:
        text, s, e = cue
        if not text:
            out.append(cue)
            continue
        seg = _cue_window(x, s, e, win)
        emb = _embed_segment(ex, seg)
        sims = emb @ cent2.T
        k = int(np.argmax(sims))
        if float(abs(sims[0] - sims[1])) < min_conf:
            kk = _cue_overlap_cluster(cue, starts, lab)
            if kk is None:
                out.append(cue)
                continue
            k = 0 if kk == first else 1
        out.append(("[S%d] %s" % (k + 1, text), s, e))
    return out


def label_cues(cues, samples, sr=SR, min_sep=None):
    """Best-effort speaker labelling. `samples` is mono audio (float32, 16k by
    default — pass sr otherwise). Returns cues unchanged on any doubt/failure."""
    if not cues:
        return cues
    if not available():
        return cues
    if min_sep is None:
        min_sep = float(os.environ.get("AMH_DIARIZE_SEP", "0.10"))
    try:
        ex = _make_extractor()
        embs, starts = extract_embeddings(samples, sr, ex=ex)
        if len(embs) < 4:
            return cues
        r = kmeans2(embs)
        if r is None:
            return cues
        lab, cent = r
        if not _two_speakers(embs, lab, cent, min_sep):
            return cues
        return classify_cues(cues, samples, sr, ex, cent, starts, lab)
    except Exception as e:  # never break transcription for a label
        print("[info] diarization skipped: %s" % e, file=sys.stderr)
        return cues


def _selftest():
    import numpy as np
    # assign_labels: two windows 0-1.5s (S1) and 1.5-3.0s (S2)
    cues = [("a", 0.0, 1.4), ("b", 1.6, 2.9), ("c", 1.4, 1.7)]
    embs = np.eye(2, dtype=np.float32)
    starts = np.array([0.0, 1.5], dtype=np.float32)
    lab = np.array([0, 1])
    out = assign_labels(cues, embs, starts, lab, np.eye(2, dtype=np.float32))
    assert out[0][0] == "[S1] a", out
    assert out[1][0] == "[S2] b", out
    assert out[2][0] == "[S2] c", out  # 0.2s S2 vs 0.1s S1 → S2
    # single-speaker gate
    assert not _two_speakers(np.eye(4, dtype=np.float32), np.zeros(4, dtype=int),
                             np.eye(2, dtype=np.float32), 0.1)
    print("ALL PASS")


if __name__ == "__main__":
    _selftest()
