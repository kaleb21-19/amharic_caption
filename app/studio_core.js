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
      style: String(p.style || 'plain'), styleOpts: p.styleOpts || null,
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

  const api = { MAX_PPS, minPps, clampView, fitView, timeToX, xToTime, zoomAt, follow, hitCaption, ticks, fmtClock,
    projectId, projectFileName, makeProject, parseProject, recentProjects };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhStudio = api;
})(typeof window !== 'undefined' ? window : this);
