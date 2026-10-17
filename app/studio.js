/*
 * studio.js — Amharic Captions Studio, the desktop app's workspace.
 * Design: docs/agent/STUDIO_DESIGN.md (one screen, no wizard; decide later,
 * never redo; act where you look; never lose work; calm by default).
 *
 *   Home      — drop a video (it starts at once) · Recent projects.
 *   Workspace — top bar (⌂ · name · ↶ · ✓ Saved · license · language · ⬆ Export)
 *               text left · video middle · tabs right (🎨 Style · Aa Captions)
 *               · timeline bottom (sound wave, caption blocks, playhead).
 *   While the words are being written the workspace is already open: the
 *   video plays, the text column shows the progress.
 * Loaded after app_mode.js (app only). Pure parts: studio_core.js.
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  const S = window.AmhStudio;
  if (!APP || !S) return;
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text, title, fn) => { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; if (fn) b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); fn(e); }); return b; };
  document.documentElement.classList.add('amh-studio');
  const review = $('review');
  if (!review) return;
  const NAME = 'Amharic Captions Studio';

  // ── top bar (workspace) ────────────────────────────────────────────────
  const top = el('div', 'st-top');
  const homeB = btn('st-ico', '⌂', '', () => goHome());
  const logo = el('div', 'st-logo', 'አ');
  const brandEl = el('span', 'st-name', NAME);
  const projEl = el('span', 'st-proj', '');
  const undoB = btn('st-ico', '↶', '', () => { if (typeof undoReview === 'function') undoReview(); });
  const savedEl = el('span', 'st-saved', '');
  const chip = btn('st-chip', '', '', () => openLicense());
  const langB = btn('st-chip', 'EN', '', () => i18nSetLang(AMH_LANG === 'am' ? 'en' : 'am'));
  const exportB = btn('st-export', '', '', () => openExport());
  [homeB, logo, brandEl, projEl, undoB, savedEl, el('span', 'st-flex'), chip, langB, exportB].forEach((x) => top.appendChild(x));
  review.insertBefore(top, review.firstChild);

  // ── text column head ──────────────────────────────────────────────────
  const thead = el('div', 'st-thead');
  const tTitle = el('span', 'st-ttl', '');
  const tCount = el('span', 'st-tcount', '');
  const doubtB = btn('st-pill warn', '', '', () => { if (typeof goFirstDoubtStudio === 'function') goFirstDoubtStudio(); });
  const memB = btn('st-ico', '🧠', '', () => { if (typeof toggleMemoryPanel === 'function') toggleMemoryPanel(); });
  const cliB = btn('st-ico', '👤', '', () => { if (typeof toggleClientPanel === 'function') toggleClientPanel(); });
  const addB = btn('st-ico', '＋', '', () => { if (typeof addReviewCue === 'function') { const j = addReviewCue(-1); focusReviewCue(j, 0); } });
  [tTitle, tCount, el('span', 'st-flex'), doubtB, memB, cliB, addB].forEach((x) => thead.appendChild(x));
  const list = $('reviewList');
  if (list) list.before(thead);
  // progress while the words are being written (mirrors the panel's bar)
  const busy = el('div', 'st-busy');
  busy.innerHTML = '<div class="st-busy-ttl"></div><div class="st-busy-bar"><i></i></div><div class="st-busy-lbl"></div>';
  const cancelB = btn('st-btn', '', '', () => { const c = $('cancelBtn'); if (c) c.click(); });
  busy.appendChild(cancelB);
  if (list) list.before(busy);

  // ── right side: tabs ───────────────────────────────────────────────────
  const side = el('div', 'st-side');
  const tabs = el('div', 'st-tabs');
  const panes = el('div', 'st-panes');
  side.appendChild(tabs); side.appendChild(panes);
  const TABS = [];
  function addTab(id, label, pane) {
    const b = btn('st-tab', '', '', () => showTab(id));
    b.dataset.tab = id;
    pane.classList.add('st-pane');
    pane.dataset.tab = id;
    tabs.appendChild(b); panes.appendChild(pane);
    TABS.push({ id, b, pane, label });
  }
  let tabNow = 'style';
  function showTab(id) {
    tabNow = id;
    TABS.forEach((t) => { t.b.classList.toggle('on', t.id === id); t.pane.style.display = t.id === id ? '' : 'none'; });
    if (id === 'style' && typeof renderStyleStrip === 'function') renderStyleStrip();
  }
  const stylePane = el('div', '');
  const strip = $('styleStrip');
  if (strip) stylePane.appendChild(strip);
  const capPane = el('div', '');
  addTab('style', () => '🎨 ' + tx('ስታይል', 'Style'), stylePane);
  addTab('captions', () => 'Aa ' + tx('ካፕሽን', 'Captions'), capPane);
  review.appendChild(side);

  // Captions tab: words per caption + line length, instantly (regroupCues)
  function renderCapPane() {
    capPane.textContent = '';
    const seg = (label, opts, cur, set) => {
      const box = el('div', 'st-field');
      box.appendChild(el('div', 'st-lab', label));
      const row = el('div', 'st-seg');
      opts.forEach(([v, t]) => {
        const b = btn(v === cur ? 'on' : '', t, '', () => { set(v); renderCapPane(); });
        row.appendChild(b);
      });
      box.appendChild(row);
      capPane.appendChild(box);
    };
    const n = CAP === 'words' ? 1 : GROUP_SIZE;
    seg(tx('ቃላት በአንድ ካፕሽን', 'Words per caption'), [[1, '1 · ' + tx('ካራኦኬ', 'Karaoke')], [2, '2'], [3, '3'], [4, '4'], [5, '5']],
      n > 5 ? -1 : n, (v) => regroup(v, FORMAT));
    seg(tx('የመስመር ርዝመት', 'Line length'), [['v', '📱 ' + tx('አጭር', 'Short')], ['h', '🖥 ' + tx('መደበኛ', 'Normal')]],
      FORMAT, (v) => regroup(CAP === 'words' ? 1 : GROUP_SIZE, v));
    capPane.appendChild(el('div', 'st-note', tx('ወዲያውኑ ይቀየራል — እንደገና መጻፍ አያስፈልግም። ያደረጓቸው ለውጦች ይቆያሉ።',
      'Changes at once — nothing is transcribed again. Your edits stay.')));
  }
  function regroup(n, fmt) {
    if (typeof reviewCues === 'undefined' || !reviewCues.length || (typeof REVIEW_LIVE !== 'undefined' && REVIEW_LIVE)) return;
    pushReviewUndo('regroup');
    CAP = n === 1 ? 'words' : 'grouped';
    if (n > 1) GROUP_SIZE = n;
    FORMAT = fmt === 'v' ? 'v' : 'h';
    MAX_CHARS = FORMAT_CHARS[FORMAT];
    saveSettings({ cap: CAP, group: GROUP_SIZE, format: FORMAT, chars: MAX_CHARS });
    reviewCues = regroupCues(reviewCues, { words: n, maxChars: MAX_CHARS });
    renderReview();
    if (typeof schedulePreview === 'function') schedulePreview();
    drawSoon();
    saveSoon();
  }

  // ── Export sheet ───────────────────────────────────────────────────────
  const sheet = el('div', 'st-sheet');
  sheet.style.display = 'none';
  review.appendChild(sheet);
  function closeSheet() { sheet.style.display = 'none'; sheet.textContent = ''; }
  function openExport() {
    if (typeof reviewOpen === 'undefined' || !reviewOpen) return;
    const X = window.__amhAppExport;
    sheet.textContent = '';
    const box = el('div', 'st-sheet-box');
    const head = el('div', 'st-sheet-head');
    head.appendChild(el('b', '', '⬆ ' + tx('ይላኩ', 'Export')));
    head.appendChild(el('span', 'st-flex'));
    head.appendChild(btn('st-ico', '✕', tx('ዝጋ', 'Close'), closeSheet));
    box.appendChild(head);
    const card = (icon, title, sub) => {
      const c = el('div', 'st-card');
      const h = el('div', 'st-card-head');
      h.appendChild(el('span', 'st-card-ico', icon));
      const t = el('div', ''); t.appendChild(el('b', '', title)); t.appendChild(el('div', 'st-sub', sub));
      h.appendChild(t);
      c.appendChild(h);
      const out = el('div', 'st-card-out');
      c.appendChild(out);
      box.appendChild(c);
      return { c, h, out };
    };
    const done = (out, file, extra) => {
      out.textContent = '';
      out.appendChild(el('div', 'st-ok', '✓ ' + APP.path.basename(file)));
      const row = el('div', 'st-row');
      row.appendChild(btn('st-btn', '📂 ' + tx('ፎልደሩን ክፈት', 'Show in folder'), '', () => { try { APP.call('reveal', [file]); } catch (e) {} }));
      (extra || []).forEach((b) => row.appendChild(b));
      out.appendChild(row);
    };
    // 1. subtitles
    const a = card('📝', tx('ንዑስ ጽሑፍ (.srt)', 'Subtitles (.srt)'), tx('ለ CapCut፣ DaVinci፣ YouTube', 'For CapCut, DaVinci, YouTube'));
    a.h.appendChild(btn('st-btn primary', tx('አስቀምጥ', 'Save'), '', () => {
      let r = null;
      try { r = X.srt(); } catch (e) { a.out.textContent = e.message; return; }
      const here = X.editors ? X.editors() : {};
      const eds = (X.EDITORS || []).filter((ed) => here[ed.id]).map((ed) => btn('st-btn', ed.icon + ' ' + tx('በ ' + ed.name + ' ክፈት', 'Open in ' + ed.name), '', () => {
        try { APP.call('copyText', [r.file]); } catch (e) {}
        try { APP.call('openEditor', [ed.id]); } catch (e) {}
        a.out.appendChild(el('div', 'st-sub', tx(ed.name + ' እየተከፈተ ነው — የፋይሉ ቦታ ተቀድቷል፤ በማስገቢያው ላይ ይለጥፉት።',
          ed.name + ' is opening — the file location is copied; paste it in the import window.')));
      }));
      done(a.out, r.file, eds);
      saveProject(true);
    }));
    // 2. the video with the captions drawn in
    const v = card('🎬', tx('ካፕሽን ያለው ቪዲዮ (MP4)', 'Video with captions (MP4)'),
      (typeof STYLE !== 'undefined' && STYLE !== 'plain') ? tx('በ ' + (STYLE_NAMES[STYLE] || STYLE) + ' ስታይል፣ ለመለጠፍ ዝግጁ', 'In the ' + (STYLE_NAMES[STYLE] || STYLE) + ' style, ready to post')
        : tx('መጀመሪያ ስታይል ይምረጡ', 'Choose a style first'));
    if (typeof STYLE === 'undefined' || STYLE === 'plain' || !STYLE_OK) {
      v.h.appendChild(btn('st-btn', '🎨 ' + tx('ስታይል ይምረጡ', 'Choose a style'), '', () => { closeSheet(); showTab('style'); }));
    } else {
      const go = btn('st-btn primary', tx('ቪዲዮ ይስሩ', 'Make video'), '', async () => {
        go.disabled = true;
        v.out.innerHTML = '<div class="st-busy-bar"><i></i></div><div class="st-sub"></div>';
        const bar = v.out.querySelector('i'), lbl = v.out.querySelector('.st-sub');
        try {
          const r = await X.video((x) => { bar.style.width = Math.round(x * 100) + '%'; lbl.textContent = tx('እየሰራ ነው… ', 'Making… ') + Math.round(x * 100) + '%'; });
          done(v.out, r.file, []);
        } catch (e) { v.out.textContent = tx('ቪዲዮው አልተሰራም፦ ', 'The video could not be made: ') + (e && e.message ? e.message : e); }
        go.disabled = false;
      });
      v.h.appendChild(go);
    }
    // 3. more subtitle files (SRT + VTT + TXT, a folder you choose)
    const m = card('📄', tx('ሌሎች ፋይሎች (SRT · VTT · TXT)', 'More files (SRT · VTT · TXT)'), tx('እርስዎ በሚመርጡት ፎልደር', 'To a folder you choose'));
    m.h.appendChild(btn('st-btn', tx('ይምረጡ…', 'Choose…'), '', () => { if (typeof exportReviewFiles === 'function') exportReviewFiles(); }));
    sheet.appendChild(box);
    sheet.style.display = '';
  }
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

  // license: the chip opens the panel's own license section (buy / key)
  function openLicense() {
    goHome();
    const s = document.querySelector('.section-license');
    if (s && s.scrollIntoView) s.scrollIntoView({ block: 'center' });
  }

  // ── labels (both languages) ────────────────────────────────────────────
  function relabel() {
    document.querySelectorAll('[data-i18n="app.title"]').forEach((x) => { x.textContent = NAME; });
    try { document.title = NAME; } catch (e) {}
    homeB.title = tx('መነሻ', 'Home');
    undoB.title = tx('መልስ (Ctrl+Z)', 'Undo (Ctrl+Z)');
    langB.textContent = AMH_LANG === 'am' ? 'EN' : 'አማ';
    exportB.textContent = '⬆ ' + tx('ይላኩ', 'Export');
    exportB.title = tx('ይላኩ (Ctrl+E)', 'Export (Ctrl+E)');
    tTitle.textContent = tx('ጽሑፍ', 'Text');
    memB.title = tx('ማስታወሻ (የተማራቸው ቃላት)', 'Memory (learned words)');
    cliB.title = tx('ደንበኛ', 'Client');
    addB.title = tx('ካፕሽን ጨምር', 'Add a caption');
    cancelB.textContent = tx('አቁም', 'Cancel');
    busy.querySelector('.st-busy-ttl').textContent = tx('ቃላቱን እያዳመጠ ነው…', 'Listening to the words…');
    TABS.forEach((t) => { t.b.textContent = t.label(); });
    const lic = $('licenseStatus');
    chip.textContent = (typeof LICENSED !== 'undefined' && LICENSED) ? '✓ ' + tx('ፈቃድ አለው', 'Licensed') : '🔑 ' + ((lic && lic.textContent.trim()) || tx('ፈቃድ', 'License'));
    syncHead();
    renderCapPane();
  }
  function syncHead() {
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    tCount.textContent = cues.length ? cues.length + ' ' + tx('ካፕሽኖች', 'captions') : '';
    const d = typeof reviewDoubtCount === 'function' ? reviewDoubtCount() : 0;
    doubtB.style.display = d ? '' : 'none';
    doubtB.textContent = '⚠ ' + d;
    doubtB.title = d + ' ' + tx('የሚፈተሹ ቃላት — ወደ መጀመሪያው ይሂዱ', 'words to check — go to the first one');
    const c = window.__amhAppChosen && window.__amhAppChosen();
    projEl.textContent = c ? '/ ' + c.name : '';
    memB.style.display = ($('revMemory') && $('revMemory').style.display !== 'none') ? '' : 'none';
  }
  window.goFirstDoubtStudio = () => { if (typeof goFirstDoubt === 'function') goFirstDoubt(); };
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(() => { relabel(); renderRecent(); drawSoon(); }, 0));

  // ── the timeline (bottom) ──────────────────────────────────────────────
  const tl = el('div', 'studio-tl');
  tl.id = 'studioTimeline';
  tl.innerHTML =
    '<div class="tl-bar"><span class="tl-time" id="tlTime">0:00</span><span class="tl-hint" id="tlHint"></span>' +
    '<button type="button" class="tl-btn" id="tlOut">−</button><button type="button" class="tl-btn" id="tlIn">+</button>' +
    '<button type="button" class="tl-btn" id="tlFit">⤢</button></div>' +
    '<div class="tl-canvas-wrap" id="tlWrap"><canvas id="tlCanvas"></canvas></div>';
  review.appendChild(tl);
  const canvas = tl.querySelector('canvas');
  const wrap = tl.querySelector('#tlWrap');
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  const video = () => $('appVideo');
  let view = { start: 0, pps: 50 };
  let fitted = false;
  let peaks = null;
  const PEAKS_PER_SEC = 50;
  let peaksFor = '';
  let drag = null;
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
    if (!ctx || !review.classList.contains('show')) return;
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
    ctx.fillStyle = '#101614'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#151d1a'; ctx.fillRect(0, 0, w, RULER);
    ctx.font = '10px "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    S.ticks(view, w).forEach((k) => {
      ctx.fillStyle = '#2c3a34'; ctx.fillRect(Math.round(k.x), RULER - 5, 1, 5);
      ctx.fillStyle = '#86998f'; ctx.fillText(k.label, k.x + 3, RULER / 2);
    });
    const waveTop = RULER + 2, waveH = h - RULER - LANE - 6, mid = waveTop + waveH / 2;
    ctx.fillStyle = '#2c463c';
    if (peaks && peaks.length) {
      for (let x = 0; x < w; x++) {
        const a = Math.floor(S.xToTime(x, view) * PEAKS_PER_SEC), b = Math.max(a + 1, Math.floor(S.xToTime(x + 1, view) * PEAKS_PER_SEC));
        let m = 0;
        for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > m) m = peaks[k];
        const hh = Math.max(1, m / 100 * (waveH / 2));
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    } else { ctx.fillRect(0, mid, w, 1); }
    const laneTop = h - LANE - 2;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const t = now();
    ctx.font = '600 12px ' + (getComputedStyle(document.documentElement).getPropertyValue('--review-font').trim() || '"Abyssinica SIL"') + ', serif';
    cues.forEach((c, i) => {
      const x0 = S.timeToX(c.start, view), x1 = S.timeToX(c.end, view);
      if (x1 < 0 || x0 > w) return;
      const on = t >= c.start && t < c.end;
      const sel = drag && drag.i === i;
      const cut = /~[^~]+~/.test(c.text || '') && String(c.text).replace(/~[^~]*~/g, '').trim() === '';
      ctx.fillStyle = sel ? '#2ecc71' : (cut ? '#4a2622' : (on ? '#1f7a4c' : '#22413a'));
      ctx.fillRect(x0 + 0.5, laneTop, Math.max(2, x1 - x0 - 1), LANE);
      ctx.fillStyle = (hover && hover.i === i && hover.edge !== 'body') ? '#ffffff' : (cut ? '#ff6b6b' : '#3ddc84');
      ctx.fillRect(x0, laneTop, 2, LANE); ctx.fillRect(x1 - 2, laneTop, 2, LANE);
      if (/\*[^*]+\*/.test(c.text || '')) { ctx.fillStyle = '#ffd60a'; ctx.fillRect(x0 + 2, laneTop + LANE - 3, Math.max(1, x1 - x0 - 4), 3); }
      if (x1 - x0 > 18) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 4, laneTop, x1 - x0 - 8, LANE); ctx.clip();
        ctx.fillStyle = sel ? '#06110c' : '#e8f5ee';
        ctx.fillText(String(c.text || '').replace(/[*~]/g, ''), x0 + 5, laneTop + LANE / 2);
        ctx.restore();
      }
    });
    const px = S.timeToX(t, view);
    ctx.fillStyle = '#ff5c5c'; ctx.fillRect(Math.round(px) - 1, 0, 2, h);
    const tm = $('tlTime'); if (tm) tm.textContent = S.fmtClock(t, true) + ' / ' + S.fmtClock(dur());
  }
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
    if (hit && hit.edge !== 'body' && reviewOpen) { pushReviewUndo('timing'); drag = { kind: 'edge', i: hit.i, edge: hit.edge }; }
    else if (hit) { drag = { kind: 'select', i: hit.i }; seek(reviewCues[hit.i].start + 0.01); if (typeof focusReviewCue === 'function') focusReviewCue(hit.i, 0); }
    else { drag = { kind: 'seek' }; seek(S.xToTime(p.x, view)); }
    drawSoon();
  });
  document.addEventListener('mousemove', (e) => {
    if (!review.classList.contains('show')) return;
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
    if (was.kind === 'edge') { renderReview(); if (typeof schedulePreview === 'function') schedulePreview(); saveSoon(); }
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

  // ── keys ───────────────────────────────────────────────────────────────
  const typing = (x) => !!x && (/^(TEXTAREA|INPUT|SELECT)$/.test(x.tagName) || x.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (!review.classList.contains('show')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
    if (e.key === 'Escape' && sheet.style.display !== 'none') { e.preventDefault(); closeSheet(); return; }
    if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
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

  // ── projects ───────────────────────────────────────────────────────────
  const projDir = () => path.join(typeof USER_CAPTIONS_DIR !== 'undefined' ? USER_CAPTIONS_DIR : path.join(os.homedir(), 'Documents', 'AmharicCaptions'), 'Studio');
  const chosenVideo = () => (window.__amhAppChosen && window.__amhAppChosen()) || null;
  let lastSaved = '';
  function currentProject() {
    const c = chosenVideo();
    if (!c || typeof reviewCues === 'undefined' || !reviewCues.length) return null;
    return S.makeProject({ video: c.path, name: c.name, duration: dur(), style: typeof STYLE !== 'undefined' ? STYLE : 'plain',
      styleOpts: typeof styleOpts === 'function' && typeof STYLE !== 'undefined' ? styleOpts(STYLE) : null, cues: reviewCues });
  }
  function saveProject(force) {
    if (!review.classList.contains('show') || !reviewOpen || (typeof REVIEW_LIVE !== 'undefined' && REVIEW_LIVE)) return false;
    const p = currentProject();
    if (!p) return false;
    const sig = JSON.stringify([p.cues, p.style, p.styleOpts]);
    if (sig === lastSaved && !force) return false;
    try {
      if (!fs.existsSync(projDir())) fs.mkdirSync(projDir(), { recursive: true });
      fs.writeFileSync(path.join(projDir(), S.projectFileName(p.video)), JSON.stringify(p), { encoding: 'utf8' });
      lastSaved = sig;
      savedEl.textContent = '✓ ' + tx('ተቀምጧል', 'Saved');
      return true;
    } catch (e) { savedEl.textContent = '⚠ ' + tx('አልተቀመጠም', 'Not saved'); return false; }
  }
  let saveTimer = 0;
  function saveSoon() { clearTimeout(saveTimer); savedEl.textContent = tx('እየተቀመጠ ነው…', 'Saving…'); saveTimer = setTimeout(() => { if (!saveProject()) savedEl.textContent = '✓ ' + tx('ተቀምጧል', 'Saved'); }, 800); }
  setInterval(() => { saveProject(); syncHead(); }, 5000);
  review.addEventListener('input', saveSoon);
  function projectFor(videoPath) {
    try {
      const f = path.join(projDir(), S.projectFileName(videoPath));
      return fs.existsSync(f) ? S.parseProject(fs.readFileSync(f, 'utf8')) : null;
    } catch (e) { return null; }
  }
  function listProjects() {
    let names = [];
    try { names = fs.readdirSync(projDir()).filter((n) => /\.amhproj$/.test(n)); } catch (e) { return []; }
    return S.recentProjects(names.map((n) => {
      let p = null;
      try { p = S.parseProject(fs.readFileSync(path.join(projDir(), n), 'utf8')); } catch (e) {}
      return p;
    }), 8);
  }
  async function openProject(p) {
    if (!p) return false;
    if (!fs.existsSync(p.video)) {
      renderRecent(tx('የዚህ ፕሮጀክት ቪዲዮ ተንቀሳቅሷል ወይም ተሰርዟል።', 'This project\'s video was moved or deleted.'));
      return false;
    }
    if (window.__amhAppChoose) window.__amhAppChoose(p.video, true);
    if (p.style && typeof STYLE_LIST !== 'undefined' && STYLE_LIST.indexOf(p.style) >= 0) { STYLE = p.style; saveSettings({ style: p.style }); }
    const tmp = path.join(os.tmpdir(), 'amh_review_studio_' + Date.now() + '.srt');
    fs.writeFileSync(tmp, srtTextFromCues(p.cues.map((c) => ({ start: c.start, end: c.end, text: String(c.text).replace(/[*~]/g, '') }))), { encoding: 'utf8' });
    await openReview(tmp, p.name || 'captions', 0, { projectId: p.name });
    reviewCues = p.cues.map((c, i) => Object.assign({ _id: 'p' + i }, c));
    lastSaved = JSON.stringify([currentProject() && currentProject().cues, p.style, p.styleOpts]);
    savedEl.textContent = '✓ ' + tx('ተቀምጧል', 'Saved');
    renderReview();
    if (typeof renderStyleStrip === 'function') renderStyleStrip();
    if (typeof schedulePreview === 'function') schedulePreview();
    return true;
  }

  // ── home ───────────────────────────────────────────────────────────────
  const recent = el('div', 'card studio-recent');
  recent.id = 'studioRecent';
  const drop = $('appDrop');
  const dropCard = drop && drop.closest ? drop.closest('.card') : null;
  if (dropCard) { dropCard.classList.add('st-dropcard'); dropCard.after(recent); }
  function renderRecent(note) {
    const items = listProjects();
    recent.style.display = items.length ? '' : 'none';
    recent.textContent = '';
    if (!items.length) return;
    recent.appendChild(el('div', 'st-home-h', tx('የቅርብ ጊዜ ፕሮጀክቶች', 'Recent projects')));
    if (note) recent.appendChild(el('div', 'hint studio-note', note));
    const grid = el('div', 'studio-grid');
    items.forEach((p) => {
      const b = btn('studio-proj', '', '', () => openProject(p));
      b.appendChild(el('b', '', p.name || S.projectFileName(p.video)));
      const d = new Date(p.at || 0);
      const meta = el('span', '', (p.duration ? S.fmtClock(p.duration) + ' · ' : '') + p.cues.length + ' ' + tx('ካፕሽኖች', 'captions') + ' · ' +
        d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      b.appendChild(meta);
      if (!fs.existsSync(p.video)) { b.classList.add('missing'); meta.textContent += ' · ' + tx('ቪዲዮው የለም', 'video missing'); }
      grid.appendChild(b);
    });
    recent.appendChild(grid);
  }

  // ── drop a video → the work starts (or its project opens) ─────────────
  let running = false;
  window.__amhOnChosen = (c) => {
    if (!c || running || reviewOpen) return;
    const p = projectFor(c.path);
    if (p && p.cues.length) { openProject(p); return; }
    startTranscribe();
  };
  function startTranscribe() {
    const run = $('runBtn');
    if (!run || run.disabled) return;
    running = true;
    review.classList.add('show', 'st-working');
    syncHead();
    run.click();
    watchRun();
  }
  function watchRun() {
    const t = setInterval(() => {
      const bar = $('progBar'), lbl = $('progLabel');
      const pct = bar && bar.style.width ? bar.style.width : '0%';
      busy.querySelector('i').style.width = pct;
      busy.querySelector('.st-busy-lbl').textContent = (lbl && lbl.textContent) || '';
      const isBusy = $('runBtn') && $('runBtn').disabled;
      if (reviewOpen) { clearInterval(t); running = false; review.classList.remove('st-working'); afterOpen(); return; }
      if (!isBusy) {          // stopped without captions: back home, where the reason is shown
        clearInterval(t); running = false;
        review.classList.remove('st-working', 'show');
      }
    }, 300);
  }
  function goHome() {
    closeSheet();
    if (running) return;
    if (reviewOpen) { saveProject(true); closeReview(); }
    review.classList.remove('show', 'st-working');
    renderRecent();
    if (window.__amhAppRenderDrop) window.__amhAppRenderDrop();
  }
  function afterOpen() {
    hookVideo();
    fitted = false;
    const c = chosenVideo();
    if (c) loadPeaks(c.path);
    relabel();
    showTab(tabNow);
    setTimeout(drawSoon, 50);
  }
  new MutationObserver(() => {
    if (review.classList.contains('show')) {
      hookVideo();
      const c = chosenVideo();
      if (c) loadPeaks(c.path);
      if (reviewOpen) afterOpen();
    } else { renderRecent(); }
  }).observe(review, { attributes: true, attributeFilter: ['class'] });
  const listObs = $('reviewList');
  if (listObs) new MutationObserver(() => { syncHead(); drawSoon(); }).observe(listObs, { childList: true });

  relabel();
  renderRecent();
  showTab('style');
  if (window.__amhAppRenderDrop) window.__amhAppRenderDrop();
  // a video dropped on the desktop shortcut: start as soon as Generate can run
  const given = ((window.__AMH_APP__ || {}).files || [])[0];
  if (given) {
    let tries = 0;
    const t = setInterval(() => {
      const r = $('runBtn');
      const ready = r && !r.disabled;
      if (ready || ++tries > 60) { clearInterval(t); const c = chosenVideo(); if (ready && c) window.__amhOnChosen(c); }
    }, 250);
  }
  window.__amhStudio = { draw, drawSoon, saveProject, listProjects, openProject, renderRecent, openExport, closeSheet, showTab, regroup, goHome,
    view: () => view, setPeaks: (p) => { peaks = p; drawSoon(); } };
})();
