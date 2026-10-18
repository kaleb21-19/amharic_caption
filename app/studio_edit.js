/*
 * studio_edit.js — Amharic Captions Studio, the real editor (1.20.0).
 * Design: docs/agent/STUDIO_DESIGN.md. The edit itself: studio_edit_core.js.
 *
 *  · Media (left, 📁): the videos of this project; ＋ import or drop more;
 *    a click puts one at the end of the timeline.
 *  · Player: plays the EDIT (clip after clip, any file), on a canvas in the
 *    chosen format (16:9 · 9:16 · 1:1 · 4:5); drag the picture to move it.
 *  · Timeline: 💬 captions and 🎬 the main track — click to select, drag an
 *    edge to trim, drag a clip to move it, ✂ S splits at the playhead,
 *    Delete removes (the rest closes up), ↶ ↷ for everything.
 *  · ⚙ Clip (right): size, position, volume of the selected clip.
 *  · Export: the whole edit as one render, captions drawn in by the style.
 * Captions belong to the source files (S); the edit's captions (reviewCues)
 * are derived and every change goes back — nothing is lost by cutting.
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  const S = window.AmhStudio;
  const E = window.AmhEdit;
  const ST = window.__amhStudio;
  const review = document.getElementById('review');
  if (!APP || !S || !E || !ST || !review) return;
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text, title, fn) => { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; if (fn) b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); fn(e); }); return b; };
  document.documentElement.classList.add('amh-editor');

  // ── state ──────────────────────────────────────────────────────────────
  let media = {};          // id -> { id, path, name, dur, w, h, video, audio }
  let clips = [];          // the main track
  let ovl = [];            // the overlay track (1.21.0): B-roll, photos, logos
  let SRC = {};            // the captions of each file, in that file's time
  let fmt = '16:9';
  let sel = null;          // the selected clip's id
  let built = false;       // the edit exists for the open review
  let nid = 0;
  const newId = () => 'k' + Date.now().toString(36) + (++nid);
  const primary = () => Object.keys(media)[0] || null;
  const L = () => E.layout(clips);
  const total = () => Math.max(0.1, E.total(clips));

  // ── files: what is in them (ffmpeg -i), their sound wave ───────────────
  const IMAGE = /\.(png|jpe?g|webp)$/i;
  function probe(p) {
    return new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-i', p], { timeout: 30000 }, (err, out, errText) => {
        const t = String(errText || (err && err.message) || '');
        const d = t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const vm = t.match(/Stream[^\n]*Video:[^\n]*?\s(\d{2,5})x(\d{2,5})/);
        if (IMAGE.test(p)) { resolve({ dur: 0, image: true, w: vm ? Number(vm[1]) : 0, h: vm ? Number(vm[2]) : 0, video: !!vm, audio: false }); return; }
        resolve({ dur: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
          w: vm ? Number(vm[1]) : 0, h: vm ? Number(vm[2]) : 0, video: !!vm && !/attached pic/.test(t.slice(t.indexOf(vm[0]), t.indexOf(vm[0]) + 300)),
          audio: /Stream[^\n]*Audio:/.test(t) });
      });
    });
  }
  const PEAKS = {};           // media id -> loudness 0-100, 50 a second
  const peaking = {};
  function loadPeaks(id) {
    const m = media[id];
    if (!m || PEAKS[id] || peaking[id] || !m.audio) return;
    peaking[id] = true;
    const raw = path.join(os.tmpdir(), 'amh_peaks_' + Date.now() + '_' + id + '.raw');
    execFile(FFMPEG, ['-v', 'error', '-y', '-i', m.path, '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', raw], { timeout: 30 * 60 * 1000 }, (err) => {
      peaking[id] = false;
      if (err) return;
      try { PEAKS[id] = APP.call('peaks', [raw, 2000, 50]); } catch (e) { PEAKS[id] = null; }
      drawSoon();
    });
  }
  // the loudness of the EDIT (for ✂ Clean up's pauses): the files' waves, clip by clip
  function editPeaks() {
    const out = [];
    for (const c of L()) {
      const p = PEAKS[c.m];
      if (!p) return null;
      const a = Math.floor(c.in * 50), b = Math.floor(c.out * 50);
      for (let k = a; k < b; k++) out.push(p[k] || 0);
    }
    return out.length ? out : null;
  }
  async function addMedia(p, opts) {
    opts = opts || {};
    const info = await probe(p);
    if (!info.dur && !(info.image && info.w)) { log(tx('ይህ ፋይል ሊከፈት አልቻለም፦ ', 'This file could not be opened: ') + path.basename(p)); return null; }
    const id = opts.id || ('m' + (Object.keys(media).length + 1) + '_' + Date.now().toString(36));
    media[id] = Object.assign({ id, path: p, name: path.basename(p) }, info);
    loadPeaks(id);
    renderMedia();
    return id;
  }

  // ── the edit and the captions ──────────────────────────────────────────
  // reviewCues (what the editor sees and edits) are derived from the files'
  // captions; before the edit changes, what the editor changed goes back.
  function syncSrc() { if (built && typeof reviewCues !== 'undefined') SRC = E.syncBack(clips, SRC, reviewCues); }
  function derive() {
    reviewCues = E.deriveCaptions(clips, SRC);
    if (typeof renderReview === 'function') renderReview();
    if (typeof schedulePreview === 'function') schedulePreview();
  }
  function change(what, fn) {
    pushReviewUndo(what);
    syncSrc();
    fn();
    derive();
    if (sel && !clips.some((c) => c.id === sel)) sel = null;
    after();
  }
  function after() { frame(); renderInspector(); drawSoon(); ST.saveSoon(); }

  // ── undo / redo for the edit too ───────────────────────────────────────
  const origPush = window.pushReviewUndo;
  const origUndo = window.undoReview;
  const REDO = [];
  let redoing = false;
  const snap = () => JSON.stringify({ clips, ovl, fmt, media, SRC: built ? E.syncBack(clips, SRC, reviewCues) : SRC });
  function restore(json) {
    const o = JSON.parse(json);
    clips = o.clips; ovl = o.ovl || []; fmt = o.fmt; SRC = o.SRC;
    Object.keys(o.media || {}).forEach((k) => { if (!media[k]) { media[k] = o.media[k]; loadPeaks(k); } });
  }
  window.pushReviewUndo = function (what) {
    origPush(what);
    const top = REVIEW_UNDO[REVIEW_UNDO.length - 1];
    if (top && built) top.edit = snap();
    if (!redoing) REDO.length = 0;
    syncUndo();
  };
  function entryNow() {
    return { what: 'redo', cues: JSON.stringify(reviewCues), client: JSON.stringify(REVIEW_CLIENT_WORDS), active: ACTIVE_CLIENT,
      fixes: JSON.stringify(REVIEW_AUTOFIX.rules), mem: JSON.stringify(REVIEW_MEM_FIXES), edit: built ? snap() : null };
  }
  window.undoReview = function () {
    const top = REVIEW_UNDO[REVIEW_UNDO.length - 1];
    if (!top) return;
    REDO.push(entryNow());
    if (top.edit) restore(top.edit);
    origUndo();
    after(); renderMedia(); syncUndo();
  };
  function redo() {
    const e = REDO.pop();
    if (!e) return;
    redoing = true;
    const cur = entryNow();
    REVIEW_UNDO.push(e);
    if (e.edit) restore(e.edit);
    origUndo();                       // takes e off and puts its captions back
    REVIEW_UNDO.push(cur);            // undo goes back to before the redo
    redoing = false;
    after(); renderMedia(); syncUndo();
  }
  function syncUndo() {
    if (bUndo) bUndo.disabled = !REVIEW_UNDO.length;
    if (bRedo) bRedo.disabled = !REDO.length;
  }

  // ── the player: plays the edit ─────────────────────────────────────────
  const V = () => $('appVideo');
  let cur = 0;                 // index of the clip being shown
  let ET = 0;                  // edit time while not playing
  let playing = false;
  const urls = {};
  function urlOf(id) { if (!urls[id]) urls[id] = APP.call('media', [media[id].path]); return urls[id]; }
  function ensureSrc(id) {
    const v = V();
    return new Promise((resolve) => {
      if (!v || !media[id]) { resolve(false); return; }
      if (v.dataset.m === id && v.getAttribute('src')) { resolve(true); return; }
      v.dataset.m = id;
      const done = () => { v.removeEventListener('loadedmetadata', done); resolve(true); };
      v.addEventListener('loadedmetadata', done);
      v.src = urlOf(id);
      setTimeout(done, 4000);
    });
  }
  function time() {
    const v = V();
    const c = L()[cur];
    if (v && c && v.dataset.m === c.m && (playing || Math.abs(v.currentTime - (c.in + (ET - c.s))) < 0.25)) {
      return Math.max(c.s, Math.min(c.e, c.s + (v.currentTime - c.in)));
    }
    return ET;
  }
  async function seek(t) {
    t = Math.max(0, Math.min(total(), Number(t) || 0));
    ET = t;
    const loc = E.locate(clips, t);
    if (!loc) { drawSoon(); return; }
    cur = loc.i;
    await ensureSrc(loc.clip.m);
    try { V().currentTime = loc.src; } catch (e) {}
    frame(); tick(false);
  }
  async function play() {
    if (!clips.length) return;
    let t = time();
    if (t >= total() - 0.05) t = 0;
    await seek(t);
    playing = true;
    try { await V().play(); } catch (e) {}
    syncPlay();
    requestAnimationFrame(loop);
  }
  function pause() { if (playing) ET = time(); playing = false; const v = V(); if (v) v.pause(); syncPlay(); tick(false); }
  function toggle() { if (playing) pause(); else play(); }
  function loop() {
    if (!playing) return;
    const v = V();
    const LL = L();
    const c = LL[cur];
    if (!c || !v) { pause(); return; }
    if (v.currentTime >= c.out - 0.03 || v.ended) {
      const n = LL[cur + 1];
      if (!n) { pause(); ET = total(); tick(false); return; }
      cur += 1;
      if (v.dataset.m !== n.m) { ensureSrc(n.m).then(() => { try { v.currentTime = n.in; } catch (e) {} if (playing) v.play().catch(() => {}); }); }
      else if (Math.abs(v.currentTime - n.in) > 0.06) { try { v.currentTime = n.in; } catch (e) {} }
      frame();
    }
    tick(true);
    requestAnimationFrame(loop);
  }
  // the rest of the Studio reads and moves the edit's time through these
  window.__amhEditTime = () => time();
  window.__amhSeek = (t) => seek(t);

  // ── the canvas (format) ────────────────────────────────────────────────
  const pv = $('appPreview');
  const wrapEl = pv ? pv.querySelector('.app-video-wrap') : null;
  const stage = el('div', 'ed-canvas');
  if (wrapEl) {
    const v = V();
    wrapEl.appendChild(stage);
    if (v) { stage.appendChild(v); v.controls = false; v.removeAttribute('controls'); }
    const cap = $('appCap');
    if (cap) stage.appendChild(cap);
  }
  const fmtBar = el('div', 'ed-fmt');
  ['16:9', '9:16', '1:1', '4:5'].forEach((f) => {
    const b = btn('', f, '', () => { if (f !== fmt) change('format', () => { fmt = f; }); });
    b.dataset.f = f;
    fmtBar.appendChild(b);
  });
  if (pv) pv.insertBefore(fmtBar, pv.firstChild);
  const transport = el('div', 'ed-transport');
  const bStart = btn('ed-tbtn', '⏮', '', () => seek(0));
  const bPlay = btn('ed-play', '▶', '', () => toggle());
  const bEnd = btn('ed-tbtn', '⏭', '', () => seek(total()));
  const tTime = el('span', 'ed-time', '0:00.0 / 0:00');
  const bFull = btn('ed-tbtn', '⛶', '', () => { try { stage.requestFullscreen(); } catch (e) {} });
  [bStart, bPlay, bEnd, tTime, el('span', 'st-flex'), bFull].forEach((x) => transport.appendChild(x));
  if (pv) pv.appendChild(transport);
  function syncPlay() { bPlay.textContent = playing ? '⏸' : '▶'; }
  // the canvas fits the space; the picture is placed exactly as the export will place it
  function frame() {
    if (!wrapEl) return;
    const { w: W, h: H } = E.canvasSize(fmt);
    const aw = Math.max(50, wrapEl.clientWidth - 8), ah = Math.max(50, wrapEl.clientHeight - 8);
    const k = Math.min(aw / W, ah / H);
    stage.style.width = Math.round(W * k) + 'px';
    stage.style.height = Math.round(H * k) + 'px';
    fmtBar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === fmt));
    const c = L()[cur] || L()[0];
    const v = V();
    if (!v) return;
    const m = c && media[c.m];
    if (!m || !m.video) { v.style.visibility = 'hidden'; return; }
    v.style.visibility = '';
    const p = E.placement(m, c, W, H);
    v.style.left = (p.x * k) + 'px'; v.style.top = (p.y * k) + 'px';
    v.style.width = (p.sw * k) + 'px'; v.style.height = (p.sh * k) + 'px';
    stage.classList.toggle('sel', !!sel && c.id === sel);
    syncOverlays(time());
  }
  window.addEventListener('resize', () => { frame(); drawSoon(); });
  // overlay pictures on the canvas, placed exactly as the export places them
  const OVEL = {};
  function ovEl(o) {
    let e = OVEL[o.id];
    const m = media[o.m];
    if (!m) return null;
    if (!e || e.dataset.m !== o.m) {
      if (e) e.remove();
      e = document.createElement(m.image ? 'img' : 'video');
      e.className = 'ed-ov';
      e.dataset.m = o.m;
      if (!m.image) { e.muted = true; e.playsInline = true; e.preload = 'auto'; }
      e.src = urlOf(o.m);
      e.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); startMove(o.id, ev); });
      const cap = $('appCap');
      stage.insertBefore(e, cap && cap.parentNode === stage ? cap : null);
      OVEL[o.id] = e;
    }
    return e;
  }
  function syncOverlays(t) {
    const { w: W, h: H } = E.canvasSize(fmt);
    const k = stage.clientWidth / W || 0;
    const on = {};
    E.ovAt(ovl, t).forEach((o) => {
      if (t >= total()) return;
      const e = ovEl(o);
      if (!e) return;
      on[o.id] = 1;
      const p = E.placement(media[o.m], o, W, H);
      e.style.display = '';
      e.style.left = (p.x * k) + 'px'; e.style.top = (p.y * k) + 'px';
      e.style.width = (p.sw * k) + 'px'; e.style.height = (p.sh * k) + 'px';
      e.style.opacity = o.opacity == null ? 1 : o.opacity;
      e.classList.toggle('sel', o.id === sel);
      if (e.tagName === 'VIDEO') {
        const want = o.in + (t - o.start);
        e.muted = !(Number(o.volume) > 0);
        if (!e.muted) e.volume = Math.min(1, Number(o.volume));
        if (playing) { if (e.paused) { try { e.currentTime = want; } catch (x) {} e.play().catch(() => {}); } else if (Math.abs(e.currentTime - want) > 0.25) { try { e.currentTime = want; } catch (x) {} } }
        else { if (!e.paused) e.pause(); if (Math.abs(e.currentTime - want) > 0.04) { try { e.currentTime = want; } catch (x) {} } }
      }
    });
    Object.keys(OVEL).forEach((id) => {
      if (on[id]) return;
      const e = OVEL[id];
      if (!ovl.some((o) => o.id === id)) { e.remove(); delete OVEL[id]; return; }
      e.style.display = 'none';
      if (e.tagName === 'VIDEO' && !e.paused) e.pause();
    });
  }
  // drag the picture to move the selected clip (one undo step per drag)
  let moving = null;
  const findItem = (id) => clips.find((c) => c.id === id) || ovl.find((o) => o.id === id);
  function startMove(id, e) {
    const it = findItem(id);
    if (!it || e.button !== 0) return;
    if (sel !== id) { sel = id; renderInspector(); ST.showTab('clip'); }
    const { w: W, h: H } = E.canvasSize(fmt);
    pushReviewUndo('move picture');
    moving = { id, x0: e.clientX, y0: e.clientY, cx: Number(it.x) || 0, cy: Number(it.y) || 0, k: stage.clientWidth / W, W, H };
  }
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sOv = ovl.find((o) => o.id === sel && E.ovAt([o], time()).length);
    const c = L()[cur];
    if (sOv) startMove(sOv.id, e); else if (c) startMove(c.id, e);
  });
  document.addEventListener('mousemove', (e) => {
    if (!moving) return;
    const dx = (e.clientX - moving.x0) / moving.k / moving.W, dy = (e.clientY - moving.y0) / moving.k / moving.H;
    const upd = (x) => (x.id === moving.id ? Object.assign({}, x, { x: Math.round((moving.cx + dx) * 1000) / 1000, y: Math.round((moving.cy + dy) * 1000) / 1000 }) : x);
    clips = clips.map(upd); ovl = ovl.map(upd);
    frame(); renderInspector();
  });
  document.addEventListener('mouseup', () => { if (moving) { moving = null; ST.saveSoon(); } });

  // ── the timeline ───────────────────────────────────────────────────────
  const tl = el('div', 'studio-tl ed-tl');
  const tbar = el('div', 'ed-tbar');
  const bSplit = btn('ed-tool', '', '', () => splitHere());
  const bDel = btn('ed-tool', '', '', () => deleteSel());
  const bUndo = btn('ed-tool', '↶', '', () => undoReview());
  const bRedo = btn('ed-tool', '↷', '', () => redo());
  const zOut = btn('tl-btn', '−', '', () => { view = S.zoomAt(view, 0.625, S.timeToX(time(), view), total(), width()); drawSoon(); });
  const zIn = btn('tl-btn', '+', '', () => { view = S.zoomAt(view, 1.6, S.timeToX(time(), view), total(), width()); drawSoon(); });
  const zFit = btn('tl-btn', '⤢', '', () => { view = S.fitView(total(), width()); drawSoon(); });
  const hint = el('span', 'ed-hint', '');
  [bSplit, bDel, bUndo, bRedo, hint, el('span', 'st-flex'), zOut, zIn, zFit].forEach((x) => tbar.appendChild(x));
  const lanes = el('div', 'ed-lanes');
  const labels = el('div', 'ed-labels');
  const cwrap = el('div', 'tl-canvas-wrap ed-cwrap');
  const canvas = el('canvas');
  cwrap.appendChild(canvas);
  lanes.appendChild(labels); lanes.appendChild(cwrap);
  tl.appendChild(tbar); tl.appendChild(lanes);
  review.appendChild(tl);
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  const RULER = 20, CAP = 30, OVL = 34, MAIN = 50, GAP = 6;
  const capTop = RULER + 4, ovTop = capTop + CAP + GAP, mainTop = ovTop + OVL + GAP;
  let view = { start: 0, pps: 50 };
  let fitted = false;
  const width = () => Math.max(50, cwrap.clientWidth || 600);
  let drag = null, hover = null;
  let pending = 0;
  function drawSoon() { if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); }); }
  // overlapping overlays get their own row inside the overlay lane (up to 3)
  function ovRows() {
    const ends = [];
    const row = {};
    ovl.slice().sort((a, b) => a.start - b.start).forEach((o) => {
      let r = ends.findIndex((e) => e <= o.start + 1e-6);
      if (r < 0) { r = Math.min(ends.length, 2); }
      ends[r] = Math.max(ends[r] || 0, E.ovEnd(o));
      row[o.id] = r;
    });
    const n = Math.max(1, Math.min(3, ends.length));
    return { row, n, h: OVL / n };
  }
  function tick(follow) {
    const t = time();
    syncOverlays(t);
    tTime.textContent = S.fmtClock(t, true) + ' / ' + S.fmtClock(total());
    if (follow) view = S.follow(view, t, total(), width());
    draw();
  }
  function draw() {
    if (!ctx || !review.classList.contains('show')) return;
    const w = width(), h = cwrap.clientHeight || 120, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    if (!fitted && clips.length) { view = S.fitView(total(), w); fitted = true; }
    view = S.clampView(view, total(), w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1513'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#141c19'; ctx.fillRect(0, 0, w, RULER);
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    S.ticks(view, w).forEach((k) => {
      ctx.fillStyle = '#2c3a34'; ctx.fillRect(Math.round(k.x), RULER - 5, 1, 5);
      ctx.fillStyle = '#86998f'; ctx.fillText(k.label, k.x + 3, RULER / 2);
    });
    // 🎬 the main track: one block per clip with its file's sound wave
    const LL = L();
    LL.forEach((c) => {
      const x0 = S.timeToX(c.s, view), x1 = S.timeToX(c.e, view);
      if (x1 < 0 || x0 > w) return;
      const isSel = c.id === sel;
      ctx.fillStyle = isSel ? '#2a5f86' : '#1f4b6b';
      ctx.fillRect(x0 + 1, mainTop, Math.max(2, x1 - x0 - 2), MAIN);
      const p = PEAKS[c.m];
      if (p) {
        ctx.fillStyle = 'rgba(160,210,230,.45)';
        const bot = mainTop + MAIN - 3;
        for (let x = Math.max(0, Math.floor(x0) + 2); x < Math.min(w, x1 - 2); x++) {
          const sa = c.in + (S.xToTime(x, view) - c.s), sb = c.in + (S.xToTime(x + 1, view) - c.s);
          let mx = 0;
          for (let k = Math.floor(sa * 50); k < Math.max(Math.floor(sa * 50) + 1, Math.floor(sb * 50)) && k < p.length; k++) if (p[k] > mx) mx = p[k];
          const hh = Math.max(1, mx / 100 * (MAIN - 22));
          ctx.fillRect(x, bot - hh, 1, hh);
        }
      }
      ctx.strokeStyle = isSel ? '#ffffff' : '#3d7fb0';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, mainTop + 0.5, Math.max(2, x1 - x0 - 3), MAIN - 1);
      const edgeHot = hover && hover.lane === 'main' && hover.id === c.id && hover.edge !== 'body';
      if (edgeHot) { ctx.fillStyle = '#ffffff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, mainTop, 3, MAIN); }
      if (x1 - x0 > 30) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 6, mainTop, x1 - x0 - 12, MAIN); ctx.clip();
        ctx.fillStyle = '#e6f2fa'; ctx.font = '600 11px "Segoe UI", sans-serif';
        ctx.fillText((media[c.m] ? media[c.m].name : '') + '  ·  ' + S.fmtClock(c.e - c.s, true), x0 + 7, mainTop + 11);
        ctx.restore();
      }
    });
    // 🎞 overlays
    const R = ovRows();
    ovl.forEach((o) => {
      const x0 = S.timeToX(o.start, view), x1 = S.timeToX(E.ovEnd(o), view);
      if (x1 < 0 || x0 > w) return;
      const isSel = o.id === sel, m = media[o.m];
      const y0 = ovTop + R.row[o.id] * R.h, hh = R.h - (R.n > 1 ? 1 : 0);
      ctx.fillStyle = isSel ? '#6a52a0' : '#4b3a6b';
      ctx.fillRect(x0 + 1, y0, Math.max(2, x1 - x0 - 2), hh);
      ctx.strokeStyle = isSel ? '#ffffff' : '#8b6fc0';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, y0 + 0.5, Math.max(2, x1 - x0 - 3), hh - 1);
      if (hover && hover.lane === 'ov' && hover.id === o.id && hover.edge !== 'body') { ctx.fillStyle = '#fff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, y0, 3, hh); }
      if (x1 - x0 > 24) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 5, y0, x1 - x0 - 10, hh); ctx.clip();
        ctx.fillStyle = '#f0e8ff'; ctx.font = '600 ' + (R.n > 1 ? 10 : 11) + 'px "Segoe UI", sans-serif';
        ctx.fillText((m && m.image ? '🖼 ' : '🎞 ') + (m ? m.name : ''), x0 + 6, y0 + hh / 2);
        ctx.restore();
      }
    });
    if (drag && drag.kind === 'move' && drag.moved) {
      const x = S.timeToX(drag.dropT, view);
      ctx.fillStyle = '#ffd60a'; ctx.fillRect(x - 1, mainTop - 3, 3, MAIN + 6);
    }
    // 💬 captions
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const t = time();
    ctx.font = '600 11px ' + (getComputedStyle(document.documentElement).getPropertyValue('--review-font').trim() || '"Abyssinica SIL"') + ', serif';
    cues.forEach((c, i) => {
      const x0 = S.timeToX(c.start, view), x1 = S.timeToX(c.end, view);
      if (x1 < 0 || x0 > w) return;
      const on = t >= c.start && t < c.end;
      const cut = /~[^~]+~/.test(c.text || '') && String(c.text).replace(/~[^~]*~/g, '').trim() === '';
      ctx.fillStyle = cut ? '#4a2622' : (on ? '#1f7a4c' : '#22413a');
      ctx.fillRect(x0 + 0.5, capTop, Math.max(2, x1 - x0 - 1), CAP);
      ctx.fillStyle = (hover && hover.lane === 'cap' && hover.i === i && hover.edge !== 'body') ? '#ffffff' : (cut ? '#ff6b6b' : '#3ddc84');
      ctx.fillRect(x0, capTop, 2, CAP); ctx.fillRect(x1 - 2, capTop, 2, CAP);
      if (/\*[^*]+\*/.test(c.text || '')) { ctx.fillStyle = '#ffd60a'; ctx.fillRect(x0 + 2, capTop + CAP - 3, Math.max(1, x1 - x0 - 4), 3); }
      if (x1 - x0 > 18) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 4, capTop, x1 - x0 - 8, CAP); ctx.clip();
        ctx.fillStyle = '#e8f5ee';
        ctx.fillText(String(c.text || '').replace(/[*~]/g, ''), x0 + 5, capTop + CAP / 2);
        ctx.restore();
      }
    });
    ST.overlays.forEach((f) => { try { f(ctx, view, w, h, { ruler: RULER, laneTop: capTop, lane: CAP }); } catch (e) {} });
    const px = S.timeToX(t, view);
    ctx.fillStyle = '#ff5c5c'; ctx.fillRect(Math.round(px) - 1, 0, 2, h);
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
  }
  function xy(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hitAt(p) {
    if (p.y >= ovTop && p.y <= ovTop + OVL) {
      const R = ovRows();
      const r = Math.min(R.n - 1, Math.floor((p.y - ovTop) / R.h));
      for (let k = ovl.length - 1; k >= 0; k--) {
        const o = ovl[k];
        if (R.row[o.id] !== r) continue;
        const x0 = S.timeToX(o.start, view), x1 = S.timeToX(E.ovEnd(o), view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'ov', id: o.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'ov', id: o.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'ov', id: o.id, edge: 'body' };
      }
      return null;
    }
    if (p.y >= mainTop && p.y <= mainTop + MAIN) {
      const LL = L();
      for (const c of LL) {
        const x0 = S.timeToX(c.s, view), x1 = S.timeToX(c.e, view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'main', id: c.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'main', id: c.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'main', id: c.id, edge: 'body' };
      }
      return null;
    }
    if (p.y >= capTop && p.y <= capTop + CAP) {
      const hit = S.hitCaption(typeof reviewCues !== 'undefined' ? reviewCues : [], view, p.x, 6);
      return hit ? Object.assign({ lane: 'cap' }, hit) : null;
    }
    return null;
  }
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = xy(e);
    const hit = hitAt(p);
    if (playing) pause();
    if (hit && hit.lane === 'ov') {
      const o = ovl.find((x) => x.id === hit.id);
      if (sel !== hit.id) { sel = hit.id; renderInspector(); ST.showTab('clip'); }
      pushReviewUndo(hit.edge === 'body' ? 'move overlay' : 'trim overlay');
      drag = { kind: 'ov', id: hit.id, edge: hit.edge, x0: p.x, start0: o.start, end0: E.ovEnd(o), len: media[o.m] && !media[o.m].image ? media[o.m].dur : null };
      if (hit.edge === 'body') seek(S.xToTime(p.x, view));
    } else if (hit && hit.lane === 'main') {
      const c = clips.find((x) => x.id === hit.id);
      if (sel !== hit.id) { sel = hit.id; renderInspector(); ST.showTab('clip'); }
      if (hit.edge !== 'body') {
        pushReviewUndo('trim');
        syncSrc();
        drag = { kind: 'trim', id: hit.id, edge: hit.edge, x0: p.x, in0: c.in, out0: c.out, len: media[c.m] ? media[c.m].dur : Infinity };
      } else {
        drag = { kind: 'move', id: hit.id, x0: p.x, moved: false, dropT: 0 };
        seek(S.xToTime(p.x, view));
      }
    } else if (hit && hit.lane === 'cap') {
      if (hit.edge !== 'body') { pushReviewUndo('timing'); drag = { kind: 'cap', i: hit.i, edge: hit.edge }; }
      else { seek(reviewCues[hit.i].start + 0.01); if (typeof focusReviewCue === 'function') focusReviewCue(hit.i, 0); }
    } else {
      sel = null; renderInspector();
      drag = { kind: 'seek' };
      seek(S.xToTime(p.x, view));
    }
    frame(); drawSoon();
  });
  document.addEventListener('mousemove', (e) => {
    if (!review.classList.contains('show')) return;
    const p = xy(e);
    if (drag) {
      if (drag.kind === 'seek') { seek(S.xToTime(p.x, view)); return; }
      if (drag.kind === 'cap') { setTimingEdge(drag.i, drag.edge, S.xToTime(p.x, view)); drawSoon(); return; }
      if (drag.kind === 'ov') {
        const d = (p.x - drag.x0) / view.pps;
        if (drag.edge === 'body') {
          // snaps to the playhead and the main clips' edges (8 px)
          let st = drag.start0 + d;
          const snaps = [0, time()].concat(L().map((c) => c.s), L().map((c) => c.e));
          const near = snaps.find((x) => Math.abs((x - st) * view.pps) < 8);
          if (near != null) st = near;
          ovl = E.ovMove(ovl, drag.id, st);
        } else ovl = E.ovTrim(ovl, drag.id, drag.edge, (drag.edge === 'in' ? drag.start0 : drag.end0) + d, drag.len);
        frame(); drawSoon(); return;
      }
      if (drag.kind === 'trim') {
        const d = (p.x - drag.x0) / view.pps;
        clips = E.trimClip(clips, drag.id, drag.edge, drag.edge === 'in' ? drag.in0 + d : drag.out0 + d, drag.len);
        reviewCues = E.deriveCaptions(clips, SRC);
        const c = L().find((x) => x.id === drag.id);
        if (c) { ET = drag.edge === 'in' ? c.s : Math.max(c.s, c.e - 0.04); seek(ET); }
        drawSoon(); return;
      }
      if (drag.kind === 'move') {
        if (Math.abs(p.x - drag.x0) > 4) drag.moved = true;
        if (drag.moved) {
          const t = S.xToTime(p.x, view);
          const idx = E.dropIndex(clips, drag.id, t);
          const rest = E.layout(clips.filter((c) => c.id !== drag.id));
          drag.idx = idx;
          drag.dropT = idx < rest.length ? rest[idx].s : E.total(clips.filter((c) => c.id !== drag.id));
          drawSoon();
        }
        return;
      }
    }
    if (e.target === canvas) {
      const hit = hitAt(p);
      canvas.style.cursor = hit && hit.edge && hit.edge !== 'body' ? 'ew-resize' : (hit && (hit.lane === 'main' || hit.lane === 'ov') ? 'grab' : (hit ? 'pointer' : 'text'));
      if (JSON.stringify(hit) !== JSON.stringify(hover)) { hover = hit; drawSoon(); }
    }
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'trim') { derive(); after(); }
    else if (d.kind === 'ov') { after(); }
    else if (d.kind === 'cap') { renderReview(); ST.saveSoon(); }
    else if (d.kind === 'move' && d.moved && d.idx != null) {
      const from = clips.findIndex((c) => c.id === d.id);
      if (d.idx !== from) change('move', () => { clips = E.moveClip(clips, d.id, d.idx); });
    }
    drawSoon();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = xy(e);
    if (e.ctrlKey || e.metaKey) view = S.zoomAt(view, e.deltaY < 0 ? 1.25 : 0.8, p.x, total(), width());
    else view = S.clampView({ start: view.start + (e.deltaX || e.deltaY) / view.pps, pps: view.pps }, total(), width());
    drawSoon();
  }, { passive: false });

  function splitHere() {
    const t = time();
    const loc = E.locate(clips, t);
    if (!loc || t <= loc.clip.s + E.MIN / 2 || t >= loc.clip.e - E.MIN / 2) return;
    change('split', () => { clips = E.splitAt(clips, t, newId()); });
    sel = clips[loc.i + 1] ? clips[loc.i + 1].id : sel;
    after();
  }
  function deleteSel() {
    if (sel && ovl.some((o) => o.id === sel)) {
      const oid = sel;
      change('delete overlay', () => { ovl = ovl.filter((o) => o.id !== oid); });
      sel = null; after(); return;
    }
    if (!sel) { hint.textContent = tx('መጀመሪያ ክሊፕ ይምረጡ', 'Select a clip first'); setTimeout(() => { hint.textContent = ''; }, 2000); return; }
    if (clips.length <= 1) { hint.textContent = tx('የመጨረሻው ክሊፕ ሊሰረዝ አይችልም', 'The last clip cannot be removed'); setTimeout(() => { hint.textContent = ''; }, 2500); return; }
    const id = sel;
    change('delete', () => { clips = E.removeClip(clips, id); });
    sel = null;
    seek(Math.min(time(), total()));
  }
  // ✂ Clean up "cut them": ranges of the edit out of the main track, one step
  function cutRanges(ranges) {
    const list = (ranges || []).slice().sort((a, b) => b.start - a.start);   // last first: earlier times stay valid
    if (!list.length) return;
    change('clean up', () => { list.forEach((r) => { clips = E.cutRange(clips, r.start, r.end, newId); }); });
    seek(Math.min(time(), total()));
  }

  // ── keys ───────────────────────────────────────────────────────────────
  const typing = (x) => !!x && (/^(TEXTAREA|INPUT|SELECT)$/.test(x.tagName) || x.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (!review.classList.contains('show') || !built) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || '');
    if (mod && !e.altKey && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) {
      if (typing(document.activeElement)) return;
      e.preventDefault(); redo(); return;
    }
    if (typing(document.activeElement) || mod || e.altKey) return;
    let used = true;
    if (k === ' ' || k === 'k' || k === 'K') toggle();
    else if (k === 's' || k === 'S') splitHere();
    else if (k === 'Delete' || k === 'Backspace') deleteSel();
    else if (k === 'j' || k === 'J') seek(time() - (e.shiftKey ? 5 : 1));
    else if (k === 'l' || k === 'L') seek(time() + (e.shiftKey ? 5 : 1));
    else if (k === 'ArrowLeft') seek(time() - (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'ArrowRight') seek(time() + (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(total());
    else used = false;
    if (used) e.preventDefault();
  });

  // ── 📁 Media (left) ─────────────────────────────────────────────────────
  const mediaPane = el('div', 'ed-media');
  const list = $('reviewList');
  if (list) list.after(mediaPane);
  const sw = document.querySelector('.st-viewsw');
  const bMedia = btn('', '', '', () => setLeft(true));
  if (sw) sw.insertBefore(bMedia, sw.firstChild);
  function setLeft(m) {
    review.classList.toggle('ed-mediamode', !!m);
    bMedia.classList.toggle('on', !!m);
    if (sw) sw.querySelectorAll('button').forEach((b) => { if (b !== bMedia && m) b.classList.remove('on'); });
    if (m) renderMedia();
  }
  if (sw) sw.addEventListener('click', (e) => { if (e.target !== bMedia && e.target.closest && e.target.closest('button')) setLeft(false); });
  async function importMedia() {
    let p = null;
    try { p = APP.call('dialog', ['open', tx('ቪዲዮ ወይም ድምፅ ይምረጡ', 'Choose a video or sound')]); } catch (e) {}
    if (p) await addAndPlace(p);
  }
  // above the main video, from the playhead: B-roll up to 5 s (silent), a photo 5 s
  function addOverlay(id) {
    const m = media[id];
    const at = Math.min(time(), Math.max(0, total() - 0.5));
    const len = m.image ? 5 : Math.min(5, m.dur);
    const oid = newId();
    change('add overlay', () => { ovl = ovl.concat([{ id: oid, m: id, in: 0, out: Math.round(len * 1000) / 1000, start: Math.round(at * 1000) / 1000, volume: 0 }]); });
    sel = oid; after(); ST.showTab('clip');
  }
  async function addAndPlace(p) {
    const id = await addMedia(p);
    if (!id) return;
    const m = media[id];
    if (m.image) { addOverlay(id); renderMedia(); return; }
    change('add clip', () => { clips = clips.concat([{ id: newId(), m: id, in: 0, out: Math.round(m.dur * 1000) / 1000 }]); });
    view = S.fitView(total(), width());
    renderMedia();
  }
  function renderMedia() {
    mediaPane.textContent = '';
    const head = el('div', 'ed-mhead');
    head.appendChild(btn('st-btn primary', '＋ ' + tx('ሚዲያ ያስገቡ', 'Import media'), '', importMedia));
    head.appendChild(el('span', 'st-note', tx('ወይም ቪዲዮ ወደ መስኮቱ ይጎትቱ', 'or drop videos onto the window')));
    mediaPane.appendChild(head);
    const grid = el('div', 'ed-mgrid');
    Object.keys(media).forEach((id) => {
      const m = media[id];
      const it = el('div', 'ed-mitem');
      const th = el('div', 'ed-mthumb', m.image ? '' : (m.video ? '🎬' : '♪'));
      if (m.image) { const im = el('img'); im.src = urlOf(id); th.appendChild(im); }
      th.appendChild(el('b', '', m.image ? '🖼' : S.fmtClock(m.dur)));
      it.appendChild(th);
      it.appendChild(el('div', 'ed-mname', m.name));
      const used = clips.filter((c) => c.m === id).length + ovl.filter((o) => o.m === id).length;
      const caps = (SRC[id] || []).length;
      it.appendChild(el('div', 'ed-mmeta', (caps ? '✓ ' + tx('ካፕሽን አለው', 'captions') : tx('ካፕሽን የለውም', 'no captions')) + (used ? ' · ' + used + '× ' + tx('በጊዜ መስመሩ', 'on timeline') : '')));
      const row = el('div', 'ed-madd');
      if (!m.image) row.appendChild(btn('st-btn', '＋ ' + tx('ዋና', 'Main'), tx('በዋናው መስመር መጨረሻ', 'At the end of the main track'), () => change('add clip', () => {
        clips = clips.concat([{ id: newId(), m: id, in: 0, out: Math.round(m.dur * 1000) / 1000 }]);
      })));
      if (m.video) row.appendChild(btn('st-btn', '＋ ' + tx('ተደራቢ', 'Overlay'), tx('ከዋናው ቪዲዮ በላይ፣ ማጫወቻው ባለበት', 'Above the main video, at the playhead'), () => addOverlay(id)));
      it.appendChild(row);
      grid.appendChild(it);
    });
    mediaPane.appendChild(grid);
  }
  // a video dropped while editing joins the project (never replaces it)
  const origDropped = window.__amhDropped;
  window.__amhDropped = (paths) => {
    if (typeof reviewOpen !== 'undefined' && reviewOpen && built) {
      (paths || []).reduce((pr, p) => pr.then(() => addAndPlace(p)), Promise.resolve());
      return;
    }
    if (origDropped) origDropped(paths);
  };

  // ── ⚙ Clip (right) ──────────────────────────────────────────────────────
  const clipPane = el('div', 'ed-clip');
  ST.addTab('clip', () => '⚙ ' + tx('ክሊፕ', 'Clip'), clipPane);
  function renderInspector() {
    clipPane.textContent = '';
    const ov = ovl.find((x) => x.id === sel);
    if (ov) { renderOverlayInspector(ov); return; }
    const c = clips.find((x) => x.id === sel);
    if (!c) { clipPane.appendChild(el('div', 'st-note', tx('በጊዜ መስመሩ ላይ ክሊፕ ይምረጡ — ከዚያ መጠኑን፣ ቦታውንና ድምፁን እዚህ ያስተካክሉ።', 'Select a clip on the timeline — then set its size, position and volume here.'))); return; }
    const lc = L().find((x) => x.id === c.id);
    clipPane.appendChild(el('div', 'ed-cname', (media[c.m] ? media[c.m].name : '') + ' · ' + S.fmtClock(lc ? lc.e - lc.s : 0, true)));
    const slider = (label, key, min, max, step, dflt, show) => {
      const row = el('div', 'ed-row');
      row.appendChild(el('span', 'ed-lab', label));
      const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step;
      r.value = c[key] == null ? dflt : c[key];
      const val = el('span', 'ed-val', show(Number(r.value)));
      let started = false;
      r.addEventListener('input', () => {
        if (!started) { pushReviewUndo('clip'); started = true; }
        const v = Number(r.value);
        clips = clips.map((x) => (x.id === c.id ? Object.assign({}, x, { [key]: v }) : x));
        val.textContent = show(v);
        frame();
      });
      r.addEventListener('change', () => { started = false; ST.saveSoon(); drawSoon(); });
      row.appendChild(r); row.appendChild(val);
      clipPane.appendChild(row);
    };
    clipPane.appendChild(el('div', 'ed-sec', tx('ቦታና መጠን', 'Size and position')));
    slider(tx('መጠን', 'Size'), 'scale', 0.5, 3, 0.01, 1, (v) => Math.round(v * 100) + '%');
    slider('X', 'x', -0.5, 0.5, 0.005, 0, (v) => Math.round(v * 100));
    slider('Y', 'y', -0.5, 0.5, 0.005, 0, (v) => Math.round(v * 100));
    clipPane.appendChild(el('div', 'ed-sec', tx('ድምፅ', 'Sound')));
    slider(tx('ድምፅ', 'Volume'), 'volume', 0, 2, 0.01, 1, (v) => Math.round(v * 100) + '%');
    const row = el('div', 'st-row');
    row.appendChild(btn('st-btn', tx('ወደ መጀመሪያው መልስ', 'Reset'), '', () => change('clip', () => {
      clips = clips.map((x) => (x.id === c.id ? Object.assign({}, x, { scale: 1, x: 0, y: 0, volume: 1 }) : x));
    })));
    row.appendChild(btn('st-btn', '✂ ' + tx('ቁረጥ (S)', 'Split (S)'), '', splitHere));
    row.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(row);
  }

  function renderOverlayInspector(o) {
    const m = media[o.m] || {};
    clipPane.appendChild(el('div', 'ed-cname', (m.image ? '🖼 ' : '🎞 ') + (m.name || '') + ' · ' + S.fmtClock(E.ovLen(o), true)));
    const slider = (label, key, min, max, step, dflt, show) => {
      const row = el('div', 'ed-row');
      row.appendChild(el('span', 'ed-lab', label));
      const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step;
      r.value = o[key] == null ? dflt : o[key];
      const val = el('span', 'ed-val', show(Number(r.value)));
      let started = false;
      r.addEventListener('input', () => {
        if (!started) { pushReviewUndo('overlay'); started = true; }
        const v = Number(r.value);
        ovl = ovl.map((x) => (x.id === o.id ? Object.assign({}, x, { [key]: v }) : x));
        val.textContent = show(v);
        frame();
      });
      r.addEventListener('change', () => { started = false; ST.saveSoon(); drawSoon(); });
      row.appendChild(r); row.appendChild(val);
      clipPane.appendChild(row);
    };
    clipPane.appendChild(el('div', 'ed-sec', tx('ቦታና መጠን', 'Size and position')));
    slider(tx('መጠን', 'Size'), 'scale', 0.05, 3, 0.01, 1, (v) => Math.round(v * 100) + '%');
    slider('X', 'x', -0.6, 0.6, 0.005, 0, (v) => Math.round(v * 100));
    slider('Y', 'y', -0.6, 0.6, 0.005, 0, (v) => Math.round(v * 100));
    slider(tx('ግልጽነት', 'Opacity'), 'opacity', 0, 1, 0.01, 1, (v) => Math.round(v * 100) + '%');
    const fitRow = el('div', 'st-seg ed-fit');
    [['cover', tx('ሙላ', 'Fill')], ['contain', tx('ሙሉውን አሳይ', 'Whole')]].forEach(([f, t]) => {
      const cur2 = o.fit || (m.image ? 'contain' : 'cover');
      fitRow.appendChild(btn(cur2 === f ? 'on' : '', t, '', () => change('overlay', () => { ovl = ovl.map((x) => (x.id === o.id ? Object.assign({}, x, { fit: f }) : x)); })));
    });
    clipPane.appendChild(fitRow);
    if (!m.image && m.audio) {
      clipPane.appendChild(el('div', 'ed-sec', tx('ድምፅ', 'Sound')));
      slider(tx('ድምፅ', 'Volume'), 'volume', 0, 2, 0.01, 0, (v) => (v ? Math.round(v * 100) + '%' : tx('ድምፅ የለም', 'muted')));
    }
    const row = el('div', 'st-row');
    row.appendChild(btn('st-btn', tx('ወደ መጀመሪያው መልስ', 'Reset'), '', () => change('overlay', () => {
      ovl = ovl.map((x) => (x.id === o.id ? Object.assign({}, x, { scale: 1, x: 0, y: 0, opacity: 1 }) : x));
    })));
    row.appendChild(btn('st-btn', '⤓ ' + tx('ወደ ማጫወቻው', 'To playhead'), tx('እዚህ እንዲጀምር', 'Start it here'), () => change('move overlay', () => { ovl = E.ovMove(ovl, o.id, time()); })));
    row.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(row);
  }

  // ── export: the whole edit, then the captions drawn in ─────────────────
  function render(out, onProgress, fast) {
    return new Promise((resolve, reject) => {
      const used = [];
      clips.concat(ovl).forEach((c) => { if (media[c.m] && used.indexOf(c.m) < 0) used.push(c.m); });
      const info = {};
      used.forEach((id, i) => { info[id] = Object.assign({ idx: i }, media[id]); });
      const g = E.editGraph(clips, info, fmt, 30, ovl);
      const args = ['-v', 'error', '-y'];
      used.forEach((id) => { if (media[id].image) args.push('-loop', '1', '-framerate', '30'); args.push('-i', media[id].path); });
      if (g.graph.length > 6000) {
        const f = path.join(os.tmpdir(), 'amh_edit_' + Date.now() + '.txt');
        fs.writeFileSync(f, g.graph, { encoding: 'utf8' });
        args.push('-/filter_complex', f);
      } else args.push('-filter_complex', g.graph);
      args.push('-map', '[v]', '-map', '[a]', '-t', String(g.duration), '-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'medium', '-crf', fast ? '16' : '18',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
      const p = spawn(FFMPEG, args);
      let err = '';
      p.stdout.on('data', (d) => {
        const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
        if (m && onProgress) onProgress(Math.min(1, Number(m[m.length - 1].split('=')[1]) / 1e6 / Math.max(0.1, g.duration)));
      });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('close', (code) => {
        if (code === 0 && fs.existsSync(out)) { if (onProgress) onProgress(1); resolve(out); }
        else reject(new Error(err.trim().split('\n').pop() || ('ffmpeg ' + code)));
      });
    });
  }
  async function exportVideo(onProgress, styled) {
    const X = window.__amhAppExport;
    const c = window.__amhAppChosen && window.__amhAppChosen();
    const dir = c ? path.dirname(c.path) : os.tmpdir();
    if (!styled) {
      const out = X.uniquePath(dir, X.baseName() + ' (' + fmt.replace(':', 'x') + ')', '.mp4');
      await render(out, onProgress, false);
      return { file: out };
    }
    const tmp = path.join(os.tmpdir(), 'amh_edit_' + Date.now() + '.mp4');
    try {
      await render(tmp, (x) => onProgress(x * 0.5), true);
      return await X.video((x) => onProgress(0.5 + x * 0.5), dir, { cues: reviewCues, video: tmp, suffix: ' (' + fmt.replace(':', 'x') + ')' });
    } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
  }

  // ── labels ─────────────────────────────────────────────────────────────
  function relabel() {
    bMedia.textContent = '📁 ' + tx('ሚዲያ', 'Media');
    bSplit.textContent = '✂ ' + tx('ቁረጥ', 'Split');
    bSplit.title = tx('በማጫወቻው ቦታ ቁረጥ (S)', 'Split at the playhead (S)');
    bDel.textContent = '🗑 ' + tx('ሰርዝ', 'Delete');
    bDel.title = tx('የተመረጠውን ክሊፕ ሰርዝ (Delete)', 'Remove the selected clip (Delete)');
    bUndo.title = tx('መልስ (Ctrl+Z)', 'Undo (Ctrl+Z)');
    bRedo.title = tx('እንደገና (Ctrl+Shift+Z)', 'Redo (Ctrl+Shift+Z)');
    bPlay.title = tx('አጫውት / አቁም (Space)', 'Play / pause (Space)');
    labels.innerHTML = '';
    labels.appendChild(el('div', 'ed-lh', ''));
    labels.appendChild(el('div', 'ed-lcap', '💬 ' + tx('ካፕሽን', 'Captions')));
    labels.appendChild(el('div', 'ed-lov', '🎞 ' + tx('ተደራቢ', 'Overlay')));
    labels.appendChild(el('div', 'ed-lmain', '🎬 ' + tx('ዋና', 'Main')));
    renderInspector();
    if (review.classList.contains('ed-mediamode')) renderMedia();
  }
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(relabel, 0));

  // ── open / save ────────────────────────────────────────────────────────
  // a fresh review: the transcribed video is the first clip, whole
  let opening = null;
  async function open() {
    if (built) { frame(); drawSoon(); return; }
    const c = window.__amhAppChosen && window.__amhAppChosen();
    if (!c) return;
    const token = {};
    opening = token;
    if (!Object.keys(media).length) await addMedia(c.path, { id: 'm1' });
    if (opening !== token || built) return;
    const id = primary();
    if (!id) return;
    SRC = { [id]: (reviewCues || []).map((q) => Object.assign({}, q)) };
    clips = [{ id: newId(), m: id, in: 0, out: Math.round(media[id].dur * 1000) / 1000 }];
    built = true; fitted = false; cur = 0; ET = 0; sel = null;
    reviewCues = E.deriveCaptions(clips, SRC);
    renderReview();
    await seek(0);
    after(); renderMedia(); syncUndo();
  }
  function saveState() {
    if (!built) return null;
    syncSrc();
    return { v: 1, fmt, clips, ovl, media, S: SRC };
  }
  function loadState(ed, cues) {
    opening = null;
    if (ed && Array.isArray(ed.clips) && ed.clips.length && ed.media) {
      media = ed.media; clips = ed.clips; ovl = ed.ovl || []; fmt = ed.fmt || '16:9'; SRC = ed.S || {};
      Object.keys(media).forEach(loadPeaks);
      built = true; fitted = false; cur = 0; ET = 0; sel = null;
      reviewCues = E.deriveCaptions(clips, SRC);
      renderReview();
      seek(0); after(); renderMedia(); syncUndo();
    } else {
      built = false; media = {}; clips = []; ovl = []; SRC = {};
      void cues;
      open();
    }
  }
  function reset() {
    pause();
    built = false; media = {}; clips = []; ovl = []; SRC = {}; sel = null; fitted = false; REDO.length = 0; opening = null;
    Object.keys(OVEL).forEach((id) => { OVEL[id].remove(); delete OVEL[id]; });
    const v = V(); if (v) delete v.dataset.m;
    setLeft(false);
  }
  new MutationObserver(() => { if (!review.classList.contains('show')) reset(); }).observe(review, { attributes: true, attributeFilter: ['class'] });
  const shown = () => { const c = window.__amhAppChosen && window.__amhAppChosen(); if (c && !Object.keys(media).length) addMedia(c.path, { id: 'm1' }).then(() => { const v = V(); if (v) v.dataset.m = 'm1'; frame(); }); };

  relabel();
  ST.attachEditor({ draw, drawSoon, seek, duration: total, peaks: editPeaks, open, shown, saveState, loadState, exportVideo, format: () => fmt });
  window.__amhEditor = { state: () => ({ clips, ovl, media, SRC, fmt, sel, built }), addOverlay, seek, play, pause, time, splitHere, deleteSel, cutRanges, redo,
    select: (id) => { sel = id; renderInspector(); frame(); drawSoon(); }, addMedia: addAndPlace, render, exportVideo, frame, setFormat: (f) => change('format', () => { fmt = f; }) };
})();
