/*
 * studio_core.js — Amharic Captions Studio (1.17.0): the pure parts of the
 * Studio (timeline maths, what the mouse is on, project files). No DOM, no
 * bridge: loaded as a classic <script> before studio.js (window.AmhStudio) and
 * requireable from Node for tools/test/test_studio.js.
 */
'use strict';
(function (root) {
  // ── the timeline view: which seconds are shown, how many pixels a second ──
  // v = { start (s), pps (pixels per second) }
  const MAX_PPS = 400;
  function minPps(duration, width) { return duration > 0 ? Math.max(1e-3, width / duration) : 50; }
  function clampView(v, duration, width) {
    const pps = Math.max(minPps(duration, width), Math.min(MAX_PPS, v.pps));
    const maxStart = Math.max(0, duration - width / pps);
    return { start: Math.max(0, Math.min(maxStart, v.start)), pps };
  }
  function fitView(duration, width) { return { start: 0, pps: minPps(duration, width) }; }
  const timeToX = (t, v) => (t - v.start) * v.pps;
  const xToTime = (x, v) => v.start + x / v.pps;
  // Zoom by `factor` keeping the second under the mouse where it is.
  function zoomAt(v, factor, x, duration, width) {
    const t = xToTime(x, v);
    const pps = Math.max(minPps(duration, width), Math.min(MAX_PPS, v.pps * factor));
    return clampView({ start: t - x / pps, pps }, duration, width);
  }
  // Keep the playhead in view while playing: page forward when it leaves.
  function follow(v, t, duration, width) {
    const end = v.start + width / v.pps;
    if (t >= v.start && t <= end - 0.05 * width / v.pps) return v;
    return clampView({ start: t - 0.1 * width / v.pps, pps: v.pps }, duration, width);
  }

  // What is at x on the caption lane: a block's start/end edge (resize) or
  // its body (select). Edges win within `edge` pixels; the nearer edge wins
  // between two touching blocks.
  function hitCaption(cues, v, x, edge) {
    edge = edge == null ? 5 : edge;
    let best = null;
    (cues || []).forEach((c, i) => {
      const a = timeToX(Number(c.start), v), b = timeToX(Number(c.end), v);
      const da = Math.abs(x - a), db = Math.abs(x - b);
      if (da <= edge && (!best || da < best.d)) best = { i, edge: 'start', d: da };
      if (db <= edge && (!best || db < best.d)) best = { i, edge: 'end', d: db };
    });
    if (best) return { i: best.i, edge: best.edge };
    for (let i = 0; i < (cues || []).length; i++) {
      const a = timeToX(Number(cues[i].start), v), b = timeToX(Number(cues[i].end), v);
      if (x >= a && x <= b) return { i, edge: 'body' };
    }
    return null;
  }

  // Ruler marks: a step that leaves ~80 px between labels.
  const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  function ticks(v, width) {
    const step = STEPS.find((s) => s * v.pps >= 80) || 3600;
    const out = [];
    const first = Math.ceil(v.start / step) * step;
    for (let t = first; t <= v.start + width / v.pps + 1e-9; t += step) {
      out.push({ t: Math.round(t * 1000) / 1000, x: timeToX(t, v), label: fmtClock(t, step < 1) });
    }
    return out;
  }
  function fmtClock(t, tenths) {
    t = Math.max(0, Number(t) || 0);
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + ss;
  }

  // ── projects ──────────────────────────────────────────────────────────────
  // One project per video (the same video reopens the same project): a short
  // stable id from its path. Saved as JSON (.amhproj) in Documents/
  // AmharicCaptions/Studio; autosaved while the editor works.
  function projectId(videoPath) {
    let h = 2166136261;
    const s = String(videoPath || '').replace(/\\/g, '/').toLowerCase();
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  function projectFileName(videoPath) {
    const base = String(videoPath || 'video').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 60) || 'video';
    return base + ' __' + projectId(videoPath) + '.amhproj';
  }
  const PROJECT_KEYS = ['start', 'end', 'text', 'doubt', 'wt', '_fixed'];
  function makeProject(p) {
    return {
      kind: 'amharic-captions-studio', v: 1, at: p.at || Date.now(),
      video: String(p.video || ''), name: String(p.name || ''), duration: Number(p.duration) || 0,
      title: p.title ? String(p.title).slice(0, 120) : '',          // the editor's own name for it (1.76)
      style: String(p.style || 'plain'), styleOpts: p.styleOpts || null,
      // words per caption + line length the captions were grouped with (1.33)
      group: p.group && p.group.n >= 1 && p.group.n <= 99 ? { n: Math.round(p.group.n), fmt: p.group.fmt === 'v' ? 'v' : 'h' } : null,
      cleanup: p.cleanup || null,
      edit: p.edit || null,
      // what was last made from it (1.76): { kind: srt | video | capcut | davinci, at }
      done: p.done && p.done.kind ? { kind: String(p.done.kind), at: Number(p.done.at) || 0 } : null,
      cues: (p.cues || []).map((c) => {
        const o = {};
        PROJECT_KEYS.forEach((k) => { if (c[k] != null) o[k] = c[k]; });
        return o;
      }),
    };
  }
  function parseProject(text) {
    let p = null;
    try { p = JSON.parse(text); } catch (e) { return null; }
    if (!p || p.kind !== 'amharic-captions-studio' || !Array.isArray(p.cues) || !p.video) return null;
    p.cues = p.cues.filter((c) => c && isFinite(c.start) && isFinite(c.end) && typeof c.text === 'string');
    return p;
  }
  function recentProjects(list, n) {
    return (list || []).filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, n || 12);
  }
  // ── the project library (1.76) ──────────────────────────────────────────
  // Every project (the home used to show only the 8 newest), found by its
  // name or by any word said in it. fold: how text is compared (the panel's
  // amhFold: letters that sound alike are one, spaces do not count).
  const lowFold = (t) => String(t || '').toLowerCase().replace(/\s+/g, '');
  function libraryMatch(p, q, fold) {
    fold = fold || lowFold;
    if (!q) return { by: 'all' };
    const name = fold(p.title || '') + ' ' + fold(p.name || '') + ' ' + fold(String(p.video || '').split(/[\\/]/).pop());
    if (name.indexOf(q) >= 0) return { by: 'name' };
    const c = (p.cues || []).find((x) => fold(x.text).indexOf(q) >= 0);
    return c ? { by: 'words', text: String(c.text || '').replace(/[*~]/g, ''), t: c.start } : null;
  }
  function libraryList(projects, query, sort, fold) {
    fold = fold || lowFold;
    const q = fold(query || '');
    const out = [];
    (projects || []).filter(Boolean).forEach((p) => { const m = libraryMatch(p, q, fold); if (m) out.push(Object.assign({}, p, { _hit: m })); });
    if (sort === 'old') out.sort((a, b) => (a.at || 0) - (b.at || 0));
    else if (sort === 'name') out.sort((a, b) => String(a.title || a.name || '').localeCompare(String(b.title || b.name || '')));
    else out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return out;
  }
  // newest first, in groups: today, this week (7 days), this month (30), older
  function libraryGroups(list, now) {
    now = now || Date.now();
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const keys = ['today', 'week', 'month', 'older'];
    const g = { today: [], week: [], month: [], older: [] };
    (list || []).forEach((p) => {
      const at = p.at || 0;
      g[at >= day.getTime() ? 'today' : at >= now - 7 * 86400000 ? 'week' : at >= now - 30 * 86400000 ? 'month' : 'older'].push(p);
    });
    return keys.filter((k) => g[k].length).map((k) => ({ key: k, items: g[k] }));
  }
  // ── earlier versions (1.71) ─────────────────────────────────────────────
  // Every few minutes of work the project is also copied to
  // versions/<project>/<YYYYMMDD-HHMMSS>.amhproj; the newest VERSIONS_KEEP stay.
  const VERSIONS_KEEP = 10;
  const VERSION_EVERY = 5 * 60 * 1000;
  const pad2 = (n) => String(n).padStart(2, '0');
  function versionName(ms) {
    const d = new Date(ms);
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.amhproj';
  }
  // the time a version file was made (local), or null for any other file
  function versionTime(name) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.amhproj$/.exec(String(name || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  // newest first; the ones past `keep` are to be deleted
  function versionsSorted(names) {
    return (names || []).filter((n) => versionTime(n) != null).sort().reverse();
  }
  function versionsToDrop(names, keep) {
    return versionsSorted(names).slice(keep == null ? VERSIONS_KEEP : keep);
  }
  // the first readable of several texts (the project, its .tmp, its versions)
  function firstProject(texts) {
    for (let i = 0; i < (texts || []).length; i++) { const p = texts[i] == null ? null : parseProject(texts[i]); if (p) return { p, i }; }
    return null;
  }

  // ── the Script view (1.18.1) ──────────────────────────────────────────────
  // Words (from core cleanupWords: { w, s, e, cue, k }) as paragraphs: a new
  // paragraph after a long pause, or after a sentence end with a pause.
  function scriptParagraphs(words, longGap, sentenceGap) {
    longGap = longGap == null ? 1.2 : longGap;
    sentenceGap = sentenceGap == null ? 0.45 : sentenceGap;
    const out = [];
    let cur = [];
    (words || []).forEach((x, i) => {
      const prev = words[i - 1];
      if (prev && cur.length) {
        const gap = x.s - prev.e;
        const endsSentence = /[።?!፧]$/.test(String(prev.w).replace(/[*~]+$/, ''));
        // and a long stretch without one breaks at a small pause (readable blocks)
        if (gap > longGap || (endsSentence && gap > sentenceGap) || (cur.length >= 35 && gap > 0.25) || cur.length >= 60) { out.push(cur); cur = []; }
      }
      cur.push(x);
    });
    if (cur.length) out.push(cur);
    return out;
  }
  // [start, end) character range of each word of a caption's text (the same
  // words, same order as core cleanupWords).
  function wordRanges(text) {
    const t = String(text || '').replace(/\n/g, ' ');
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(t)) !== null) out.push([m.index, m.index + m[0].length]);
    return out;
  }
  // The word being spoken at t (binary search over start times): its index,
  // or -1 before the first word / in a pause longer than `hold` after one.
  function wordAt(words, t, hold) {
    hold = hold == null ? 0.25 : hold;
    let lo = 0, hi = (words || []).length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return -1;
    return t <= words[best].e + hold ? best : -1;
  }
  // The selected words grouped per caption: [{ cue, from, to }] — character
  // ranges in that caption's text, ready for toggleEmphasis / toggleTextCut.
  function selectionByCaption(cues, picked) {
    const by = {};
    (picked || []).forEach((p) => { (by[p.cue] = by[p.cue] || []).push(p.k); });
    return Object.keys(by).map(Number).sort((a, b) => a - b).map((ci) => {
      const r = wordRanges(cues[ci] && cues[ci].text);
      const ks = by[ci].sort((a, b) => a - b);
      return { cue: ci, from: r[ks[0]] ? r[ks[0]][0] : 0, to: r[ks[ks.length - 1]] ? r[ks[ks.length - 1]][1] : 0, words: ks };
    });
  }

  // ── Clean up on export (1.19.0) ───────────────────────────────────────────
  // The stretches of the video that stay: everything outside the cuts
  // (merged, sorted), dropping slivers shorter than `minKeep`.
  function keepRanges(cuts, duration, minKeep) {
    minKeep = minKeep == null ? 0.04 : minKeep;
    const c = (cuts || []).map((x) => [Math.max(0, Number(x.start)), Math.min(duration, Number(x.end))])
      .filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
    const keeps = [];
    let at = 0;
    c.forEach(([a, b]) => { if (a - at >= minKeep) keeps.push([at, a]); at = Math.max(at, b); });
    if (duration - at >= minKeep) keeps.push([at, duration]);
    return keeps.map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
  }
  // One ffmpeg filter graph that keeps those stretches and joins them,
  // frame-exact; a 10 ms sound fade at every join (no clicks).
  function cutFilter(keeps, hasVideo, fade) {
    fade = fade == null ? 0.01 : fade;
    const parts = [];
    const ins = [];
    keeps.forEach(([a, b], i) => {
      const d = Math.max(0, b - a);
      const f = Math.min(fade, d / 4).toFixed(3);
      if (hasVideo) parts.push('[0:v]trim=start=' + a + ':end=' + b + ',setpts=PTS-STARTPTS[v' + i + ']');
      parts.push('[0:a]atrim=start=' + a + ':end=' + b + ',asetpts=PTS-STARTPTS,afade=t=in:d=' + f +
        ',afade=t=out:st=' + Math.max(0, d - f).toFixed(3) + ':d=' + f + '[a' + i + ']');
      ins.push((hasVideo ? '[v' + i + ']' : '') + '[a' + i + ']');
    });
    parts.push(ins.join('') + 'concat=n=' + keeps.length + ':v=' + (hasVideo ? 1 : 0) + ':a=1' + (hasVideo ? '[v][a]' : '[a]'));
    return parts.join(';');
  }
  const keptLength = (keeps) => keeps.reduce((n, k) => n + (k[1] - k[0]), 0);

  // ✔ Check words (1.48): what a doubtful word probably is — the panel's
  // core (panel/js/core.js, 1.52: shared, + the Amharic dictionary)
  const CORE = (typeof module !== 'undefined' && module.exports) ? require('../panel/js/core.js') : root;
  const editDistance = (a, b) => CORE.editDistance(a, b);
  const checkSuggest = (word, cues, fixes, max, dict) => CORE.suggestWords(word, cues, fixes, max, dict);

  const api = { MAX_PPS, minPps, clampView, fitView, timeToX, xToTime, zoomAt, follow, hitCaption, ticks, fmtClock,
    projectId, projectFileName, makeProject, parseProject, recentProjects, libraryMatch, libraryList, libraryGroups, VERSIONS_KEEP, VERSION_EVERY, versionName, versionTime, versionsSorted, versionsToDrop, firstProject, scriptParagraphs, wordRanges, wordAt, selectionByCaption,
    keepRanges, cutFilter, keptLength, editDistance, checkSuggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhStudio = api;
})(typeof window !== 'undefined' ? window : this);
