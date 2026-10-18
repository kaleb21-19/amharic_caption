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
    const a = card('📝', tx('ንዑስ ጽሑፍ (.srt)', 'Subtitles (.srt)'), tx('ከዚህ ኤዲት ጋር የሚሄድ — ለ CapCut፣ DaVinci፣ YouTube', 'Matches this edit — for CapCut, DaVinci, YouTube'));
    const saveSrt = () => {
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
    };
    a.h.appendChild(btn('st-btn primary', tx('አስቀምጥ', 'Save'), '', () => saveSrt()));
    // 2. the video: the whole edit (clips, format, reframes), with the
    // captions drawn in when a caption style is chosen
    const styled = typeof STYLE !== 'undefined' && STYLE !== 'plain' && STYLE_OK;
    const fmtName = editor ? editor.format() : '16:9';
    const v = card('🎬', tx('ቪዲዮ (MP4)', 'Video (MP4)'),
      (styled ? tx('ካፕሽኑ በ ' + (STYLE_NAMES[STYLE] || STYLE) + ' ስታይል ተጽፎበት', 'With the captions in the ' + (STYLE_NAMES[STYLE] || STYLE) + ' style')
        : tx('ያለ ካፕሽን — ካፕሽን ለመጻፍ ስታይል ይምረጡ', 'Without captions — choose a style to draw them in')) + ' · ' + fmtName);
    const go = btn('st-btn primary', tx('ቪዲዮ ይስሩ', 'Make video'), '', async () => {
      if (!editor) return;
      go.disabled = true;
      v.out.innerHTML = '<div class="st-busy-bar"><i></i></div><div class="st-sub"></div>';
      const bar = v.out.querySelector('i'), lbl = v.out.querySelector('.st-sub');
      const show = (x) => { bar.style.width = Math.round(x * 100) + '%'; lbl.textContent = tx('እየሰራ ነው… ', 'Making… ') + Math.round(x * 100) + '%'; };
      try { done(v.out, (await editor.exportVideo(show, styled)).file, []); }
      catch (e) { v.out.textContent = tx('ቪዲዮው አልተሰራም፦ ', 'The video could not be made: ') + (e && e.message ? e.message : e); }
      go.disabled = false;
    });
    v.h.appendChild(go);
    if (!styled) v.c.appendChild(btn('st-link', '🎨 ' + tx('ስታይል ይምረጡ', 'Choose a style'), '', () => { closeSheet(); showTab('style'); }));
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

  // ── the player, the timeline and its keys: studio_edit.js (1.20.0) ──
  // (the real edit — several clips, split / trim / move, formats). Until it
  // is attached these do nothing.
  const overlays = [];
  let editor = null;
  const drawSoon = () => { if (editor) editor.drawSoon(); };
  const draw = () => { if (editor) editor.draw(); };
  const seek = (t) => { if (editor) editor.seek(t); };
  const dur = () => (editor ? editor.duration() : 1);
  const peaks = () => (editor ? editor.peaks() : null);
  // the Studio's own keys (the editor adds play / split / delete / undo)
  document.addEventListener('keydown', (e) => {
    if (!review.classList.contains('show')) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'e') { e.preventDefault(); openExport(); return; }
    if (e.key === 'Escape' && sheet.style.display !== 'none') { e.preventDefault(); closeSheet(); }
  });

  // ── projects ───────────────────────────────────────────────────────────
  const projDir = () => path.join(typeof USER_CAPTIONS_DIR !== 'undefined' ? USER_CAPTIONS_DIR : path.join(os.homedir(), 'Documents', 'AmharicCaptions'), 'Studio');
  const chosenVideo = () => (window.__amhAppChosen && window.__amhAppChosen()) || null;
  let lastSaved = '';
  function currentProject() {
    const c = chosenVideo();
    if (!c || typeof reviewCues === 'undefined' || !reviewCues.length) return null;
    const ed = editor ? editor.saveState() : null;
    return S.makeProject({ video: c.path, name: c.name, duration: dur(), edit: ed, style: typeof STYLE !== 'undefined' ? STYLE : 'plain',
      styleOpts: typeof styleOpts === 'function' && typeof STYLE !== 'undefined' ? styleOpts(STYLE) : null, cues: reviewCues,
      cleanup: window.__amhCuts ? window.__amhCuts.save() : null });
  }
  function saveProject(force) {
    if (!review.classList.contains('show') || !reviewOpen || (typeof REVIEW_LIVE !== 'undefined' && REVIEW_LIVE)) return false;
    const p = currentProject();
    if (!p) return false;
    const sig = JSON.stringify([p.cues, p.style, p.styleOpts, p.cleanup, p.edit]);
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
    if (editor) editor.loadState(p.edit, p.cues);
    if (window.__amhCuts) window.__amhCuts.load(p.cleanup);
    const cp = currentProject();
    lastSaved = JSON.stringify([cp && cp.cues, p.style, p.styleOpts, cp && cp.cleanup, cp && cp.edit]);
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
    if (editor) editor.open();
    relabel();
    showTab(tabNow);
    setTimeout(drawSoon, 50);
  }
  new MutationObserver(() => {
    if (review.classList.contains('show')) {
      if (editor) editor.shown();
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
  window.__amhStudio = { draw, drawSoon, saveProject, saveSoon, listProjects, openProject, renderRecent, openExport, closeSheet, showTab, regroup, goHome,
    addTab: (id, label, pane) => { addTab(id, label, pane); relabel(); showTab(tabNow); }, overlays, seek, dur, peaks,
    attachEditor: (e) => { editor = e; }, relabel, savedEl, projDir, chosenVideo, tx };
})();
