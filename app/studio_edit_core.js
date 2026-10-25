/*
 * studio_edit_core.js — Amharic Captions Studio editor (1.20.0): the edit
 * itself, pure (no DOM, no bridge). Loaded before studio_edit.js
 * (window.AmhEdit) and requireable from Node (tools/test/test_edit.js).
 *
 * The main track is "magnetic" (like CapCut): its clips play one after the
 * other with no gaps; a clip = a piece of a media file { id, m, in, out,
 * scale, x, y, volume, speed, tr (transition INTO it), col (colour) }.
 * Edit time = position in the finished video; a clip lasts (out-in)/speed.
 *
 * Captions belong to the SOURCE: S = { mediaId: [cues in that file's time] }.
 * What the editor sees and edits is derived for the edit (deriveCaptions);
 * every change made there goes back to the source (syncBack) — so a trim,
 * an undo or moving a clip never loses a fixed word.
 */
'use strict';
(function (root) {
  const r3 = (x) => Math.round(Number(x) * 1000) / 1000;
  const MIN = 0.1;                                   // shortest clip, seconds
  // a clip's speed (1.24.0): 0.25x - 4x; its edit length is (out - in) / speed
  const sp = (c) => { const v = Number(c && c.speed); return v > 0 ? Math.max(0.25, Math.min(4, v)) : 1; };
  const clipLen = (c) => Math.max(0, c.out - c.in) / sp(c);

  // ── the main track ───────────────────────────────────────────────────────
  function layout(clips) {
    let t = 0;
    return (clips || []).map((c) => { const d = clipLen(c); const o = Object.assign({}, c, { s: r3(t), e: r3(t + d) }); t += d; return o; });
  }
  const total = (clips) => r3((clips || []).reduce((n, c) => n + clipLen(c), 0));
  // the clip at edit time t (the last one at the very end) and the file's second there
  function locate(clips, t) {
    const L = layout(clips);
    if (!L.length) return null;
    let i = L.findIndex((c) => t >= c.s && t < c.e);
    if (i < 0) i = t < 0 ? 0 : L.length - 1;
    const c = L[i];
    const src = Math.max(c.in, Math.min(c.out, c.in + (t - c.s) * sp(c)));
    return { i, clip: c, src };
  }
  // every edit time that shows second `src` of media m
  function sourceToEdit(clips, m, src) {
    return layout(clips).filter((c) => c.m === m && src >= c.in && src < c.out).map((c) => r3(c.s + (src - c.in) / sp(c)));
  }
  // split the clip under t in two; nothing at a clip edge
  function splitAt(clips, t, newId) {
    const L = layout(clips);
    const i = L.findIndex((c) => t > c.s + MIN / 2 && t < c.e - MIN / 2);
    if (i < 0) return clips;
    const c = clips[i];
    const cut = r3(c.in + (t - L[i].s) * sp(c));
    const a = Object.assign({}, c, { out: cut });
    const b = Object.assign({}, c, { id: newId, in: cut });
    return clips.slice(0, i).concat([a, b], clips.slice(i + 1));
  }
  const removeClip = (clips, id) => clips.filter((c) => c.id !== id);
  // drag a clip's start / end edge to the file's second `src` (inside the file)
  function trimClip(clips, id, edge, src, mediaDur) {
    return clips.map((c) => {
      if (c.id !== id) return c;
      if (edge === 'in') return Object.assign({}, c, { in: r3(Math.max(0, Math.min(c.out - MIN, src))) });
      return Object.assign({}, c, { out: r3(Math.min(mediaDur == null ? Infinity : mediaDur, Math.max(c.in + MIN, src))) });
    });
  }
  function moveClip(clips, id, toIndex) {
    const from = clips.findIndex((c) => c.id === id);
    if (from < 0) return clips;
    const out = clips.slice();
    const [c] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(out.length, toIndex)), 0, c);
    return out;
  }
  // where to drop a dragged clip: the gap nearest to edit time t
  function dropIndex(clips, id, t) {
    const L = layout(clips.filter((c) => c.id !== id));
    for (let i = 0; i < L.length; i++) if (t < (L[i].s + L[i].e) / 2) return i;
    return L.length;
  }
  // cut a range of the edit out of the main track (✂ Clean up "cut them")
  function cutRange(clips, a, b, idGen) {
    let out = splitAt(clips, a, idGen());
    out = splitAt(out, b, idGen());
    const L = layout(out);
    return out.filter((c, i) => !(L[i].s >= a - 1e-3 && L[i].e <= b + 1e-3));
  }
  // move a range of the edit [a, b] so it starts at edit time t (1.34: drag a
  // sentence in the Script view). t inside the range: nothing changes.
  function moveRange(clips, a, b, t, idGen) {
    if (!(b - a > MIN / 2) || (t > a + 1e-3 && t < b - 1e-3)) return clips;
    let out = splitAt(clips, a, idGen());
    out = splitAt(out, b, idGen());
    out = splitAt(out, t, idGen());
    const L = layout(out);
    const inside = (i) => L[i].s >= a - 1e-3 && L[i].e <= b + 1e-3;
    const moving = out.filter((c, i) => inside(i));
    if (!moving.length) return clips;
    const rest = [], startOf = [];
    out.forEach((c, i) => { if (!inside(i)) { rest.push(c); startOf.push(L[i].s); } });
    let at = startOf.findIndex((s) => s >= t - 1e-3);
    if (at < 0) at = rest.length;
    return rest.slice(0, at).concat(moving, rest.slice(at));
  }

  // ── captions follow the edit ─────────────────────────────────────────────
  // the words of one caption with times (exact when the engine gave them,
  // else shared by letters) — same rule as the panel's core cleanupWords
  function words(c) {
    const parts = String(c.text || '').replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    const wt = Array.isArray(c.wt) && c.wt.length === parts.length ? c.wt : null;
    if (wt) return parts.map((w, k) => ({ w, k, s: wt[k][0], e: wt[k][1], x: true }));
    const weight = parts.map((w) => Array.from(w.replace(/[~*]/g, '')).length + 1);
    const sum = weight.reduce((a, b) => a + b, 0);
    const span = Math.max(0, c.end - c.start);
    let t = c.start;
    return parts.map((w, k) => { const d = span * weight[k] / sum; const o = { w, k, s: t, e: t + d, x: false }; t += d; return o; });
  }
  // a caption made of some of its words, times from those words
  // shift: a number added to the times, or a function (time -> time)
  function fromWords(c, ws, shift) {
    if (!ws.length) return null;
    const f = typeof shift === 'function' ? shift : (x) => x + shift;
    const q = Object.assign({}, c);
    q.text = ws.map((x) => x.w).join(' ');
    q.start = r3(f(ws[0].s)); q.end = r3(f(ws[ws.length - 1].e));
    if (ws.every((x) => x.x)) q.wt = ws.map((x) => [r3(f(x.s)), r3(f(x.e))]); else delete q.wt;
    return q;
  }
  const mid = (x) => (x.s + x.e) / 2;
  const META = ['_m', '_ci', '_id', '_part'];
  const clean = (c) => { const o = Object.assign({}, c); META.forEach((k) => delete o[k]); return o; };
  // S (source captions) -> the captions of the edit, in edit time
  function deriveCaptions(clips, S) {
    const out = [];
    layout(clips).forEach((c) => {
      const k = sp(c);
      const shift = (x) => c.s + (x - c.in) / k;           // file time -> edit time
      (S[c.m] || []).forEach((q, ci) => {
        if (q.end <= c.in || q.start >= c.out) return;
        let d;
        if (q.start >= c.in - 1e-6 && q.end <= c.out + 1e-6) {
          d = Object.assign(clean(q), { start: r3(shift(q.start)), end: r3(shift(q.end)) });
          if (Array.isArray(q.wt)) d.wt = q.wt.map((w) => [r3(shift(w[0])), r3(shift(w[1]))]);
        } else {
          d = fromWords(clean(q), words(q).filter((w) => mid(w) >= c.in && mid(w) < c.out), shift);
          if (!d) return;
          d.start = r3(Math.max(d.start, c.s)); d.end = r3(Math.min(d.end, c.e));
          d._part = 1;
        }
        d._m = c.m; d._ci = ci; d._id = c.id + ':' + ci;
        out.push(d);
      });
    });
    return out;
  }
  // the edit's captions (changed by the editor) -> S again. What the edit
  // does not show of a file stays as it was; what it shows is replaced by
  // what the editor has now (mapped back to the file's time).
  function syncBack(clips, S, D) {
    const L = layout(clips);
    const spans = {};
    L.forEach((c) => { (spans[c.m] = spans[c.m] || []).push([c.in, c.out]); });
    const shown = (m, t) => (spans[m] || []).some(([a, b]) => t >= a && t < b);
    const NS = {};
    Object.keys(S || {}).forEach((m) => {
      NS[m] = [];
      (S[m] || []).forEach((q) => {
        const ws = words(q);
        if (!spans[m] || !ws.some((w) => shown(m, mid(w)))) { NS[m].push(clean(q)); return; }
        const keep = ws.filter((w) => !shown(m, mid(w)));          // the part the edit does not show
        const rest = fromWords(clean(q), keep, 0);
        if (rest) NS[m].push(rest);
      });
    });
    const seen = {};
    (D || []).forEach((d) => {
      const dw = words(d);
      L.forEach((c) => {
        if (d.end <= c.s || d.start >= c.e) return;
        const inClip = dw.filter((w) => mid(w) >= c.s && mid(w) < c.e);
        const ws = inClip.length ? inClip : (d.start >= c.s && d.start < c.e ? dw : []);
        const back = (t) => c.in + (t - c.s) * sp(c);         // edit time -> file time
        const q = fromWords(clean(d), ws, back);
        if (!q) return;
        if (!inClip.length) { q.start = r3(Math.max(c.in, back(d.start))); q.end = r3(Math.min(c.out, back(d.end))); }
        const k = c.m + '|' + q.start + '|' + q.text;
        if (seen[k]) return;
        seen[k] = 1;
        (NS[c.m] = NS[c.m] || []).push(q);
      });
    });
    Object.keys(NS).forEach((m) => NS[m].sort((a, b) => a.start - b.start || a.end - b.end));
    return NS;
  }


  // ── transitions, speed, colour (1.24.0) ──────────────────────────────────
  // a transition belongs to the clip it goes INTO: tr { type, d }. It is
  // centred on the cut and uses the media just past the cut (the "handles"),
  // so the video keeps its length and the captions do not move; with no media
  // there, the edge frame is held (like Premiere).
  const TRANSITIONS = ['fade', 'fadeblack', 'fadewhite', 'slideleft', 'wipeleft', 'circleopen', 'zoomin'];
  function trDur(clips, i) {
    const c = clips[i], a = clips[i - 1];
    if (!c || !a || !c.tr || TRANSITIONS.indexOf(c.tr.type) < 0) return 0;
    const d = Math.min(Number(c.tr.d) || 0.5, 2, clipLen(a), clipLen(c));
    return d >= 0.04 ? r3(d) : 0;
  }
  function atempo(k) {
    const out = [];
    while (k > 2.0001) { out.push('atempo=2'); k /= 2; }
    while (k < 0.4999) { out.push('atempo=0.5'); k /= 0.5; }
    if (Math.abs(k - 1) > 1e-6) out.push('atempo=' + r3(k));
    return out;
  }
  // colour: { look, bright -1..1, contrast 0.5..1.5, sat 0..2, temp -1..1 }
  // -> one 3x3 matrix + one offset (RGB 0-1). The export uses it
  // (colorchannelmixer + lutrgb) and the preview too (an SVG feColorMatrix),
  // so what you see is what you export.
  const LOOKS = {
    none: { bright: 0, contrast: 1, sat: 1, temp: 0 },
    warm: { bright: 0.02, contrast: 1.05, sat: 1.1, temp: 0.6 },
    cool: { bright: 0, contrast: 1.05, sat: 0.95, temp: -0.6 },
    bw: { bright: 0, contrast: 1.15, sat: 0, temp: 0 },
    vivid: { bright: 0.02, contrast: 1.12, sat: 1.45, temp: 0.1 },
    cine: { bright: -0.03, contrast: 1.15, sat: 0.8, temp: 0.25 },
    faded: { bright: 0.06, contrast: 0.8, sat: 0.75, temp: 0.1 },
  };
  const colV = (col, k) => (col && col[k] != null ? Number(col[k]) : LOOKS.none[k]);
  function colorMatrix(col) {
    const s = colV(col, 'sat'), c = colV(col, 'contrast'), b = colV(col, 'bright'), t = colV(col, 'temp');
    const lr = 0.2126, lg = 0.7152, lb = 0.0722;
    const S = [lr * (1 - s) + s, lg * (1 - s), lb * (1 - s),
      lr * (1 - s), lg * (1 - s) + s, lb * (1 - s),
      lr * (1 - s), lg * (1 - s), lb * (1 - s) + s];
    const T = [1 + 0.12 * t, 1, 1 - 0.12 * t];
    const m = S.map((v, i) => r3(v * T[Math.floor(i / 3)] * c));
    return { m, o: r3(0.5 * (1 - c) + 0.25 * b) };
  }
  const colorOn = (col) => !!col && ['bright', 'contrast', 'sat', 'temp'].some((k) => Math.abs(colV(col, k) - LOOKS.none[k]) > 1e-6);
  function colorFilter(col) {
    if (!colorOn(col)) return '';
    const { m, o } = colorMatrix(col);
    const n = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
    let f = ',colorchannelmixer=' + n.map((k, i) => k + '=' + m[i]).join(':');
    if (Math.abs(o) > 1e-6) { const v = Math.round(o * 255); f += ",lutrgb=r='clip(val" + (v >= 0 ? '+' : '') + v + ",0,255)':g='clip(val" + (v >= 0 ? '+' : '') + v + ",0,255)':b='clip(val" + (v >= 0 ? '+' : '') + v + ",0,255)'"; }
    return f;
  }

  // ── the export: the whole edit as one ffmpeg graph ───────────────────────
  const FORMATS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };
  // res: the short side (1080 or 720); the canvas keeps its shape
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const canvasSize = (fmt, res) => { const s = FORMATS[fmt] || FORMATS['16:9']; const k = (Number(res) || 1080) / 1080; return { w: even(s[0] * k), h: even(s[1] * k) }; };

  // ── export choices (1.25.0): where it goes, how big, which encoder ───────
  // fmt null = the edit's own format
  const PRESETS = {
    youtube: { fmt: '16:9', res: 1080, q: 'high' },
    shorts: { fmt: '9:16', res: 1080, q: 'high' },
    insta: { fmt: '4:5', res: 1080, q: 'high' },
    square: { fmt: '1:1', res: 1080, q: 'high' },
    telegram: { fmt: null, res: 720, q: 'small' },
    master: { fmt: null, res: 1080, q: 'master' },
  };
  const presetFor = (fmt) => ({ '16:9': 'youtube', '9:16': 'shorts', '4:5': 'insta', '1:1': 'square' }[fmt] || 'youtube');
  // the graphics card's encoder when there is one (found by a tiny test
  // encode), else x264; q: high | small (a light file to send) | master
  const GPU_ENCODERS = { win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'], darwin: ['h264_videotoolbox'], linux: ['h264_nvenc'] };
  function encoderArgs(enc, q, h) {
    const Q = { high: 0, small: 1, master: 2 }[q] || 0;
    const pick = (a) => a[Q];
    let v;
    if (enc === 'h264_nvenc') v = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(pick([20, 27, 16])), '-b:v', '0'];
    else if (enc === 'h264_qsv') v = ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(pick([20, 27, 16]))];
    else if (enc === 'h264_amf') { const k = pick([20, 27, 16]); v = ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(k), '-qp_p', String(k + 2)]; }
    else if (enc === 'h264_videotoolbox') v = ['-c:v', 'h264_videotoolbox', '-b:v', pick([h >= 1000 ? '12M' : '6M', '2500k', h >= 1000 ? '25M' : '12M'])];
    else v = ['-c:v', 'libx264', '-preset', pick(['medium', 'medium', 'slow']), '-crf', String(pick([18, 24, 14]))];
    if (Q === 1 && enc !== 'h264_videotoolbox') v = v.concat(['-maxrate', '2500k', '-bufsize', '5000k']);
    return v.concat(['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', pick(['192k', '128k', '320k'])]);
  }
  // seconds left, from how far it is and how long it took so far (none at first)
  function eta(progress, elapsed) {
    if (!(progress > 0.03) || !(elapsed > 2)) return null;
    return Math.max(0, Math.round(elapsed * (1 - progress) / progress));
  }
  // fill the canvas (cover) — or, for a photo / logo, show it whole
  // (contain) — then the clip's own size and position
  function placement(media, clip, W, H) {
    const mw = media.w || W, mh = media.h || H;
    const fit = clip.fit || (media.image ? 'contain' : 'cover');
    const k = (fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh)) * (Number(clip.scale) || 1);
    const sw = Math.max(2, Math.round(mw * k / 2) * 2), sh = Math.max(2, Math.round(mh * k / 2) * 2);
    return { sw, sh, x: Math.round((W - sw) / 2 + (Number(clip.x) || 0) * W), y: Math.round((H - sh) / 2 + (Number(clip.y) || 0) * H) };
  }
  // ── 📱 Reframe (1.63): wide video in a tall frame that keeps the speaker ──
  // A clip can have rf: { mode: 'face' | 'center' | 'left' | 'right', pace:
  // 'calm' | 'normal' | 'fast' } and rfk: the camera's path, [[file second,
  // cx, cy], ...] (0-1 of the picture), made from the face finder's answers
  // (app/amh_faces.py) by rfTrack. The camera only moves when the face leaves
  // a calm zone, then glides there — no shaking. Preview and export place the
  // picture with the same numbers (rfPlace / rfExpr).
  const RF_PACE = { calm: { dz: 0.1, glide: 0.9 }, normal: { dz: 0.06, glide: 0.6 }, fast: { dz: 0.03, glide: 0.35 } };
  // how much of the picture the frame shows (0-1 of its width / height)
  function rfWindow(m, c, W, H) {
    const p = placement(m || {}, Object.assign({}, c, { x: 0, y: 0 }), W, H);
    return { ww: Math.min(1, W / p.sw), wh: Math.min(1, H / p.sh), p };
  }
  // faces: [[t, cx, cy, fw, fh, s] | [t]] -> the camera's path in file seconds
  function rfTrack(faces, m, c, W, H, pace) {
    const P = RF_PACE[pace] || RF_PACE.normal;
    const win = rfWindow(m, c, W, H);
    const list = (faces || []).filter((f) => Array.isArray(f) && f.length >= 1);
    if (!list.length) return [];
    // no face in a frame: the last face seen (or the first one coming)
    const first = list.find((f) => f.length > 2);
    if (!first) return [];
    let last = first;
    const raw = list.map((f) => { if (f.length > 2) last = f; return [f[0], last[1], last[2]]; });
    // steady: the median of 5, then a short average (one bad frame does not move the camera)
    const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    const sm = raw.map((r, i) => {
      const nb = raw.slice(Math.max(0, i - 2), i + 3);
      return [r[0], med(nb.map((x) => x[1])), med(nb.map((x) => x[2]))];
    });
    const clampX = (x) => (win.ww >= 1 ? 0.5 : Math.max(win.ww / 2, Math.min(1 - win.ww / 2, x)));
    const clampY = (y) => (win.wh >= 1 ? 0.5 : Math.max(win.wh / 2, Math.min(1 - win.wh / 2, y)));
    // the camera: holds still while the face stays in the calm zone; a move
    // glides to the new place in `glide` seconds
    const dzx = P.dz * Math.max(0.2, win.ww), dzy = P.dz * Math.max(0.2, win.wh);
    let cx = clampX(sm[0][1]), cy = clampY(sm[0][2]);
    const kf = [[r3(sm[0][0]), r3(cx), r3(cy)]];
    let busyUntil = -1;
    sm.forEach(([t, fx, fy]) => {
      if (t < busyUntil) return;
      const tx = clampX(fx), ty = clampY(fy);
      if (Math.abs(tx - cx) > dzx || Math.abs(ty - cy) > dzy) {
        const nx = Math.abs(tx - cx) > dzx ? tx : cx, ny = Math.abs(ty - cy) > dzy ? ty : cy;
        if (kf[kf.length - 1][0] < t) kf.push([r3(t), r3(cx), r3(cy)]);
        cx = nx; cy = ny;
        kf.push([r3(t + P.glide), r3(cx), r3(cy)]);
        busyUntil = t + P.glide;
      }
    });
    return kf;
  }
  // the camera at file second s (between two points: a smoothstep glide)
  function rfAt(kf, s) {
    if (!kf || !kf.length) return null;
    if (s <= kf[0][0]) return { cx: kf[0][1], cy: kf[0][2] };
    for (let i = 1; i < kf.length; i++) {
      if (s < kf[i][0]) {
        const a = kf[i - 1], b = kf[i], u = (s - a[0]) / Math.max(1e-6, b[0] - a[0]), q = u * u * (3 - 2 * u);   // smoothstep
        return { cx: a[1] + (b[1] - a[1]) * q, cy: a[2] + (b[2] - a[2]) * q };
      }
    }
    const z = kf[kf.length - 1];
    return { cx: z[1], cy: z[2] };
  }
  // where the window's centre is at file second s, by the clip's framing mode
  function rfCenter(m, c, W, H, s) {
    const win = rfWindow(m, c, W, H);
    const mode = c.rf && c.rf.mode;
    let cx = 0.5, cy = 0.5;
    if (mode === 'left') cx = win.ww / 2;
    else if (mode === 'right') cx = 1 - win.ww / 2;
    else if (mode === 'face') { const a = rfAt(c.rfk, s); if (a) { cx = a.cx; cy = a.cy; } }
    return { cx, cy, win };
  }
  const rfOn = (c) => !!(c && c.rf && c.rf.mode && c.rf.mode !== 'off');
  // the picture's place at file second s ({ sw, sh, x, y }), framed
  function rfPlace(m, c, W, H, s) {
    if (!rfOn(c)) return placement(m, c, W, H);
    const r = rfCenter(m, c, W, H, s);
    const p = r.win.p;
    return { sw: p.sw, sh: p.sh, x: Math.round(W / 2 - r.cx * p.sw), y: Math.round(H / 2 - r.cy * p.sh) };
  }
  // the export: overlay x / y as expressions of the segment's own time t
  // (file second = tin + (t - hold) * speed); the same smoothstep glides
  function rfExpr(m, c, W, H, tin, hold, k) {
    const r0 = rfPlace(m, c, W, H, tin);
    if (!(c.rf && c.rf.mode === 'face' && c.rfk && c.rfk.length > 1)) return { x: String(r0.x), y: String(r0.y) };
    const p = rfWindow(m, c, W, H).p;
    const segT = (s) => (s - tin) / k + hold;
    const pts = c.rfk.map((q) => [segT(q[0]), W / 2 - q[1] * p.sw, H / 2 - q[2] * p.sh]);
    const line = (j) => {
      let e = String(r3(pts[0][j]));
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i][0] - pts[i - 1][0], dv = pts[i][j] - pts[i - 1][j];
        if (Math.abs(dv) < 1e-6 || d <= 0) continue;
        const u = 'clip((t-' + r3(pts[i - 1][0]) + ')/' + r3(d) + ',0,1)';
        e += '+' + r3(dv) + '*(3*pow(' + u + ',2)-2*pow(' + u + ',3))';
      }
      return e;
    };
    return { x: line(1), y: line(2) };
  }
  // ── the overlay track (1.21.0): B-roll, photos, logos ABOVE the main track ──
  // free placement in time: { id, m, in, out, start, scale, x, y, opacity,
  // volume (B-roll is silent unless raised), fit }. A photo has no length of
  // its own: in = 0, out = how long it shows.
  const ovLen = (o) => r3(Math.max(0, o.out - o.in));
  const ovEnd = (o) => r3(o.start + ovLen(o));
  function ovAt(ovl, t) { return (ovl || []).filter((o) => t >= o.start && t < ovEnd(o)); }
  function ovMove(ovl, id, start) { return ovl.map((o) => (o.id === id ? Object.assign({}, o, { start: r3(Math.max(0, start)) }) : o)); }
  // drag an edge: the start edge also moves where the file starts (a photo just
  // gets shorter / longer); never shorter than MIN, never past the file
  function ovTrim(ovl, id, edge, t, mediaDur) {
    return ovl.map((o) => {
      if (o.id !== id) return o;
      if (edge === 'in') {
        const ns = Math.max(0, Math.max(o.start - o.in, Math.min(ovEnd(o) - MIN, t)));
        return Object.assign({}, o, { start: r3(ns), in: r3(o.in + (ns - o.start)) });
      }
      const end = Math.min(o.start + ((mediaDur == null ? Infinity : mediaDur) - o.in), Math.max(o.start + MIN, t));
      return Object.assign({}, o, { out: r3(o.in + (end - o.start)) });
    });
  }


  // ── the text track (1.22.0): titles, lower thirds, text on a box ─────────
  // { id, text, sub (second line, lower third), preset: title | lower | box |
  //   plain, font: sans | menbere | serif | abyssinica, size (share of the
  //   canvas height), color, x, y (offset, share of the canvas), anim: auto |
  //   none | fade | slide | pop, start, in: 0, out (= how long it shows) }.
  // Drawn by libass (the caption styles' engine) with the shipped fonts.
  const TFONTS = { sans: 'Noto Sans Ethiopic', menbere: 'Menbere', serif: 'Noto Serif Ethiopic', abyssinica: 'Abyssinica SIL',
    yebse: 'Ethiopic Yebse', washra: 'Ethiopic WashRa Bold', agbalumo: 'Agbalumo', tint: 'Ethiopic Tint', fantuwua: 'Ethiopic Fantuwua',
    jiret: 'Ethiopia Jiret', hibur: 'Hibur Mono', gothic: 'Ethiopic Yigezu Bisrat Gothic' };
  const TPRESETS = {
    title: { size: 0.085, anim: 'pop' },
    lower: { size: 0.05, anim: 'slide' },
    box: { size: 0.055, anim: 'fade' },
    plain: { size: 0.06, anim: 'fade' },
  };
  function assColor(hex, alpha) {
    const h = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')) ? String(hex).replace('#', '') : 'FFFFFF';
    const a = Math.round(Math.max(0, Math.min(1, alpha == null ? 0 : alpha)) * 255).toString(16).padStart(2, '0');
    return '&H' + a.toUpperCase() + h.slice(4, 6).toUpperCase() + h.slice(2, 4).toUpperCase() + h.slice(0, 2).toUpperCase() + '&';
  }
  const assText = (t) => String(t || '').replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\r?\n/g, '\\N');
  function assTime(t) {
    const cs = Math.max(0, Math.round(t * 100));
    return Math.floor(cs / 360000) + ':' + String(Math.floor(cs / 6000) % 60).padStart(2, '0') + ':' + String(Math.floor(cs / 100) % 60).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0');
  }
  // where a text item sits (pixels): its anchor point and alignment
  function textAnchor(t, W, H) {
    const preset = TPRESETS[t.preset] ? t.preset : 'plain';
    if (preset === 'lower') return { an: 1, x: Math.round(W * 0.06 + (Number(t.x) || 0) * W), y: Math.round(H * (H > W ? 0.72 : 0.82) + (Number(t.y) || 0) * H) };
    return { an: 5, x: Math.round(W / 2 + (Number(t.x) || 0) * W), y: Math.round(H / 2 + (Number(t.y) || 0) * H) };
  }
  // 1.28.0: each font's measurements (runtime/fonts/metrics.json, set by the
  // editor): scale = the size factor that makes every font look the same size;
  // css = browser px per libass size (libass sizes a font by its line box,
  // a browser by its em), so the preview shows exactly what the export draws
  let FONTINFO = {};
  function setFontInfo(metrics) {
    FONTINFO = {};
    Object.keys(TFONTS).forEach((id) => {
      const m = metrics && (metrics[TFONTS[id] + '|1'] || metrics[TFONTS[id] + '|0']);
      if (m) FONTINFO[id] = { scale: Number(m.scale) || 1, css: m.upm && m.em ? m.upm / m.em : 1 };
    });
  }
  const fontInfo = (id) => FONTINFO[TFONTS[id] ? id : 'sans'] || { scale: 1, css: 1 };
  function textSize(t, H) {
    const preset = TPRESETS[t.preset] ? t.preset : 'plain';
    return Math.round(H * (Number(t.size) || TPRESETS[preset].size) * fontInfo(t.font).scale);
  }
  function textAss(items, W, H, totalLen) {
    const head = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + W, 'PlayResY: ' + H, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: T,Noto Sans Ethiopic,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,2,5,0,0,0,1',
      'Style: B,Noto Sans Ethiopic,60,&H00FFFFFF,&H00FFFFFF,&H4D0E1210,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,5,0,0,0,1',
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    const ev = [];
    (items || []).forEach((t) => {
      if (t.tpl) { tplAss(t, W, H, totalLen).forEach((x) => ev.push(x)); return; }      // 🇪🇹 a template (1.62)
      const st = Number(t.start) || 0;
      const en = Math.min(totalLen == null ? Infinity : totalLen, st + Math.max(0, t.out - (t.in || 0)));
      if (en <= st || !String(t.text || '').trim()) return;
      const preset = TPRESETS[t.preset] ? t.preset : 'plain';
      const P = TPRESETS[preset];
      const fs = textSize(t, H);
      const fn = TFONTS[t.font] || TFONTS.sans;
      const col = assColor(t.color || '#FFFFFF');
      const a = textAnchor(t, W, H);
      const anim = t.anim && t.anim !== 'auto' ? t.anim : P.anim;
      const fx = (x, y) => {
        if (anim === 'fade') return '\\fad(300,250)\\pos(' + x + ',' + y + ')';
        if (anim === 'slide') return '\\fad(200,200)\\move(' + (x - Math.round(W * 0.05)) + ',' + y + ',' + x + ',' + y + ',0,350)';
        if (anim === 'pop') return '\\fad(120,180)\\pos(' + x + ',' + y + ')\\fscx70\\fscy70\\t(0,180,\\fscx106\\fscy106)\\t(180,300,\\fscx100\\fscy100)';
        return '\\pos(' + x + ',' + y + ')';
      };
      const lay = 2 * Math.max(0, Math.floor(Number(t.row) || 0));      // 🎚 its track (1.68)
      const line = (style, tags, text) => ev.push('Dialogue: ' + lay + ',' + assTime(st) + ',' + assTime(en) + ',' + style + ',,0,0,0,,{' + tags + '}' + assText(text));
      if (preset === 'lower') {
        // name on a dark box, title under it, an accent bar on the left
        const sub = String(t.sub || '').trim();
        const subFs = Math.round(fs * 0.62);
        const nameY = sub ? a.y - Math.round(subFs * 1.5) : a.y;
        const barH = sub ? Math.round(fs * 1.25 + subFs * 1.5) : Math.round(fs * 1.25);
        // drawn from its top-left corner (a drawing anchored at the bottom with
        // negative coordinates lands one bar-height too high in libass)
        const bw = Math.max(4, Math.round(fs * 0.12));
        ev.push('Dialogue: 1,' + assTime(st) + ',' + assTime(en) + ',T,,0,0,0,,{\\an7\\bord0\\shad0\\c' + assColor(t.accent || '#2ECC71') +
          fx(a.x - Math.round(fs * 0.45), a.y - barH + Math.round(fs * 0.08)) + '\\p1}m 0 0 l ' + bw + ' 0 ' + bw + ' ' + barH + ' 0 ' + barH + '{\\p0}');
        line('B', '\\an1\\fn' + fn + '\\fs' + fs + '\\c' + col + '\\b1' + fx(a.x, nameY), t.text);
        if (sub) line('B', '\\an1\\fn' + fn + '\\fs' + subFs + '\\c' + assColor(t.subColor || '#C9D6CF') + '\\b0' + fx(a.x, a.y), sub);
      } else if (preset === 'box') {
        line('B', '\\an5\\fn' + fn + '\\fs' + fs + '\\c' + col + fx(a.x, a.y), t.text);
      } else {
        line('T', '\\an5\\fn' + fn + '\\fs' + fs + '\\c' + col + '\\bord' + (preset === 'title' ? 5 : 3) + '\\shad2' + fx(a.x, a.y), t.text);
      }
    });
    return head.concat(ev).join('\n') + '\n';
  }


  // ── 🇪🇹 Templates (1.62) ─────────────────────────────────────────────────
  // Animated titles made of layers (rect / poly / text), each with its own
  // motion. The SAME layers make the export (libass lines: \t with accel,
  // \move, \clip, \frz) and the preview (studio_edit draws them on a canvas
  // with tplState) — so the preview is the export. A template is a text item
  // with `tpl`: { tpl, text, sub, accent, color, font, size, fx, fy, speed,
  // end ('fade'|'none': how it ends), theme (holidays) }.
  let MEASURE = null;                 // (text, font, S, bold, fsp) -> px width; set by the editor (the real fonts)
  function setMeasure(fn) { MEASURE = fn; }
  const measureText = (text, font, S, bold, fsp) => {
    if (MEASURE) { try { const w = MEASURE(text, font, S, bold, fsp || 0); if (w > 0) return w; } catch (e) {} }
    const n = Array.from(String(text || '')).length;
    return n * S * (bold ? 0.62 : 0.58) + Math.max(0, n - 1) * (fsp || 0);
  };
  const HOLIDAYS = {
    meskel: { name: ['መስቀል', 'Meskel'], text: 'እንኳን ለብርሃነ መስቀሉ በሰላም አደረሳችሁ', a: '#FFC300', c: '#FFFFFF', d: '#2E7D32' },
    timket: { name: ['ጥምቀት', 'Timket'], text: 'እንኳን ለብርሃነ ጥምቀቱ በሰላም አደረሳችሁ', a: '#42A5F5', c: '#FFFFFF', d: '#FFFFFF' },
    enkutatash: { name: ['እንቁጣጣሽ', 'New Year'], text: 'እንኳን ለአዲሱ ዓመት በሰላም አደረሳችሁ', a: '#FFD600', c: '#FFFFFF', d: '#43A047' },
    genna: { name: ['ገና', 'Genna'], text: 'እንኳን ለብርሃነ ልደቱ በሰላም አደረሳችሁ', a: '#E53935', c: '#FFFFFF', d: '#FFC107' },
    fasika: { name: ['ፋሲካ', 'Fasika'], text: 'እንኳን ለብርሃነ ትንሣኤው በሰላም አደረሳችሁ', a: '#AB47BC', c: '#FFFFFF', d: '#FFD54F' },
    eid: { name: ['ኢድ', 'Eid'], text: 'ኢድ ሙባረክ', a: '#26A69A', c: '#FFFFFF', d: '#FFD54F' },
    any: { name: ['በዓል', 'Holiday'], text: 'መልካም በዓል', a: '#FFC107', c: '#FFFFFF', d: '#FFFFFF' },
  };
  // the catalogue: group, names, default texts, look; build -> layers
  const TEMPLATES = {
    hook: { g: 'hook', name: ['ርዕስ በሳጥን', 'Hook on a box'], text: 'ይህን ማወቅ አለብዎት!', sub: '', accent: '#FFD60A', color: '#111111', fx: 0.5, fy: 0.3 },
    slam: { g: 'hook', name: ['ኃይለኛ ርዕስ', 'Slam title'], text: 'አስደናቂ ውጤት', sub: 'በ3 ቀን ብቻ', accent: '#FFD60A', color: '#FFFFFF', fx: 0.5, fy: 0.32 },
    cinema: { g: 'hook', name: ['ሲኒማ ርዕስ', 'Cinematic title'], text: 'የኢትዮጵያ ታሪክ', sub: 'ክፍል አንድ', accent: '#E8C77A', color: '#FFFFFF', font: 'serif', fx: 0.5, fy: 0.45 },
    stack: { g: 'hook', name: ['ባለ ሁለት መስመር', 'Two-line title'], text: 'ቡና በኢትዮጵያ', sub: 'ዛሬ የምናየው', accent: '#2ECC71', color: '#FFFFFF', fx: 0.08, fy: 0.42 },
    lower: { g: 'name', name: ['ዘመናዊ የስም ጽሑፍ', 'Modern lower third'], text: 'አበበ በቀለ', sub: 'ሥራ ፈጣሪ', accent: '#2ECC71', color: '#FFFFFF', fx: 0.06, fy: 0.84 },
    minimal: { g: 'name', name: ['ቀላል የስም ጽሑፍ', 'Minimal lower third'], text: 'ሰላም ታደሰ', sub: 'ጋዜጠኛ', accent: '#FFFFFF', color: '#FFFFFF', fx: 0.06, fy: 0.84 },
    pill: { g: 'name', name: ['የስም ካፕሱል', 'Name pill'], text: 'ዮሐንስ ዳዊት', sub: '', accent: '#2ECC71', color: '#111111', fx: 0.5, fy: 0.84 },
    subscribe: { g: 'social', name: ['ሰብስክራይብ', 'Subscribe button'], text: 'ሰብስክራይብ', sub: 'ተመዝግበዋል', accent: '#FF0033', color: '#FFFFFF', fx: 0.5, fy: 0.8 },
    follow: { g: 'social', name: ['ተከተሉን', 'Follow us'], text: '@your.channel', sub: 'ተከተሉን', accent: '#FE2C55', color: '#FFFFFF', fx: 0.5, fy: 0.8 },
    cta: { g: 'social', name: ['ጥሪ ከቀስት ጋር', 'Call to action'], text: 'ሊንኩን ይጫኑ', sub: '', accent: '#FFD60A', color: '#111111', fx: 0.5, fy: 0.62 },
    banner: { g: 'social', name: ['የታች ባነር', 'Bottom banner'], text: 'ለበለጠ መረጃ ይደውሉ', sub: '0911 00 00 00', accent: '#1565C0', color: '#FFFFFF', fx: 0.5, fy: 0.92 },
    quote: { g: 'text', name: ['ጥቅስ', 'Quote'], text: 'ትዕግስት መራራ ናት፣ ፍሬዋ ግን ጣፋጭ ነው', sub: 'ተረት', accent: '#FFD60A', color: '#FFFFFF', font: 'serif', fx: 0.5, fy: 0.5 },
    number: { g: 'text', name: ['ቁጥር ዝርዝር', 'Numbered point'], text: 'በጠዋት ውሃ ይጠጡ', sub: '1', accent: '#2ECC71', color: '#FFFFFF', fx: 0.1, fy: 0.5 },
    price: { g: 'text', name: ['ቅናሽ ማህተም', 'Sale badge'], text: '-30%', sub: 'ቅናሽ', accent: '#E53935', color: '#FFFFFF', fx: 0.78, fy: 0.3 },
    holiday: { g: 'holiday', name: ['የበዓል ሰላምታ', 'Holiday greeting'], text: '', sub: 'ከ ቤተሰቦቻችን', accent: '', color: '', theme: 'meskel', fx: 0.5, fy: 0.45 },
  };
  const TPL_GROUPS = { hook: ['ርዕስ', 'Titles'], name: ['የስም ጽሑፍ', 'Names'], social: ['ሶሻል እና ጥሪ', 'Social & CTA'], text: ['ጥቅስ እና ዝርዝር', 'Quotes & lists'], holiday: ['በዓላት', 'Holidays'] };
  const TPL_SPEED = { slow: 1.4, normal: 1, fast: 0.7 };
  // the look of a template item, defaults filled in
  function tplOf(t) {
    const D = TEMPLATES[t.tpl] || TEMPLATES.hook;
    const th = HOLIDAYS[t.theme] || HOLIDAYS[D.theme] || HOLIDAYS.meskel;
    const hol = (TEMPLATES[t.tpl] ? t.tpl : 'hook') === 'holiday';
    const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
    return {
      id: TEMPLATES[t.tpl] ? t.tpl : 'hook', D, th,
      text: String(t.text == null ? (hol ? th.text : D.text) : t.text).replace(/\s*\n\s*/g, ' ').trim(),
      sub: String(t.sub == null ? D.sub : t.sub).replace(/\s*\n\s*/g, ' ').trim(),
      accent: hex(t.accent, hol ? th.a : D.accent), color: hex(t.color, hol ? th.c : D.color),
      font: TFONTS[t.font] ? t.font : (D.font || 'sans'),
      size: Math.max(0.5, Math.min(2, Number(t.size) || 1)),
      fx: t.fx == null ? D.fx : Number(t.fx), fy: t.fy == null ? D.fy : Number(t.fy),
      k: TPL_SPEED[t.speed] || 1, out: t.end === 'none' ? 'none' : 'fade',
    };
  }
  // layers in canvas px: { kind, x, y (centre), w, h, r, color, a, text, S, font, bold, ob (outline), oc, sh,
  //   on, off (s, relative), an: [{ p, t0, t1, from, to, accel }] } — p: 'sc' (scale %), 'al' (0-1),
  //   'mv' ([dx, dy] -> [0, 0], linear like \move), 'sp' (letter spacing), 'wipe' (0-1 shown from the left), 'rot' (deg)
  function tplLayers(t, W, H) {
    const P = tplOf(t);
    const u = Math.min(W, H) / 1080 * P.size, k = P.k;
    const len = Math.max(0.5, ovLen(t));
    const ax = P.fx * W, ay = P.fy * H, F = P.font;
    const L = [];
    const tw = (text, S, bold, fsp) => measureText(text, F, S, bold, fsp);
    const A = (p, t0, t1, from, to, accel) => ({ p, t0: t0 * k, t1: t1 * k, from, to, accel: accel == null ? 1 : accel });
    const rect = (o) => { L.push(Object.assign({ kind: 'rect', r: 0, a: 1, an: [] }, o)); return L[L.length - 1]; };
    const text = (o) => { L.push(Object.assign({ kind: 'text', font: F, bold: true, a: 1, ob: 0, oc: '#000000', sh: 0, an: [] }, o)); return L[L.length - 1]; };
    const poly = (o) => { L.push(Object.assign({ kind: 'poly', a: 1, an: [] }, o)); return L[L.length - 1]; };
    const pop = (d0) => [A('sc', d0, d0 + 0.18, 0, 108, 0.5), A('sc', d0 + 0.18, d0 + 0.3, 108, 100), A('al', d0, d0 + 0.12, 0, 1)];
    const rise = (d0, dy) => [A('mv', d0, d0 + 0.35, [0, dy], [0, 0]), A('al', d0, d0 + 0.3, 0, 1)];
    const wipe = (d0, d1) => [A('wipe', d0, d1, 0, 1, 0.6)];
    const id = P.id;
    if (id === 'hook') {
      const S = 86 * u, w = tw(P.text, S, true) + 60 * u, h = S + 36 * u;
      rect({ x: ax, y: ay, w, h, r: 14 * u, color: P.accent, an: pop(0) });
      text({ x: ax, y: ay, text: P.text, S, color: P.color, an: pop(0) });
      if (P.sub) text({ x: ax, y: ay + h / 2 + 40 * u, text: P.sub, S: 42 * u, color: '#FFFFFF', ob: 3 * u, an: rise(0.25, 24 * u) });
    } else if (id === 'slam') {
      const S = 104 * u;
      text({ x: ax, y: ay, text: P.text, S, color: P.color, ob: 6 * u, sh: 4 * u, an: [A('sc', 0, 0.22, 165, 100, 0.4), A('al', 0, 0.12, 0, 1)] });
      if (P.sub) text({ x: ax, y: ay + S * 0.95, text: P.sub, S: 48 * u, color: P.accent, ob: 4 * u, an: [A('sc', 0.25, 0.45, 140, 100, 0.4), A('al', 0.25, 0.35, 0, 1)] });
    } else if (id === 'cinema') {
      const S = 76 * u, w0 = tw(P.text, S, false, 4 * u);
      text({ x: ax, y: ay, text: P.text, S, bold: false, color: P.color, sh: 2 * u, an: [A('sp', 0, 1.4, 22 * u, 4 * u, 0.5), A('al', 0, 0.6, 0, 1)] });
      rect({ x: ax, y: ay + S * 0.78, w: Math.min(W * 0.6, w0 + 90 * u), h: 4 * u, color: P.accent, an: [A('wipe', 0.35, 1.1, 0, 1, 0.5), A('al', 0.35, 0.36, 0, 1)] });
      if (P.sub) text({ x: ax, y: ay - S * 0.92, text: P.sub, S: 32 * u, bold: false, color: P.accent, an: [A('sp', 0.4, 1.4, 14 * u, 8 * u, 0.5), A('al', 0.4, 0.9, 0, 1)] });
    } else if (id === 'stack') {
      const S = 84 * u, S2 = 42 * u, w1 = tw(P.text, S, true), w2 = P.sub ? tw(P.sub, S2, true) : 0;
      const top = ay - (P.sub ? S2 * 0.65 + S * 0.6 : S * 0.6), x0 = ax + 22 * u;
      rect({ x: ax + 4 * u, y: top + (P.sub ? S2 * 1.3 + S * 1.2 : S * 1.2) / 2, w: 8 * u, h: P.sub ? S2 * 1.3 + S * 1.2 : S * 1.2, color: P.accent, an: [A('sc', 0, 0.3, 0, 100, 0.5), A('al', 0, 0.01, 0, 1)], sy: true });
      if (P.sub) text({ x: x0 + w2 / 2, y: top + S2 * 0.65, text: P.sub, S: S2, color: P.accent, sh: 2 * u, an: wipe(0.15, 0.5) });
      text({ x: x0 + w1 / 2, y: top + (P.sub ? S2 * 1.3 : 0) + S * 0.6, text: P.text, S, color: P.color, ob: 3 * u, sh: 2 * u, an: wipe(0.3, 0.75) });
    } else if (id === 'lower' || id === 'minimal') {
      const S = (id === 'lower' ? 52 : 58) * u, S2 = 32 * u, wn = tw(P.text, S, true), ws = P.sub ? tw(P.sub, S2, id === 'lower') : 0;
      const h = S * 1.25 + (P.sub ? S2 * 1.45 : 0) + 24 * u, bottom = ay, top = bottom - h, x0 = ax;
      if (id === 'lower') {
        const w = Math.max(wn, ws) + 56 * u;
        rect({ x: x0 + 10 * u + w / 2, y: top + h / 2, w, h, r: 8 * u, color: '#101614', a: 0.88, an: wipe(0.12, 0.45) });
        rect({ x: x0 + 4 * u, y: top + h / 2, w: 8 * u, h, color: P.accent, an: [A('sc', 0, 0.25, 0, 100, 0.5), A('al', 0, 0.01, 0, 1)], sy: true });
        text({ x: x0 + 38 * u + wn / 2, y: top + 12 * u + S * 0.62, text: P.text, S, color: P.color, an: wipe(0.3, 0.6) });
        if (P.sub) text({ x: x0 + 38 * u + ws / 2, y: top + 12 * u + S * 1.25 + S2 * 0.7, text: P.sub, S: S2, color: P.accent, an: wipe(0.42, 0.72) });
      } else {
        const lw = Math.max(wn, ws) + 8 * u;
        text({ x: x0 + wn / 2, y: top + S * 0.62, text: P.text, S, color: P.color, ob: 2 * u, sh: 3 * u, an: rise(0, 20 * u) });
        rect({ x: x0 + lw / 2, y: top + S * 1.25 + 4 * u, w: lw, h: 3 * u, color: P.accent, an: [A('wipe', 0.2, 0.65, 0, 1, 0.5), A('al', 0.2, 0.21, 0, 1)] });
        if (P.sub) text({ x: x0 + ws / 2, y: top + S * 1.25 + 12 * u + S2 * 0.7, text: P.sub, S: S2, bold: false, color: '#E6ECE9', sh: 2 * u, an: rise(0.3, 14 * u) });
      }
    } else if (id === 'pill') {
      const S = 42 * u, h = 78 * u, w = tw(P.text, S, true) + h + 40 * u;
      rect({ x: ax, y: ay, w, h, r: h / 2, color: '#FFFFFF', an: pop(0) });
      rect({ x: ax - w / 2 + h / 2, y: ay, w: h - 26 * u, h: h - 26 * u, r: (h - 26 * u) / 2, color: P.accent, an: pop(0.08) });
      text({ x: ax + h / 2 - 10 * u, y: ay, text: P.text, S, color: P.color, an: pop(0.05) });
    } else if (id === 'subscribe') {
      // red, then pressed (1.2 s): grey with the second text
      const S = 42 * u, h = 88 * u, press = 1.2 * k;
      const w1 = tw(P.text, S, true) + 130 * u, w2 = tw(P.sub || P.text, S, true) + 130 * u;
      const tri = (cx, cy, s) => [[cx - s * 0.45, cy - s * 0.55], [cx + s * 0.6, cy], [cx - s * 0.45, cy + s * 0.55]];
      const pr = (d) => [A('sc', press, press + 0.1, 100, 88), A('sc', press + 0.1, press + 0.25, 88, 100, 0.5)].concat(d ? pop(0) : []);
      rect({ x: ax, y: ay, w: w1, h, r: 14 * u, color: P.accent, off: press + 0.1, an: pr(true) });
      poly({ pts: tri(ax - w1 / 2 + 50 * u, ay, 30 * u), color: '#FFFFFF', off: press + 0.1, cx: ax, cy: ay, an: pr(true) });
      text({ x: ax + 24 * u, y: ay, text: P.text, S, color: P.color, off: press + 0.1, an: pr(true) });
      rect({ x: ax, y: ay, w: w2, h, r: 14 * u, color: '#3A3A3A', on: press + 0.1, an: [A('sc', press + 0.1, press + 0.25, 88, 100, 0.5)] });
      text({ x: ax + 24 * u, y: ay, text: P.sub || P.text, S, color: '#FFFFFF', on: press + 0.1, an: [A('sc', press + 0.1, press + 0.25, 88, 100, 0.5)] });
      poly({ pts: [[ax - w2 / 2 + 32 * u, ay], [ax - w2 / 2 + 46 * u, ay + 14 * u], [ax - w2 / 2 + 72 * u, ay - 14 * u], [ax - w2 / 2 + 66 * u, ay - 20 * u], [ax - w2 / 2 + 46 * u, ay + 2 * u], [ax - w2 / 2 + 38 * u, ay - 6 * u]],
        color: '#FFFFFF', on: press + 0.1, cx: ax, cy: ay, an: [A('sc', press + 0.1, press + 0.25, 88, 100, 0.5)] });
    } else if (id === 'follow') {
      const S = 42 * u, S2 = 32 * u, h = 84 * u, w1 = tw(P.text, S, true), w2 = tw(P.sub, S2, true) + 40 * u;
      const w = w1 + w2 + 70 * u;
      const up = [A('mv', 0, 0.35, [0, 70 * u], [0, 0]), A('al', 0, 0.25, 0, 1)];
      rect({ x: ax, y: ay, w, h, r: 18 * u, color: '#111111', a: 0.9, an: up });
      text({ x: ax - w / 2 + 25 * u + w1 / 2, y: ay, text: P.text, S, color: P.color, an: up });
      rect({ x: ax + w / 2 - 14 * u - w2 / 2, y: ay, w: w2, h: h - 26 * u, r: (h - 26 * u) / 2, color: P.accent, an: up.concat([A('sc', 0.4, 0.55, 100, 112), A('sc', 0.55, 0.7, 112, 100)]) });
      text({ x: ax + w / 2 - 14 * u - w2 / 2, y: ay, text: P.sub, S: S2, color: '#FFFFFF', an: up.concat([A('sc', 0.4, 0.55, 100, 112), A('sc', 0.55, 0.7, 112, 100)]) });
    } else if (id === 'cta') {
      const S = 50 * u, w = tw(P.text, S, true) + 64 * u, h = S + 34 * u;
      rect({ x: ax, y: ay, w, h, r: 12 * u, color: P.accent, an: pop(0) });
      text({ x: ax, y: ay, text: P.text, S, color: P.color, an: pop(0) });
      // the arrow bounces, one bounce every 0.6 s
      const ay2 = ay + h / 2 + 52 * u, s = 34 * u;
      const arrow = [[ax - s, ay2 - s * 0.5], [ax, ay2 + s * 0.6], [ax + s, ay2 - s * 0.5], [ax + s * 0.55, ay2 - s * 0.85], [ax, ay2 - s * 0.15], [ax - s * 0.55, ay2 - s * 0.85]];
      for (let b = 0.3 * k, n = 0; b < len && n < 60; b += 0.6, n++) {
        const down = n % 2 === 0;
        const mvb = { p: 'mv', t0: b, t1: b + 0.6, from: [0, down ? 0 : 16 * u], to: [0, down ? 16 * u : 0], accel: 1 };
        poly({ pts: arrow, color: P.accent, on: b, off: Math.min(len, b + 0.6), an: [mvb].concat(n === 0 ? [A('al', 0.3, 0.45, 0, 1)] : []) });
      }
    } else if (id === 'banner') {
      const h = (P.sub ? 150 : 112) * u, cy = Math.min(H - h / 2, ay), S = 48 * u, S2 = 34 * u;
      const up = [A('mv', 0, 0.35, [0, h + 40 * u], [0, 0])];
      rect({ x: W / 2, y: cy, w: W, h, color: P.accent, a: 0.95, an: up });
      rect({ x: W / 2, y: cy - h / 2 + 3 * u, w: W, h: 6 * u, color: '#FFFFFF', a: 0.9, an: up });
      text({ x: ax, y: cy - (P.sub ? S2 * 0.75 : 0), text: P.text, S, color: P.color, an: up });
      if (P.sub) text({ x: ax, y: cy + S * 0.62, text: P.sub, S: S2, color: P.color, bold: false, an: up.concat([A('al', 0.25, 0.45, 0, 1)]) });
    } else if (id === 'quote') {
      // a dark card with an accent edge; the big quote mark on its corner
      const S = 56 * u, w = tw(P.text, S, false), bw = w + 110 * u, bh = S * 1.5 + (P.sub ? 70 * u : 40 * u);
      const cy = ay + (P.sub ? 18 * u : 0);
      rect({ x: ax, y: cy, w: bw, h: bh, r: 12 * u, color: '#0E1412', a: 0.82, an: [A('al', 0, 0.3, 0, 1), A('sc', 0, 0.3, 94, 100, 0.5)] });
      rect({ x: ax - bw / 2 + 4 * u, y: cy, w: 8 * u, h: bh, color: P.accent, an: [A('sc', 0.1, 0.4, 0, 100, 0.5), A('al', 0.1, 0.11, 0, 1)], sy: true });
      text({ x: ax - bw / 2 + 40 * u, y: cy - bh / 2 - 6 * u, text: '“', S: 150 * u, bold: true, font: 'serif', color: P.accent, an: pop(0.15) });
      text({ x: ax, y: ay, text: P.text, S, bold: false, color: P.color, an: rise(0.25, 20 * u) });
      if (P.sub) text({ x: ax + w / 2 - tw('— ' + P.sub, 34 * u, false) / 2, y: ay + S * 1.0, text: '— ' + P.sub, S: 34 * u, bold: false, color: P.accent, an: rise(0.5, 14 * u) });
    } else if (id === 'number') {
      const d = 112 * u, S = 54 * u, w = tw(P.text, S, true);
      rect({ x: ax + d / 2, y: ay, w: d, h: d, r: d / 2, color: P.accent, an: pop(0) });
      text({ x: ax + d / 2, y: ay, text: P.sub || '1', S: 66 * u, color: '#111111', an: pop(0) });
      text({ x: ax + d + 28 * u + w / 2, y: ay, text: P.text, S, color: P.color, ob: 3 * u, sh: 2 * u, an: wipe(0.2, 0.65) });
    } else if (id === 'price') {
      const R = 150 * u, pts = [];
      for (let i = 0; i < 24; i++) { const ang = Math.PI * 2 * i / 24 - Math.PI / 2, r = i % 2 ? R * 0.84 : R; pts.push([ax + r * Math.cos(ang), ay + r * Math.sin(ang)]); }
      const sp = [A('sc', 0, 0.22, 0, 112, 0.5), A('sc', 0.22, 0.34, 112, 100), A('al', 0, 0.1, 0, 1), A('rot', 0, 0.5, -40, -8, 0.5)];
      poly({ pts, color: P.accent, cx: ax, cy: ay, an: sp });
      text({ x: ax, y: ay + (P.sub ? 16 * u : 0), text: P.text, S: 78 * u, color: P.color, an: sp });
      if (P.sub) text({ x: ax, y: ay - 52 * u, text: P.sub, S: 34 * u, color: P.color, an: sp });
    } else if (id === 'holiday') {
      const S = 58 * u, S2 = 36 * u, th = P.th, gap = 34 * u;
      for (let i = -2; i <= 2; i++) {
        const cx = ax + i * gap, cy = ay - S * 1.15, s = (i === 0 ? 14 : 9) * u;
        poly({ pts: [[cx, cy - s], [cx + s, cy], [cx, cy + s], [cx - s, cy]], color: i === 0 ? P.accent : th.d, cx, cy, an: [A('sc', 0.1 * (Math.abs(i) + 1), 0.1 * (Math.abs(i) + 1) + 0.3, 0, 100, 0.5), A('al', 0.1 * (Math.abs(i) + 1), 0.1 * (Math.abs(i) + 1) + 0.15, 0, 1)] });
      }
      text({ x: ax, y: ay, text: P.text, S, color: P.color, ob: 3 * u, oc: '#000000', sh: 3 * u, an: rise(0.25, 30 * u) });
      if (P.sub) text({ x: ax, y: ay + S * 1.05, text: P.sub, S: S2, bold: false, color: P.accent, sh: 2 * u, an: rise(0.55, 18 * u) });
    }
    L.forEach((l) => {
      // a text's half width (the wipe's box); a polygon's own box (it turns / scales in place)
      if (l.kind === 'text') l.w2 = measureText(l.text, l.font, l.S, l.bold, 0) / 2;
      if (l.kind === 'poly') {
        const xs = l.pts.map((q) => q[0]), ys = l.pts.map((q) => q[1]);
        l.px0 = Math.min.apply(null, xs); l.py0 = Math.min.apply(null, ys);
        l.x = (l.px0 + Math.max.apply(null, xs)) / 2; l.y = (l.py0 + Math.max.apply(null, ys)) / 2;
      }
      if (l.on == null) l.on = 0;
      if (l.off == null) l.off = len;
      l.off = Math.min(l.off, len);
    });
    return { layers: L.filter((l) => l.off > l.on && (l.kind !== 'text' || String(l.text || '').trim())), len, out: P.out };
  }
  // a layer's state at τ seconds after the item starts (the libass maths:
  // \t progress = ((τ-t0)/(t1-t0))^accel; \move linear)
  function tplState(l, tau) {
    const st = { sc: 100, al: 1, mv: [0, 0], sp: 0, wipe: 1, rot: 0 };
    const firsts = {};
    l.an.forEach((a) => { if (!(a.p in firsts)) { firsts[a.p] = a; st[a.p] = a.from; } });
    l.an.forEach((a) => {
      if (tau <= a.t0) return;
      const q = tau >= a.t1 ? 1 : Math.pow((tau - a.t0) / Math.max(1e-6, a.t1 - a.t0), a.accel);
      st[a.p] = a.p === 'mv' ? [a.from[0] + (a.to[0] - a.from[0]) * (tau >= a.t1 ? 1 : (tau - a.t0) / Math.max(1e-6, a.t1 - a.t0)),
        a.from[1] + (a.to[1] - a.from[1]) * (tau >= a.t1 ? 1 : (tau - a.t0) / Math.max(1e-6, a.t1 - a.t0))] : a.from + (a.to - a.from) * q;
    });
    return st;
  }
  const fadeOut = (tpl, tau) => (tpl.out === 'fade' ? Math.max(0, Math.min(1, (tpl.len - tau) / 0.35)) : 1);
  // the export: libass lines for a template item
  function tplAss(t, W, H, totalLen) {
    const T = tplLayers(t, W, H);
    const st0 = Number(t.start) || 0;
    const out = [];
    const a2 = (a) => '&H' + Math.round(Math.max(0, Math.min(1, 1 - a)) * 255).toString(16).padStart(2, '0').toUpperCase() + '&';
    const ms = (s, l) => Math.round((s - l.on) * 1000);
    T.layers.forEach((l) => {
      const s = st0 + l.on, e = Math.min(totalLen == null ? Infinity : totalLen, st0 + l.off);
      if (e <= s) return;
      const firsts = {};
      l.an.forEach((a) => { if (!(a.p in firsts)) firsts[a.p] = a; });
      // alpha: fill / outline / shadow each from its base, times the animation
      const baseA = l.a == null ? 1 : l.a;
      const al = (k) => '\\1a' + a2(baseA * k) + '\\3a' + a2(k) + '\\4a' + a2(0.55 * k);
      let tags = '\\an5';
      const mv = l.an.find((a) => a.p === 'mv' && a.t1 > l.on);
      if (mv) tags += '\\move(' + r3(l.x + mv.from[0]) + ',' + r3(l.y + mv.from[1]) + ',' + r3(l.x + mv.to[0]) + ',' + r3(l.y + mv.to[1]) + ',' + Math.max(0, ms(mv.t0, l)) + ',' + Math.max(0, ms(mv.t1, l)) + ')';
      else tags += '\\pos(' + r3(l.x) + ',' + r3(l.y) + ')';
      const s0 = tplState(l, l.on);
      const scale = (v, sy) => (sy ? '\\fscx100\\fscy' + r3(v) : '\\fscx' + r3(v) + '\\fscy' + r3(v));
      tags += scale(s0.sc, l.sy) + al(s0.al);
      if (firsts.rot) tags += '\\org(' + r3(l.cx == null ? l.x : l.cx) + ',' + r3(l.cy == null ? l.y : l.cy) + ')\\frz' + r3(-s0.rot);
      // the wipe: a rectangle clip growing from the left edge
      const box = l.kind === 'text' ? { x0: l.x - l.w2 - l.S, x1: l.x + l.w2 + l.S, y0: l.y - l.S, y1: l.y + l.S } : null;
      const bx = box || (l.kind === 'rect' ? { x0: l.x - l.w / 2 - 2, x1: l.x + l.w / 2 + 2, y0: l.y - l.h / 2 - 2, y1: l.y + l.h / 2 + 2 } : null);
      const clip = (q) => '\\clip(' + Math.round(bx.x0) + ',' + Math.round(bx.y0) + ',' + Math.round(bx.x0 + (bx.x1 - bx.x0) * q) + ',' + Math.round(bx.y1) + ')';
      if (firsts.wipe && bx) tags += clip(s0.wipe);
      if (l.kind === 'text') tags += '\\fn' + (TFONTS[l.font] || TFONTS.sans) + '\\fs' + r3(l.S) + '\\b' + (l.bold ? 1 : 0) + '\\c' + assColor(l.color) +
        '\\bord' + r3(l.ob || 0) + '\\3c' + assColor(l.oc || '#000000') + '\\shad' + r3(l.sh || 0) + '\\4c&H000000&\\fsp' + r3(s0.sp || 0);
      else tags += '\\c' + assColor(l.color) + '\\bord0\\shad0\\p1';
      l.an.forEach((a) => {
        if (a.p === 'mv' || a.t1 <= l.on) return;
        const t0 = Math.max(0, ms(a.t0, l)), t1 = Math.max(t0 + 1, ms(a.t1, l));
        let to = '';
        if (a.p === 'sc') to = scale(a.to, l.sy);
        else if (a.p === 'al') to = al(a.to);
        else if (a.p === 'sp' && l.kind === 'text') to = '\\fsp' + r3(a.to);
        else if (a.p === 'rot') to = '\\frz' + r3(-a.to);
        else if (a.p === 'wipe' && bx) to = clip(a.to);
        if (to) tags += '\\t(' + t0 + ',' + t1 + ',' + r3(a.accel) + ',' + to + ')';
      });
      const fo = T.out === 'fade' && st0 + T.len - e < 0.01 ? Math.round(Math.min(350, (e - s) * 1000)) : 0;
      if (fo) tags += '\\fad(0,' + fo + ')';
      let body;
      if (l.kind === 'text') body = assText(l.text);
      else if (l.kind === 'rect') body = rrPath(l.w, l.h, Math.min(l.r || 0, l.w / 2, l.h / 2)) + '{\\p0}';
      else body = 'm ' + l.pts.map((p, i) => (i === 1 ? 'l ' : '') + Math.round((p[0] - l.px0) * 10) / 10 + ' ' + Math.round((p[1] - l.py0) * 10) / 10).join(' ') + '{\\p0}';
      out.push('Dialogue: ' + (1 + 2 * Math.max(0, Math.floor(Number(t.row) || 0))) + ',' + assTime(s) + ',' + assTime(e) + ',T,,0,0,0,,{' + tags + '}' + body);
    });
    return out;
  }
  // a rounded rectangle as a libass drawing (0,0 - w,h)
  function rrPath(w, h, r) {
    const f = (v) => Math.round(v * 10) / 10;
    if (!(r > 0.5)) return 'm 0 0 l ' + f(w) + ' 0 l ' + f(w) + ' ' + f(h) + ' l 0 ' + f(h);
    const c = r * 0.4477;
    return 'm ' + f(r) + ' 0 l ' + f(w - r) + ' 0 b ' + f(w - c) + ' 0 ' + f(w) + ' ' + f(c) + ' ' + f(w) + ' ' + f(r) +
      ' l ' + f(w) + ' ' + f(h - r) + ' b ' + f(w) + ' ' + f(h - c) + ' ' + f(w - c) + ' ' + f(h) + ' ' + f(w - r) + ' ' + f(h) +
      ' l ' + f(r) + ' ' + f(h) + ' b ' + f(c) + ' ' + f(h) + ' 0 ' + f(h - c) + ' 0 ' + f(h - r) +
      ' l 0 ' + f(r) + ' b 0 ' + f(c) + ' ' + f(c) + ' 0 ' + f(r) + ' 0';
  }


  // ── 🔊 Sound effects (1.65) ──────────────────────────────────────────────
  // Our own synthesized sounds (tools/make_sfx.py -> app/sfx/*.wav). They come
  // from the edit itself: a zoom, a B-roll sliding in / out, a template, a
  // transition — so they move when those move. snd.sfx turns them on,
  // snd.sfxVol is their loudness; an item's own `sfx` ('none' or a sound)
  // overrides the automatic choice. The preview and the export use the same
  // list (sfxEvents).
  const SFX = ['whoosh', 'swish', 'boom', 'pop', 'click', 'ding', 'riser', 'tick'];
  // when a sound starts, from the moment it belongs to (so its loudest part lands on it)
  const SFX_LEAD = { whoosh: -0.18, swish: -0.06, boom: 0, pop: 0, click: 0, ding: 0, riser: -1.2, tick: 0 };
  const SFX_LEN = { whoosh: 0.6, swish: 0.28, boom: 0.9, pop: 0.14, click: 0.06, ding: 1.4, riser: 1.5, tick: 0.045 };
  function sfxPick(own, auto) {
    if (own === 'none') return null;
    if (SFX.indexOf(own) >= 0) return own;
    return auto;
  }
  function sfxEvents(st, totalLen) {
    st = st || {};
    const snd = st.snd || {};
    if (!snd.sfx) return [];
    const len = totalLen == null ? total(st.clips || []) : totalLen;
    const out = [];
    const add = (t, name, vol) => {
      if (!name) return;
      const at = r3(Math.max(0, t + SFX_LEAD[name]));
      if (at < len) out.push({ t: at, name, vol: vol == null ? 1 : vol });
    };
    (st.zm || []).forEach((o) => {
      const auto = o.style === 'punch' || o.style === 'pulse' ? 'swish' : o.style === 'impact' ? 'boom' : 'whoosh';
      add(Number(o.start) || 0, sfxPick(o.sfx, auto), 0.8);
    });
    (st.ovl || []).forEach((o) => {
      const L = ovLook(o), d = ovLen(o), ad = Math.min(L.ad, d / 2);
      const slide = (a) => ['left', 'right', 'up', 'down'].indexOf(a) >= 0;
      if (o.sfx && o.sfx !== 'auto') { add(Number(o.start) || 0, sfxPick(o.sfx, null)); return; }
      if (slide(L.ain)) add(Number(o.start) || 0, 'whoosh', 0.9);
      if (slide(L.aout)) add((Number(o.start) || 0) + d - ad, 'whoosh', 0.7);
    });
    (st.txt || []).forEach((t) => {
      const s0 = Number(t.start) || 0;
      if (!t.tpl) { add(s0, sfxPick(t.sfx, 'pop'), 0.8); return; }
      const auto = { cinema: 'riser', slam: 'boom', holiday: 'ding', price: 'pop' }[t.tpl] || 'pop';
      add(s0, sfxPick(t.sfx, auto), 0.9);
      if (t.tpl === 'subscribe' && (!t.sfx || t.sfx === 'auto')) add(s0 + 1.2 * (TPL_SPEED[t.speed] || 1), 'click', 1);
    });
    const L = layout(st.clips || []);
    (st.clips || []).forEach((c, i) => {
      if (i > 0 && c.tr && trDur(st.clips, i) > 0) add(L[i].s, sfxPick(c.sfx, 'swish'), 0.6);
    });
    return out.sort((a, b) => a.t - b.t);
  }


  // ── sound (1.23.0): the music track, ducking, clean voice, loudness ──────
  // music: { id, m, in, out, start, volume, fadeIn, fadeOut, duck (0-1: how
  // much quieter while someone speaks) }. snd: { clean: true|false (a gentle
  // FFT noise reduction + rumble cut on the voice), loud: 'off' | 'web' (-14
  // LUFS, YouTube/TikTok) | 'tv' (-23 LUFS) }.
  const LOUD = { web: -14, tv: -23 };
  const MUS_DEFAULT = { volume: 0.35, fadeIn: 1, fadeOut: 2, duck: 0.8 };
  const musV = (o, k) => (o[k] == null ? MUS_DEFAULT[k] : Number(o[k]));
  // the music's loudness at time t of the edit (for the preview): volume,
  // fades, and ducked while one of the speech ranges is on
  function musicGain(o, t, totalLen, speech) {
    const len = Math.min(ovLen(o), (totalLen == null ? Infinity : totalLen) - o.start);
    const x = t - o.start;
    if (x < 0 || x >= len) return 0;
    let g = musV(o, 'volume');
    const fi = musV(o, 'fadeIn'), fo = musV(o, 'fadeOut');
    if (fi > 0 && x < fi) g *= x / fi;
    if (fo > 0 && x > len - fo) g *= Math.max(0, (len - x) / fo);
    if ((speech || []).some((r) => t >= r.start && t < r.end)) g *= 1 - 0.75 * Math.max(0, Math.min(1, musV(o, 'duck')));
    return g;
  }
  // the audio after the voice [vin]: clean, music (ducked by the voice), loudness -> [a]
  function soundChain(parts, vin, totalLen, media, mus, snd, sfx) {
    snd = snd || {};
    let v = vin;
    if (snd.clean) { parts.push('[' + v + ']highpass=f=80,afftdn=nr=12:nf=-40[vcl]'); v = 'vcl'; }
    const list = (mus || []).filter((o) => media[o.m] && media[o.m].audio && o.start < totalLen && ovLen(o) > 0);
    const ducked = list.filter((o) => musV(o, 'duck') > 0);
    let keys = [];
    if (ducked.length) {
      keys = ducked.map((o, k) => 'vk' + k);
      parts.push('[' + v + ']asplit=' + (keys.length + 1) + '[vmain]' + keys.map((k) => '[' + k + ']').join(''));
      v = 'vmain';
    }
    const mix = ['[' + v + ']'];
    list.forEach((o, k) => {
      const m = media[o.m];
      const d = r3(Math.min(ovLen(o), totalLen - o.start));
      const fi = Math.min(musV(o, 'fadeIn'), d / 2), fo = Math.min(musV(o, 'fadeOut'), d / 2);
      const ms = Math.round(o.start * 1000);
      let f = '[' + m.idx + ':a]atrim=start=' + o.in + ':end=' + r3(o.in + d) + ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=' + musV(o, 'volume');
      if (fi > 0) f += ',afade=t=in:d=' + r3(fi);
      if (fo > 0) f += ',afade=t=out:st=' + r3(d - fo) + ':d=' + r3(fo);
      f += ',adelay=' + ms + '|' + ms + ',apad';
      const di = ducked.indexOf(o);
      if (di >= 0) {
        // a real sidechain compressor: the voice pushes the music down; a strong
        // one, mixed with the music by the duck amount (0.7 = about -7 dB under steady talk)
        parts.push(f + '[mu' + k + ']');
        parts.push('[mu' + k + '][' + keys[di] + ']sidechaincompress=threshold=0.01:ratio=20:attack=20:release=800:mix=' + r3(Math.min(1, musV(o, 'duck'))) + '[md' + k + ']');
        mix.push('[md' + k + ']');
      } else {
        parts.push(f + '[md' + k + ']');
        mix.push('[md' + k + ']');
      }
    });
    // 🔊 the sound effects (1.65): each its own input, at its time, not ducked
    (sfx || []).forEach((x, k) => {
      const ms = Math.round(x.t * 1000);
      parts.push('[' + x.idx + ':a]aresample=48000,aformat=channel_layouts=stereo,volume=' + r3(x.vol) + ',adelay=' + ms + '|' + ms + ',apad[sx' + k + ']');
      mix.push('[sx' + k + ']');
    });
    const lo = LOUD[snd.loud];
    let tail = lo ? ',loudnorm=I=' + lo + ':TP=-1.5:LRA=11,aresample=48000' : '';
    if (mix.length > 1) parts.push(mix.join('') + 'amix=inputs=' + mix.length + ':duration=first:normalize=0' + tail + '[a]');
    else parts.push('[' + v + ']' + (tail ? tail.slice(1) : 'anull') + '[a]');
  }

  // media: { id: { idx (ffmpeg input number), w, h, video, audio, image } }
  // opts.mus / opts.snd: the music track and the sound settings (1.23.0)
  // opts.ass: a libass script (file name, in the folder ffmpeg runs in, with a
  // fonts/ folder) drawn over everything — the text track

  // ── 🎞 B-roll looks (1.61) ───────────────────────────────────────────────
  // An overlay can also have: layout ('free' = the old size/X/Y placement;
  // 'full' | 'whole' | 'blur' | 'pip' | 'top' | 'bottom'), corner + size +
  // border (picture-in-picture), ain / aout (how it comes in / goes:
  // 'none' | 'fade' | 'left' | 'right' | 'up' | 'down'), ad (that time),
  // mot (motion inside it: 'none' | 'in' | 'out' | 'pan'). The preview
  // (ovBox / ovAnim) and the export (ovChain / ovPos) use the same numbers.
  const OV_LAYOUTS = ['free', 'full', 'whole', 'blur', 'pip', 'top', 'bottom'];
  const OV_ANIMS = ['none', 'fade', 'left', 'right', 'up', 'down'];
  const OV_MOTION = ['none', 'in', 'out', 'pan'];
  const evenN = (x) => Math.max(2, Math.round(x / 2) * 2);
  function ovLook(o) {
    const layout = OV_LAYOUTS.indexOf(o.layout) >= 0 ? o.layout : 'free';
    return {
      layout,
      corner: ['tl', 'tr', 'bl', 'br'].indexOf(o.corner) >= 0 ? o.corner : 'tr',
      size: Math.max(0.2, Math.min(0.6, Number(o.size) || 0.38)),
      border: ['none', 'white', 'black'].indexOf(o.border) >= 0 ? o.border : (layout === 'pip' ? 'white' : 'none'),
      ain: OV_ANIMS.indexOf(o.ain) >= 0 ? o.ain : 'none',
      aout: OV_ANIMS.indexOf(o.aout) >= 0 ? o.aout : 'none',
      ad: Math.max(0.1, Math.min(1.2, Number(o.ad) || 0.35)),
      mot: OV_MOTION.indexOf(o.mot) >= 0 ? o.mot : 'none',
    };
  }
  // where it sits: { x, y, w, h, fit ('fill' | 'cover' | 'contain' | 'blur'), b (border px) }
  function ovBox(o, m, W, H) {
    const L = ovLook(o);
    if (L.layout === 'free') { const p = placement(m || {}, o, W, H); return { x: p.x, y: p.y, w: p.sw, h: p.sh, fit: 'fill', b: 0 }; }
    if (L.layout === 'full') return { x: 0, y: 0, w: W, h: H, fit: 'cover', b: 0 };
    if (L.layout === 'whole') return { x: 0, y: 0, w: W, h: H, fit: 'contain', b: 0 };
    if (L.layout === 'blur') return { x: 0, y: 0, w: W, h: H, fit: 'blur', b: 0 };
    if (L.layout === 'top') return { x: 0, y: 0, w: W, h: evenN(H / 2), fit: 'cover', b: 0 };
    if (L.layout === 'bottom') return { x: 0, y: H - evenN(H / 2), w: W, h: evenN(H / 2), fit: 'cover', b: 0 };
    const mw = (m && m.w) || 16, mh = (m && m.h) || 9;
    let w = evenN(L.size * Math.min(W, H * 1.2)), h = evenN(w * mh / mw);
    if (h > H * 0.6) { h = evenN(H * 0.6); w = evenN(h * mw / mh); }
    const b = L.border === 'none' ? 0 : Math.max(2, Math.round(Math.min(W, H) * 0.006));
    const mg = Math.round(Math.min(W, H) * 0.04);
    const x = L.corner.charAt(1) === 'l' ? mg + b : W - mg - b - w;
    const y = L.corner.charAt(0) === 't' ? mg + b : H - mg - b - h;
    return { x, y, w, h, fit: 'cover', b };
  }
  const outC = (u) => 1 - Math.pow(1 - u, 3), inC = (u) => u * u * u;
  // how far it is pushed off screen to come in / go (px), per direction
  function ovSlide(dir, box, W, H) {
    const b = box.b || 0;
    return dir === 'left' ? [-(box.x + box.w + b), 0] : dir === 'right' ? [W - box.x + b, 0]
      : dir === 'up' ? [0, H - box.y + b] : dir === 'down' ? [0, -(box.y + box.h + b)] : [0, 0];
  }
  // at edit time t: { dx, dy (px), a (0-1), z, fx (motion inside, 0-1) }
  function ovAnim(o, t, box, W, H) {
    const L = ovLook(o), s = Number(o.start) || 0, d = ovLen(o);
    const ad = Math.min(L.ad, d / 2);
    const ui = Math.max(0, Math.min(1, (t - s) / ad)), uo = Math.max(0, Math.min(1, (t - (s + d - ad)) / ad));
    let dx = 0, dy = 0, a = o.opacity == null ? 1 : Number(o.opacity);
    if (L.ain === 'fade') a *= outC(ui); else if (L.ain !== 'none') { const v = ovSlide(L.ain, box, W, H); dx += v[0] * (1 - outC(ui)); dy += v[1] * (1 - outC(ui)); }
    if (L.aout === 'fade') a *= 1 - inC(uo); else if (L.aout !== 'none') { const v = ovSlide(L.aout, box, W, H); dx += v[0] * inC(uo); dy += v[1] * inC(uo); }
    const p = d > 0 ? Math.max(0, Math.min(1, (t - s) / d)) : 0, e = (1 - Math.cos(Math.PI * p)) / 2;
    const z = Math.max(1, L.mot === 'in' ? 1 + 0.15 * e : L.mot === 'out' ? 1.15 - 0.15 * e : L.mot === 'pan' ? 1.15 : 1);
    const fx = L.mot === 'pan' ? 0.3 + 0.4 * e : 0.5;
    return { dx, dy, a, z, fx };
  }
  // the export: the overlay's own filters (after trim / setpts / fps) and its place
  function ovChain(o, m, W, H, fps, k) {
    const L = ovLook(o), box = ovBox(o, m, W, H), d = ovLen(o), s = Number(o.start) || 0;
    const steps = [];
    if (box.fit === 'fill') steps.push('scale=' + box.w + ':' + box.h);
    else if (box.fit === 'cover') steps.push('scale=' + box.w + ':' + box.h + ':force_original_aspect_ratio=increase,crop=' + box.w + ':' + box.h);
    else if (box.fit === 'contain') steps.push('scale=' + box.w + ':' + box.h + ':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' + box.w + ':' + box.h + ':(ow-iw)/2:(oh-ih)/2:color=black');
    if (L.mot !== 'none') {
      // the same slow zoom / pan as ovAnim, over the overlay's own frames
      const T = '(in/' + fps + ')', e = '((1-cos(PI*clip(' + T + '/' + Math.max(0.1, d) + ',0,1)))/2)';
      // never under 1 (1.15 - 0.15 is 0.9999999999999999 in floating point: ffmpeg refuses the frame)
      const Z = 'max(1,' + (L.mot === 'in' ? '1+0.15*' + e : L.mot === 'out' ? '1.15-0.15*' + e : '1.15') + ')';
      const FX = L.mot === 'pan' ? '(0.3+0.4*' + e + ')' : '0.5';
      const left = 'st(0,' + Z + ');clip(' + FX + '*W-W/(2*ld(0)),0,W-W/ld(0))', top = 'st(0,' + Z + ');(H-H/ld(0))/2';
      const right = left + '+W/ld(0)', bottom = top + '+H/ld(0)';
      steps.push('perspective=x0=\'' + left + '\':y0=\'' + top + '\':x1=\'' + right + '\':y1=\'' + top + '\':x2=\'' + left + '\':y2=\'' + bottom +
        '\':x3=\'' + right + '\':y3=\'' + bottom + '\':interpolation=cubic:eval=frame');
    }
    if (box.b) steps.push('pad=iw+' + 2 * box.b + ':ih+' + 2 * box.b + ':' + box.b + ':' + box.b + ':color=' + (L.border === 'black' ? 'black' : 'white'));
    steps.push('setsar=1', 'format=yuva420p');
    const op = o.opacity == null ? 1 : Number(o.opacity);
    if (op < 1) steps.push('colorchannelmixer=aa=' + op);
    const ad = r3(Math.min(L.ad, d / 2));
    if (L.ain === 'fade') steps.push('fade=t=in:st=' + s + ':d=' + ad + ':alpha=1');
    if (L.aout === 'fade') steps.push('fade=t=out:st=' + r3(s + d - ad) + ':d=' + ad + ':alpha=1');
    return { box, steps, blur: box.fit === 'blur' };
  }
  // overlay x / y (of the top-left corner, border included), with the slides
  function ovPos(o, box, W, H) {
    const L = ovLook(o), s = Number(o.start) || 0, d = ovLen(o), ad = r3(Math.min(L.ad, d / 2));
    const ui = 'clip((t-' + s + ')/' + ad + ',0,1)', uo = 'clip((t-' + r3(s + d - ad) + ')/' + ad + ',0,1)';
    let x = String(box.x - box.b), y = String(box.y - box.b);
    if (L.ain !== 'none' && L.ain !== 'fade') { const v = ovSlide(L.ain, box, W, H); if (v[0]) x += '+' + v[0] + '*pow(1-' + ui + ',3)'; if (v[1]) y += '+' + v[1] + '*pow(1-' + ui + ',3)'; }
    if (L.aout !== 'none' && L.aout !== 'fade') { const v = ovSlide(L.aout, box, W, H); if (v[0]) x += '+' + v[0] + '*pow(' + uo + ',3)'; if (v[1]) y += '+' + v[1] + '*pow(' + uo + ',3)'; }
    return { x, y };
  }

  // ── 🔍 Zoom (1.60) ───────────────────────────────────────────────────────
  // Smooth zooms on the main picture, no keyframes to set: a zoom is
  // { id, start, in: 0, out: length, style, amt (1.05-1.6), speed
  // ('slow'|'normal'|'fast'), fx, fy (the focus, 0-1 of the picture) }.
  // A style = how it moves in and out, with After Effects-like easing. The
  // preview (CSS) and the export (ffmpeg perspective: sub-pixel, per frame,
  // no jitter) use the SAME curves (zoomRect / zoomExprs).
  const ZOOM_STYLES = {
    push: { din: 0.6, dout: 0.6, ein: 'io', eout: 'io' },          // smooth push in, hold, back out
    punch: { din: 0.12, dout: 0.16, ein: 'expo', eout: 'io' },     // snap zoom (TikTok)
    creep: { whole: true, dout: 0.35, ein: 'sine', eout: 'io' },   // slow push the whole time (Ken Burns)
    bounce: { din: 0.5, dout: 0.4, ein: 'back', eout: 'io' },      // overshoots, settles
    pulse: { din: 0.12, dout: 0.38, ein: 'quad', eout: 'quadin' }, // a heartbeat
    reveal: { reveal: true, din: 0.9, ein: 'io' },                 // starts close, opens out
    impact: { din: 0.1, dout: 0.16, ein: 'expo', eout: 'io', shake: true }, // punch + camera shake
  };
  const ZOOM_SPEED = { slow: 1.6, normal: 1, fast: 0.6 };
  const ZOOM_DEFAULT = { style: 'push', amt: 1.2, speed: 'normal', fx: 0.5, fy: 0.5 };
  const clip01 = (u) => Math.max(0, Math.min(1, u));
  const EASE = {
    io: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(2 - 2 * u, 3) / 2),
    expo: (u) => 1 - Math.pow(2, -10 * u),
    sine: (u) => (1 - Math.cos(Math.PI * u)) / 2,
    back: (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2),
    quad: (u) => 1 - (1 - u) * (1 - u),
    quadin: (u) => u * u,
  };
  // the same curves as ffmpeg expressions of u (a string)
  const EASE_X = {
    io: (u) => 'if(lt(' + u + ',0.5),4*pow(' + u + ',3),1-pow(2-2*' + u + ',3)/2)',
    expo: (u) => '(1-pow(2,-10*' + u + '))',
    sine: (u) => '((1-cos(PI*' + u + '))/2)',
    back: (u) => '(1+2.70158*pow(' + u + '-1,3)+1.70158*pow(' + u + '-1,2))',
    quad: (u) => '(1-pow(1-' + u + ',2))',
    quadin: (u) => 'pow(' + u + ',2)',
  };
  function zoomOf(o) {
    const st = ZOOM_STYLES[o.style] ? o.style : ZOOM_DEFAULT.style;
    const amt = Math.max(1.02, Math.min(2, Number(o.amt) || ZOOM_DEFAULT.amt));
    const k = ZOOM_SPEED[o.speed] || 1;
    const fx = Math.max(0, Math.min(1, o.fx == null ? 0.5 : Number(o.fx)));
    const fy = Math.max(0, Math.min(1, o.fy == null ? 0.5 : Number(o.fy)));
    const S = ZOOM_STYLES[st], d = ovLen(o), s = Number(o.start) || 0;
    let din = Math.min((S.din || 0) * k, d / 2), dout = Math.min((S.dout || 0) * k, d / 2);
    if (S.whole) din = Math.max(0.1, d - dout);
    if (S.reveal) { din = Math.min((S.din || 0.9) * k, d); dout = 0; }
    return { st, S, amt, fx, fy, s, d, din: r3(din), dout: r3(dout) };
  }
  // how far in (0 = not at all, 1 = the full amount; a bounce goes a bit past 1)
  function zoomEnv(o, t) {
    const z = zoomOf(o);
    if (t < z.s || t >= z.s + z.d || z.d <= 0) return 0;
    const x = t - z.s;
    if (z.S.reveal) return 1 - EASE[z.S.ein](clip01(x / Math.max(0.001, z.din)));
    const a = EASE[z.S.ein](clip01(x / Math.max(0.001, z.din)));
    const b = z.dout > 0 ? EASE[z.S.eout](clip01((x - (z.d - z.dout)) / z.dout)) : 0;
    return a * (1 - b);
  }
  // the part of the picture shown at edit time t: { z, x, y, w, h } (canvas px)
  function zoomRect(zm, t, W, H) {
    let z = 1, fx = 0.5, fy = 0.5;
    (zm || []).forEach((o) => {
      const q = zoomOf(o);
      if (q.d <= 0) return;
      if (t >= q.s && t < q.s + q.d) {
        fx += q.fx - 0.5; fy += q.fy - 0.5;
        if (q.S.shake) {
          const x = t - q.s, f = Math.max(0, 1 - x / 0.45);
          fx += 0.012 * Math.sin(2 * Math.PI * 13 * x) * f;
          fy += 0.009 * Math.cos(2 * Math.PI * 11 * x) * f;
        }
      }
      z += (q.amt - 1) * zoomEnv(o, t);
    });
    z = Math.max(1, z);
    const w = W / z, h = H / z;
    return { z, w, h, x: Math.max(0, Math.min(W - w, fx * W - w / 2)), y: Math.max(0, Math.min(H - h, fy * H - h / 2)) };
  }
  // ffmpeg perspective corners (sense=source, eval=frame); time = in / fps
  function zoomExprs(zm, fps) {
    const T = '(in/' + fps + ')';
    const zs = [], fxs = [], fys = [];
    (zm || []).forEach((o) => {
      const q = zoomOf(o);
      if (q.d <= 0) return;
      const x = '(' + T + '-' + q.s + ')';
      const inside = '(gte(' + T + ',' + q.s + ')*lt(' + T + ',' + r3(q.s + q.d) + '))';
      const uin = 'clip(' + x + '/' + Math.max(0.001, q.din) + ',0,1)';
      let env;
      if (q.S.reveal) env = '(1-' + EASE_X[q.S.ein](uin) + ')';
      else {
        env = EASE_X[q.S.ein](uin);
        if (q.dout > 0) env = '(' + env + '*(1-' + EASE_X[q.S.eout]('clip((' + x + '-' + r3(q.d - q.dout) + ')/' + q.dout + ',0,1)') + '))';
      }
      zs.push(r3(q.amt - 1) + '*' + inside + '*' + env);
      if (q.fx !== 0.5) fxs.push(r3(q.fx - 0.5) + '*' + inside);
      if (q.fy !== 0.5) fys.push(r3(q.fy - 0.5) + '*' + inside);
      if (q.S.shake) {
        const f = 'max(0,1-' + x + '/0.45)';
        fxs.push('0.012*sin(2*PI*13*' + x + ')*' + f + '*' + inside);
        fys.push('0.009*cos(2*PI*11*' + x + ')*' + f + '*' + inside);
      }
    });
    const Z = 'max(1,1+' + (zs.join('+') || '0') + ')';
    const FX = '(0.5' + fxs.map((v) => '+' + v).join('') + ')', FY = '(0.5' + fys.map((v) => '+' + v).join('') + ')';
    // st(0) = the zoom, then the window's edge, kept inside the picture
    const left = 'st(0,' + Z + ');clip(' + FX + '*W-W/(2*ld(0)),0,W-W/ld(0))';
    const top = 'st(0,' + Z + ');clip(' + FY + '*H-H/(2*ld(0)),0,H-H/ld(0))';
    const right = left + '+W/ld(0)', bottom = top + '+H/ld(0)';
    return { x0: left, y0: top, x1: right, y1: top, x2: left, y2: bottom, x3: right, y3: bottom };
  }
  function zoomFilter(zm, fps) {
    const e = zoomExprs(zm, fps);
    return 'perspective=' + ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'].map((k) => k + "='" + e[k] + "'").join(':') +
      ':interpolation=cubic:eval=frame';
  }

  // 🎚 the export's view of the tracks (1.68): hidden / muted tracks are left
  // out, picture tracks go bottom to top (a higher track covers a lower one)
  function trackedState(st) {
    const trk = (st && st.trk) || {};
    const row = (it) => Math.max(0, Math.floor(Number(it && it.row) || 0));
    const off = (kind, it) => { const t = (trk[kind] || [])[row(it)] || {}; return !!(t.hide || t.mute); };
    return Object.assign({}, st, {
      ovl: (st.ovl || []).filter((o) => !off('ov', o)).map((o, i) => [o, i]).sort((a, b) => row(a[0]) - row(b[0]) || a[1] - b[1]).map((x) => x[0]),
      txt: (st.txt || []).filter((t) => !off('tx', t)),
      mus: (st.mus || []).filter((o) => !off('au', o)),
    });
  }
  function editGraph(clips, media, fmt, fps, ovl, opts) {
    opts = opts || {};
    fps = fps || 30;
    const { w: W, h: H } = canvasSize(fmt, opts.res);
    const L = layout(clips);
    const parts = [], ins = [];
    const D = L.map((c, i) => trDur(clips, i));            // D[i]: the transition into clip i
    const seg = [];
    L.forEach((c, i) => {
      const m = media[c.m] || {};
      const k = sp(c);
      const len = clipLen(c);
      // the media just past the cut, for a transition (edit seconds), and how much of it the file has
      const pre = D[i] / 2, post = (D[i + 1] || 0) / 2;
      const a0 = Math.max(0, c.in - pre * k), b0 = Math.min(m.dur == null ? Infinity : m.dur, c.out + post * k);
      const holdA = r3(pre - (c.in - a0) / k), holdB = r3(post - (b0 - c.out) / k);
      const tin = r3(a0), tout = r3(b0);
      const d = r3(len + pre + post);
      seg.push(d);
      const f = Math.min(0.01, d / 4).toFixed(3);
      if (m.video) {
        const p = placement(m, c, W, H);
        const rx = rfOn(c) ? rfExpr(m, c, W, H, tin, holdA, k) : null;      // 📱 framed (1.63)
        const hold = (holdA > 0.001 || holdB > 0.001) ? ',tpad=' + [holdA > 0.001 ? 'start_mode=clone:start_duration=' + holdA : '', holdB > 0.001 ? 'stop_mode=clone:stop_duration=' + holdB : ''].filter(Boolean).join(':') : '';
        parts.push('[' + m.idx + ':v]trim=start=' + tin + ':end=' + tout + ',setpts=' + (k === 1 ? 'PTS-STARTPTS' : '(PTS-STARTPTS)/' + r3(k)) + ',fps=' + fps + hold + ',scale=' + p.sw + ':' + p.sh + ',setsar=1' + colorFilter(c.col) + '[s' + i + ']');
        parts.push('color=c=black:s=' + W + 'x' + H + ':r=' + fps + ':d=' + d + '[b' + i + ']');
        parts.push('[b' + i + '][s' + i + ']overlay=' + (rx ? "'" + rx.x + "':'" + rx.y + "'" : p.x + ':' + p.y) + ':shortest=1,format=yuv420p[v' + i + ']');
      } else {
        parts.push('color=c=black:s=' + W + 'x' + H + ':r=' + fps + ':d=' + d + ',format=yuv420p[v' + i + ']');
      }
      if (m.audio) {
        const tempo = atempo(k);
        const pads = (holdA > 0.001 ? ',adelay=' + Math.round(holdA * 1000) + ':all=1' : '') + (holdB > 0.001 ? ',apad=pad_dur=' + holdB : '');
        parts.push('[' + m.idx + ':a]atrim=start=' + tin + ':end=' + tout + ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo' + (tempo.length ? ',' + tempo.join(',') : '') + pads + ',volume=' +
          (c.volume == null ? 1 : Number(c.volume)) + ',afade=t=in:d=' + f + ',afade=t=out:st=' + Math.max(0, d - f).toFixed(3) + ':d=' + f + (pads || tempo.length ? ',atrim=duration=' + d : '') + '[a' + i + ']');
      } else {
        parts.push('anullsrc=r=48000:cl=stereo,atrim=duration=' + d + '[a' + i + ']');
      }
      ins.push('[v' + i + '][a' + i + ']');
    });
    const list = (ovl || []).filter((o) => media[o.m] && o.start < total(clips) && ovLen(o) > 0);
    const vOut = opts.ass ? 'vx' : 'v';
    const soundOn = (opts.mus || []).some((o) => media[o.m]) || (opts.snd && (opts.snd.clean || LOUD[opts.snd.loud])) || (opts.sfx || []).length > 0;
    const aOut = soundOn ? 'av' : 'a';
    const vFinal = list.length ? 'vm' : vOut, aEnd = list.length ? 'am' : aOut;
    // 🔍 zooms (1.60): on the main track only, before the overlays and text
    const zm = (opts.zm || []).filter((o) => ovLen(o) > 0 && o.start < total(clips));
    const vEnd = zm.length ? 'vzm' : vFinal;
    if (!D.some((x) => x > 0)) parts.push(ins.join('') + 'concat=n=' + L.length + ':v=1:a=1[' + vEnd + '][' + aEnd + ']');
    else {
      // one cut after the other: a transition (xfade + acrossfade) or a plain join
      let cv = 'v0', ca = 'a0', len = seg[0];
      for (let i = 1; i < L.length; i++) {
        const last = i === L.length - 1;
        const nv = last ? vEnd : 'jv' + i, na = last ? aEnd : 'ja' + i;
        if (D[i] > 0) {
          const type = clips[i].tr.type;
          parts.push('[' + cv + '][v' + i + ']xfade=transition=' + type + ':duration=' + D[i] + ':offset=' + r3(len - D[i]) + '[' + nv + ']');
          parts.push('[' + ca + '][a' + i + ']acrossfade=d=' + D[i] + ':c1=tri:c2=tri[' + na + ']');
          len = r3(len + seg[i] - D[i]);
        } else {
          // concat gives a 1/1000000 time base; xfade needs both inputs alike -> back to 1/fps
          parts.push('[' + cv + '][' + ca + '][v' + i + '][a' + i + ']concat=n=2:v=1:a=1[jc' + i + '][' + na + ']');
          parts.push('[jc' + i + ']settb=1/' + fps + '[' + nv + ']');
          len = r3(len + seg[i]);
        }
        cv = nv; ca = na;
      }
    }
    if (zm.length) parts.push('[vzm]' + zoomFilter(zm, fps) + '[' + vFinal + ']');
    if (list.length) {
      let base = 'vm';
      const mix = ['[am]'];
      list.forEach((o, k) => {
        const m = media[o.m];
        const p = placement(m, o, W, H);
        const d = Math.min(ovLen(o), total(clips) - o.start);
        const src = m.image ? '[' + m.idx + ':v]trim=duration=' + r3(d) : '[' + m.idx + ':v]trim=start=' + o.in + ':end=' + r3(o.in + d);
        const op = o.opacity == null ? 1 : Number(o.opacity);
        const next = k === list.length - 1 ? vOut : 'vo' + k;
        const LK = ovLook(o);
        let px = p.x, py = p.y;
        if (LK.layout === 'free' && LK.ain === 'none' && LK.aout === 'none' && LK.mot === 'none') {
          parts.push(src + ',setpts=PTS-STARTPTS+' + o.start + '/TB,fps=' + fps + ',scale=' + p.sw + ':' + p.sh + ',setsar=1,format=yuva420p' +
            (op < 1 ? ',colorchannelmixer=aa=' + op : '') + '[o' + k + ']');
        } else {
          // 🎞 B-roll looks (1.61): layout, motion, border, fades; slides in the overlay's x / y
          const o2 = Object.assign({}, o, { out: r3(o.in + d) });
          const ch = ovChain(o2, m, W, H, fps, k);
          const head = src + ',setpts=PTS-STARTPTS+' + o.start + '/TB,fps=' + fps;
          if (ch.blur) {
            const bw = ch.box.w, bh = ch.box.h;
            parts.push(head + ',split=2[ob' + k + '][of' + k + ']');
            parts.push('[ob' + k + ']scale=' + bw + ':' + bh + ':force_original_aspect_ratio=increase,crop=' + bw + ':' + bh + ',boxblur=24:2[obb' + k + ']');
            parts.push('[of' + k + ']scale=' + bw + ':' + bh + ':force_original_aspect_ratio=decrease:force_divisible_by=2[off' + k + ']');
            parts.push('[obb' + k + '][off' + k + ']overlay=(W-w)/2:(H-h)/2,' + ch.steps.join(',') + '[o' + k + ']');
          } else parts.push(head + ',' + ch.steps.join(',') + '[o' + k + ']');
          const pos = ovPos(o2, ch.box, W, H);
          px = "'" + pos.x + "'"; py = "'" + pos.y + "'";
        }
        parts.push('[' + base + '][o' + k + ']overlay=' + px + ':' + py + ":enable='between(t," + o.start + ',' + r3(o.start + d) + ")':eof_action=pass" +
          (k === list.length - 1 ? ',format=yuv420p' : '') + '[' + next + ']');
        base = next;
        if (m.audio && !m.image && Number(o.volume) > 0) {
          const ms = Math.round(o.start * 1000);
          parts.push('[' + m.idx + ':a]atrim=start=' + o.in + ':end=' + r3(o.in + d) + ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=' +
            Number(o.volume) + ',adelay=' + ms + '|' + ms + '[oa' + k + ']');
          mix.push('[oa' + k + ']');
        }
      });
      if (mix.length > 1) parts.push(mix.join('') + 'amix=inputs=' + mix.length + ':duration=first:normalize=0[' + aOut + ']');
      else parts.push('[am]anull[' + aOut + ']');
    }
    if (soundOn) soundChain(parts, aOut, total(clips), media, opts.mus, opts.snd || {}, opts.sfx);
    // opts.ass: one script or several (the text track, then the captions on top)
    if (opts.ass) parts.push('[vx]' + [].concat(opts.ass).map((a) => 'subtitles=' + a + ':fontsdir=fonts').join(',') + ',format=yuv420p[v]');
    return { graph: parts.join(';'), w: W, h: H, duration: total(clips) };
  }

  const api = { MIN, layout, total, locate, sourceToEdit, splitAt, removeClip, trimClip, moveClip, dropIndex, cutRange, moveRange,
    words, deriveCaptions, syncBack, FORMATS, canvasSize, placement, editGraph, ovLen, ovEnd, ovAt, ovMove, ovTrim,
    TFONTS, TPRESETS, assColor, textAnchor, textAss, setFontInfo, fontInfo, textSize, LOUD, MUS_DEFAULT, musicGain,
    PRESETS, presetFor, GPU_ENCODERS, encoderArgs, eta,
    speedOf: sp, clipLen, trackedState, SFX, SFX_LEN, SFX_LEAD, sfxEvents, RF_PACE, rfWindow, rfTrack, rfAt, rfPlace, rfExpr, rfOn, TEMPLATES, TPL_GROUPS, HOLIDAYS, TPL_SPEED, tplOf, tplLayers, tplState, tplAss, setMeasure, tplFade: fadeOut, OV_LAYOUTS, OV_ANIMS, OV_MOTION, ovLook, ovBox, ovAnim, ovChain, ovPos, ZOOM_STYLES, ZOOM_SPEED, ZOOM_DEFAULT, zoomEnv, zoomRect, zoomExprs, zoomFilter, TRANSITIONS, trDur, atempo, LOOKS, colorMatrix, colorOn, colorFilter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhEdit = api;
})(typeof window !== 'undefined' ? window : this);
