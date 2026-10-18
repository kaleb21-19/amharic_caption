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
  const canvasSize = (fmt) => { const s = FORMATS[fmt] || FORMATS['16:9']; return { w: s[0], h: s[1] }; };
  // fill the canvas (cover) — or, for a photo / logo, show it whole
  // (contain) — then the clip's own size and position
  function placement(media, clip, W, H) {
    const mw = media.w || W, mh = media.h || H;
    const fit = clip.fit || (media.image ? 'contain' : 'cover');
    const k = (fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh)) * (Number(clip.scale) || 1);
    const sw = Math.max(2, Math.round(mw * k / 2) * 2), sh = Math.max(2, Math.round(mh * k / 2) * 2);
    return { sw, sh, x: Math.round((W - sw) / 2 + (Number(clip.x) || 0) * W), y: Math.round((H - sh) / 2 + (Number(clip.y) || 0) * H) };
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
  const TFONTS = { sans: 'Noto Sans Ethiopic', menbere: 'Menbere', serif: 'Noto Serif Ethiopic', abyssinica: 'Abyssinica SIL' };
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
  function textAss(items, W, H, totalLen) {
    const head = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + W, 'PlayResY: ' + H, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: T,Noto Sans Ethiopic,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,3,2,5,0,0,0,1',
      'Style: B,Noto Sans Ethiopic,60,&H00FFFFFF,&H00FFFFFF,&H4D0E1210,&H00000000,-1,0,0,0,100,100,0,0,3,14,0,5,0,0,0,1',
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    const ev = [];
    (items || []).forEach((t) => {
      const st = Number(t.start) || 0;
      const en = Math.min(totalLen == null ? Infinity : totalLen, st + Math.max(0, t.out - (t.in || 0)));
      if (en <= st || !String(t.text || '').trim()) return;
      const preset = TPRESETS[t.preset] ? t.preset : 'plain';
      const P = TPRESETS[preset];
      const fs = Math.round(H * (Number(t.size) || P.size));
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
      const line = (style, tags, text) => ev.push('Dialogue: 0,' + assTime(st) + ',' + assTime(en) + ',' + style + ',,0,0,0,,{' + tags + '}' + assText(text));
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
  function soundChain(parts, vin, totalLen, media, mus, snd) {
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
    const lo = LOUD[snd.loud];
    let tail = lo ? ',loudnorm=I=' + lo + ':TP=-1.5:LRA=11,aresample=48000' : '';
    if (mix.length > 1) parts.push(mix.join('') + 'amix=inputs=' + mix.length + ':duration=first:normalize=0' + tail + '[a]');
    else parts.push('[' + v + ']' + (tail ? tail.slice(1) : 'anull') + '[a]');
  }

  // media: { id: { idx (ffmpeg input number), w, h, video, audio, image } }
  // opts.mus / opts.snd: the music track and the sound settings (1.23.0)
  // opts.ass: a libass script (file name, in the folder ffmpeg runs in, with a
  // fonts/ folder) drawn over everything — the text track
  function editGraph(clips, media, fmt, fps, ovl, opts) {
    opts = opts || {};
    fps = fps || 30;
    const { w: W, h: H } = canvasSize(fmt);
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
        const hold = (holdA > 0.001 || holdB > 0.001) ? ',tpad=' + [holdA > 0.001 ? 'start_mode=clone:start_duration=' + holdA : '', holdB > 0.001 ? 'stop_mode=clone:stop_duration=' + holdB : ''].filter(Boolean).join(':') : '';
        parts.push('[' + m.idx + ':v]trim=start=' + tin + ':end=' + tout + ',setpts=' + (k === 1 ? 'PTS-STARTPTS' : '(PTS-STARTPTS)/' + r3(k)) + ',fps=' + fps + hold + ',scale=' + p.sw + ':' + p.sh + ',setsar=1' + colorFilter(c.col) + '[s' + i + ']');
        parts.push('color=c=black:s=' + W + 'x' + H + ':r=' + fps + ':d=' + d + '[b' + i + ']');
        parts.push('[b' + i + '][s' + i + ']overlay=' + p.x + ':' + p.y + ':shortest=1,format=yuv420p[v' + i + ']');
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
    const soundOn = (opts.mus || []).some((o) => media[o.m]) || (opts.snd && (opts.snd.clean || LOUD[opts.snd.loud]));
    const aOut = soundOn ? 'av' : 'a';
    const vEnd = list.length ? 'vm' : vOut, aEnd = list.length ? 'am' : aOut;
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
    if (list.length) {
      let base = 'vm';
      const mix = ['[am]'];
      list.forEach((o, k) => {
        const m = media[o.m];
        const p = placement(m, o, W, H);
        const d = Math.min(ovLen(o), total(clips) - o.start);
        const src = m.image ? '[' + m.idx + ':v]trim=duration=' + r3(d) : '[' + m.idx + ':v]trim=start=' + o.in + ':end=' + r3(o.in + d);
        const op = o.opacity == null ? 1 : Number(o.opacity);
        parts.push(src + ',setpts=PTS-STARTPTS+' + o.start + '/TB,fps=' + fps + ',scale=' + p.sw + ':' + p.sh + ',setsar=1,format=yuva420p' +
          (op < 1 ? ',colorchannelmixer=aa=' + op : '') + '[o' + k + ']');
        const next = k === list.length - 1 ? vOut : 'vo' + k;
        parts.push('[' + base + '][o' + k + ']overlay=' + p.x + ':' + p.y + ":enable='between(t," + o.start + ',' + r3(o.start + d) + ")':eof_action=pass" +
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
    if (soundOn) soundChain(parts, aOut, total(clips), media, opts.mus, opts.snd);
    if (opts.ass) parts.push('[vx]subtitles=' + opts.ass + ':fontsdir=fonts,format=yuv420p[v]');
    return { graph: parts.join(';'), w: W, h: H, duration: total(clips) };
  }

  const api = { MIN, layout, total, locate, sourceToEdit, splitAt, removeClip, trimClip, moveClip, dropIndex, cutRange,
    words, deriveCaptions, syncBack, FORMATS, canvasSize, placement, editGraph, ovLen, ovEnd, ovAt, ovMove, ovTrim,
    TFONTS, TPRESETS, assColor, textAnchor, textAss, LOUD, MUS_DEFAULT, musicGain,
    speedOf: sp, clipLen, TRANSITIONS, trDur, atempo, LOOKS, colorMatrix, colorOn, colorFilter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhEdit = api;
})(typeof window !== 'undefined' ? window : this);
