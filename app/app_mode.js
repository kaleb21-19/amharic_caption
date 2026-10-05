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
    try { APP.call('reveal', [out]); } catch (e) {}
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

  function showDone(file, n) {
    done.innerHTML =
      '<div class="app-done-head">✅ ' + tx('ካፕሽኑ ተቀምጧል', 'Captions saved') + ' · ' + n + '</div>' +
      '<div class="app-done-file"></div>' +
      '<button class="btn btn-neutral" id="appReveal">📂 ' + tx('ፎልደሩን ክፈት', 'Show in folder') + '</button>' +
      '<div class="app-steps"><b>CapCut</b> — ' +
      tx('Text → Captions → <b>Import captions</b> (ወይም Local captions) → ይህን .srt ይምረጡ።',
         'Text → Captions → <b>Import captions</b> (or Local captions) → choose this .srt.') +
      '</div><div class="app-steps"><b>DaVinci Resolve</b> — ' +
      tx('<b>File → Import → Subtitle</b> → ይህን .srt ይምረጡ፣ ከዚያ ወደ timeline ይጎትቱት።',
         '<b>File → Import → Subtitle</b> → choose this .srt, then drag it onto the timeline.') +
      '</div>';
    done.querySelector('.app-done-file').textContent = APP.path.basename(file);
    done.querySelector('#appReveal').addEventListener('click', () => { try { APP.call('reveal', [file]); } catch (e) {} });
    done.style.display = '';
    done.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function hideDone() { done.style.display = 'none'; }

  // ── words that only make sense in Premiere ──────────────────────────────
  function relabel() {
    renderDrop();
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
    }]);
  } catch (e) {}
})();
