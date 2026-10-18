/*
 * studio_edit_core.js — Amharic Captions Studio editor (1.20.0): the edit
 * itself, pure (no DOM, no bridge). Loaded before studio_edit.js
 * (window.AmhEdit) and requireable from Node (tools/test/test_edit.js).
 *
 * The main track is "magnetic" (like CapCut): its clips play one after the
 * other with no gaps; a clip = a piece of a media file { id, m, in, out,
 * scale, x, y, volume }. Edit time = position in the finished video.
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

  // ── the main track ───────────────────────────────────────────────────────
  function layout(clips) {
    let t = 0;
    return (clips || []).map((c) => { const d = Math.max(0, c.out - c.in); const o = Object.assign({}, c, { s: r3(t), e: r3(t + d) }); t += d; return o; });
  }
  const total = (clips) => r3((clips || []).reduce((n, c) => n + Math.max(0, c.out - c.in), 0));
  // the clip at edit time t (the last one at the very end) and the file's second there
  function locate(clips, t) {
    const L = layout(clips);
    if (!L.length) return null;
    let i = L.findIndex((c) => t >= c.s && t < c.e);
    if (i < 0) i = t < 0 ? 0 : L.length - 1;
    const c = L[i];
    const src = Math.max(c.in, Math.min(c.out, c.in + (t - c.s)));
    return { i, clip: c, src };
  }
  // every edit time that shows second `src` of media m
  function sourceToEdit(clips, m, src) {
    return layout(clips).filter((c) => c.m === m && src >= c.in && src < c.out).map((c) => r3(c.s + (src - c.in)));
  }
  // split the clip under t in two; nothing at a clip edge
  function splitAt(clips, t, newId) {
    const L = layout(clips);
    const i = L.findIndex((c) => t > c.s + MIN / 2 && t < c.e - MIN / 2);
    if (i < 0) return clips;
    const c = clips[i];
    const cut = r3(c.in + (t - L[i].s));
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
  function fromWords(c, ws, shift) {
    if (!ws.length) return null;
    const q = Object.assign({}, c);
    q.text = ws.map((x) => x.w).join(' ');
    q.start = r3(ws[0].s + shift); q.end = r3(ws[ws.length - 1].e + shift);
    if (ws.every((x) => x.x)) q.wt = ws.map((x) => [r3(x.s + shift), r3(x.e + shift)]); else delete q.wt;
    return q;
  }
  const mid = (x) => (x.s + x.e) / 2;
  const META = ['_m', '_ci', '_id', '_part'];
  const clean = (c) => { const o = Object.assign({}, c); META.forEach((k) => delete o[k]); return o; };
  // S (source captions) -> the captions of the edit, in edit time
  function deriveCaptions(clips, S) {
    const out = [];
    layout(clips).forEach((c) => {
      const shift = c.s - c.in;
      (S[c.m] || []).forEach((q, ci) => {
        if (q.end <= c.in || q.start >= c.out) return;
        let d;
        if (q.start >= c.in - 1e-6 && q.end <= c.out + 1e-6) {
          d = Object.assign(clean(q), { start: r3(q.start + shift), end: r3(q.end + shift) });
          if (Array.isArray(q.wt)) d.wt = q.wt.map((w) => [r3(w[0] + shift), r3(w[1] + shift)]);
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
        const q = fromWords(clean(d), ws, c.in - c.s);
        if (!q) return;
        if (!inClip.length) { q.start = r3(Math.max(c.in, d.start + c.in - c.s)); q.end = r3(Math.min(c.out, d.end + c.in - c.s)); }
        const k = c.m + '|' + q.start + '|' + q.text;
        if (seen[k]) return;
        seen[k] = 1;
        (NS[c.m] = NS[c.m] || []).push(q);
      });
    });
    Object.keys(NS).forEach((m) => NS[m].sort((a, b) => a.start - b.start || a.end - b.end));
    return NS;
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

  // media: { id: { idx (ffmpeg input number), w, h, video, audio, image } }
  // opts.ass: a libass script (file name, in the folder ffmpeg runs in, with a
  // fonts/ folder) drawn over everything — the text track
  function editGraph(clips, media, fmt, fps, ovl, opts) {
    opts = opts || {};
    fps = fps || 30;
    const { w: W, h: H } = canvasSize(fmt);
    const L = layout(clips);
    const parts = [], ins = [];
    L.forEach((c, i) => {
      const m = media[c.m] || {};
      const d = r3(c.out - c.in);
      const f = Math.min(0.01, d / 4).toFixed(3);
      if (m.video) {
        const p = placement(m, c, W, H);
        parts.push('[' + m.idx + ':v]trim=start=' + c.in + ':end=' + c.out + ',setpts=PTS-STARTPTS,fps=' + fps + ',scale=' + p.sw + ':' + p.sh + ',setsar=1[s' + i + ']');
        parts.push('color=c=black:s=' + W + 'x' + H + ':r=' + fps + ':d=' + d + '[b' + i + ']');
        parts.push('[b' + i + '][s' + i + ']overlay=' + p.x + ':' + p.y + ':shortest=1,format=yuv420p[v' + i + ']');
      } else {
        parts.push('color=c=black:s=' + W + 'x' + H + ':r=' + fps + ':d=' + d + ',format=yuv420p[v' + i + ']');
      }
      if (m.audio) {
        parts.push('[' + m.idx + ':a]atrim=start=' + c.in + ':end=' + c.out + ',asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=' +
          (c.volume == null ? 1 : Number(c.volume)) + ',afade=t=in:d=' + f + ',afade=t=out:st=' + Math.max(0, d - f).toFixed(3) + ':d=' + f + '[a' + i + ']');
      } else {
        parts.push('anullsrc=r=48000:cl=stereo,atrim=duration=' + d + '[a' + i + ']');
      }
      ins.push('[v' + i + '][a' + i + ']');
    });
    const list = (ovl || []).filter((o) => media[o.m] && o.start < total(clips) && ovLen(o) > 0);
    const vOut = opts.ass ? 'vx' : 'v';
    parts.push(ins.join('') + 'concat=n=' + L.length + ':v=1:a=1' + (list.length ? '[vm][am]' : '[' + vOut + '][a]'));
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
      if (mix.length > 1) parts.push(mix.join('') + 'amix=inputs=' + mix.length + ':duration=first:normalize=0[a]');
      else parts.push('[am]anull[a]');
    }
    if (opts.ass) parts.push('[vx]subtitles=' + opts.ass + ':fontsdir=fonts,format=yuv420p[v]');
    return { graph: parts.join(';'), w: W, h: H, duration: total(clips) };
  }

  const api = { MIN, layout, total, locate, sourceToEdit, splitAt, removeClip, trimClip, moveClip, dropIndex, cutRange,
    words, deriveCaptions, syncBack, FORMATS, canvasSize, placement, editGraph, ovLen, ovEnd, ovAt, ovMove, ovTrim,
    TFONTS, TPRESETS, assColor, textAnchor, textAss };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhEdit = api;
})(typeof window !== 'undefined' ? window : this);
