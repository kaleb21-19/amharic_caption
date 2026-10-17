/*
 * studio.js — Amharic Captions Studio (1.17.0), the desktop app's workspace.
 * Loaded after app_mode.js (app only). On a wide window the review becomes a
 * studio: the video big on the left with a timeline under it (the sound wave
 * of the whole video, the captions as blocks you drag to retime, a playhead),
 * the captions / style / save on the right. Space · J K L · ← → drive the
 * video. Every video is a project: autosaved, and "Recent projects" on the
 * home screen reopens one without transcribing again. A narrow window keeps
 * the panel layout. Pure parts: studio_core.js (window.AmhStudio).
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  const S = window.AmhStudio;
  if (!APP || !S) return;
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  document.documentElement.classList.add('amh-studio');

  // ── name ────────────────────────────────────────────────────────────────
  function brand() {
    document.querySelectorAll('[data-i18n="app.title"]').forEach((el) => { el.textContent = 'Amharic Captions Studio'; });
    try { document.title = 'Amharic Captions Studio'; } catch (e) {}
  }
  brand();
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(() => { brand(); renderRecent(); drawSoon(); }, 0));

  // ── the timeline ────────────────────────────────────────────────────────
  const review = $('review');
  const tl = document.createElement('div');
  tl.id = 'studioTimeline';
  tl.className = 'studio-tl';
  tl.innerHTML =
    '<div class="tl-bar">' +
      '<span class="tl-time" id="tlTime">0:00</span>' +
      '<span class="tl-hint" id="tlHint"></span>' +
      '<button type="button" class="tl-btn" id="tlOut" title="Zoom out">−</button>' +
      '<button type="button" class="tl-btn" id="tlIn" title="Zoom in">+</button>' +
      '<button type="button" class="tl-btn" id="tlFit" title="Whole video">⤢</button>' +
    '</div>' +
    '<div class="tl-canvas-wrap" id="tlWrap"><canvas id="tlCanvas"></canvas></div>';
  const preview = $('appPreview');
  if (preview && preview.parentNode) preview.after(tl);
  else if (review) review.appendChild(tl);
  const canvas = tl.querySelector('canvas');
  const wrap = tl.querySelector('#tlWrap');
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  const video = () => $('appVideo');

  let view = { start: 0, pps: 50 };
  let fitted = false;
  let peaks = null;             // loudness 0-100, PEAKS_PER_SEC a second
  const PEAKS_PER_SEC = 50;
  let peaksFor = '';
  let drag = null;              // { kind: 'seek' | 'edge', i, edge }
  let hover = null;
  const RULER = 18, LANE = 34;

  const dur = () => {
    const v = video();
    const d = v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const last = (typeof reviewCues !== 'undefined' && reviewCues.length) ? reviewCues[reviewCues.length - 1].end : 0;
    return Math.max(d, last + 1, 1);
  };
  const width = () => Math.max(50, wrap.clientWidth || 600);
  const now = () => { const v = video(); return v ? v.currentTime || 0 : 0; };

  function loadPeaks(file) {
    if (!file || peaksFor === file || typeof FFMPEG === 'undefined' || !FFMPEG) return;
    peaksFor = file;
    peaks = null;
    const raw = path.join(os.tmpdir(), 'amh_peaks_' + Date.now() + '.raw');
    const hint = $('tlHint');
    if (hint) hint.textContent = tx('የድምፅ ሞገዱ እየተዘጋጀ ነው…', 'Drawing the sound wave…');
    execFile(FFMPEG, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', raw],
      { timeout: 30 * 60 * 1000 }, (err) => {
        if (hint) hint.textContent = '';
        if (err || peaksFor !== file) return;
        try { peaks = APP.call('peaks', [raw, 2000, PEAKS_PER_SEC]); } catch (e) { peaks = null; }
        drawSoon();
      });
  }

  let pending = 0;
  function drawSoon() { if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); }); }
  function draw() {
    if (!ctx || !review || !review.classList.contains('show')) return;
    const w = width(), h = wrap.clientHeight || 110, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    const d = dur();
    if (!fitted) { view = S.fitView(d, w); fitted = true; }
    view = S.clampView(view, d, w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#121816'; ctx.fillRect(0, 0, w, h);
    // ruler
    ctx.fillStyle = '#18201d'; ctx.fillRect(0, 0, w, RULER);
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    S.ticks(view, w).forEach((k) => {
      ctx.fillStyle = '#33423c'; ctx.fillRect(Math.round(k.x), RULER - 5, 1, 5);
      ctx.fillStyle = '#8fa39b'; ctx.fillText(k.label, k.x + 3, RULER / 2);
    });
    // the sound wave
    const waveTop = RULER + 2, waveH = h - RULER - LANE - 6, mid = waveTop + waveH / 2;
    ctx.fillStyle = '#2f4a40';
    if (peaks && peaks.length) {
      for (let x = 0; x < w; x++) {
        const a = Math.floor(S.xToTime(x, view) * PEAKS_PER_SEC), b = Math.max(a + 1, Math.floor(S.xToTime(x + 1, view) * PEAKS_PER_SEC));
        let m = 0;
        for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
        const hh = Math.max(1, m / 100 * (waveH / 2));
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    } else { ctx.fillRect(0, mid, w, 1); }
    // the captions
    const laneTop = h - LANE - 2;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const t = now();
    ctx.font = '600 12px ' + getComputedStyle(document.documentElement).getPropertyValue('--review-font').trim() + ', "Abyssinica SIL", serif';
    cues.forEach((c, i) => {
      const x0 = S.timeToX(c.start, view), x1 = S.timeToX(c.end, view);
      if (x1 < 0 || x0 > w) return;
      const on = t >= c.start && t < c.end;
      const sel = drag && drag.i === i;
      ctx.fillStyle = sel ? '#2ecc71' : (on ? '#1f7a4c' : '#24453a');
      ctx.fillRect(x0 + 0.5, laneTop, Math.max(2, x1 - x0 - 1), LANE);
      ctx.fillStyle = (hover && hover.i === i && hover.edge !== 'body') ? '#ffffff' : '#3ddc84';
      ctx.fillRect(x0, laneTop, 2, LANE); ctx.fillRect(x1 - 2, laneTop, 2, LANE);
      if (x1 - x0 > 18) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 4, laneTop, x1 - x0 - 8, LANE); ctx.clip();
        ctx.fillStyle = sel ? '#06110c' : '#e8f5ee';
        ctx.fillText(String(c.text || '').replace(/[*~]/g, ''), x0 + 5, laneTop + LANE / 2);
        ctx.restore();
      }
    });
    // playhead
    const px = S.timeToX(t, view);
    ctx.fillStyle = '#ff5c5c'; ctx.fillRect(Math.round(px) - 1, 0, 2, h);
    const tm = $('tlTime'); if (tm) tm.textContent = S.fmtClock(t, true) + ' / ' + S.fmtClock(dur());
  }

  // ── mouse ───────────────────────────────────────────────────────────────
  function xy(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function laneHit(p) {
    const h = wrap.clientHeight || 110;
    if (p.y < h - LANE - 4) return null;
    return S.hitCaption(typeof reviewCues !== 'undefined' ? reviewCues : [], view, p.x, 6);
  }
  function seek(t) {
    const v = video();
    t = Math.max(0, Math.min(dur(), t));
    if (v && v.getAttribute('src')) { try { v.currentTime = t; } catch (e) {} }
    drawSoon();
  }
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = xy(e);
    const hit = laneHit(p);
    if (hit && hit.edge !== 'body') {
      pushReviewUndo('timing');
      drag = { kind: 'edge', i: hit.i, edge: hit.edge };
    } else if (hit) {
      drag = { kind: 'select', i: hit.i };
      seek(reviewCues[hit.i].start + 0.01);
      if (typeof focusReviewCue === 'function') focusReviewCue(hit.i, 0);
    } else {
      drag = { kind: 'seek' };
      seek(S.xToTime(p.x, view));
    }
    drawSoon();
  });
  document.addEventListener('mousemove', (e) => {
    if (!review || !review.classList.contains('show')) return;
    const p = xy(e);
    if (drag && drag.kind === 'edge') {
      setTimingEdge(drag.i, drag.edge, S.xToTime(p.x, view));
      seek(drag.edge === 'start' ? reviewCues[drag.i].start + 0.01 : reviewCues[drag.i].end - 0.05);
      return;
    }
    if (drag && drag.kind === 'seek') { seek(S.xToTime(p.x, view)); return; }
    if (e.target === canvas) {
      const hit = laneHit(p);
      canvas.style.cursor = hit && hit.edge !== 'body' ? 'ew-resize' : (hit ? 'pointer' : 'text');
      if (JSON.stringify(hit) !== JSON.stringify(hover)) { hover = hit; drawSoon(); }
    }
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (was.kind === 'edge') {
      if (typeof renderReview === 'function') renderReview();
      if (typeof schedulePreview === 'function') schedulePreview();
      saveSoon();
    }
    drawSoon();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = xy(e);
    if (e.ctrlKey || e.metaKey) view = S.zoomAt(view, e.deltaY < 0 ? 1.25 : 0.8, p.x, dur(), width());
    else view = S.clampView({ start: view.start + (e.deltaX || e.deltaY) / view.pps, pps: view.pps }, dur(), width());
    drawSoon();
  }, { passive: false });
  const zoomBtn = (id, f) => { const b = tl.querySelector('#' + id); if (b) b.addEventListener('click', () => { view = f ? S.zoomAt(view, f, S.timeToX(now(), view), dur(), width()) : S.fitView(dur(), width()); drawSoon(); }); };
  zoomBtn('tlIn', 1.6); zoomBtn('tlOut', 0.625); zoomBtn('tlFit', 0);

  // follow the video
  let raf = 0;
  const tick = () => {
    const v = video();
    if (v && !v.paused) { view = S.follow(view, v.currentTime, dur(), width()); draw(); raf = requestAnimationFrame(tick); } else { raf = 0; draw(); }
  };
  function hookVideo() {
    const v = video();
    if (!v || v.__studio) return;
    v.__studio = true;
    v.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
    ['seeked', 'pause', 'loadedmetadata', 'timeupdate'].forEach((ev) => v.addEventListener(ev, drawSoon));
  }
  hookVideo();
  window.addEventListener('resize', drawSoon);

  // ── keyboard (never while typing in a caption or a field) ─────────────
  const typing = (el) => !!el && (/^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName) || el.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (!review || !review.classList.contains('show') || typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    const v = video();
    if (!v || !v.getAttribute('src')) return;
    const k = e.key;
    let used = true;
    if (k === ' ' || k === 'k' || k === 'K') { if (v.paused) v.play().catch(() => {}); else v.pause(); }
    else if (k === 'j' || k === 'J') seek(v.currentTime - (e.shiftKey ? 5 : 1));
    else if (k === 'l' || k === 'L') seek(v.currentTime + (e.shiftKey ? 5 : 1));
    else if (k === 'ArrowLeft') seek(v.currentTime - (e.shiftKey ? 1 : 1 / 25));
    else if (k === 'ArrowRight') seek(v.currentTime + (e.shiftKey ? 1 : 1 / 25));
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(dur());
    else used = false;
    if (used) e.preventDefault();
  });

  // ── projects ────────────────────────────────────────────────────────────
  const projDir = () => path.join(typeof USER_CAPTIONS_DIR !== 'undefined' ? USER_CAPTIONS_DIR : path.join(os.homedir(), 'Documents', 'AmharicCaptions'), 'Studio');
  const chosenVideo = () => (window.__amhAppChosen && window.__amhAppChosen()) || null;
  let lastSaved = '';
  function currentProject() {
    const c = chosenVideo();
    if (!c || typeof reviewCues === 'undefined' || !reviewCues.length) return null;
    return S.makeProject({ video: c.path, name: c.name, duration: dur(), style: typeof STYLE !== 'undefined' ? STYLE : 'plain',
      styleOpts: typeof styleOpts === 'function' && typeof STYLE !== 'undefined' ? styleOpts(STYLE) : null, cues: reviewCues });
  }
  function saveProject() {
    if (!review || !review.classList.contains('show') || (typeof REVIEW_LIVE !== 'undefined' && REVIEW_LIVE)) return false;
    const p = currentProject();
    if (!p) return false;
    const sig = JSON.stringify([p.cues, p.style, p.styleOpts]);
    if (sig === lastSaved) return false;
    try {
      if (!fs.existsSync(projDir())) fs.mkdirSync(projDir(), { recursive: true });
      fs.writeFileSync(path.join(projDir(), S.projectFileName(p.video)), JSON.stringify(p), { encoding: 'utf8' });
      lastSaved = sig;
      return true;
    } catch (e) { return false; }
  }
  let saveTimer = 0;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 800); }
  setInterval(saveProject, 5000);
  if (review) {
    review.addEventListener('input', saveSoon);
    review.addEventListener('click', saveSoon);
  }
  function listProjects() {
    let names = [];
    try { names = fs.readdirSync(projDir()).filter((n) => /\.amhproj$/.test(n)); } catch (e) { return []; }
    return S.recentProjects(names.map((n) => {
      let p = null;
      try { p = S.parseProject(fs.readFileSync(path.join(projDir(), n), 'utf8')); } catch (e) {}
      if (p) p.file = path.join(projDir(), n);
      return p;
    }), 8);
  }
  async function openProject(p) {
    if (!p) return false;
    if (!fs.existsSync(p.video)) {
      log(tx('ቪዲዮው አልተገኘም፦ ', 'The video was not found: ') + p.video);
      renderRecent(tx('የዚህ ፕሮጀክት ቪዲዮ ተንቀሳቅሷል ወይም ተሰርዟል።', 'This project\'s video was moved or deleted.'));
      return false;
    }
    if (window.__amhAppChoose) window.__amhAppChoose(p.video);
    if (p.style && typeof STYLE_LIST !== 'undefined' && STYLE_LIST.indexOf(p.style) >= 0) {
      STYLE = p.style;
      saveSettings({ style: p.style });
    }
    const tmp = path.join(os.tmpdir(), 'amh_review_studio_' + Date.now() + '.srt');
    fs.writeFileSync(tmp, srtTextFromCues(p.cues.map((c) => ({ start: c.start, end: c.end, text: String(c.text).replace(/[*~]/g, '') }))), { encoding: 'utf8' });
    await openReview(tmp, p.name || 'captions', 0, { projectId: p.name });
    reviewCues = p.cues.map((c, i) => Object.assign({ _id: 'p' + i }, c));
    lastSaved = JSON.stringify([currentProject() && currentProject().cues, p.style, p.styleOpts]);
    if (typeof renderReview === 'function') renderReview();
    if (typeof renderStyleStrip === 'function') renderStyleStrip();
    if (typeof schedulePreview === 'function') schedulePreview();
    return true;
  }

  // Recent projects on the home screen
  const recent = document.createElement('div');
  recent.id = 'studioRecent';
  recent.className = 'card studio-recent';
  const firstCard = document.querySelector('.panel-body > .card');
  if (firstCard) firstCard.before(recent);
  function renderRecent(note) {
    const list = listProjects();
    recent.style.display = list.length ? '' : 'none';
    recent.textContent = '';
    if (!list.length) return;
    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = '<span class="card-title"></span>';
    head.firstChild.textContent = '📁 ' + tx('የቅርብ ጊዜ ፕሮጀክቶች', 'Recent projects');
    recent.appendChild(head);
    if (note) { const n = document.createElement('div'); n.className = 'hint studio-note'; n.textContent = note; recent.appendChild(n); }
    const grid = document.createElement('div');
    grid.className = 'studio-grid';
    list.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'studio-proj';
      const nm = document.createElement('b'); nm.textContent = p.name || S.projectFileName(p.video);
      const meta = document.createElement('span');
      const d = new Date(p.at || 0);
      meta.textContent = p.cues.length + ' ' + tx('ካፕሽኖች', 'captions') + ' · ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      b.appendChild(nm); b.appendChild(meta);
      if (!fs.existsSync(p.video)) { b.classList.add('missing'); meta.textContent += ' · ' + tx('ቪዲዮው የለም', 'video missing'); }
      b.addEventListener('click', () => openProject(p));
      grid.appendChild(b);
    });
    recent.appendChild(grid);
  }
  renderRecent();

  // review opens / closes
  if (review && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      if (review.classList.contains('show')) {
        hookVideo();
        fitted = false;
        const c = chosenVideo();
        if (c) loadPeaks(c.path);
        setTimeout(drawSoon, 50);
      } else {
        saveProject();
        renderRecent();
      }
    }).observe(review, { attributes: true, attributeFilter: ['class'] });
  }

  window.__amhStudio = { draw, drawSoon, saveProject, listProjects, openProject, renderRecent, view: () => view, setPeaks: (p) => { peaks = p; drawSoon(); } };
})();
