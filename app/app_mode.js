/*
 * app_mode.js — the panel as a desktop app (CapCut, DaVinci Resolve, …).
 *
 * Loaded after main.js. Everything that works the same (license, trial,
 * options, transcription, the review editor, export) is the panel's own code.
 * Only the Premiere-only parts are swapped:
 *   Source "Selected clip / Work area / Whole edit"  → drop a video / choose one
 *   "✓ Place on timeline"                            → "💾 Save SRT" next to the
 *                                                      video + import steps
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  if (!APP) return;
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|wmv|webm|mts|m2ts|mp3|wav|m4a|aac|flac|ogg|opus)$/i;

  document.documentElement.classList.add('amh-app');

  // main.js's log lines mention Premiere's "Place on timeline" button.
  if (typeof window.log === 'function') {
    const panelLog = window.log;
    window.log = (msg) => panelLog(String(msg)
      .replace(/"Place on timeline"/g, '"Save SRT"')
      .replace(/restart Premiere/g, 'restart the app'));
  }
  let chosen = null;          // { path, name }
  let lastSaved = null;

  // ── Step 1: the video ───────────────────────────────────────────────────
  const seg = $('srcSeg');
  const drop = document.createElement('div');
  drop.id = 'appDrop';
  drop.className = 'app-drop';
  drop.setAttribute('role', 'button');
  drop.tabIndex = 0;
  if (seg) seg.replaceWith(drop);

  function renderDrop() {
    drop.innerHTML = chosen
      ? '<div class="app-drop-icon">🎬</div><div class="app-drop-name"></div>' +
        '<div class="app-drop-sub">' + tx('ሌላ ቪዲዮ ለመምረጥ እዚህ ይጫኑ ወይም ይጎትቱ', 'Click or drop another video to change') + '</div>'
      : '<div class="app-drop-icon">⬇</div><div class="app-drop-title">' +
        tx('ቪዲዮዎን እዚህ ይጎትቱ', 'Drag your video here') + '</div><div class="app-drop-sub">' +
        tx('ወይም ለመምረጥ ይጫኑ', 'or click to choose a file') + '</div>';
    if (chosen) drop.querySelector('.app-drop-name').textContent = chosen.name;
    drop.classList.toggle('has-file', !!chosen);
    const run = $('runBtn');
    if (run) run.textContent = tx('▶ ካፕሽን ይስሩ', '▶ Make captions');
  }

  function choose(p) {
    if (!p) return;
    if (!VIDEO_EXT.test(p)) {
      log(tx('ይህ ቪዲዮ ወይም ድምፅ አይደለም፦ ', 'Not a video or audio file: ') + APP.path.basename(p));
      return;
    }
    chosen = { path: p, name: APP.path.basename(p) };
    try { localStorage.setItem('amh.app.lastFile', JSON.stringify(chosen)); } catch (e) {}
    renderDrop();
    hideDone();
  }

  function pick() {
    let p = null;
    try { p = APP.call('dialog', ['open', tx('ቪዲዮ ይምረጡ', 'Choose a video')]); } catch (e) {}
    choose(p);
  }

  drop.addEventListener('click', pick);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    if (ev === 'drop') e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('drag');
  }));
  // amh_app.py reports the full path of a dropped file (the page itself
  // only sees the name).
  window.__amhDropped = (paths) => { drop.classList.remove('drag'); choose(paths && paths[0]); };

  // ── Step 3: Make captions ───────────────────────────────────────────────
  // Replace the button node: drops main.js's "run the Premiere source" handler.
  const oldRun = $('runBtn');
  if (oldRun) {
    const run = oldRun.cloneNode(true);
    oldRun.replaceWith(run);
    run.addEventListener('click', () => {
      if (!chosen) { pick(); if (!chosen) return; }
      hideDone();
      runFile(chosen.path, chosen.name);        // main.js: transcribe → review
    });
  }

  // ── Review: Save SRT instead of Place on timeline ───────────────────────
  function uniquePath(dir, base, ext) {
    let p = APP.path.join(dir, base + ext);
    for (let n = 2; fs.existsSync(p); n++) p = APP.path.join(dir, base + ' (' + n + ')' + ext);
    return p;
  }

  function saveSrt() {
    if (!reviewOpen) return;
    if (typeof REVIEW_LIVE !== 'undefined' && REVIEW_LIVE) return;   // still writing
    const cues = (reviewCues || []).filter((c) => (c.text || '').trim().length > 0);
    if (!cues.length) { log(tx('የሚቀመጥ ካፕሽን የለም።', 'Nothing to save yet.')); return; }
    const src = chosen && chosen.path;
    const dir = src ? APP.path.dirname(src) : ensureCaptionsDir();
    const base = safeFileName((chosen && chosen.name.replace(/\.[^.]+$/, '')) || (REVIEW && REVIEW.label) || 'captions');
    let out = uniquePath(dir, base, '.srt');
    try {
      fs.writeFileSync(out, displaySrtTextFromCues(cues), { encoding: 'utf8' });
    } catch (e) {
      // e.g. a read-only folder or a memory card: fall back to Documents.
      out = uniquePath(ensureCaptionsDir(), base, '.srt');
      fs.writeFileSync(out, displaySrtTextFromCues(cues), { encoding: 'utf8' });
    }
    lastSaved = out;
    log(tx('ተቀምጧል፦ ', 'Saved: ') + out);
    closeReview(true);
    showDone(out, cues.length);
    // With an editor on this computer the card's "Open in …" button is the
    // next step; without one, show the file in its folder straight away.
    const here = editorsHere();
    if (!here.capcut && !here.davinci) { try { APP.call('reveal', [out]); } catch (e) {} }
  }

  const oldPlace = $('reviewPlace');
  if (oldPlace) {
    const place = oldPlace.cloneNode(true);
    place.removeAttribute('data-i18n');
    oldPlace.replaceWith(place);
    place.addEventListener('click', saveSrt);
  }

  // ── Done card: where the file is + how to import it ─────────────────────
  const done = document.createElement('div');
  done.id = 'appDone';
  done.className = 'card app-done';
  done.style.display = 'none';
  const runCard = $('runBtn') && $('runBtn').closest('.card');
  if (runCard) runCard.after(done);

  // Which editors are on this computer (asked once; installs rarely change
  // while the app is open). The one used last is shown first.
  const IS_MAC = (window.process && process.platform) === 'darwin';
  const PASTE = IS_MAC ? '⌘V' : 'Ctrl+V';
  const LAST_EDITOR = 'amh.app.lastEditor';
  let installed = null;
  function editorsHere() {
    if (!installed) { try { installed = APP.call('editors', []) || {}; } catch (e) { installed = {}; } }
    return installed;
  }
  // The Open window: on Windows the path goes in "File name"; a Mac Open
  // window only takes a typed path after ⌘⇧G ("Go to folder").
  const pasteStep = () => IS_MAC
    ? tx('<b>⌘⇧G</b> ይጫኑ፣ <b>⌘V</b> (ቦታውን ይለጥፉ)፣ ከዚያ <b>Return</b>', 'press <b>⌘⇧G</b>, paste with <b>⌘V</b>, then <b>Return</b>')
    : tx('<b>Ctrl+V</b> (ቦታውን ይለጥፉ)፣ ከዚያ <b>Enter</b>', 'paste with <b>Ctrl+V</b>, then <b>Enter</b>');
  const EDITORS = [
    { id: 'capcut', name: 'CapCut', icon: '✂️', steps: () => [
      tx('<b>Text → Captions → Import captions</b> (ወይም Local captions)', '<b>Text → Captions → Import captions</b> (or Local captions)'),
      pasteStep(),
      tx('ካፕሽኑ በ timeline ላይ ይገባል — ስታይል ይምረጡ', 'the captions land on the timeline — pick a style') ] },
    { id: 'davinci', name: 'DaVinci Resolve', icon: '🎞️', steps: () => [
      tx('<b>File → Import → Subtitle…</b>', '<b>File → Import → Subtitle…</b>'),
      pasteStep(),
      tx('ከ Media Pool ወደ timeline ይጎትቱት', 'drag it from the Media Pool onto the timeline') ] },
  ];

  function openIn(ed, file, tile) {
    let copied = false, opened = false;
    try { copied = !!APP.call('copyText', [file]); } catch (e) {}
    try { opened = !!APP.call('openEditor', [ed.id]); } catch (e) {}
    try { localStorage.setItem(LAST_EDITOR, ed.id); } catch (e) {}
    done.querySelectorAll('.app-editor').forEach((t) => t.classList.toggle('active', t === tile));
    const note = tile.querySelector('.app-editor-note');
    note.textContent = opened
      ? (copied ? tx(ed.name + ' እየተከፈተ ነው · የ .srt ቦታው ተቀድቷል (' + PASTE + ')', ed.name + ' is opening · the .srt location is copied (' + PASTE + ')')
                : tx(ed.name + ' እየተከፈተ ነው', ed.name + ' is opening'))
      : tx(ed.name + ' አልተከፈተም — እራስዎ ይክፈቱት', 'Could not open ' + ed.name + ' — please open it yourself');
    note.className = 'app-editor-note ' + (opened ? 'ok' : 'warn');
  }

  function showDone(file, n) {
    const here = editorsHere();
    let last = null;
    try { last = localStorage.getItem(LAST_EDITOR); } catch (e) {}
    const order = EDITORS.slice().sort((a, b) =>
      (b.id === last) - (a.id === last) || (!!here[b.id]) - (!!here[a.id]));
    done.innerHTML =
      '<div class="app-done-head">✅ ' + tx('ካፕሽኑ ተቀምጧል', 'Captions saved') + ' · ' + n + '</div>' +
      '<div class="app-done-file"></div>' +
      '<div class="app-done-actions">' +
      '<button class="btn btn-neutral" id="appReveal">📂 ' + tx('ፎልደሩን ክፈት', 'Show in folder') + '</button>' +
      '<button class="btn btn-neutral" id="appCopy">📋 ' + tx('ቦታውን ቅዳ', 'Copy location') + '</button>' +
      '</div>' +
      '<div class="app-done-sub">' + tx('በኤዲተርዎ ይክፈቱት', 'Open it in your editor') + '</div>' +
      order.map((ed) =>
        '<div class="app-editor" data-ed="' + ed.id + '">' +
          '<div class="app-editor-head"><span class="app-editor-icon">' + ed.icon + '</span>' +
          '<span class="app-editor-name">' + ed.name + '</span>' +
          (here[ed.id]
            ? '<button class="btn btn-primary app-editor-open">' + tx('በ ' + ed.name + ' ክፈት', 'Open in ' + ed.name) + '</button>'
            : '<span class="app-editor-missing">' + tx('በዚህ ኮምፒውተር አልተገኘም', 'not found on this computer') + '</span>') +
          '</div>' +
          '<ol class="app-editor-steps">' + ed.steps().map((s) => '<li>' + s + '</li>').join('') + '</ol>' +
          '<div class="app-editor-note"></div>' +
        '</div>').join('');
    done.querySelector('.app-done-file').textContent = APP.path.basename(file);
    done.querySelector('#appReveal').addEventListener('click', () => { try { APP.call('reveal', [file]); } catch (e) {} });
    const copyBtn = done.querySelector('#appCopy');
    copyBtn.addEventListener('click', () => {
      let okc = false;
      try { okc = !!APP.call('copyText', [file]); } catch (e) {}
      copyBtn.textContent = okc ? '✓ ' + tx('ተቀድቷል', 'Copied') : tx('መቅዳት አልተቻለም', 'Could not copy');
      setTimeout(() => { copyBtn.textContent = '📋 ' + tx('ቦታውን ቅዳ', 'Copy location'); }, 2000);
    });
    done.querySelectorAll('.app-editor').forEach((tile) => {
      const ed = EDITORS.find((e) => e.id === tile.dataset.ed);
      const b = tile.querySelector('.app-editor-open');
      if (b) b.addEventListener('click', () => openIn(ed, file, tile));
    });
    done.style.display = '';
    done.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideDone() { done.style.display = 'none'; }

  // ── Review: the video, with the captions on it ──────────────────────────
  // CapCut / DaVinci users have no timeline next to the review: they see the
  // video above the list, the current caption drawn on it (live while they
  // type), clicking a caption jumps there, and while it plays the caption
  // being spoken is highlighted. A format the window cannot play gets a small
  // H.264 preview copy made by our ffmpeg.
  const PREVIEW_KEY = 'amh.app.preview';
  const preview = document.createElement('div');
  preview.id = 'appPreview';
  preview.className = 'app-preview';
  preview.innerHTML =
    '<div class="app-video-wrap"><video id="appVideo" controls playsinline preload="metadata"></video>' +
    '<div class="app-cap" id="appCap"></div></div>' +
    '<div class="app-preview-msg" id="appPreviewMsg"></div>';
  const list0 = $('reviewList');
  if (list0) list0.before(preview);
  const video = preview.querySelector('video');
  const capEl = preview.querySelector('#appCap');
  const msgEl = preview.querySelector('#appPreviewMsg');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'appPreviewToggle';
  toggle.className = 'btn btn-neutral';
  const actions = document.querySelector('#review .review-actions');
  if (actions) actions.prepend(toggle);
  const previewWanted = () => { try { return localStorage.getItem(PREVIEW_KEY) !== 'off'; } catch (e) { return true; } };
  function syncToggle() {
    toggle.textContent = previewWanted() ? tx('🎬 ቪዲዮ ደብቅ', '🎬 Hide video') : tx('🎬 ቪዲዮ አሳይ', '🎬 Show video');
    preview.style.display = previewWanted() && video.getAttribute('src') ? '' : 'none';
  }
  toggle.addEventListener('click', () => {
    try { localStorage.setItem(PREVIEW_KEY, previewWanted() ? 'off' : 'on'); } catch (e) {}
    if (!previewWanted()) video.pause();
    syncToggle();
  });

  let proxyTried = false;
  let activeIdx = -1;
  const say = (text) => { msgEl.textContent = text || ''; msgEl.style.display = text ? '' : 'none'; };

  function loadPreview() {
    proxyTried = false;
    activeIdx = -1;
    say('');
    capEl.textContent = '';
    if (!chosen || !fs.existsSync(chosen.path)) { video.removeAttribute('src'); syncToggle(); return; }
    try { video.src = APP.call('media', [chosen.path]); } catch (e) { video.removeAttribute('src'); }
    syncToggle();
  }
  function unloadPreview() {
    video.pause();
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}
    preview.style.display = 'none';
  }

  // Some formats (HEVC, older codecs) do not play in the window: make a small
  // H.264 copy once, in the temp folder. The captions never depend on it.
  function makeProxy() {
    if (proxyTried || !chosen) { say(tx('ይህ ቪዲዮ እዚህ መታየት አይችልም — ካፕሽኑ ግን ይሰራል።', 'This video cannot be shown here — the captions are not affected.')); return; }
    proxyTried = true;
    const out = path.join(os.tmpdir(), 'amh_preview_' + crypto.createHash('sha1').update(chosen.path).digest('hex').slice(0, 12) + '.mp4');
    if (fs.existsSync(out)) { video.src = APP.call('media', [out]); return; }
    say(tx('የቪዲዮ ቅድመ እይታ በማዘጋጀት ላይ…', 'Preparing a preview of this video…'));
    execFile(FFMPEG, ['-v', 'error', '-y', '-i', chosen.path, '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out],
    { timeout: 20 * 60 * 1000 }, (err) => {
      if (err || !fs.existsSync(out)) { say(tx('ይህ ቪዲዮ እዚህ መታየት አይችልም — ካፕሽኑ ግን ይሰራል።', 'This video cannot be shown here — the captions are not affected.')); return; }
      say('');
      try { video.src = APP.call('media', [out]); } catch (e) {}
    });
  }
  video.addEventListener('error', () => { if (video.getAttribute('src')) makeProxy(); });
  const IS_VIDEO_FILE = /\.(mp4|mov|m4v|mkv|avi|wmv|webm|mts|m2ts|flv|3gp)$/i;
  video.addEventListener('loadedmetadata', () => {
    // A video whose picture the window cannot decode (old codecs, HEVC on
    // some PCs) still "loads" — sound, no picture, no error: make the copy.
    if (!video.videoWidth && chosen && IS_VIDEO_FILE.test(chosen.path) && !/amh_preview_/.test(video.getAttribute('src') || '')) {
      makeProxy();
      return;
    }
    preview.classList.toggle('audio-only', !video.videoWidth);
  });

  function cueAt(t) {
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    for (let i = 0; i < cues.length; i++) if (t >= cues[i].start && t < cues[i].end) return i;
    return -1;
  }
  function rows() { return $('reviewList') ? $('reviewList').querySelectorAll('.review-row') : []; }
  function showAt(t, scroll) {
    const i = cueAt(t);
    const cue = i >= 0 ? reviewCues[i] : null;
    capEl.textContent = cue ? String(cue.text || '').trim() : '';
    capEl.style.display = capEl.textContent ? '' : 'none';
    const r = rows();
    // The list is rebuilt after edits (split, join, delete): re-apply the mark.
    if (i === activeIdx && (i < 0 || (r[i] && r[i].classList.contains('app-active')))) return;
    r.forEach((x) => x.classList.remove('app-active'));
    activeIdx = i;
    if (r[i]) {
      r[i].classList.add('app-active');
      // Follow the playback, but never pull the list away from a caption the
      // user is typing in.
      const typing = document.activeElement && $('reviewList').contains(document.activeElement);
      if (scroll && !typing) r[i].scrollIntoView({ block: 'nearest' });
    }
  }
  let raf = 0;
  const tick = () => { showAt(video.currentTime, true); raf = video.paused ? 0 : requestAnimationFrame(tick); };
  video.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
  // timeupdate keeps going where animation frames are throttled (window in
  // the background); frames make it smooth for one-word karaoke captions.
  video.addEventListener('timeupdate', () => showAt(video.currentTime, !video.paused));
  video.addEventListener('seeked', () => showAt(video.currentTime, false));
  video.addEventListener('pause', () => showAt(video.currentTime, false));

  // Click (or tab) into a caption: the video jumps to it.
  const list = $('reviewList');
  function jumpTo(target) {
    const row = target && target.closest && target.closest('.review-row');
    if (!row || !video.getAttribute('src')) return;
    const i = Array.prototype.indexOf.call(rows(), row);
    if (i < 0 || !reviewCues[i]) return;
    if (Math.abs(video.currentTime - reviewCues[i].start) > 0.05) video.currentTime = reviewCues[i].start + 0.01;
    showAt(reviewCues[i].start + 0.01, false);
  }
  if (list) {
    list.addEventListener('focusin', (e) => jumpTo(e.target));
    list.addEventListener('mousedown', (e) => jumpTo(e.target));
    // Typing changes the caption on the video right away.
    list.addEventListener('input', () => setTimeout(() => showAt(video.currentTime, false), 0));
  }

  const reviewEl = $('review');
  if (reviewEl && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => {
      if (reviewEl.classList.contains('show')) { if (!video.getAttribute('src')) loadPreview(); }
      else if (video.getAttribute('src')) unloadPreview();
    }).observe(reviewEl, { attributes: true, attributeFilter: ['class'] });
  }

  // ── words that only make sense in Premiere ──────────────────────────────
  function relabel() {
    renderDrop();
    syncToggle();
    const place = $('reviewPlace');
    if (place) place.textContent = tx('💾 SRT አስቀምጥ', '💾 Save SRT');
    const sub = $('reviewSub');
    if (sub) sub.textContent = tx('ጽሑፉን ያስተካክሉ፣ ከዚያ SRT ያስቀምጡ', 'edit the text, then save the SRT');
    const t1 = document.querySelector('[data-i18n="src.title"]');
    if (t1) t1.textContent = tx('ቪዲዮ', 'Video');
    const h1 = document.querySelector('[data-i18n="src.hint"]');
    if (h1) h1.textContent = tx('CapCut · DaVinci · ሌሎች', 'for CapCut · DaVinci · others');
    // First-run guide: the panel's steps talk about Premiere's timeline.
    const ob = (key, am, en) => {
      const el = document.querySelector('[data-i18n-html="' + key + '"]') || document.querySelector('[data-app-ob="' + key + '"]');
      if (!el) return;
      el.removeAttribute('data-i18n-html');
      el.setAttribute('data-app-ob', key);
      el.innerHTML = tx(am, en);
    };
    ob('ob.pick', '<b>ቪዲዮ ይምረጡ</b><span>ቪዲዮዎን ወደ መስኮቱ ይጎትቱ ወይም ይምረጡ።</span>',
      '<b>Pick a video</b><span>Drag your video into the window, or choose it.</span>');
    ob('ob.generate', '<b>ካፕሽን ይስሩ</b><span>ያስተካክሉ፣ ከዚያ የ .srt ፋይሉን ወደ CapCut ወይም DaVinci ያስገቡ — ሙሉ በሙሉ ያለ ኢንተርኔት።</span>',
      '<b>Make captions</b><span>Review, then import the .srt into CapCut or DaVinci Resolve — fully offline, on your computer.</span>');
    if (lastSaved && done.style.display !== 'none') showDone(lastSaved, (lastCues || []).length);
  }
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(relabel, 0));
  // A video dropped on the desktop shortcut comes in from amh_app.py;
  // otherwise offer the last one again.
  const given = ((window.__AMH_APP__ || {}).files || [])[0];
  try {
    const last = JSON.parse(localStorage.getItem('amh.app.lastFile') || 'null');
    if (!given && last && last.path && fs.existsSync(last.path)) chosen = last;
  } catch (e) {}
  relabel();
  if (given) choose(given);

  // Tell the app the page is fully up (used by the automated Mac check; a
  // no-op for customers).
  try {
    APP.call('appReady', [{
      version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '',
      chosen: chosen ? chosen.name : null,
      licenseText: ($('licenseStatus') || {}).textContent || '',
      runtime: typeof RUNTIME !== 'undefined' ? RUNTIME : null,
      userAgent: navigator.userAgent,
      // can the review preview play the usual camera / phone video here?
      h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
      previewUi: !!document.getElementById('appVideo'),
    }]);
  } catch (e) {}
})();
