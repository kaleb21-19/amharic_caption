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
 *  · Speed, colour, transitions (1.24.0): in ⚙ for the selected clip; a
 *    transition is previewed with a second <video> playing the other clip.
 *  · ♪ Music (1.23.0): a music lane under the main track, fades, ducked
 *    under the voice; 🔊 Sound: clean voice, loudness for YouTube/TikTok/TV.
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
  let txt = [];            // the text track (1.22.0): titles, lower thirds, text on a box
  let trk = { tx: [], ov: [], au: [] };   // 🎚 the tracks' hide / mute / lock (1.68)
  let zm = [];             // 🔍 zooms on the main picture (1.60): { id, start, in: 0, out, style, amt, speed, fx, fy }
  let mus = [];            // the music track (1.23.0)
  let snd = { clean: false, loud: 'off' };   // clean voice, loudness (1.23.0)
  let SRC = {};            // the captions of each file, in that file's time
  let fmt = '16:9';
  let sel = null;          // the selected clip's id
  let picks = [];          // 1.70: more selected items (Shift / Ctrl + click); sel = the last one
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
        const vc = t.match(/Stream[^\n]*Video:\s*(\w+)/), ac = t.match(/Stream[^\n]*Audio:\s*(\w+)/);
        resolve({ dur: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
          w: vm ? Number(vm[1]) : 0, h: vm ? Number(vm[2]) : 0, video: !!vm && !/attached pic/.test(t.slice(t.indexOf(vm[0]), t.indexOf(vm[0]) + 300)),
          audio: /Stream[^\n]*Audio:/.test(t), vc: vc ? vc[1].toLowerCase() : '', ac: ac ? ac[1].toLowerCase() : '' });
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
      const k0 = E.speedOf(c), n = Math.floor(E.clipLen(c) * 50);
      for (let j = 0; j < n; j++) out.push(p[Math.floor(c.in * 50 + j * k0)] || 0);
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
    previewCopy(id);
    renderMedia();
    return id;
  }

  // ── preview copies (1.70) ──────────────────────────────────────────────
  // A file the window cannot play (iPhone HEVC, ProRes, WMA, AC-3…) gets a
  // small H.264 / AAC copy in the temp folder, made once in the background,
  // for the PREVIEW only: the export always reads the original file. The same
  // name as the review's own copy (app_mode.js), so it is never made twice.
  const PLAYS_V = /^(h264|vp8|vp9|av1)$/;
  const PLAYS_A = /^(aac|mp3|opus|vorbis|flac|alac|pcm_\w+)$/;
  function needsCopy(m) {
    if (!m || m.image) return false;
    if (m.video) return !!m.vc && !PLAYS_V.test(m.vc);
    return !!m.audio && !!m.ac && !PLAYS_A.test(m.ac);
  }
  const copyPath = (m) => path.join(os.tmpdir(), 'amh_preview_' + crypto.createHash('sha1').update(m.path).digest('hex').slice(0, 12) + (m.video ? '.mp4' : '.m4a'));
  const copying = {};
  function previewCopy(id) {
    const m = media[id];
    if (!m || m.image) return;
    // a project from before 1.70 does not know its codecs yet: look once
    if (m.vc === undefined && m.ac === undefined) {
      probe(m.path).then((info) => { if (media[id] === m) { m.vc = info.vc; m.ac = info.ac; previewCopy(id); } });
      return;
    }
    if (!needsCopy(m) || copying[id]) return;
    const out = copyPath(m);
    if (fs.existsSync(out)) { useCopy(id, out); return; }
    copying[id] = true;
    log('⏳ ' + tx('ለቅድመ እይታ የሚጫወት ቅጂ በማዘጋጀት ላይ፦ ', 'Making a copy the preview can play: ') + m.name);
    const args = m.video
      ? ['-v', 'error', '-y', '-i', m.path, '-vf', 'scale=-2:540', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]
      : ['-v', 'error', '-y', '-i', m.path, '-vn', '-c:a', 'aac', '-b:a', '160k', out];
    execFile(FFMPEG, args, { timeout: 30 * 60 * 1000 }, (err) => {
      copying[id] = false;
      if (!err && fs.existsSync(out)) useCopy(id, out);
      else log(tx('ይህ ፋይል በቅድመ እይታ ላይታይ ይችላል — ኤክስፖርቱ ግን ይሰራል፦ ', 'This file may not show in the preview — the export still works: ') + m.name);
    });
  }
  // the copy is ready: every player showing that file switches to it
  function useCopy(id, out) {
    const m = media[id];
    if (!m) return;
    m.pv = out;
    delete urls[id];
    const v = V();
    if (v && v.dataset.m === id) { v.dataset.m = ''; v.removeAttribute('src'); }
    document.querySelectorAll('video, audio').forEach((x) => { if (x !== v && x.dataset && x.dataset.m === id) { x.dataset.m = ''; x.src = urlOf(id); } });
    ovl.forEach((o) => { if (o.m === id && OVEL[o.id]) { OVEL[o.id].remove(); delete OVEL[o.id]; } });
    if (built) seek(time());
  }

  // ── the edit and the captions ──────────────────────────────────────────
  // reviewCues (what the editor sees and edits) are derived from the files'
  // captions; before the edit changes, what the editor changed goes back.
  function syncSrc() { if (built && typeof reviewCues !== 'undefined') SRC = E.syncBack(clips, SRC, reviewCues); }
  function derive() {
    packAll();
    reviewCues = E.deriveCaptions(clips, SRC);
    if (typeof renderReview === 'function') renderReview();
    if (typeof schedulePreview === 'function') schedulePreview();
  }
  function change(what, fn) {
    pushReviewUndo(what);
    syncSrc();
    fn();
    derive();
    // keep the selection while it still exists: a text, an overlay or music
    // too (their own settings buttons used to unselect them - 1.29.0)
    if (sel && !findItem(sel)) sel = null;
    picks = picks.filter((id) => id !== sel && findItem(id));
    after();
  }
  // 1.70: the zooms, B-roll, texts and sounds follow their moment of the video
  // when the main track changed from `old` (a cut, a delete, a move, a trim)
  function follow(old, skip) {
    ovl = E.followClips(old, clips, ovl, false, skip);
    txt = E.followClips(old, clips, txt, false, skip);
    zm = E.followClips(old, clips, zm, false, skip);
    mus = E.followClips(old, clips, mus, true, skip);
  }
  function after() { frame(); renderInspector(); if (typeof renderSound === 'function') renderSound(); drawSoon(); ST.saveSoon(); }

  // ── undo / redo for the edit too ───────────────────────────────────────
  const origPush = window.pushReviewUndo;
  const origUndo = window.undoReview;
  const REDO = [];
  let redoing = false;
  const snap = () => JSON.stringify({ clips, ovl, txt, mus, snd, zm, trk, fmt, media, SRC: built ? E.syncBack(clips, SRC, reviewCues) : SRC });
  function restore(json) {
    const o = JSON.parse(json);
    clips = o.clips; ovl = o.ovl || []; txt = o.txt || []; mus = o.mus || []; snd = o.snd || { clean: false, loud: 'off' }; zm = o.zm || []; trk = o.trk || { tx: [], ov: [], au: [] }; fmt = o.fmt; SRC = o.SRC;
    picks = [];
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
  function urlOf(id) {
    if (!urls[id]) {
      const m = media[id];
      let pv = null;
      try { pv = m.pv && fs.existsSync(m.pv) ? m.pv : null; } catch (e) {}
      urls[id] = APP.call('media', [pv || m.path]);
    }
    return urls[id];
  }
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
    const k = c ? E.speedOf(c) : 1;
    if (v && c && v.dataset.m === c.m && (playing || Math.abs(v.currentTime - (c.in + (ET - c.s) * k)) < 0.25)) {
      return Math.max(c.s, Math.min(c.e, c.s + (v.currentTime - c.in) / k));
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
    try { V().currentTime = loc.src; V().playbackRate = E.speedOf(loc.clip); } catch (e) {}
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
  function pause() { if (playing) ET = time(); playing = false; const v = V(); if (v) v.pause(); syncPlay(); tick(false); syncMusic(time()); }
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
      if (v.dataset.m !== n.m) { ensureSrc(n.m).then(() => { try { v.currentTime = n.in; v.playbackRate = E.speedOf(n); } catch (e) {} if (playing) v.play().catch(() => {}); }); }
      else if (Math.abs(v.currentTime - n.in) > 0.06) { try { v.currentTime = n.in; } catch (e) {} }
      try { v.playbackRate = E.speedOf(n); } catch (e) {}
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
  const mainLayer = el('div', 'ed-mainlayer');
  stage.appendChild(mainLayer);
  const vB = document.createElement('video');           // the other clip, during a transition
  vB.className = 'ed-vb'; vB.muted = true; vB.playsInline = true; vB.preload = 'auto'; vB.style.display = 'none';
  mainLayer.appendChild(vB);
  // colour: the same matrix as the export, as an SVG filter (sRGB, like ffmpeg)
  const SVGNS = 'http://www.w3.org/2000/svg';
  const fsvg = document.createElementNS(SVGNS, 'svg');
  fsvg.setAttribute('width', '0'); fsvg.setAttribute('height', '0'); fsvg.style.position = 'absolute';
  const CFM = {};
  ['A', 'B'].forEach((n) => {
    const f = document.createElementNS(SVGNS, 'filter');
    f.setAttribute('id', 'edcol' + n); f.setAttribute('color-interpolation-filters', 'sRGB');
    const m = document.createElementNS(SVGNS, 'feColorMatrix');
    m.setAttribute('type', 'matrix');
    f.appendChild(m); fsvg.appendChild(f); CFM[n] = m;
  });
  document.body.appendChild(fsvg);
  function colorTo(e, n, col) {
    if (!E.colorOn(col)) { e.style.filter = ''; return; }
    const { m, o } = E.colorMatrix(col);
    CFM[n].setAttribute('values', [m[0], m[1], m[2], 0, o, m[3], m[4], m[5], 0, o, m[6], m[7], m[8], 0, o, 0, 0, 0, 1, 0].join(' '));
    e.style.filter = 'url(#edcol' + n + ')';
  }
  if (wrapEl) {
    const v = V();
    wrapEl.appendChild(stage);
    if (v) { mainLayer.insertBefore(v, vB); v.controls = false; v.removeAttribute('controls'); }
    const cap = $('appCap');
    if (cap) stage.appendChild(cap);
  }
  const fmtBar = el('div', 'ed-fmt');
  ['16:9', '9:16', '1:1', '4:5'].forEach((f) => {
    const b = btn('', f, '', () => { if (f !== fmt) { change('format', () => { fmt = f; reframeAll(); }); showRfOffer(); } });
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
    posMain(time());
    stage.classList.toggle('sel', !!sel && c.id === sel);
    colorTo(v, 'A', c.col);
    syncTrans(time());
    syncZoom(time());
    syncOverlays(time());
    syncTexts(time());
    syncTemplates(time());
  }
  // 🔍 the zoom, live: the main picture's layer, scaled and moved exactly as
  // the export's perspective filter (E.zoomRect = E.zoomExprs)
  function syncZoom(t) {
    const { w: W, h: H } = E.canvasSize(fmt);
    const r = E.zoomRect(zm, t, W, H);
    if (r.z <= 1.0001) { if (mainLayer.style.transform) mainLayer.style.transform = ''; return; }
    const k = (stage.clientWidth || W) / W;
    mainLayer.style.transformOrigin = '0 0';
    mainLayer.style.transform = 'translate(' + (-r.z * r.x * k) + 'px,' + (-r.z * r.y * k) + 'px) scale(' + r.z + ')';
  }
  // the main picture's place at edit time t (📱 framed clips follow their camera)
  function posMain(t) {
    const v = V();
    const c = L()[cur] || L()[0];
    const m = c && media[c.m];
    if (!v || !m || !m.video) return;
    const { w: W, h: H } = E.canvasSize(fmt);
    const k = stage.clientWidth / W || 0;
    const p = E.rfPlace(m, c, W, H, c.in + Math.max(0, t - c.s) * E.speedOf(c));
    v.style.left = (p.x * k) + 'px'; v.style.top = (p.y * k) + 'px';
    v.style.width = (p.sw * k) + 'px'; v.style.height = (p.sh * k) + 'px';
  }
  window.addEventListener('resize', () => { frame(); drawSoon(); });
  // the shipped Amharic fonts, so the text on the canvas is the exported text
  const FONTFILES = { sans: ['NotoSansEthiopic-Regular.ttf', 'NotoSansEthiopic-Bold.ttf'], menbere: ['Menbere-Regular.ttf', 'Menbere-Bold.ttf'],
    serif: ['NotoSerifEthiopic-Regular.ttf', 'NotoSerifEthiopic-Bold.ttf'], abyssinica: ['AbyssinicaSIL-Regular.ttf', 'AbyssinicaSIL-Regular.ttf'],
    yebse: ['yebse.ttf', 'yebse.ttf'], washra: ['washrab.ttf', 'washrab.ttf'], agbalumo: ['Agbalumo-Regular.ttf', 'Agbalumo-Regular.ttf'],
    tint: ['tint.ttf', 'tint.ttf'], fantuwua: ['fantuwua.ttf', 'fantuwua.ttf'], jiret: ['jiret.ttf', 'jiret.ttf'],
    hibur: ['HiburMono-Regular.ttf', 'HiburMono-Regular.ttf'], gothic: ['yigezubisratgothic.ttf', 'yigezubisratgothic.ttf'] };
  const fontsDir = () => (typeof RUNTIME !== 'undefined' && RUNTIME ? path.join(RUNTIME, 'fonts') : '');
  let fontsReady = false;
  function loadFonts() {
    if (fontsReady || !fontsDir()) return;
    fontsReady = true;
    try { E.setFontInfo(JSON.parse(fs.readFileSync(path.join(fontsDir(), 'metrics.json'), 'utf8'))); } catch (e) {}
    const css = [];
    Object.keys(FONTFILES).forEach((id) => {
      FONTFILES[id].forEach((f, bold) => {
        const p2 = path.join(fontsDir(), f);
        let u = null;
        try { if (fs.existsSync(p2)) u = APP.call('media', [p2]); } catch (e) {}
        if (u) css.push("@font-face{font-family:'AC " + id + "';src:url('" + u + "');font-weight:" + (bold ? 700 : 400) + ';}');
      });
    });
    const st = document.createElement('style');
    st.textContent = css.join('\n');
    document.head.appendChild(st);
  }
  // the text items on the canvas — the same place, size, font and look as libass draws them
  const TXEL = {};
  function syncTexts(t) {
    const { w: W, h: H } = E.canvasSize(fmt);
    const k = stage.clientWidth / W || 0;
    const on = {};
    txt.forEach((it) => {
      if (it.tpl) return;                    // 🇪🇹 templates are drawn on the canvas (syncTemplates)
      const vis = t >= it.start && t < it.start + E.ovLen(it) && t < total() && !rowHidden('tx', rowOf(it));
      let e = TXEL[it.id];
      if (!vis) { if (e) e.style.display = 'none'; return; }
      on[it.id] = 1;
      if (!e) {
        e = el('div', 'ed-tx');
        e.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); startMove(it.id, ev); });
        e.addEventListener('dblclick', () => { const ta = clipPane.querySelector('textarea'); if (ta) ta.focus(); });
        const cap = $('appCap');
        stage.insertBefore(e, cap && cap.parentNode === stage ? cap : null);
        TXEL[it.id] = e;
      }
      const preset = E.TPRESETS[it.preset] ? it.preset : 'plain';
      const fsz = E.textSize(it, H) * E.fontInfo(it.font).css * k;   // exactly the size libass draws
      const a = E.textAnchor(it, W, H);
      e.className = 'ed-tx ed-tx-' + preset + (it.id === sel ? ' sel' : '');
      e.style.display = '';
      e.style.fontFamily = "'AC " + (FONTFILES[it.font] ? it.font : 'sans') + "', 'Abyssinica SIL', serif";
      e.style.fontSize = fsz + 'px';
      e.style.color = it.color || '#FFFFFF';
      e.style.setProperty('--fs', fsz + 'px');
      e.style.setProperty('--accent', it.accent || '#2ECC71');
      e.textContent = '';
      if (preset === 'lower') {
        e.style.left = (a.x * k) + 'px'; e.style.top = ''; e.style.bottom = ((H - a.y) * k) + 'px';
        e.appendChild(el('div', 'ed-tx-name', it.text || ''));
        if (String(it.sub || '').trim()) { const sb = el('div', 'ed-tx-sub', it.sub); sb.style.color = it.subColor || '#C9D6CF'; e.appendChild(sb); }
      } else {
        e.style.left = (a.x * k) + 'px'; e.style.top = (a.y * k) + 'px'; e.style.bottom = '';
        e.appendChild(el('span', 'ed-tx-line', it.text || ''));
      }
    });
    Object.keys(TXEL).forEach((id) => {
      if (!txt.some((x) => x.id === id)) { TXEL[id].remove(); delete TXEL[id]; }
      else if (!on[id]) TXEL[id].style.display = 'none';
    });
  }
  // overlay pictures on the canvas, placed exactly as the export places them
  const OVEL = {};
  function ovEl(o) {
    let box = OVEL[o.id];
    const m = media[o.m];
    if (!m) return null;
    if (!box || box.dataset.m !== o.m) {
      if (box) box.remove();
      // 1.61: a box (layout, border, slides) holding the picture (fit, motion)
      // and, for "whole + blur", a blurred copy behind it
      box = document.createElement('div');
      box.className = 'ed-ov';
      box.dataset.m = o.m;
      const mk = (cls) => {
        const e = document.createElement(m.image ? 'img' : 'video');
        e.className = cls;
        if (!m.image) { e.muted = true; e.playsInline = true; e.preload = 'auto'; }
        e.src = urlOf(o.m);
        e.draggable = false;
        return e;
      };
      box._m = mk('ed-ov-m');
      box.appendChild(box._m);
      box._mk = mk;
      box.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); startMove(o.id, ev); });
      const cap = $('appCap');
      stage.insertBefore(box, cap && cap.parentNode === stage ? cap : null);
      OVEL[o.id] = box;
    }
    return box;
  }
  // play a video element at the overlay's second (or hold it, paused)
  function ovSeek(e, o, t, sound) {
    if (e.tagName !== 'VIDEO') return;
    const want = o.in + (t - o.start);
    e.muted = !sound;
    if (sound) e.volume = Math.min(1, Number(o.volume));
    if (playing) { if (e.paused) { try { e.currentTime = want; } catch (x) {} e.play().catch(() => {}); } else if (Math.abs(e.currentTime - want) > 0.25) { try { e.currentTime = want; } catch (x) {} } }
    else { if (!e.paused) e.pause(); if (Math.abs(e.currentTime - want) > 0.04) { try { e.currentTime = want; } catch (x) {} } }
  }
  function syncOverlays(t) {
    const { w: W, h: H } = E.canvasSize(fmt);
    const k = stage.clientWidth / W || 0;
    const on = {};
    E.ovAt(ovl, t).forEach((o) => {
      if (t >= total() || rowHidden('ov', rowOf(o))) return;
      const box = ovEl(o);
      if (!box) return;
      box.style.zIndex = String(1 + rowOf(o));
      on[o.id] = 1;
      const m = media[o.m];
      const L = E.ovLook(o);
      const b = E.ovBox(o, m, W, H);
      const an = E.ovAnim(o, t, b, W, H);
      box.style.display = '';
      box.style.left = ((b.x + an.dx) * k) + 'px'; box.style.top = ((b.y + an.dy) * k) + 'px';
      box.style.width = (b.w * k) + 'px'; box.style.height = (b.h * k) + 'px';
      box.style.opacity = an.a;
      box.style.outline = b.b ? (Math.max(1, b.b * k) + 'px solid ' + (L.border === 'black' ? '#000' : '#fff')) : '';
      box.style.background = b.fit === 'contain' ? '#000' : '';
      box.classList.toggle('sel', o.id === sel);
      const pic = box._m;
      pic.style.objectFit = b.fit === 'fill' ? 'fill' : (b.fit === 'cover' ? 'cover' : 'contain');
      // the slow zoom / pan inside, as the export's perspective window
      if (an.z > 1.0001) {
        const left = Math.max(0, Math.min(b.w - b.w / an.z, an.fx * b.w - b.w / (2 * an.z)));
        const ox = left / (1 - 1 / an.z);
        pic.style.transformOrigin = (ox * k) + 'px 50%';
        pic.style.transform = 'scale(' + an.z + ')';
      } else pic.style.transform = '';
      if (b.fit === 'blur') {
        if (!box._bg) { box._bg = box._mk('ed-ov-bg'); box.insertBefore(box._bg, pic); }
        box._bg.style.display = '';
        ovSeek(box._bg, o, t, false);
      } else if (box._bg) { box._bg.style.display = 'none'; if (box._bg.tagName === 'VIDEO' && !box._bg.paused) box._bg.pause(); }
      ovSeek(pic, o, t, Number(o.volume) > 0);
    });
    Object.keys(OVEL).forEach((id) => {
      if (on[id]) return;
      const box = OVEL[id];
      if (!ovl.some((o) => o.id === id)) { box.remove(); delete OVEL[id]; return; }
      box.style.display = 'none';
      [box._m, box._bg].forEach((e) => { if (e && e.tagName === 'VIDEO' && !e.paused) e.pause(); });
    });
  }
  // ⧓ a transition in the preview: the other clip in vB, mixed like xfade
  function placeEl(e, c) {
    const { w: W, h: H } = E.canvasSize(fmt);
    const k = stage.clientWidth / W || 0;
    const m = media[c.m];
    if (!m) return;
    const p = E.rfPlace(m, c, W, H, c.in);
    e.style.left = (p.x * k) + 'px'; e.style.top = (p.y * k) + 'px';
    e.style.width = (p.sw * k) + 'px'; e.style.height = (p.sh * k) + 'px';
  }
  const resetFx = (e) => { e.style.opacity = ''; e.style.clipPath = ''; e.style.transform = ''; e.style.zIndex = ''; };
  function syncTrans(t) {
    const v = V();
    if (!v) return;
    const LL = L();
    let hit = null;
    for (let i = 1; i < LL.length; i++) {
      const d = E.trDur(clips, i);
      if (d > 0 && Math.abs(t - LL[i].s) < d / 2) { hit = { i, d }; break; }
    }
    if (!hit) {
      if (vB.style.display !== 'none') { vB.style.display = 'none'; if (!vB.paused) vB.pause(); }
      resetFx(v); mainLayer.style.background = '';
      return;
    }
    const A = LL[hit.i - 1], B = LL[hit.i], cut = B.s, h = hit.d / 2;
    const prog = Math.max(0, Math.min(1, (t - (cut - h)) / hit.d));
    const showB = t < cut;                                 // vB shows the clip the main video is not showing
    const oc = showB ? B : A;
    const om = media[oc.m];
    if (!om) return;
    const want = showB ? Math.max(0, B.in - (cut - t) * E.speedOf(B)) : Math.min(om.dur || Infinity, A.out + (t - cut) * E.speedOf(A));
    if (vB.dataset.m !== oc.m) { vB.dataset.m = oc.m; vB.src = urlOf(oc.m); }
    vB.style.display = '';
    vB.style.visibility = om.video ? '' : 'hidden';
    placeEl(vB, oc);
    colorTo(vB, 'B', oc.col);
    try { vB.playbackRate = E.speedOf(oc); } catch (x) {}
    if (playing) { if (vB.paused) { try { vB.currentTime = want; } catch (x) {} vB.play().catch(() => {}); } else if (Math.abs(vB.currentTime - want) > 0.15) { try { vB.currentTime = want; } catch (x) {} } }
    else { if (!vB.paused) vB.pause(); if (Math.abs(vB.currentTime - want) > 0.03) { try { vB.currentTime = want; } catch (x) {} } }
    const eA = showB ? v : vB, eB = showB ? vB : v;      // outgoing, incoming
    resetFx(eA); resetFx(eB);
    const W = stage.clientWidth;
    const type = clips[hit.i].tr.type;
    mainLayer.style.background = type === 'fadewhite' ? '#fff' : '';
    eB.style.zIndex = 2; eA.style.zIndex = 1;
    if (type === 'fade') eB.style.opacity = prog;
    else if (type === 'fadeblack' || type === 'fadewhite') { eA.style.opacity = prog < 0.5 ? 1 - 2 * prog : 0; eB.style.opacity = prog < 0.5 ? 0 : 2 * prog - 1; }
    else if (type === 'slideleft') { eA.style.transform = 'translateX(' + (-prog * W) + 'px)'; eB.style.transform = 'translateX(' + ((1 - prog) * W) + 'px)'; }
    else if (type === 'wipeleft') eB.style.clipPath = 'inset(0 0 0 ' + ((1 - prog) * 100) + '%)';
    else if (type === 'circleopen') eB.style.clipPath = 'circle(' + (prog * 75) + '% at 50% 50%)';
    else if (type === 'zoomin') { eA.style.zIndex = 2; eB.style.zIndex = 1; eA.style.transform = 'scale(' + (1 + prog) + ')'; eA.style.opacity = 1 - prog; }
  }
  // ♪ the music: one hidden <audio> per music item, at its time, with its
  // fades and ducked while a caption is on (the export ducks by the voice)
  const MUEL = {};
  const speech = () => ((typeof reviewCues !== 'undefined' && reviewCues) || []).filter((c) => String(c.text || '').replace(/~[^~]*~/g, '').trim());
  function syncMusic(t) {
    const sp = playing ? speech() : [];
    mus.forEach((o) => {
      const m = media[o.m];
      if (!m) return;
      let a = MUEL[o.id];
      if (!a || a.dataset.m !== o.m) { if (a) a.remove(); a = document.createElement('audio'); a.preload = 'auto'; a.dataset.m = o.m; a.src = urlOf(o.m); document.body.appendChild(a); MUEL[o.id] = a; }
      const g = rowHidden('au', rowOf(o)) ? 0 : E.musicGain(o, t, total(), sp);
      const want = o.in + (t - o.start);
      if (!playing || g <= 0 && (t < o.start || t >= E.ovEnd(o))) { if (!a.paused) a.pause(); return; }
      a.volume = Math.max(0, Math.min(1, g));
      if (a.paused) { try { a.currentTime = want; } catch (x) {} a.play().catch(() => {}); }
      else if (Math.abs(a.currentTime - want) > 0.3) { try { a.currentTime = want; } catch (x) {} }
    });
    Object.keys(MUEL).forEach((id) => { if (!mus.some((o) => o.id === id)) { MUEL[id].pause(); MUEL[id].remove(); delete MUEL[id]; } });
  }
  // drag the picture to move the selected clip (one undo step per drag)
  let moving = null;
  const findItem = (id) => clips.find((c) => c.id === id) || ovl.find((o) => o.id === id) || txt.find((o) => o.id === id) || mus.find((o) => o.id === id) || zm.find((o) => o.id === id);
  function startMove(id, e) {
    const it = findItem(id);
    if (!it || e.button !== 0) return;
    if (sel !== id) { sel = id; renderInspector(); ST.showTab('clip'); }
    if (ovl.some((o) => o.id === id && E.ovLook(o).layout !== 'free')) return;
    const { w: W, h: H } = E.canvasSize(fmt);
    pushReviewUndo('move picture');
    moving = { id, x0: e.clientX, y0: e.clientY, cx: Number(it.x) || 0, cy: Number(it.y) || 0, k: stage.clientWidth / W, W, H,
      framed: clips.some((c) => c.id === id && E.rfOn(c)) };
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
    // 📱 a framed picture dragged by hand: it keeps the place it had and becomes "by hand"
    if (moving.framed && Math.abs(e.clientX - moving.x0) + Math.abs(e.clientY - moving.y0) > 3) {
      const id = moving.id, W = moving.W, H = moving.H;
      const lc = L().find((c) => c.id === id);
      const fc = clips.find((c) => c.id === id);
      if (lc && fc) {
        const fp = E.rfPlace(media[fc.m], lc, W, H, lc.in + Math.max(0, time() - (lc.s || 0)) * E.speedOf(lc));
        const nx = Math.round((fp.x - (W - fp.sw) / 2) / W * 1000) / 1000, ny = Math.round((fp.y - (H - fp.sh) / 2) / H * 1000) / 1000;
        clips = clips.map((c) => (c.id === id ? Object.assign({}, c, { rf: null, rfk: null, x: nx, y: ny }) : c));
        moving.cx = nx; moving.cy = ny;
      }
      moving.framed = false;
    }
    if (moving.framed) return;
    const dx = (e.clientX - moving.x0) / moving.k / moving.W, dy = (e.clientY - moving.y0) / moving.k / moving.H;
    const upd = (x) => (x.id === moving.id ? Object.assign({}, x, { x: Math.round((moving.cx + dx) * 1000) / 1000, y: Math.round((moving.cy + dy) * 1000) / 1000 }) : x);
    clips = clips.map(upd); ovl = ovl.map(upd); txt = txt.map(upd);
    frame(); renderInspector();
  });
  document.addEventListener('mouseup', () => { if (moving) { moving = null; ST.saveSoon(); } });

  // ── the timeline ───────────────────────────────────────────────────────
  const tl = el('div', 'studio-tl ed-tl');
  const tbar = el('div', 'ed-tbar');
  const bSplit = btn('ed-tool', '', '', () => splitHere());
  const bDel = btn('ed-tool', '', '', () => deleteSel());
  const bDup = btn('ed-tool', '', '', () => duplicate());
  const bUndo = btn('ed-tool', '↶', '', () => undoReview());
  const bRedo = btn('ed-tool', '↷', '', () => redo());
  const zOut = btn('tl-btn', '−', '', () => { view = S.zoomAt(view, 0.625, S.timeToX(time(), view), total(), width()); drawSoon(); });
  const zIn = btn('tl-btn', '+', '', () => { view = S.zoomAt(view, 1.6, S.timeToX(time(), view), total(), width()); drawSoon(); });
  const zFit = btn('tl-btn', '⤢', '', () => { view = S.fitView(total(), width()); drawSoon(); });
  const hint = el('span', 'ed-hint', '');
  // 🧩 Simple / Pro (1.64): Simple hides the exact sliders (position X/Y,
  // colour grading, speed, exact zoom, music fades) — every choice made of
  // buttons stays. New users start in Simple; nothing is lost either way.
  const modeSw = el('span', 'st-seg ed-mode');
  function studioMode() {
    let v = null;
    try { v = loadSettings().studioMode; } catch (e) {}
    if (v === 'simple' || v === 'pro') return v;
    let n = 0;
    try { n = (ST.listProjects && ST.listProjects().length) || 0; } catch (e) {}
    return n > 1 ? 'pro' : 'simple';
  }
  function setStudioMode(v) {
    try { saveSettings({ studioMode: v }); } catch (e) {}
    document.documentElement.classList.toggle('amh-simple', v === 'simple');
    renderModeSw();
  }
  function renderModeSw() {
    const v = studioMode();
    document.documentElement.classList.toggle('amh-simple', v === 'simple');
    modeSw.textContent = '';
    [['simple', tx('ቀላል', 'Simple')], ['pro', tx('ፕሮ', 'Pro')]].forEach(([k, t]) => {
      const b = btn(v === k ? 'on' : '', t, k === 'simple' ? tx('ዋና ዋና አዝራሮች ብቻ', 'Only the main buttons') : tx('ሁሉም ትክክለኛ ማስተካከያዎች', 'Every exact setting too'), () => setStudioMode(k));
      modeSw.appendChild(b);
    });
  }
  const bTrans = btn('ed-tool', '', '', () => addTransition());
  const bZoom = btn('ed-tool ed-tool-zoom', '', '', () => addZoom(time()));
  const bText = btn('ed-tool ed-tool-text', '', '', () => { const open = tmenu.style.display === 'none'; tmenu.style.display = open ? '' : 'none'; if (open) renderTextMenu(); });
  const tmenu = el('div', 'ed-tmenu');
  tmenu.style.display = 'none';
  const tdrop = el('span', 'ed-tdrop');
  tdrop.appendChild(bText); tdrop.appendChild(tmenu);
  // ✨ Make it pro (1.59): one button for what a junior editor does by hand
  const bPro = btn('ed-tool ed-tool-pro', '', '', () => { if (pmenu.style.display === 'none') openPro(); else pmenu.style.display = 'none'; });
  const pmenu = el('div', 'ed-pmenu');
  pmenu.style.display = 'none';
  const pdrop = el('span', 'ed-tdrop');
  pdrop.appendChild(bPro); pdrop.appendChild(pmenu);
  [pdrop, bSplit, bDel, bDup, bTrans, bZoom, tdrop, bUndo, bRedo, hint, el('span', 'st-flex'), modeSw, zOut, zIn, zFit].forEach((x) => tbar.appendChild(x));
  document.addEventListener('mousedown', (e) => { if (pmenu.style.display !== 'none' && !pdrop.contains(e.target)) pmenu.style.display = 'none'; });
  document.addEventListener('mousedown', (e) => { if (tmenu.style.display !== 'none' && !tdrop.contains(e.target)) tmenu.style.display = 'none'; });
  // ✨ Make it pro (1.59, owner's friend: "no keyframes, a junior editor does a
  // pro edit by one move"). Ticks, all on: the ✂ Clean up finds (pauses,
  // repeated takes, እ… sounds, your ✂ words), clean voice, loudness for
  // TikTok / YouTube. One change = one ↶ brings everything back. Steps
  // already done are not offered again.
  function proPlan() {
    const C = window.__amhCuts;
    const items = C && C.items ? C.items().filter((x) => x.on) : [];
    const ranges = mergeRanges(items);
    const gone = ranges.reduce((n, r) => n + r.end - r.start, 0);
    return { ranges, gone, n: items.length, clean: !snd.clean, loud: snd.loud !== 'web', zooms: zoomMoments(ranges).length, sfx: !snd.sfx };
  }
  let PRO = { cuts: true, clean: true, loud: true, zoom: true, sfx: true };
  function openPro(done) {
    pmenu.textContent = '';
    pmenu.style.display = '';
    const P = proPlan();
    pmenu.appendChild(el('div', 'ed-pm-title', '✨ ' + tx('ፕሮ አድርግ', 'Make it pro')));
    if (done) {
      pmenu.appendChild(el('div', 'ed-pm-done', done));
      pmenu.appendChild(el('div', 'st-note', tx('ያልወደዱት ነገር ካለ፦ አንድ ጊዜ ↶ ሁሉንም ይመልሳል።', "Don't like it? One ↶ brings everything back.")));
      return;
    }
    pmenu.appendChild(el('div', 'st-note', tx('አንድ ጊዜ በመጫን ቪዲዮዎን ያጸዳል — ምን እንደሚደረግ ይምረጡ።', 'Cleans up your video in one click — choose what it does.')));
    const steps = [
      ['cuts', '✂ ' + tx('ዝምታ፣ የተደገመና እ… ድምፆችን አስወግድ', 'Remove pauses, repeated takes and እ… sounds'),
        P.n ? P.n + ' ' + tx('ቦታዎች', 'places') + ' · −' + P.gone.toFixed(1) + ' ' + tx('ሰከንድ', 's') : tx('የሚወገድ የለም — አስቀድሞ ጥብቅ ነው', 'Nothing to remove — already tight'), P.n > 0],
      ['clean', '🎙 ' + tx('ድምፁን አጽዳ', 'Clean the voice'), P.clean ? tx('ጫጫታና ጉምጉምታ ይቀንሳል', 'Less noise and hum') : tx('✓ አስቀድሞ በርቷል', '✓ Already on'), P.clean],
      ['loud', '🔊 ' + tx('እንደ TikTok እና YouTube ጮክ አድርግ', 'Loud like TikTok and YouTube'), P.loud ? '−14 LUFS' : tx('✓ አስቀድሞ በርቷል', '✓ Already on'), P.loud],
      ['zoom', '🔍 ' + tx('አስፈላጊ ቃላት ላይ ዙም', 'Zoom on the important words'),
        P.zooms ? P.zooms + ' ' + tx('ቦታዎች — ★ ቃላት፣ ቁጥሮች፣ ገንዘብ', 'places — ★ words, numbers, money') : tx('★ ቃል ወይም ቁጥር አልተገኘም', 'No ★ word or number found'), P.zooms > 0],
      ['sfx', '🔊 ' + tx('የድምፅ ውጤቶች ጨምር', 'Add sound effects'), P.sfx ? tx('በዙም ዉሽ፣ በርዕስ ፖፕ፣ በሽግግር ስዊሽ', 'Whoosh on zooms, pop on titles, swish on transitions') : tx('✓ አስቀድሞ በርቷል', '✓ Already on'), P.sfx],
    ];
    let any = false;
    steps.forEach(([k, name, sub, can]) => {
      const row = el('label', 'ed-pm-row' + (can ? '' : ' off'));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = can && PRO[k]; cb.disabled = !can;
      cb.addEventListener('change', () => { PRO[k] = cb.checked; openPro(); });
      const tx2 = el('span', 'ed-pm-text');
      tx2.appendChild(el('b', '', name));
      tx2.appendChild(el('span', '', sub));
      row.appendChild(cb); row.appendChild(tx2);
      pmenu.appendChild(row);
      if (can && PRO[k]) any = true;
    });
    const go = btn('st-btn primary st-wide', '✨ ' + tx('አድርግ', 'Do it'), '', () => doPro(P));
    go.disabled = !any;
    pmenu.appendChild(go);
  }
  function doPro(P) {
    const cut = PRO.cuts && P.n > 0, clean = PRO.clean && P.clean, loud = PRO.loud && P.loud, zoomOn = PRO.zoom && P.zooms > 0, sfxOn = PRO.sfx && P.sfx;
    if (!cut && !clean && !loud && !zoomOn && !sfxOn) return;
    let nz = 0;
    const list = cut ? P.ranges.slice().sort((a, b) => b.start - a.start) : [];
    change('make it pro', () => {
      const old = clips;
      list.forEach((r) => { clips = E.cutRange(clips, r.start, r.end, newId); });
      follow(old);
      if (clean || loud || sfxOn) snd = Object.assign({}, snd, clean ? { clean: true } : {}, loud ? { loud: 'web' } : {}, sfxOn ? { sfx: true } : {});
      if (zoomOn) nz = autoZooms(cut ? P.ranges : []);
    });
    seek(Math.min(time(), total()));
    const C = window.__amhCuts;
    if (cut && C && C.load && C.save) C.load(Object.assign(C.save(), { overrides: {} }));
    const said = [];
    if (cut) said.push('✂ −' + P.gone.toFixed(1) + ' ' + tx('ሰከንድ', 's'));
    if (clean) said.push('🎙 ' + tx('ድምፁ ጸድቷል', 'voice cleaned'));
    if (loud) said.push('🔊 −14 LUFS');
    if (nz) said.push('🔍 ' + nz + ' ' + tx('ዙሞች', 'zooms'));
    if (sfxOn) said.push('🔊 ' + tx('የድምፅ ውጤቶች', 'sound effects'));
    openPro('✓ ' + said.join(' · '));
    if (clean || loud) log(tx('ድምፅ ማጽዳትና loudness ሲላክ ይሠራሉ።', 'Voice cleaning and loudness are applied when you export.'));
  }
  // 🔍 Zoom (1.60): smooth, After Effects-like zooms without keyframes. Add
  // one at the playhead (or on a word in the Script view), pick a style
  // (each card shows its motion), strength, speed and focus in ⚙.
  const ZOOM_NAMES = {
    push: [tx('ለስላሳ ግፊት', 'Smooth push'), tx('ቀስ ብሎ ይቀርባል፣ ይመለሳል', 'Eases in, holds, eases out')],
    punch: [tx('ፈጣን ዝላይ', 'Punch'), tx('በቅጽበት ይቀርባል — TikTok', 'Snaps in — TikTok style')],
    creep: [tx('ቀስ ያለ ጉዞ', 'Slow creep'), tx('ሙሉ ጊዜ ቀስ ብሎ ይቀርባል', 'Creeps in the whole time')],
    bounce: [tx('ዝላይ', 'Bounce'), tx('አልፎ ተመልሶ ይረጋል', 'Overshoots, then settles')],
    pulse: [tx('የልብ ምት', 'Pulse'), tx('አንድ ፈጣን ምት', 'One quick beat')],
    reveal: [tx('መግለጥ', 'Reveal'), tx('ከቅርብ ጀምሮ ይርቃል', 'Starts close, opens out')],
    impact: [tx('ኃይለኛ', 'Impact'), tx('ዝላይ ከመንቀጥቀጥ ጋር', 'Punch with a camera shake')],
  };
  const zoomName = (st) => (ZOOM_NAMES[st] || ZOOM_NAMES.push)[0];
  const ZOOM_LEN = { push: 2, punch: 1.2, creep: 3, bounce: 1.6, pulse: 0.6, reveal: 1.5, impact: 1.2 };
  function zoomLast() {
    let z = {};
    try { z = (typeof loadSettings === 'function' && loadSettings().zoomLast) || {}; } catch (e) {}
    return {
      style: E.ZOOM_STYLES[z.style] ? z.style : E.ZOOM_DEFAULT.style,
      amt: Number(z.amt) >= 1.05 && Number(z.amt) <= 1.6 ? Number(z.amt) : E.ZOOM_DEFAULT.amt,
      speed: E.ZOOM_SPEED[z.speed] ? z.speed : E.ZOOM_DEFAULT.speed,
    };
  }
  function rememberZoom(o) {
    try { if (typeof saveSettings === 'function') saveSettings({ zoomLast: { style: o.style, amt: o.amt, speed: o.speed } }); } catch (e) {}
  }
  // a zoom that does not run into the next one; null when there is no room
  function zoomItem(at, props) {
    const d0 = total();
    const look = Object.assign(zoomLast(), props || {});
    let start = Math.max(0, Math.min(Number(at) || 0, d0 - 0.3));
    // past every zoom that is already there (one after the other, never on top)
    for (let hit = 1; hit;) {
      hit = zm.find((o) => start >= o.start - 1e-6 && start < o.start + E.ovLen(o) - 1e-6);
      if (hit) start = hit.start + E.ovLen(hit);
    }
    const next = zm.filter((o) => o.start > start + 1e-6).sort((a, b) => a.start - b.start)[0];
    let len = props && props.len ? props.len : ZOOM_LEN[look.style] || 1.6;
    len = Math.min(len, d0 - start, next ? next.start - start : Infinity);
    if (!(len >= 0.3)) return null;
    return { id: newId(), start: Math.round(start * 1000) / 1000, in: 0, out: Math.round(len * 1000) / 1000,
      style: look.style, amt: look.amt, speed: look.speed, fx: look.fx == null ? 0.5 : look.fx, fy: look.fy == null ? 0.5 : look.fy };
  }
  function addZoom(at, props) {
    if (at == null) at = time();
    // already a zoom there: open it (change its style in ⚙) instead of adding one elsewhere
    const there = zm.find((o) => at >= o.start - 0.3 && at < o.start + E.ovLen(o));
    if (there) {
      sel = there.id; after(); ST.showTab('clip');
      hint.textContent = tx('እዚህ ዙም አለ — በ⚙ ይቀይሩት', 'There is a zoom here already — change it in ⚙');
      setTimeout(() => { hint.textContent = ''; }, 2500);
      return there;
    }
    const it = zoomItem(at, props);
    if (!it) { hint.textContent = tx('እዚህ ለዙም ቦታ የለም', 'No room for a zoom here'); setTimeout(() => { hint.textContent = ''; }, 2500); return null; }
    change('add zoom', () => { zm = zm.concat([it]); });
    sel = it.id; after(); ST.showTab('clip');
    return it;
  }
  // the moments worth a zoom (★ words, numbers, money — core.js), in edit
  // time after `cuts` (✨ Make it pro cuts first), none where a zoom is
  function zoomMoments(cuts) {
    if (typeof findZoomMoments !== 'function') return [];
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const at = (t) => (cuts && cuts.length && typeof cutTime === 'function' ? cutTime(t, cuts) : t);
    return findZoomMoments(cues, { auto: true, minGap: 3 }).map((m) => at(Math.max(0, m.word - 0.05)))
      .filter((t) => !zm.some((o) => t >= o.start - 0.5 && t < o.start + E.ovLen(o) + 0.5));
  }
  function autoZooms(cuts) {
    const add = [];
    zoomMoments(cuts).forEach((t) => {
      const it = zoomItem(t, { style: 'punch', amt: 1.15, len: 1.2 });
      if (it && !add.some((a) => it.start < a.start + a.out && a.start < it.start + it.out)) add.push(it);
    });
    zm = zm.concat(add).sort((a, b) => a.start - b.start);
    return add.length;
  }
  function renderZoomInspector(o) {
    const setZ = (props, label) => {
      change(label || 'zoom', () => { zm = zm.map((x) => (x.id === o.id ? Object.assign({}, x, props) : x)); });
      const cur = zm.find((x) => x.id === o.id);
      if (cur) rememberZoom(cur);
    };
    const now = zm.find((x) => x.id === o.id) || o;
    clipPane.appendChild(el('div', 'ed-cname', '🔍 ' + tx('ዙም', 'Zoom') + ' · ' + zoomName(now.style) + ' · ' + S.fmtClock(E.ovLen(now), true)));
    clipPane.appendChild(el('div', 'ed-sec', tx('ስታይል', 'Style')));
    const grid = el('div', 'zm-grid');
    Object.keys(E.ZOOM_STYLES).forEach((st) => {
      const b = btn('zm-card' + (now.style === st ? ' on' : ''), '', ZOOM_NAMES[st][1], () => setZ({ style: st }));
      const demo = el('span', 'zm-demo');
      const pic = el('span', 'zm-pic zm-a-' + st);
      pic.appendChild(el('i', 'zm-face'));
      demo.appendChild(pic);
      b.appendChild(demo);
      b.appendChild(el('b', '', ZOOM_NAMES[st][0]));
      b.appendChild(el('span', '', ZOOM_NAMES[st][1]));
      grid.appendChild(b);
    });
    clipPane.appendChild(grid);
    clipPane.appendChild(el('div', 'ed-sec', tx('ጥንካሬ', 'Strength')));
    const amts = el('div', 'st-seg zm-seg');
    [[1.1, '110%'], [1.2, '120%'], [1.35, '135%'], [1.5, '150%']].forEach(([v, t]) => {
      amts.appendChild(btn(Math.abs((Number(now.amt) || 1.2) - v) < 0.001 ? 'on' : '', t, '', () => setZ({ amt: v })));
    });
    clipPane.appendChild(amts);
    const row = el('div', 'ed-row');
    row.appendChild(el('span', 'ed-lab', tx('በትክክል', 'Exact')));
    const r = el('input'); r.type = 'range'; r.min = 1.05; r.max = 1.6; r.step = 0.01; r.value = Number(now.amt) || 1.2;
    const val = el('span', 'ed-val', Math.round(r.value * 100) + '%');
    let started = false;
    r.addEventListener('input', () => {
      if (!started) { pushReviewUndo('zoom'); started = true; }
      zm = zm.map((x) => (x.id === o.id ? Object.assign({}, x, { amt: Number(r.value) }) : x));
      val.textContent = Math.round(r.value * 100) + '%';
      frame();
    });
    r.addEventListener('change', () => { started = false; rememberZoom(zm.find((x) => x.id === o.id) || o); ST.saveSoon(); drawSoon(); renderInspector(); });
    row.appendChild(r); row.appendChild(val);
    clipPane.appendChild(row);
    clipPane.appendChild(el('div', 'ed-sec', tx('ፍጥነት', 'Speed')));
    const sp = el('div', 'st-seg zm-seg');
    [['slow', tx('ቀስ', 'Slow')], ['normal', tx('መደበኛ', 'Normal')], ['fast', tx('ፈጣን', 'Fast')]].forEach(([v, t]) => {
      sp.appendChild(btn((now.speed || 'normal') === v ? 'on' : '', t, '', () => setZ({ speed: v })));
    });
    clipPane.appendChild(sp);
    clipPane.appendChild(el('div', 'ed-sec', tx('ወደ የት', 'Focus')));
    const fwrap = el('div', 'zm-focus-wrap');
    const fg = el('div', 'zm-focus');
    [0.25, 0.5, 0.75].forEach((fy) => [0.25, 0.5, 0.75].forEach((fx) => {
      const on = Math.abs((now.fx == null ? 0.5 : now.fx) - fx) < 0.01 && Math.abs((now.fy == null ? 0.5 : now.fy) - fy) < 0.01;
      fg.appendChild(btn('zm-dot' + (on ? ' on' : ''), '', '', () => setZ({ fx, fy })));
    }));
    fwrap.appendChild(fg);
    fwrap.appendChild(el('div', 'st-note', tx('ዙሙ ወደ የትኛው የቪዲዮ ክፍል እንደሚቀርብ — ለምሳሌ ፊት።', 'Which part of the picture it zooms to — a face, for example.')));
    clipPane.appendChild(fwrap);
    const acts = el('div', 'st-row zm-acts');
    sfxRow(now.sfx, (v) => setZ({ sfx: v }));
    acts.appendChild(btn('st-btn primary', '▶ ' + tx('አሳይ', 'Preview'), '', () => {
      const z = zm.find((x) => x.id === o.id) || o;
      seek(Math.max(0, z.start - 0.5));
      play();
      const end = z.start + E.ovLen(z) + 0.6;
      const stop = () => { if (time() >= end) pause(); else if (playing) requestAnimationFrame(stop); };
      requestAnimationFrame(stop);
    }));
    acts.appendChild(btn('st-btn', tx('ለሁሉም ዙሞች', 'Apply to all zooms'), '', () => {
      const z = zm.find((x) => x.id === o.id) || o;
      change('zoom all', () => { zm = zm.map((x) => Object.assign({}, x, { style: z.style, amt: z.amt, speed: z.speed })); });
    }));
    acts.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', () => deleteSel()));
    clipPane.appendChild(acts);
    clipPane.appendChild(el('div', 'st-note', tx('በጊዜ መስመሩ ላይ ዙሙን ይጎትቱ፣ ጫፎቹን ያራዝሙ።', 'Drag the zoom on the timeline; drag its ends to make it longer or shorter.')));
  }
  // ⧓ a dissolve on the cut nearest the playhead (then choose the kind in ⚙)
  function addTransition() {
    const LL = L();
    if (LL.length < 2) { hint.textContent = tx('መጀመሪያ ይቁረጡ (S) ወይም ሌላ ክሊፕ ያስገቡ', 'Split (S) or add another clip first'); setTimeout(() => { hint.textContent = ''; }, 2500); return; }
    const t = time();
    let best = 1;
    for (let i = 2; i < LL.length; i++) if (Math.abs(LL[i].s - t) < Math.abs(LL[best].s - t)) best = i;
    const id = clips[best].id;
    if (!clips[best].tr) change('transition', () => { clips = clips.map((c) => (c.id === id ? Object.assign({}, c, { tr: { type: 'fade', d: 0.5 } }) : c)); });
    sel = id; after(); ST.showTab('clip');
    seek(Math.max(0, LL[best].s - 0.6));
  }
  function addText(preset) {
    const at = Math.min(time(), Math.max(0, total() - 0.5));
    const id = newId();
    const it = { id, preset, start: Math.round(at * 1000) / 1000, in: 0, out: preset === 'lower' ? 4 : 3, font: 'sans',
      text: preset === 'lower' ? tx('ስም', 'Name') : tx('ጽሑፍዎን እዚህ ይጻፉ', 'Your text'), sub: preset === 'lower' ? tx('ማዕረግ', 'Title') : '' };
    if (preset === 'title') it.font = 'menbere';
    change('add text', () => { txt = txt.concat([it]); });
    sel = id; after(); ST.showTab('clip');
    setTimeout(() => { const ta = clipPane.querySelector('textarea'); if (ta) { ta.focus(); ta.select(); } }, 30);
  }
  const lanes = el('div', 'ed-lanes');
  const labels = el('div', 'ed-labels');
  const cwrap = el('div', 'tl-canvas-wrap ed-cwrap');
  const canvas = el('canvas');
  cwrap.appendChild(canvas);
  lanes.appendChild(labels); lanes.appendChild(cwrap);
  tl.appendChild(tbar); tl.appendChild(lanes);
  review.appendChild(tl);
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  // 🎚 tracks (1.68): as many text (T1, T2…), picture (V2, V3… over V1, the
  // main track) and sound (A1, A2…) tracks as the edit needs. An item's track
  // is its `row` (0 = T1 / V2 / A1); a higher track is drawn above a lower one
  // (in the picture too). trk = { tx, ov, au: [{ hide | mute, lock }] }.
  const RULER = 20, CAP = 28, TXT = 26, OVL = 28, ZM = 18, MAIN = 48, MUS = 28, GAP = 6, RG = 3;
  let capTop = 0, txTop = 0, ovTop = 0, zmTop = 0, mainTop = 0, musTop = 0, LH = 240, NT = 1, NO = 1, NA = 1;
  const rowOf = (it) => Math.max(0, Math.floor(Number(it && it.row) || 0));
  const KIND_LIST = { tx: () => txt, ov: () => ovl, au: () => mus };
  const tkOf = (kind, r) => ((trk[kind] || [])[r]) || {};
  const rowHidden = (kind, r) => !!(tkOf(kind, r).hide || tkOf(kind, r).mute);
  const rowLocked = (kind, r) => !!tkOf(kind, r).lock;
  function relayout() {
    const n = (kind) => Math.max(1, (trk[kind] || []).length, KIND_LIST[kind]().reduce((m, it) => Math.max(m, rowOf(it) + 1), 0));
    NT = n('tx'); NO = n('ov'); NA = n('au');
    capTop = RULER + 4;
    txTop = capTop + CAP + GAP;
    ovTop = txTop + NT * (TXT + RG) - RG + GAP;
    zmTop = ovTop + NO * (OVL + RG) - RG + GAP;
    mainTop = zmTop + ZM + GAP;
    musTop = mainTop + MAIN + GAP;
    LH = musTop + NA * (MUS + RG) - RG + 8;
  }
  const txY = (r) => txTop + (NT - 1 - r) * (TXT + RG);
  const ovY = (r) => ovTop + (NO - 1 - r) * (OVL + RG);
  const muY = (r) => musTop + r * (MUS + RG);
  // which track a height is on: { kind, row } (or null between tracks)
  function laneAt(y) {
    for (let r = 0; r < NT; r++) if (y >= txY(r) && y <= txY(r) + TXT) return { kind: 'tx', row: r };
    for (let r = 0; r < NO; r++) if (y >= ovY(r) && y <= ovY(r) + OVL) return { kind: 'ov', row: r };
    for (let r = 0; r < NA; r++) if (y >= muY(r) && y <= muY(r) + MUS) return { kind: 'au', row: r };
    return null;
  }
  // every item on a track; one on top of another goes to the next free track
  function packRows(list, kind) {
    const placed = [];
    const free = (it, r) => !placed.some((o) => rowOf(o) === r && it.start < E.ovEnd(o) - 1e-6 && o.start < E.ovEnd(it) - 1e-6);
    list.slice().sort((a, b) => a.start - b.start).forEach((it) => {
      let r = it.row == null ? -1 : rowOf(it);
      if (r < 0 || !free(it, r) || rowLocked(kind, r) && it.row == null) {
        r = 0;
        while (!free(it, r) || (rowLocked(kind, r) && it.row !== r)) r++;
      }
      it.row = r;
      placed.push(it);
    });
  }
  function packAll() { packRows(txt, 'tx'); packRows(ovl, 'ov'); packRows(mus, 'au'); }
  relayout();
  let view = { start: 0, pps: 50 };
  let fitted = false;
  const width = () => Math.max(50, cwrap.clientWidth || 600);
  let drag = null, hover = null;
  let pending = 0;
  function drawSoon() { if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); }); }
  function tick(follow) {
    const t = time();
    syncSfx(t);
    if ((L()[cur] || {}).rf) posMain(t);
    syncTrans(t);
    syncZoom(t);
    syncOverlays(t);
    syncTexts(t);
    syncTemplates(t);
    syncMusic(t);
    if (window.__amhSubsTick) window.__amhSubsTick(t);   // the caption style, live (studio_subs.js)
    tTime.textContent = S.fmtClock(t, true) + ' / ' + S.fmtClock(total());
    if (follow) view = S.follow(view, t, total(), width());
    draw();
  }
  // the track headers: name, 👁 hide / 🔇 mute, 🔒 lock, ＋ a track, ✕ an empty one
  let labelSig = '';
  function setTrk(kind, r, props) {
    const a = (trk[kind] || []).slice();
    while (a.length <= r) a.push({});
    a[r] = Object.assign({}, a[r], props);
    change('track', () => { trk = Object.assign({}, trk, { [kind]: a }); });
  }
  function renderLabels() {
    const sig = [NT, NO, NA, JSON.stringify(trk), typeof AMH_LANG !== 'undefined' ? AMH_LANG : ''].join('|');
    if (sig === labelSig) return;
    labelSig = sig;
    labels.textContent = '';
    const lab = (h, kind, r, name, extra) => {
      const d = el('div', 'ed-trk');
      d.style.height = h + 'px';
      d.appendChild(el('span', 'ed-trk-n', name));
      if (kind) {
        const hid = rowHidden(kind, r), lk = rowLocked(kind, r);
        const eye = btn('ed-trk-b' + (hid ? ' on' : ''), kind === 'au' ? (hid ? '🔇' : '🔊') : (hid ? '⊘' : '👁'), kind === 'au' ? tx('ድምፅ አጥፋ / አብራ', 'Mute / unmute') : tx('ደብቅ / አሳይ', 'Hide / show'),
          () => setTrk(kind, r, kind === 'au' ? { mute: !hid } : { hide: !hid }));
        const lock = btn('ed-trk-b' + (lk ? ' on' : ''), lk ? '🔒' : '🔓', tx('ቆልፍ / ክፈት', 'Lock / unlock'), () => setTrk(kind, r, { lock: !lk }));
        d.appendChild(eye); d.appendChild(lock);
        const empty = !KIND_LIST[kind]().some((it) => rowOf(it) === r);
        const n = kind === 'tx' ? NT : kind === 'ov' ? NO : NA;
        if (empty && r === n - 1 && r > 0) d.appendChild(btn('ed-trk-b', '✕', tx('ባዶውን ትራክ አስወግድ', 'Remove this empty track'), () => {
          change('track', () => { trk = Object.assign({}, trk, { [kind]: (trk[kind] || []).slice(0, r) }); });
        }));
      }
      if (extra) d.appendChild(extra);
      labels.appendChild(d);
    };
    const add = (kind) => btn('ed-trk-b ed-trk-add', '＋', tx('ትራክ ጨምር', 'Add a track'), () => {
      const n = kind === 'tx' ? NT : kind === 'ov' ? NO : NA;
      const a = (trk[kind] || []).slice();
      while (a.length < n + 1) a.push({});
      change('track', () => { trk = Object.assign({}, trk, { [kind]: a }); });
    });
    lab(RULER + 4, null, 0, '');
    lab(CAP + GAP, null, 0, '💬 ' + tx('ካፕሽን', 'Captions'));
    for (let r = NT - 1; r >= 0; r--) lab(TXT + (r === 0 ? GAP : RG), 'tx', r, 'T' + (r + 1), r === NT - 1 ? add('tx') : null);
    for (let r = NO - 1; r >= 0; r--) lab(OVL + (r === 0 ? GAP : RG), 'ov', r, 'V' + (r + 2), r === NO - 1 ? add('ov') : null);
    lab(ZM + GAP, null, 0, '🔍 ' + tx('ዙም', 'Zoom'));
    lab(MAIN + GAP, null, 0, '🎬 V1 ' + tx('ዋና', 'Main'));
    for (let r = 0; r < NA; r++) lab(MUS + RG, 'au', r, '♪ A' + (r + 1), r === NA - 1 ? add('au') : null);
  }
  function draw() {
    if (!ctx || !review.classList.contains('show')) return;
    relayout();
    renderLabels();
    if (cwrap.style.height !== LH + 'px') cwrap.style.height = LH + 'px';
    const w = width(), h = LH, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    if (!fitted && clips.length) { view = S.fitView(total(), w); fitted = true; }
    view = S.clampView(view, total(), w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1513'; ctx.fillRect(0, 0, w, h);
    // each track's own band
    ctx.fillStyle = '#121a17';
    for (let r = 0; r < NT; r++) ctx.fillRect(0, txY(r), w, TXT);
    for (let r = 0; r < NO; r++) ctx.fillRect(0, ovY(r), w, OVL);
    for (let r = 0; r < NA; r++) ctx.fillRect(0, muY(r), w, MUS);
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
      const isSel = isPicked(c.id);
      ctx.fillStyle = isSel ? '#2a5f86' : '#1f4b6b';
      ctx.fillRect(x0 + 1, mainTop, Math.max(2, x1 - x0 - 2), MAIN);
      const p = PEAKS[c.m];
      if (p) {
        ctx.fillStyle = 'rgba(160,210,230,.45)';
        const bot = mainTop + MAIN - 3;
        for (let x = Math.max(0, Math.floor(x0) + 2); x < Math.min(w, x1 - 2); x++) {
          const k0 = E.speedOf(c);
          const sa = c.in + (S.xToTime(x, view) - c.s) * k0, sb = c.in + (S.xToTime(x + 1, view) - c.s) * k0;
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
        ctx.fillText((media[c.m] ? media[c.m].name : '') + '  ·  ' + S.fmtClock(c.e - c.s, true) + (E.speedOf(c) !== 1 ? '  ·  ' + E.speedOf(c) + '×' : '') + (E.colorOn(c.col) ? '  ·  🎨' : ''), x0 + 7, mainTop + 11);
        ctx.restore();
      }
    });
    // ⧓ transitions: a bow tie over the cut, as wide as the transition
    LL.forEach((c, i) => {
      const d = E.trDur(clips, i);
      if (!d) return;
      const xc = S.timeToX(c.s, view), hw = Math.max(5, d / 2 * view.pps);
      if (xc + hw < 0 || xc - hw > w) return;
      ctx.fillStyle = isPicked(c.id) ? 'rgba(255,214,10,.35)' : 'rgba(255,255,255,.22)';
      ctx.beginPath(); ctx.moveTo(xc - hw, mainTop + 14); ctx.lineTo(xc + hw, mainTop + MAIN); ctx.lineTo(xc + hw, mainTop + 14); ctx.lineTo(xc - hw, mainTop + MAIN); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1;
      ctx.strokeRect(xc - hw + 0.5, mainTop + 14.5, hw * 2 - 1, MAIN - 15);
    });
    // T text
    txt.forEach((it) => {
      const x0 = S.timeToX(it.start, view), x1 = S.timeToX(it.start + E.ovLen(it), view);
      if (x1 < 0 || x0 > w) return;
      const txTop = txY(rowOf(it));
      ctx.globalAlpha = rowHidden('tx', rowOf(it)) ? 0.35 : 1;
      const isSel = isPicked(it.id);
      ctx.fillStyle = isSel ? '#8a6428' : '#6b4b1f';
      ctx.fillRect(x0 + 1, txTop, Math.max(2, x1 - x0 - 2), TXT);
      ctx.strokeStyle = isSel ? '#ffffff' : '#c08a3d';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, txTop + 0.5, Math.max(2, x1 - x0 - 3), TXT - 1);
      if (hover && hover.lane === 'tx' && hover.id === it.id && hover.edge !== 'body') { ctx.fillStyle = '#fff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, txTop, 3, TXT); }
      if (x1 - x0 > 20) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 5, txTop, x1 - x0 - 10, TXT); ctx.clip();
        ctx.fillStyle = '#fff3df'; ctx.font = '600 11px ' + "'AC sans', 'Abyssinica SIL', serif";
        ctx.fillText('T  ' + String(it.text || '').replace(/\n/g, ' '), x0 + 6, txTop + TXT / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    });
    // 🔍 zooms
    zm.forEach((o) => {
      const x0 = S.timeToX(o.start, view), x1 = S.timeToX(o.start + E.ovLen(o), view);
      if (x1 < 0 || x0 > w) return;
      const isSel = isPicked(o.id);
      ctx.fillStyle = isSel ? '#1f7a8c' : '#155766';
      ctx.fillRect(x0 + 1, zmTop, Math.max(2, x1 - x0 - 2), ZM);
      ctx.strokeStyle = isSel ? '#ffffff' : '#3fb6cc';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, zmTop + 0.5, Math.max(2, x1 - x0 - 3), ZM - 1);
      if (hover && hover.lane === 'zm' && hover.id === o.id && hover.edge !== 'body') { ctx.fillStyle = '#fff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, zmTop, 3, ZM); }
      if (x1 - x0 > 26) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 4, zmTop, x1 - x0 - 8, ZM); ctx.clip();
        ctx.fillStyle = '#dff8fc'; ctx.font = '600 10px "Segoe UI", sans-serif';
        ctx.fillText('🔍 ' + zoomName(o.style) + ' · ' + Math.round((Number(o.amt) || 1.2) * 100) + '%', x0 + 5, zmTop + ZM / 2);
        ctx.restore();
      }
    });
    // 🎞 overlays
    ovl.forEach((o) => {
      const x0 = S.timeToX(o.start, view), x1 = S.timeToX(E.ovEnd(o), view);
      if (x1 < 0 || x0 > w) return;
      const isSel = isPicked(o.id), m = media[o.m];
      const y0 = ovY(rowOf(o)), hh = OVL;
      ctx.globalAlpha = rowHidden('ov', rowOf(o)) ? 0.35 : 1;
      ctx.fillStyle = isSel ? '#6a52a0' : '#4b3a6b';
      ctx.fillRect(x0 + 1, y0, Math.max(2, x1 - x0 - 2), hh);
      ctx.strokeStyle = isSel ? '#ffffff' : '#8b6fc0';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, y0 + 0.5, Math.max(2, x1 - x0 - 3), hh - 1);
      if (hover && hover.lane === 'ov' && hover.id === o.id && hover.edge !== 'body') { ctx.fillStyle = '#fff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, y0, 3, hh); }
      if (x1 - x0 > 24) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 5, y0, x1 - x0 - 10, hh); ctx.clip();
        ctx.fillStyle = '#f0e8ff'; ctx.font = '600 11px "Segoe UI", sans-serif';
        ctx.fillText((m && m.image ? '🖼 ' : '🎞 ') + (m ? m.name : ''), x0 + 6, y0 + hh / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    });
    // ♪ music: its wave, its fades, how far it ducks
    mus.forEach((o) => {
      const x0 = S.timeToX(o.start, view), x1 = S.timeToX(Math.min(E.ovEnd(o), total()), view);
      if (x1 < 0 || x0 > w) return;
      const isSel = isPicked(o.id), m = media[o.m];
      const musTop = muY(rowOf(o));
      ctx.globalAlpha = rowHidden('au', rowOf(o)) ? 0.35 : 1;
      ctx.fillStyle = isSel ? '#2f7a5a' : '#1f5a42';
      ctx.fillRect(x0 + 1, musTop, Math.max(2, x1 - x0 - 2), MUS);
      const p = PEAKS[o.m];
      if (p) {
        ctx.fillStyle = 'rgba(170,240,200,.4)';
        for (let x = Math.max(0, Math.floor(x0) + 2); x < Math.min(w, x1 - 2); x++) {
          const k = Math.floor((o.in + S.xToTime(x, view) - o.start) * 50);
          const hh = Math.max(1, (p[k] || 0) / 100 * (MUS - 8));
          ctx.fillRect(x, musTop + MUS / 2 - hh / 2, 1, hh);
        }
      }
      const fi = E.MUS_DEFAULT.fadeIn, fo = E.MUS_DEFAULT.fadeOut;
      const fiw = (o.fadeIn == null ? fi : o.fadeIn) * view.pps, fow = (o.fadeOut == null ? fo : o.fadeOut) * view.pps;
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0 + 1, musTop + MUS); ctx.lineTo(x0 + 1 + fiw, musTop + 2); ctx.lineTo(x1 - 1 - fow, musTop + 2); ctx.lineTo(x1 - 1, musTop + MUS); ctx.stroke();
      ctx.strokeStyle = isSel ? '#ffffff' : '#4fbf8a';
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(x0 + 1.5, musTop + 0.5, Math.max(2, x1 - x0 - 3), MUS - 1);
      if (hover && hover.lane === 'mu' && hover.id === o.id && hover.edge !== 'body') { ctx.fillStyle = '#fff'; ctx.fillRect(hover.edge === 'in' ? x0 + 1 : x1 - 4, musTop, 3, MUS); }
      if (x1 - x0 > 24) {
        ctx.save(); ctx.beginPath(); ctx.rect(x0 + 5, musTop, x1 - x0 - 10, MUS); ctx.clip();
        ctx.fillStyle = '#e4fff0'; ctx.font = '600 11px "Segoe UI", sans-serif';
        ctx.fillText('♪ ' + (m ? m.name : '') + ((o.duck == null ? E.MUS_DEFAULT.duck : o.duck) > 0 ? '  ·  ⤵ ' + tx('ይቀንሳል', 'ducks') : ''), x0 + 6, musTop + MUS / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
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
    // 🔊 where each sound effect plays (on the ruler)
    if (snd.sfx) {
      E.sfxEvents({ snd, clips, ovl, txt, zm }, total()).forEach((ev) => {
        const x0 = S.timeToX(ev.t, view), x1 = S.timeToX(ev.t + (E.SFX_LEN[ev.name] || 0.3), view);
        if (x1 < 0 || x0 > w) return;
        ctx.fillStyle = 'rgba(255,196,0,.85)';
        ctx.fillRect(x0, RULER - 6, Math.max(3, x1 - x0), 4);
        ctx.beginPath(); ctx.moveTo(x0, RULER - 9); ctx.lineTo(x0 + 5, RULER - 6); ctx.lineTo(x0, RULER - 3); ctx.closePath(); ctx.fill();
      });
    }
    const px = S.timeToX(t, view);
    ctx.fillStyle = '#ff5c5c'; ctx.fillRect(Math.round(px) - 1, 0, 2, h);
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
  }
  function xy(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hitAt(p) {
    if (p.y >= zmTop && p.y <= zmTop + ZM) {
      for (let k = zm.length - 1; k >= 0; k--) {
        const o = zm[k];
        const x0 = S.timeToX(o.start, view), x1 = S.timeToX(o.start + E.ovLen(o), view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'zm', id: o.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'zm', id: o.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'zm', id: o.id, edge: 'body' };
      }
      return null;
    }
    relayout();
    const LN = laneAt(p.y);
    if (LN && LN.kind === 'tx') {
      if (rowLocked('tx', LN.row)) return null;
      for (let k = txt.length - 1; k >= 0; k--) {
        const it = txt[k];
        if (rowOf(it) !== LN.row) continue;
        const x0 = S.timeToX(it.start, view), x1 = S.timeToX(it.start + E.ovLen(it), view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'tx', id: it.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'tx', id: it.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'tx', id: it.id, edge: 'body' };
      }
      return null;
    }
    if (LN && LN.kind === 'ov') {
      if (rowLocked('ov', LN.row)) return null;
      for (let k = ovl.length - 1; k >= 0; k--) {
        const o = ovl[k];
        if (rowOf(o) !== LN.row) continue;
        const x0 = S.timeToX(o.start, view), x1 = S.timeToX(E.ovEnd(o), view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'ov', id: o.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'ov', id: o.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'ov', id: o.id, edge: 'body' };
      }
      return null;
    }
    if (LN && LN.kind === 'au') {
      if (rowLocked('au', LN.row)) return null;
      for (let k = mus.length - 1; k >= 0; k--) {
        const o = mus[k];
        if (rowOf(o) !== LN.row) continue;
        const x0 = S.timeToX(o.start, view), x1 = S.timeToX(Math.min(E.ovEnd(o), total()), view);
        if (Math.abs(p.x - x0) <= 6 && p.x >= x0 - 2) return { lane: 'mu', id: o.id, edge: 'in' };
        if (Math.abs(p.x - x1) <= 6 && p.x <= x1 + 2) return { lane: 'mu', id: o.id, edge: 'out' };
        if (p.x > x0 && p.x < x1) return { lane: 'mu', id: o.id, edge: 'body' };
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
    if (hit && hit.id && (hit.lane === 'ov' || hit.lane === 'tx' || hit.lane === 'mu' || hit.lane === 'zm' || hit.lane === 'main') && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      togglePick(hit.id);
      return;
    }
    if (hit && hit.id && hit.lane !== 'cap' && !isPicked(hit.id)) picks = [];
    if (hit && (hit.lane === 'ov' || hit.lane === 'tx' || hit.lane === 'mu' || hit.lane === 'zm')) {
      const isTx = hit.lane === 'tx' || hit.lane === 'zm';          // no media length to keep to
      const arr = hit.lane === 'zm' ? 'zm' : (hit.lane === 'tx' ? 'txt' : (hit.lane === 'mu' ? 'mus' : 'ovl'));
      const o = ({ zm, txt, mus, ovl })[arr].find((x) => x.id === hit.id);
      if (sel !== hit.id) { sel = hit.id; renderInspector(); ST.showTab('clip'); }
      pushReviewUndo(hit.edge === 'body' ? 'move' : 'trim');
      drag = { kind: 'ov', arr, id: hit.id, edge: hit.edge, x0: p.x, start0: o.start, end0: E.ovEnd(o),
        len: !isTx && media[o.m] && !media[o.m].image ? media[o.m].dur : null,
        // the other selected items move with it (never the main track's clips)
        group: hit.edge === 'body' ? selected().filter((x) => x.id !== hit.id && x.arr !== 'clips').map((x) => ({ arr: x.arr, id: x.id, start0: findItem(x.id).start })) : [] };
      if (hit.edge === 'body') seek(S.xToTime(p.x, view));
    } else if (hit && hit.lane === 'main') {
      const c = clips.find((x) => x.id === hit.id);
      if (sel !== hit.id) { sel = hit.id; renderInspector(); ST.showTab('clip'); }
      if (hit.edge !== 'body') {
        pushReviewUndo('trim');
        syncSrc();
        drag = { kind: 'trim', id: hit.id, edge: hit.edge, x0: p.x, in0: c.in, out0: c.out, len: media[c.m] ? media[c.m].dur : Infinity, clips0: clips };
      } else {
        drag = { kind: 'move', id: hit.id, x0: p.x, moved: false, dropT: 0 };
        seek(S.xToTime(p.x, view));
      }
    } else if (hit && hit.lane === 'cap') {
      if (hit.edge !== 'body') { pushReviewUndo('timing'); drag = { kind: 'cap', i: hit.i, edge: hit.edge }; }
      else { seek(reviewCues[hit.i].start + 0.01); if (typeof focusReviewCue === 'function') focusReviewCue(hit.i, 0); }
    } else {
      sel = null; picks = []; renderInspector();
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
        if (drag.edge === 'body' && drag.arr !== 'zm') {
          const kind = drag.arr === 'txt' ? 'tx' : drag.arr === 'mus' ? 'au' : 'ov';
          const LN2 = laneAt(p.y);
          const list = drag.arr === 'txt' ? txt : drag.arr === 'mus' ? mus : ovl;
          const me = list.find((x) => x.id === drag.id);
          if (LN2 && LN2.kind === kind && me && LN2.row !== rowOf(me) && !rowLocked(kind, LN2.row)
            && !list.some((o) => o !== me && rowOf(o) === LN2.row && me.start < E.ovEnd(o) - 1e-6 && o.start < E.ovEnd(me) - 1e-6)) me.row = LN2.row;
        }
        if (drag.edge === 'body') {
          // snaps to the playhead and the main clips' edges (8 px)
          let st = drag.start0 + d;
          const snaps = [0, time()].concat(L().map((c) => c.s), L().map((c) => c.e));
          const near = snaps.find((x) => Math.abs((x - st) * view.pps) < 8);
          if (near != null) st = near;
          if (drag.group.length) st = Math.max(st, drag.start0 - Math.min.apply(null, drag.group.map((g) => g.start0)));
          if (drag.arr === 'zm') zm = E.ovMove(zm, drag.id, st);
          else if (drag.arr === 'txt') txt = E.ovMove(txt, drag.id, st); else if (drag.arr === 'mus') mus = E.ovMove(mus, drag.id, st); else ovl = E.ovMove(ovl, drag.id, st);
          drag.group.forEach((g) => setList(g.arr, E.ovMove(listOf(g.arr), g.id, g.start0 + st - drag.start0)));
        } else if (drag.arr === 'zm') {
          zm = E.ovTrim(zm, drag.id, drag.edge, (drag.edge === 'in' ? drag.start0 : drag.end0) + d, null).map((x) => (x.id === drag.id ? Object.assign({}, x, { in: 0, out: Math.max(0.3, Math.round((x.out - x.in) * 1000) / 1000) }) : x));
        } else if (drag.arr === 'txt') {
          txt = E.ovTrim(txt, drag.id, drag.edge, (drag.edge === 'in' ? drag.start0 : drag.end0) + d, null).map((x) => (x.id === drag.id ? Object.assign({}, x, { in: 0, out: Math.round((x.out - x.in) * 1000) / 1000 }) : x));
        } else if (drag.arr === 'mus') mus = E.ovTrim(mus, drag.id, drag.edge, (drag.edge === 'in' ? drag.start0 : drag.end0) + d, drag.len);
        else ovl = E.ovTrim(ovl, drag.id, drag.edge, (drag.edge === 'in' ? drag.start0 : drag.end0) + d, drag.len);
        frame(); drawSoon(); return;
      }
      if (drag.kind === 'trim') {
        const d = (p.x - drag.x0) / view.pps;
        const k0 = E.speedOf(clips.find((x) => x.id === drag.id) || {});
        clips = E.trimClip(clips, drag.id, drag.edge, drag.edge === 'in' ? drag.in0 + d * k0 : drag.out0 + d * k0, drag.len);
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
      canvas.style.cursor = hit && hit.edge && hit.edge !== 'body' ? 'ew-resize' : (hit && (hit.lane === 'main' || hit.lane === 'ov' || hit.lane === 'tx' || hit.lane === 'mu') ? 'grab' : (hit ? 'pointer' : 'text'));
      if (JSON.stringify(hit) !== JSON.stringify(hover)) { hover = hit; drawSoon(); }
    }
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'trim') { if (d.clips0) follow(d.clips0); derive(); after(); }
    else if (d.kind === 'ov') { after(); }
    else if (d.kind === 'cap') { renderReview(); ST.saveSoon(); }
    else if (d.kind === 'move' && d.moved && d.idx != null) {
      const from = clips.findIndex((c) => c.id === d.id);
      if (d.idx !== from) change('move', () => { const old = clips; clips = E.moveClip(clips, d.id, d.idx); follow(old); });
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

  // ── several selected · copy / paste / duplicate (1.70) ──────────────────
  const listOf = (arr) => ({ clips, ovl, txt, mus, zm })[arr];
  function setList(arr, v) {
    if (arr === 'clips') clips = v; else if (arr === 'ovl') ovl = v; else if (arr === 'txt') txt = v; else if (arr === 'mus') mus = v; else if (arr === 'zm') zm = v;
  }
  const arrOf = (id) => ['clips', 'ovl', 'txt', 'mus', 'zm'].find((a) => listOf(a).some((o) => o.id === id)) || null;
  function isPicked(id) { return !!id && (id === sel || picks.indexOf(id) >= 0); }
  // what is selected, in timeline order: [{ id, arr }]
  function selected() {
    const ids = [sel].concat(picks).filter((x, i, a) => x && a.indexOf(x) === i);
    return ids.map((id) => ({ id, arr: arrOf(id) })).filter((x) => x.arr);
  }
  function togglePick(id) {
    if (isPicked(id)) {
      picks = picks.filter((x) => x !== id);
      if (sel === id) sel = picks.pop() || null;
    } else {
      if (sel) picks.push(sel);
      sel = id;
    }
    renderInspector(); drawSoon(); sayPicked();
  }
  function sayPicked() {
    const n = selected().length;
    hint.textContent = n > 1 ? '☑ ' + n + ' ' + tx('ተመርጠዋል', 'selected') : '';
    hint.title = n > 1 ? tx('አብረው ይጎትቱ · Delete · Ctrl+C · Ctrl+D', 'Drag them together · Delete · Ctrl+C · Ctrl+D') : '';
  }
  function deleteMany(list) {
    const items = list.filter((x) => x.arr !== 'clips'), cl = list.filter((x) => x.arr === 'clips').map((x) => x.id);
    const keep = clips.filter((c) => cl.indexOf(c.id) < 0);
    change('delete', () => {
      items.forEach((x) => setList(x.arr, listOf(x.arr).filter((o) => o.id !== x.id)));
      if (cl.length && keep.length) { const old = clips; clips = keep; follow(old); }
    });
    if (cl.length && !keep.length) { hint.textContent = tx('የመጨረሻው ክሊፕ ሊሰረዝ አይችልም', 'The last clip cannot be removed'); setTimeout(() => { hint.textContent = ''; }, 2500); }
    sel = null; picks = [];
    seek(Math.min(time(), total()));
  }
  let CLIP = null;     // what Ctrl+C copied: { clips: [...], items: [{ arr, o }] }
  function copySel() {
    const list = selected();
    if (!list.length) return false;
    const LL = L();
    CLIP = {
      clips: LL.filter((c) => list.some((x) => x.id === c.id)).map((c) => clips.find((x) => x.id === c.id)),
      items: list.filter((x) => x.arr !== 'clips').map((x) => ({ arr: x.arr, o: findItem(x.id) })).sort((a, b) => a.o.start - b.o.start),
    };
    hint.textContent = '⧉ ' + tx('ተቀድቷል — Ctrl+V በማጫወቻው ቦታ', 'Copied — Ctrl+V at the playhead');
    setTimeout(() => { if (/Ctrl\+V/.test(hint.textContent)) hint.textContent = ''; }, 2500);
    return true;
  }
  // put CLIP in: its clips at tClips (into the main track), its items from tItems
  function pasteAt(data, tClips, tItems, label) {
    if (!data || (!data.clips.length && !data.items.length)) return;
    const fresh = [];
    change(label || 'paste', () => {
      if (data.clips.length) {
        const add = data.clips.map((c) => { const id = newId(); fresh.push(id); return Object.assign(JSON.parse(JSON.stringify(c)), { id }); });
        const old = clips;
        clips = E.insertClips(clips, Math.max(0, Math.min(tClips, total())), add, newId);
        follow(old, fresh);
      }
      if (data.items.length) {
        const t0 = data.items[0].o.start;
        data.items.forEach((x) => {
          const id = newId();
          fresh.push(id);
          // never past the end of the video (where it would never be seen)
          const at = Math.min(tItems + x.o.start - t0, total() - Math.min(E.ovLen(x.o), total()));
          const o = Object.assign(JSON.parse(JSON.stringify(x.o)), { id, start: Math.round(Math.max(0, at) * 1000) / 1000 });
          setList(x.arr, listOf(x.arr).concat([o]));
        });
      }
    });
    sel = fresh[fresh.length - 1] || sel;
    picks = fresh.slice(0, -1);
    after(); sayPicked();
  }
  function paste() {
    if (!CLIP) { hint.textContent = tx('መጀመሪያ ይቅዱ (Ctrl+C)', 'Copy something first (Ctrl+C)'); setTimeout(() => { hint.textContent = ''; }, 2000); return; }
    pasteAt(CLIP, time(), time(), 'paste');
  }
  // ⧉ a copy right after the selection (a clip: after that clip)
  function duplicate() {
    const list = selected();
    if (!list.length) { hint.textContent = tx('መጀመሪያ ይምረጡ', 'Select something first'); setTimeout(() => { hint.textContent = ''; }, 2000); return; }
    const keep = CLIP;
    copySel();
    const data = CLIP;
    CLIP = keep;
    const LL = L();
    const clipEnd = Math.max.apply(null, [0].concat(LL.filter((c) => data.clips.some((x) => x.id === c.id)).map((c) => c.e)));
    const itemEnd = Math.max.apply(null, [0].concat(data.items.map((x) => x.o.start + E.ovLen(x.o))));
    pasteAt(data, clipEnd, itemEnd, 'duplicate');
  }
  function cutSel() { if (copySel()) deleteMany(selected()); }

  function splitHere() {
    const t = time();
    const loc = E.locate(clips, t);
    if (!loc || t <= loc.clip.s + E.MIN / 2 || t >= loc.clip.e - E.MIN / 2) return;
    change('split', () => { clips = E.splitAt(clips, t, newId()); });
    sel = clips[loc.i + 1] ? clips[loc.i + 1].id : sel;
    after();
  }
  function deleteSel() {
    if (picks.length) { deleteMany(selected()); return; }
    if (sel && zm.some((o) => o.id === sel)) {
      const zid = sel;
      change('delete zoom', () => { zm = zm.filter((o) => o.id !== zid); });
      sel = null; after(); return;
    }
    if (sel && mus.some((o) => o.id === sel)) {
      const mid = sel;
      change('delete music', () => { mus = mus.filter((o) => o.id !== mid); });
      sel = null; after(); return;
    }
    if (sel && txt.some((o) => o.id === sel)) {
      const tid = sel;
      change('delete text', () => { txt = txt.filter((o) => o.id !== tid); });
      sel = null; after(); return;
    }
    if (sel && ovl.some((o) => o.id === sel)) {
      const oid = sel;
      change('delete overlay', () => { ovl = ovl.filter((o) => o.id !== oid); });
      sel = null; after(); return;
    }
    if (!sel) { hint.textContent = tx('መጀመሪያ ክሊፕ ይምረጡ', 'Select a clip first'); setTimeout(() => { hint.textContent = ''; }, 2000); return; }
    if (clips.length <= 1) { hint.textContent = tx('የመጨረሻው ክሊፕ ሊሰረዝ አይችልም', 'The last clip cannot be removed'); setTimeout(() => { hint.textContent = ''; }, 2500); return; }
    const id = sel;
    change('delete', () => { const old = clips; clips = E.removeClip(clips, id); follow(old); });
    sel = null;
    seek(Math.min(time(), total()));
  }
  // ✂ Clean up "cut them": ranges of the edit out of the main track, one step
  // 1.34: a sentence dragged in the Script view
  function moveRange(a, b, t) {
    change('move', () => { const old = clips; clips = E.moveRange(clips, a, b, t, newId); follow(old); });
    seek(Math.min(time(), total()));
  }
  function cutRanges(ranges) {
    const list = (ranges || []).slice().sort((a, b) => b.start - a.start);   // last first: earlier times stay valid
    if (!list.length) return;
    change('clean up', () => { const old = clips; list.forEach((r) => { clips = E.cutRange(clips, r.start, r.end, newId); }); follow(old); });
    seek(Math.min(time(), total()));
  }

  // ── keys ───────────────────────────────────────────────────────────────
  const typing = (x) => !!x && (/^(TEXTAREA|INPUT|SELECT)$/.test(x.tagName) || x.isContentEditable);
  document.addEventListener('keydown', (e) => {
    if (!review.classList.contains('show') || !built) return;
    // the Script view already used it (Ctrl+D there = cut the picked words)
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || '');
    if (mod && !e.altKey && (k.toLowerCase() === 'y' || (k.toLowerCase() === 'z' && e.shiftKey))) {
      if (typing(document.activeElement)) return;
      e.preventDefault(); redo(); return;
    }
    if (mod && !e.altKey && !e.shiftKey && !typing(document.activeElement) && !String(window.getSelection ? window.getSelection() : '')) {
      const c = k.toLowerCase();
      if (c === 'c' && copySel()) { e.preventDefault(); return; }
      if (c === 'x' && selected().length) { e.preventDefault(); cutSel(); return; }
      if (c === 'v' && CLIP) { e.preventDefault(); paste(); return; }
      if (c === 'd') { e.preventDefault(); duplicate(); return; }
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
  // a song under the whole edit: from the start (or the playhead, if there is
  // music already), as long as the edit, fades and ducking on
  function addMusic(id) {
    const m = media[id];
    const at = mus.length ? Math.min(time(), Math.max(0, total() - 0.5)) : 0;
    const len = Math.min(m.dur, Math.max(0.5, total() - at));
    const mid = newId();
    change('add music', () => { mus = mus.concat([{ id: mid, m: id, in: 0, out: Math.round(len * 1000) / 1000, start: Math.round(at * 1000) / 1000 }]); });
    sel = mid; after(); ST.showTab('clip');
  }
  async function addAndPlace(p) {
    const id = await addMedia(p);
    if (!id) return;
    const m = media[id];
    if (m.image) { addOverlay(id); renderMedia(); return; }
    if (!m.video) { addMusic(id); renderMedia(); return; }
    change('add clip', () => { clips = clips.concat([{ id: newId(), m: id, in: 0, out: Math.round(m.dur * 1000) / 1000 }]); });
    view = S.fitView(total(), width());
    renderMedia();
  }
  function renderMedia() {
    mediaPane.textContent = '';
    const head = el('div', 'ed-mhead');
    head.appendChild(btn('st-btn primary', '＋ ' + tx('ሚዲያ ያስገቡ', 'Import media'), '', importMedia));
    head.appendChild(el('span', 'st-note', tx('ወይም ቪዲዮ፣ ፎቶ ወይም ሙዚቃ ወደ መስኮቱ ይጎትቱ', 'or drop videos, photos or music onto the window')));
    mediaPane.appendChild(head);
    const grid = el('div', 'ed-mgrid');
    Object.keys(media).forEach((id) => {
      const m = media[id];
      const it = el('div', 'ed-mitem');
      if (m.image || m.video) {
        it.draggable = true;
        it.title = tx('ወደ አንድ ቃል ይጎትቱ — B-roll ይሆናል', 'Drag onto a word in the Script — it becomes B-roll');
        it.addEventListener('dragstart', (e) => { try { e.dataTransfer.setData('text/amh-media', id); e.dataTransfer.effectAllowed = 'copy'; } catch (x) {} });
      }
      const th = el('div', 'ed-mthumb', m.image ? '' : (m.video ? '🎬' : '♪'));
      if (m.image) { const im = el('img'); im.src = urlOf(id); th.appendChild(im); }
      th.appendChild(el('b', '', m.image ? '🖼' : S.fmtClock(m.dur)));
      it.appendChild(th);
      it.appendChild(el('div', 'ed-mname', m.name));
      const used = clips.filter((c) => c.m === id).length + ovl.filter((o) => o.m === id).length + mus.filter((o) => o.m === id).length;
      const caps = (SRC[id] || []).length;
      it.appendChild(el('div', 'ed-mmeta', (caps ? '✓ ' + tx('ካፕሽን አለው', 'captions') : tx('ካፕሽን የለውም', 'no captions')) + (used ? ' · ' + used + '× ' + tx('በጊዜ መስመሩ', 'on timeline') : '')));
      // 💬 captions for this file too (1.29.0)
      // (a song used only as music needs none)
      const onlyMusic = !m.video && !clips.some((c) => c.m === id) && mus.some((o) => o.m === id);
      if (!caps && m.audio && !m.image && !onlyMusic) {
        const job = CAPJOBS[id];
        if (job && job.busy) {
          it.appendChild(el('div', 'ed-mcap busy', '⏳ ' + tx('ካፕሽን እየተሰራ ነው… ', 'Making captions… ') + S.fmtClock((Date.now() - job.t0) / 1000)));
        } else {
          if (job && job.err) it.appendChild(el('div', 'ed-mcap err', job.err));
          it.appendChild(btn('st-btn primary ed-mcapbtn', '💬 ' + tx('ካፕሽን ይስሩ', 'Make captions'), tx('ይህን ፋይል ወደ ጽሑፍ ቀይር', 'Turn this file\'s speech into captions'), () => makeCaptions(id)));
        }
      }
      const row = el('div', 'ed-madd');
      if (!m.image) row.appendChild(btn('st-btn', '＋ ' + tx('ዋና', 'Main'), tx('በዋናው መስመር መጨረሻ', 'At the end of the main track'), () => change('add clip', () => {
        clips = clips.concat([{ id: newId(), m: id, in: 0, out: Math.round(m.dur * 1000) / 1000 }]);
      })));
      if (m.video) row.appendChild(btn('st-btn', '＋ ' + tx('ተደራቢ', 'Overlay'), tx('ከዋናው ቪዲዮ በላይ፣ ማጫወቻው ባለበት', 'Above the main video, at the playhead'), () => addOverlay(id)));
      if (m.audio && !m.image) row.appendChild(btn('st-btn', '＋ ♪ ' + tx('ሙዚቃ', 'Music'), tx('ከዋናው መስመር በታች፣ ሰው ሲናገር ይቀንሳል', 'Under the main track; quieter while someone speaks'), () => addMusic(id)));
      it.appendChild(row);
      grid.appendChild(it);
    });
    mediaPane.appendChild(grid);
  }
  // 💬 captions for another file of the project: the same engine as the first
  // one; they belong to that file, so every clip of it shows them
  const CAPJOBS = {};
  let capTimer = 0;
  async function makeCaptions(id) {
    const m = media[id];
    if (!m || (CAPJOBS[id] && CAPJOBS[id].busy) || typeof transcribeExtra !== 'function') return;
    CAPJOBS[id] = { busy: true, t0: Date.now() };
    renderMedia();
    if (!capTimer) capTimer = setInterval(() => { if (Object.keys(CAPJOBS).some((k) => CAPJOBS[k].busy)) { if (review.classList.contains('ed-mediamode')) renderMedia(); } else { clearInterval(capTimer); capTimer = 0; } }, 1000);
    try {
      const cues = await transcribeExtra(m.path);
      if (!media[id]) return;                     // the project was closed meanwhile
      const clean = cues.filter((c) => String(c.text || '').trim()).map((c) => {
        const o = { start: Number(c.start), end: Number(c.end), text: String(c.text) };
        if (Array.isArray(c.wt)) o.wt = c.wt;
        return o;
      });
      CAPJOBS[id] = { busy: false };
      if (!clean.length) { CAPJOBS[id].err = tx('በዚህ ፋይል ንግግር አልተገኘም።', 'No speech was found in this file.'); renderMedia(); return; }
      change('captions', () => { SRC[id] = clean; });
      log(tx('✓ ካፕሽን ተሰራ፦ ', '✓ Captions made: ') + m.name + ' (' + clean.length + ')');
    } catch (e) {
      CAPJOBS[id] = { busy: false, err: (e && e.message) ? e.message : String(e) };
    }
    renderMedia();
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
  // ── 📱 Wide -> TikTok (1.63): keep the speaker in the frame ──────────────
  // The face finder (app/amh_faces.py, a small MIT face model on the speech
  // engine's onnxruntime) answers 2 times a second; the answers are kept with
  // the file (media[id].faces), so it runs once per file.
  const appDir = () => ((window.__AMH_APP__ || {}).appdir) || '';
  const FACEJOBS = {};
  function findFaces(id, onProgress) {
    const m = media[id];
    if (!m || !m.video) return Promise.resolve(null);
    if (m.faces && m.faces.list) return Promise.resolve(m.faces);
    if (FACEJOBS[id]) return FACEJOBS[id];
    FACEJOBS[id] = new Promise((resolve) => {
      const script = appDir() ? path.join(appDir(), 'amh_faces.py') : '';
      if (!script || typeof PYTHON === 'undefined' || !PYTHON || !FFMPEG) { resolve(null); return; }
      let p;
      try { p = spawn(PYTHON, ['-E', '-s', script, FFMPEG, m.path, String(m.w || 1920), String(m.h || 1080), '2', '0', String(m.dur || 60)], { windowsHide: true }); } catch (e) { resolve(null); return; }
      let buf = '', res = null;
      p.stdout.on('data', (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          const mm = /^\[faces\] ([\d.]+)/.exec(line);
          if (mm) { if (onProgress) onProgress(Number(mm[1])); continue; }
          try { const j = JSON.parse(line); if (j && j.ok) res = j; } catch (e) {}
        }
      });
      p.on('close', () => {
        if (!res && buf.trim()) { try { const j = JSON.parse(buf.trim()); if (j && j.ok) res = j; } catch (e) {} }
        if (res) { m.faces = { fps: res.fps, list: res.faces }; ST.saveSoon(); }
        delete FACEJOBS[id];
        resolve(res ? m.faces : null);
      });
    });
    return FACEJOBS[id];
  }
  // how much of a clip's picture was a face (0-1)
  const faceShare = (m) => (m && m.faces && m.faces.list && m.faces.list.length ? m.faces.list.filter((f) => f.length > 2).length / m.faces.list.length : 0);
  // a framing for these clips (face: the camera path from the faces)
  function frameClips(ids, mode, pace) {
    const { w: W, h: H } = E.canvasSize(fmt);
    change('framing', () => {
      clips = clips.map((c) => {
        if (ids.indexOf(c.id) < 0) return c;
        const m = media[c.m];
        if (!m || !m.video) return c;
        if (mode === 'off') return Object.assign({}, c, { rf: null, rfk: null });
        const n = Object.assign({}, c, { rf: { mode, pace: pace || 'normal' }, x: 0, y: 0 });
        n.rfk = mode === 'face' && m.faces ? E.rfTrack(m.faces.list, m, n, W, H, pace || 'normal') : null;
        if (mode === 'face' && !(n.rfk && n.rfk.length)) n.rf = { mode: 'center', pace: n.rf.pace, noface: true };
        return n;
      });
    });
  }
  // follow the faces in these clips: find them first (once per file)
  async function followFaces(ids, pace, say) {
    const need = Array.from(new Set(clips.filter((c) => ids.indexOf(c.id) >= 0 && media[c.m] && media[c.m].video).map((c) => c.m)));
    for (let i = 0; i < need.length; i++) {
      await findFaces(need[i], (q) => { if (say) say(Math.round(((i + q) / need.length) * 100)); });
    }
    frameClips(ids, 'face', pace);
  }
  // the camera path follows the canvas: a new format or size makes it again
  function reframeAll() {
    const { w: W, h: H } = E.canvasSize(fmt);
    clips = clips.map((c) => {
      if (!E.rfOn(c) || c.rf.mode !== 'face') return c;
      const m = media[c.m];
      return m && m.faces ? Object.assign({}, c, { rfk: E.rfTrack(m.faces.list, m, c, W, H, c.rf.pace) }) : c;
    });
  }
  // the offer after a tall / square format is chosen for wide clips
  const rfOffer = el('div', 'ed-rfoffer');
  rfOffer.style.display = 'none';
  if (pv) pv.insertBefore(rfOffer, fmtBar.nextSibling);
  function wideClips() {
    const { w: W, h: H } = E.canvasSize(fmt);
    return clips.filter((c) => { const m = media[c.m]; return m && m.video && !E.rfOn(c) && E.rfWindow(m, c, W, H).ww < 0.9; });
  }
  function showRfOffer() {
    const list = wideClips();
    if (!list.length) { rfOffer.style.display = 'none'; return; }
    rfOffer.textContent = '';
    rfOffer.appendChild(el('span', 'ed-rf-t', '🎯 ' + tx('ተናጋሪው ከፍሬሙ እንዳይወጣ ፊቱን ልከተል?', 'Keep the speaker in the frame — follow the face?')));
    const go = btn('st-btn primary', '🎯 ' + tx('ፊቱን ተከተል', 'Follow the face'), '', async () => {
      go.disabled = true;
      const ids = wideClips().map((c) => c.id);
      await followFaces(ids, 'normal', (pc) => { go.textContent = '⏳ ' + tx('ፊት እየፈለግሁ… ', 'Finding faces… ') + pc + '%'; });
      const n = clips.filter((c) => ids.indexOf(c.id) >= 0 && c.rf && c.rf.mode === 'face').length;
      rfOffer.textContent = '';
      rfOffer.appendChild(el('span', 'ed-rf-t', n ? '✓ ' + tx('ፊቱ በ' + n + ' ክሊፖች ይከተላል — በ⚙ ክሊፕ ይቀይሩ።', 'Following the face in ' + n + ' clip(s) — change it in ⚙ Clip.')
        : tx('ፊት አልተገኘም — መሃሉ ይታያል።', 'No face found — the centre is shown.')));
      setTimeout(() => { rfOffer.style.display = 'none'; }, 4000);
    });
    rfOffer.appendChild(go);
    rfOffer.appendChild(btn('st-btn', tx('አሁን አይደለም', 'Not now'), '', () => { rfOffer.style.display = 'none'; }));
    rfOffer.style.display = '';
  }
  // ⚙ Clip: the framing of a wide picture in a tall frame (and the other way)
  function renderFraming(c) {
    const m = media[c.m];
    const { w: W, h: H } = E.canvasSize(fmt);
    if (!m || !m.video) return;
    const win = E.rfWindow(m, c, W, H);
    if (win.ww > 0.97 && win.wh > 0.97) return;
    clipPane.appendChild(el('div', 'ed-sec', '📱 ' + tx('ፍሬም', 'Framing')));
    const mode = E.rfOn(c) ? c.rf.mode : 'off';
    const row = el('div', 'br-chips');
    [['face', '🎯 ' + tx('ፊቱን ተከተል', 'Follow the face')], ['center', tx('መሃል', 'Centre')], ['left', '← ' + tx('ግራ', 'Left')], ['right', tx('ቀኝ', 'Right') + ' →'], ['off', tx('በእጅ', 'By hand')]].forEach(([v, t]) => {
      row.appendChild(btn('br-chip' + (mode === v ? ' on' : ''), t, '', async () => {
        if (v === 'face') {
          const b = row.firstChild;
          b.textContent = '⏳ ' + tx('ፊት እየፈለግሁ…', 'Finding faces…');
          await followFaces([c.id], (c.rf && c.rf.pace) || 'normal', (pc) => { b.textContent = '⏳ ' + pc + '%'; });
        } else frameClips([c.id], v, (c.rf && c.rf.pace) || 'normal');
      }));
    });
    clipPane.appendChild(row);
    if (mode === 'face') {
      const s2 = el('div', 'st-seg');
      [['calm', tx('ረጋ ያለ', 'Calm')], ['normal', tx('መደበኛ', 'Normal')], ['fast', tx('ፈጣን', 'Quick')]].forEach(([v, t]) => {
        s2.appendChild(btn(((c.rf && c.rf.pace) || 'normal') === v ? 'on' : '', t, tx('ካሜራው ምን ያህል በፍጥነት ይከተላል', 'How quickly the camera follows'), () => frameClips([c.id], 'face', v)));
      });
      clipPane.appendChild(s2);
      const share = Math.round(faceShare(m) * 100);
      clipPane.appendChild(el('div', 'st-note', tx('ፊት በ' + share + '% ቪዲዮው ውስጥ ተገኝቷል። ካሜራው ፊቱ ሲርቅ ብቻ በለስላሳ ይንቀሳቀሳል።', 'A face is in ' + share + '% of the video. The camera only moves, smoothly, when the face moves away.')));
    } else if (c.rf && c.rf.noface) {
      clipPane.appendChild(el('div', 'st-note', tx('በዚህ ክሊፕ ፊት አልተገኘም — መሃሉ ይታያል።', 'No face was found in this clip — the centre is shown.')));
    }
    const all = clips.filter((x) => media[x.m] && media[x.m].video && x.id !== c.id);
    if (all.length && mode !== 'off') {
      clipPane.appendChild(btn('st-btn', tx('ይህን ፍሬም ለሁሉም ክሊፖች', 'This framing for all clips'), '', async () => {
        const ids = clips.map((x) => x.id);
        if (mode === 'face') await followFaces(ids, (c.rf && c.rf.pace) || 'normal');
        else frameClips(ids, mode, (c.rf && c.rf.pace) || 'normal');
      }));
    }
  }
  function renderInspector() {
    clipPane.textContent = '';
    setTimeout(() => {
      if (clipPane.querySelector('.ed-row:not(.simple-ok), .pro-only') && !clipPane.querySelector('.ed-simplenote')) {
        const n = el('div', 'st-note ed-simplenote', tx('ተጨማሪ ትክክለኛ ማስተካከያዎች በ «ፕሮ» ውስጥ ናቸው (ከጊዜ መስመሩ በላይ)።', 'More exact settings are in «Pro» (above the timeline).'));
        clipPane.appendChild(n);
      }
    }, 0);
    const zo = zm.find((x) => x.id === sel);
    if (zo) { renderZoomInspector(zo); return; }
    const ov = ovl.find((x) => x.id === sel);
    if (ov) { renderOverlayInspector(ov); return; }
    const ti = txt.find((x) => x.id === sel);
    if (ti) { if (ti.tpl) renderTemplateInspector(ti); else renderTextInspector(ti); return; }
    const mu = mus.find((x) => x.id === sel);
    if (mu) { renderMusicInspector(mu); return; }
    const c = clips.find((x) => x.id === sel);
    if (!c) { clipPane.appendChild(el('div', 'st-note', tx('በጊዜ መስመሩ ላይ ክሊፕ ይምረጡ — ከዚያ መጠኑን፣ ቦታውንና ድምፁን እዚህ ያስተካክሉ።', 'Select a clip on the timeline — then set its size, position and volume here.'))); return; }
    const lc = L().find((x) => x.id === c.id);
    clipPane.appendChild(el('div', 'ed-cname', (media[c.m] ? media[c.m].name : '') + ' · ' + S.fmtClock(lc ? lc.e - lc.s : 0, true)));
    renderFraming(c);
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
    clipPane.appendChild(el('div', 'ed-sec pro-only', tx('ቦታና መጠን', 'Size and position')));
    slider(tx('መጠን', 'Size'), 'scale', 0.5, 3, 0.01, 1, (v) => Math.round(v * 100) + '%');
    slider('X', 'x', -0.5, 0.5, 0.005, 0, (v) => Math.round(v * 100));
    slider('Y', 'y', -0.5, 0.5, 0.005, 0, (v) => Math.round(v * 100));
    clipPane.appendChild(el('div', 'ed-sec', tx('ድምፅ', 'Sound')));
    slider(tx('ድምፅ', 'Volume'), 'volume', 0, 2, 0.01, 1, (v) => Math.round(v * 100) + '%');
    clipPane.lastChild.classList.add('simple-ok');
    renderFx(c);
    const row = el('div', 'st-row');
    row.appendChild(btn('st-btn', tx('ወደ መጀመሪያው መልስ', 'Reset'), '', () => change('clip', () => {
      clips = clips.map((x) => (x.id === c.id ? Object.assign({}, x, { scale: 1, x: 0, y: 0, volume: 1, speed: 1, col: null }) : x));
    })));
    row.appendChild(btn('st-btn', '✂ ' + tx('ቁረጥ (S)', 'Split (S)'), '', splitHere));
    row.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(row);
  }

  // speed, colour, the transition into this clip (1.24.0)
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const TRN = () => [['none', tx('የለም', 'None')], ['fade', tx('መቀላቀል', 'Dissolve')], ['fadeblack', tx('በጥቁር', 'Dip to black')], ['fadewhite', tx('በነጭ', 'Dip to white')],
    ['slideleft', tx('መንሸራተት', 'Slide')], ['wipeleft', tx('መጥረግ', 'Wipe')], ['circleopen', tx('ክብ', 'Circle')], ['zoomin', tx('ማጉላት', 'Zoom')]];
  const LOOKN = () => [['none', tx('የመጀመሪያው', 'Original')], ['warm', tx('ሞቅ ያለ', 'Warm')], ['cool', tx('ቀዝቃዛ', 'Cool')], ['bw', tx('ጥቁርና ነጭ', 'B&W')],
    ['vivid', tx('ደማቅ', 'Vivid')], ['cine', tx('ሲኒማ', 'Cinematic')], ['faded', tx('የደበዘዘ', 'Faded')]];
  function renderFx(c) {
    const set = (props) => { clips = clips.map((x) => (x.id === c.id ? Object.assign({}, x, props) : x)); };
    // ⏩ speed
    clipPane.appendChild(el('div', 'ed-sec pro-only', '⏩ ' + tx('ፍጥነት', 'Speed')));
    const srow = el('div', 'st-seg ed-speeds pro-only');
    SPEEDS.forEach((k) => srow.appendChild(btn(E.speedOf(c) === k ? 'on' : '', k + '×', '', () => change('speed', () => { const old = clips; set({ speed: k }); follow(old); }))));
    clipPane.appendChild(srow);
    if (E.speedOf(c) !== 1) clipPane.appendChild(el('div', 'st-note', tx('ድምፁ የራሱን ቅላጼ ይይዛል፤ ካፕሽኖቹ ከቃላቱ ጋር ይሄዳሉ።', 'The voice keeps its pitch; the captions stay on their words.')));
    // 🎨 colour
    clipPane.appendChild(el('div', 'ed-sec', '🎨 ' + tx('ቀለም', 'Colour')));
    const looks = el('div', 'ed-looks');
    const curLook = (c.col && c.col.look) || 'none';
    LOOKN().forEach(([id, name]) => {
      const b = btn('ed-look' + (curLook === id ? ' on' : ''), '', '', () => change('colour', () => { set({ col: id === 'none' ? null : Object.assign({ look: id }, E.LOOKS[id]) }); }));
      const sw = el('span', 'ed-lsw');
      const { m, o } = E.colorMatrix(E.LOOKS[id]);
      const tint = (r, g, bb) => 'rgb(' + [0, 1, 2].map((k) => Math.round(255 * Math.max(0, Math.min(1, m[k * 3] * r + m[k * 3 + 1] * g + m[k * 3 + 2] * bb + o)))).join(',') + ')';
      sw.style.background = 'linear-gradient(90deg,' + tint(0.85, 0.55, 0.35) + ',' + tint(0.35, 0.6, 0.45) + ',' + tint(0.3, 0.45, 0.8) + ')';
      b.appendChild(sw); b.appendChild(el('span', '', name));
      looks.appendChild(b);
    });
    clipPane.appendChild(looks);
    const cslider = (label, key, min, max, step, show) => {
      const row = el('div', 'ed-row');
      row.appendChild(el('span', 'ed-lab', label));
      const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step;
      r.value = c.col && c.col[key] != null ? c.col[key] : E.LOOKS.none[key];
      const val = el('span', 'ed-val', show(Number(r.value)));
      let started = false;
      r.addEventListener('input', () => {
        if (!started) { pushReviewUndo('colour'); started = true; }
        const cur2 = clips.find((x) => x.id === c.id);
        set({ col: Object.assign({}, E.LOOKS.none, (cur2 && cur2.col) || {}, { [key]: Number(r.value) }) });
        val.textContent = show(Number(r.value));
        frame();
      });
      r.addEventListener('change', () => { started = false; ST.saveSoon(); drawSoon(); });
      row.appendChild(r); row.appendChild(val);
      clipPane.appendChild(row);
    };
    const pct = (v) => (v > 0 ? '+' : '') + Math.round(v * 100);
    cslider(tx('ብርሃን', 'Brightness'), 'bright', -0.5, 0.5, 0.01, pct);
    cslider(tx('ንፅፅር', 'Contrast'), 'contrast', 0.5, 1.5, 0.01, (v) => pct(v - 1));
    cslider(tx('ቀለም ሙሌት', 'Saturation'), 'sat', 0, 2, 0.01, (v) => pct(v - 1));
    cslider(tx('ሙቀት', 'Temperature'), 'temp', -1, 1, 0.01, pct);
    if (E.colorOn(c.col)) {
      const crow = el('div', 'st-row');
      crow.appendChild(btn('st-btn', '🎨 ' + tx('ለሁሉም ክሊፖች', 'Apply to all clips'), tx('ይህን ቀለም ለሁሉም ክሊፖች', 'Give every clip this colour'), () => change('colour', () => { const col = c.col; clips = clips.map((x) => Object.assign({}, x, { col })); })));
      clipPane.appendChild(crow);
    }
    // ⧓ the transition into this clip
    const i = clips.findIndex((x) => x.id === c.id);
    if (i < 1) return;
    clipPane.appendChild(el('div', 'ed-sec', '⧓ ' + tx('ከቀደመው ክሊፕ ሽግግር', 'Transition from the clip before')));
    const trow = el('div', 'st-seg ed-trans');
    const curT = c.tr && c.tr.type ? c.tr.type : 'none';
    TRN().forEach(([id, name]) => trow.appendChild(btn(curT === id ? 'on' : '', name, '', () => {
      change('transition', () => { set({ tr: id === 'none' ? null : { type: id, d: (c.tr && c.tr.d) || 0.5 } }); });
      if (id !== 'none') { const LL = L(); seek(Math.max(0, LL[i].s - 0.6)); }
    })));
    clipPane.appendChild(trow);
    if (curT !== 'none') {
      const row = el('div', 'ed-row');
      row.appendChild(el('span', 'ed-lab', tx('ርዝመት', 'Length')));
      const r = el('input'); r.type = 'range'; r.min = 0.2; r.max = 2; r.step = 0.05;
      r.value = (c.tr && c.tr.d) || 0.5;
      const val = el('span', 'ed-val', Number(r.value).toFixed(2) + ' s');
      let started = false;
      r.addEventListener('input', () => {
        if (!started) { pushReviewUndo('transition'); started = true; }
        set({ tr: { type: curT, d: Number(r.value) } });
        val.textContent = Number(r.value).toFixed(2) + ' s';
        drawSoon(); frame();
      });
      r.addEventListener('change', () => { started = false; ST.saveSoon(); });
      row.appendChild(r); row.appendChild(val);
      clipPane.appendChild(row);
      const ar = el('div', 'st-row');
      ar.appendChild(btn('st-btn', '⧓ ' + tx('ለሁሉም ቁርጦች', 'Apply to all cuts'), '', () => change('transition', () => {
        const tr = clips[i].tr;
        clips = clips.map((x, k) => (k ? Object.assign({}, x, { tr: Object.assign({}, tr) }) : x));
      })));
      ar.appendChild(btn('st-btn', '▶ ' + tx('አሳይ', 'Preview'), '', () => { const LL = L(); seek(Math.max(0, LL[i].s - 1.2)).then(() => play()); }));
      clipPane.appendChild(ar);
      if (E.trDur(clips, i) < Number(r.value) - 0.01) clipPane.appendChild(el('div', 'st-note', tx('ክሊፑ አጭር ስለሆነ ሽግግሩ አጠረ።', 'Shortened to fit the clip.')));
    }
  }

  // ── 🎞 B-roll (1.61): a photo or a video over the main video, made to look
  // finished in a few clicks — layout, how it comes in and goes, motion inside.
  // Added from a word in the Script view (its word or its sentence), by
  // dragging media onto a word, or from Media (＋ Overlay).
  const BR_LAYOUTS = {
    full: [tx('ሙሉ ገጽ', 'Full screen'), tx('ሙሉውን ይሞላል', 'Fills the frame')],
    blur: [tx('ደብዛዛ ጀርባ', 'Blurred back'), tx('ሙሉ ስዕሉ፣ ጀርባው ደብዛዛ', 'Whole picture on a blur')],
    whole: [tx('ሙሉውን', 'Whole'), tx('ሙሉ ስዕሉ፣ ጥቁር ጠርዝ', 'Whole picture, black bars')],
    pip: [tx('ትንሽ መስኮት', 'Picture in picture'), tx('በጥግ ላይ ትንሽ', 'Small, in a corner')],
    top: [tx('የላይ ግማሽ', 'Top half'), tx('ለ TikTok ጥሩ', 'Great for TikTok')],
    bottom: [tx('የታች ግማሽ', 'Bottom half'), tx('ተናጋሪው ከላይ ይታያል', 'The speaker stays on top')],
    free: [tx('ነፃ', 'Free'), tx('በእጅ ይጎትቱ፣ መጠኑን ይምረጡ', 'Drag it, set its size')],
  };
  const BR_IN = { none: tx('የለም', 'None'), fade: tx('ደብዝዞ', 'Fade'), left: '← ' + tx('ከግራ', 'From left'), right: tx('ከቀኝ', 'From right') + ' →',
    up: '↑ ' + tx('ከታች', 'From below'), down: '↓ ' + tx('ከላይ', 'From above') };
  const BR_OUT = { none: tx('የለም', 'None'), fade: tx('ደብዝዞ', 'Fade'), left: '← ' + tx('ወደ ግራ', 'To the left'), right: tx('ወደ ቀኝ', 'To the right') + ' →',
    up: '↑ ' + tx('ወደ ላይ', 'Up'), down: '↓ ' + tx('ወደ ታች', 'Down') };
  const BR_MOT = { none: tx('የለም', 'None'), in: tx('ቀስ ብሎ ቅረብ', 'Slow zoom in'), out: tx('ቀስ ብሎ ራቅ', 'Slow zoom out'), pan: tx('ተንሸራተት', 'Pan') };
  const LOOK_KEYS = ['layout', 'corner', 'size', 'border', 'ain', 'aout', 'ad', 'mot'];
  function brollLast(m) {
    let s = {};
    try { s = (typeof loadSettings === 'function' && loadSettings().brollLast) || {}; } catch (e) {}
    const look = { layout: 'full', ain: 'fade', aout: 'fade', ad: 0.35, mot: m && m.image ? 'in' : 'none' };
    LOOK_KEYS.forEach((k) => { if (s[k] != null) look[k] = s[k]; });
    if (m && !m.image && look.mot !== 'none' && !s.motVideo) look.mot = 'none';      // motion is for photos unless chosen for videos
    return look;
  }
  function rememberBroll(o) {
    const keep = {};
    LOOK_KEYS.forEach((k) => { if (o[k] != null) keep[k] = o[k]; });
    try { if (typeof saveSettings === 'function') saveSettings({ brollLast: keep }); } catch (e) {}
  }
  // a B-roll from `a` to `b` (edit seconds)
  function addBroll(mid, a, b) {
    const m = media[mid];
    if (!m || (!m.image && !m.video)) return null;
    const start = Math.max(0, Math.min(Number(a) || 0, total() - 0.3));
    let len = Math.max(0.6, (Number(b) || start + 3) - start);
    if (!m.image) len = Math.min(len, m.dur);
    len = Math.min(len, total() - start);
    const oid = newId();
    const it = Object.assign({ id: oid, m: mid, in: 0, out: Math.round(len * 1000) / 1000, start: Math.round(start * 1000) / 1000, volume: 0 }, brollLast(m));
    change('add B-roll', () => { ovl = ovl.concat([it]); });
    sel = oid; after(); ST.showTab('clip');
    return it;
  }
  // the picker under a word: "this word / its sentence", then a picture
  let picker = null;
  function brollPicker(anchor, word, sentence) {
    if (picker) picker.remove();
    picker = el('div', 'br-pick');
    let mode = 'sentence';
    try { mode = (typeof loadSettings === 'function' && loadSettings().brollLen) === 'word' ? 'word' : 'sentence'; } catch (e) {}
    const draw = () => {
      picker.textContent = '';
      const head = el('div', 'br-pick-head');
      head.appendChild(el('b', '', '🎞 ' + tx('B-roll ጨምር', 'Add B-roll')));
      head.appendChild(btn('br-x', '✕', tx('ዝጋ', 'Close'), () => { picker.remove(); picker = null; }));
      picker.appendChild(head);
      const seg = el('div', 'st-seg br-len');
      [['word', tx('ለዚህ ቃል', 'This word') + ' · ' + S.fmtClock(Math.max(0.6, word.e - word.s), true)],
        ['sentence', tx('ለዓረፍተ ነገሩ', 'The sentence') + ' · ' + S.fmtClock(Math.max(0.6, sentence.e - sentence.s), true)]].forEach(([v, t]) => {
        seg.appendChild(btn(mode === v ? 'on' : '', t, '', () => { mode = v; try { saveSettings({ brollLen: v }); } catch (e) {} draw(); }));
      });
      picker.appendChild(seg);
      const grid = el('div', 'br-pick-grid');
      const ids = Object.keys(media).filter((id) => media[id].image || media[id].video);
      ids.forEach((id) => {
        const m = media[id];
        const b = btn('br-pick-it', '', m.name, () => {
          const r = mode === 'word' ? word : sentence;
          picker.remove(); picker = null;
          addBroll(id, r.s, Math.max(r.e, r.s + 0.6));
        });
        const th = el('span', 'br-pick-th');
        if (m.image) { const im = el('img'); im.src = urlOf(id); th.appendChild(im); } else th.textContent = '🎬';
        b.appendChild(th);
        b.appendChild(el('span', 'br-pick-n', m.name));
        grid.appendChild(b);
      });
      picker.appendChild(grid);
      if (!ids.length) picker.appendChild(el('div', 'st-note', tx('ገና ፎቶ ወይም ቪዲዮ የለም — ያስገቡ።', 'No photos or videos yet — import some.')));
      picker.appendChild(btn('st-btn br-imp', '＋ ' + tx('ፎቶ ወይም ቪዲዮ ያስገቡ', 'Import a photo or video'), '', async () => {
        await importMedia();
        if (picker) draw();
      }));
      picker.appendChild(el('div', 'st-note', tx('ወይም ፎቶ/ቪዲዮ ከ «ሚዲያ» ወደ ቃሉ ይጎትቱ።', 'Or drag a photo / video from Media onto a word.')));
    };
    draw();
    picker._t = Date.now();
    document.body.appendChild(picker);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 100, bottom: 100 };
    picker.style.left = Math.max(8, Math.min(window.innerWidth - 330, r.left)) + 'px';
    picker.style.top = Math.max(8, Math.min(window.innerHeight - 380, r.bottom + 6)) + 'px';
  }
  // (the press that opened it is not a press outside it)
  document.addEventListener('mousedown', (e) => { if (picker && Date.now() - picker._t > 300 && !picker.contains(e.target)) { picker.remove(); picker = null; } });

  function renderOverlayInspector(o) {
    const m = media[o.m] || {};
    const L = E.ovLook(o);
    const setO = (props, label) => {
      change(label || 'B-roll', () => { ovl = ovl.map((x) => (x.id === o.id ? Object.assign({}, x, props) : x)); });
      const cur = ovl.find((x) => x.id === o.id);
      if (cur && E.ovLook(cur).layout !== 'free') rememberBroll(cur);
    };
    clipPane.appendChild(el('div', 'ed-cname', (m.image ? '🖼 ' : '🎞 ') + (m.name || '') + ' · ' + S.fmtClock(E.ovLen(o), true)));
    // layout cards, each a small drawing of the frame
    clipPane.appendChild(el('div', 'ed-sec', tx('አቀማመጥ', 'Layout')));
    const grid = el('div', 'br-grid');
    ['full', 'blur', 'whole', 'pip', 'top', 'bottom', 'free'].forEach((lay) => {
      const b = btn('br-card' + (L.layout === lay ? ' on' : '') + (lay === 'free' && L.layout !== 'free' ? ' pro-only' : ''), '', BR_LAYOUTS[lay][1], () => setO({ layout: lay }));
      const d = el('span', 'br-d br-d-' + lay);
      d.appendChild(el('i', 'br-d-main'));
      d.appendChild(el('i', 'br-d-pic'));
      b.appendChild(d);
      b.appendChild(el('b', '', BR_LAYOUTS[lay][0]));
      grid.appendChild(b);
    });
    clipPane.appendChild(grid);
    if (L.layout === 'pip') {
      const row = el('div', 'br-pip');
      const cg = el('div', 'br-corner');
      ['tl', 'tr', 'bl', 'br'].forEach((c) => cg.appendChild(btn('br-cdot' + (L.corner === c ? ' on' : ''), '', '', () => setO({ corner: c }))));
      row.appendChild(cg);
      const right = el('div', 'br-pip-r');
      const sz = el('div', 'st-seg');
      [[0.28, tx('ትንሽ', 'Small')], [0.38, tx('መካከለኛ', 'Medium')], [0.48, tx('ትልቅ', 'Large')]].forEach(([v, t]) => {
        sz.appendChild(btn(Math.abs(L.size - v) < 0.01 ? 'on' : '', t, '', () => setO({ size: v })));
      });
      right.appendChild(sz);
      const bd = el('div', 'st-seg');
      [['none', tx('ጠርዝ የለም', 'No border')], ['white', tx('ነጭ ጠርዝ', 'White')], ['black', tx('ጥቁር ጠርዝ', 'Black')]].forEach(([v, t]) => {
        bd.appendChild(btn(L.border === v ? 'on' : '', t, '', () => setO({ border: v })));
      });
      right.appendChild(bd);
      row.appendChild(right);
      clipPane.appendChild(row);
    }
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
    if (L.layout === 'free') {
      slider(tx('መጠን', 'Size'), 'scale', 0.05, 3, 0.01, 1, (v) => Math.round(v * 100) + '%');
      slider('X', 'x', -0.6, 0.6, 0.005, 0, (v) => Math.round(v * 100));
      slider('Y', 'y', -0.6, 0.6, 0.005, 0, (v) => Math.round(v * 100));
      const fitRow = el('div', 'st-seg ed-fit');
      [['cover', tx('ሙላ', 'Fill')], ['contain', tx('ሙሉውን አሳይ', 'Whole')]].forEach(([f, t]) => {
        const cur2 = o.fit || (m.image ? 'contain' : 'cover');
        fitRow.appendChild(btn(cur2 === f ? 'on' : '', t, '', () => setO({ fit: f })));
      });
      clipPane.appendChild(fitRow);
    }
    const segRow = (title, map, cur, key) => {
      clipPane.appendChild(el('div', 'ed-sec', title));
      const s2 = el('div', 'br-chips');
      Object.keys(map).forEach((v) => s2.appendChild(btn('br-chip' + (cur === v ? ' on' : ''), map[v], '', () => setO({ [key]: v }))));
      clipPane.appendChild(s2);
    };
    segRow(tx('ሲገባ', 'Comes in'), BR_IN, L.ain, 'ain');
    segRow(tx('ሲወጣ', 'Goes out'), BR_OUT, L.aout, 'aout');
    clipPane.appendChild(el('div', 'ed-sec', tx('የአገባብ ፍጥነት', 'In / out speed')));
    const sp = el('div', 'st-seg');
    [[0.2, tx('ፈጣን', 'Fast')], [0.35, tx('መደበኛ', 'Normal')], [0.7, tx('ቀስ', 'Slow')]].forEach(([v, t]) => sp.appendChild(btn(Math.abs(L.ad - v) < 0.01 ? 'on' : '', t, '', () => setO({ ad: v }))));
    clipPane.appendChild(sp);
    segRow(tx('እንቅስቃሴ በውስጡ', 'Motion inside'), BR_MOT, L.mot, 'mot');
    clipPane.appendChild(el('div', 'ed-sec', tx('ግልጽነትና ድምፅ', 'Opacity and sound')));
    slider(tx('ግልጽነት', 'Opacity'), 'opacity', 0, 1, 0.01, 1, (v) => Math.round(v * 100) + '%');
    if (!m.image && m.audio) { slider(tx('ድምፅ', 'Volume'), 'volume', 0, 2, 0.01, 0, (v) => (v ? Math.round(v * 100) + '%' : tx('ድምፅ የለም', 'muted'))); clipPane.lastChild.classList.add('simple-ok'); }
    sfxRow(o.sfx, (v) => setO({ sfx: v }));
    const row = el('div', 'st-row br-acts');
    row.appendChild(btn('st-btn primary', '▶ ' + tx('አሳይ', 'Preview'), '', () => {
      const z = ovl.find((x) => x.id === o.id) || o;
      seek(Math.max(0, z.start - 0.5)); play();
      const end = E.ovEnd(z) + 0.6;
      const stop = () => { if (time() >= end) pause(); else if (playing) requestAnimationFrame(stop); };
      requestAnimationFrame(stop);
    }));
    row.appendChild(btn('st-btn', tx('ይህን መልክ ለሁሉም B-roll', 'This look for all B-roll'), '', () => {
      const z = ovl.find((x) => x.id === o.id) || o;
      const look = {};
      LOOK_KEYS.forEach((k) => { if (z[k] != null) look[k] = z[k]; });
      change('B-roll all', () => { ovl = ovl.map((x) => (E.ovLook(x).layout === 'free' && x.id !== z.id ? x : Object.assign({}, x, look))); });
    }));
    row.appendChild(btn('st-btn', '⤓ ' + tx('ወደ ማጫወቻው', 'To playhead'), tx('እዚህ እንዲጀምር', 'Start it here'), () => change('move overlay', () => { ovl = E.ovMove(ovl, o.id, time()); })));
    row.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(row);
  }

  function renderMusicInspector(o) {
    const m = media[o.m] || {};
    clipPane.appendChild(el('div', 'ed-cname', '♪ ' + (m.name || '') + ' · ' + S.fmtClock(Math.min(E.ovLen(o), total() - o.start), true)));
    const slider = (label, key, min, max, step, show) => {
      const row = el('div', 'ed-row');
      row.appendChild(el('span', 'ed-lab', label));
      const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step;
      r.value = o[key] == null ? E.MUS_DEFAULT[key] : o[key];
      const val = el('span', 'ed-val', show(Number(r.value)));
      let started = false;
      r.addEventListener('input', () => {
        if (!started) { pushReviewUndo('music'); started = true; }
        const v = Number(r.value);
        mus = mus.map((x) => (x.id === o.id ? Object.assign({}, x, { [key]: v }) : x));
        val.textContent = show(v);
        drawSoon(); syncMusic(time());
      });
      r.addEventListener('change', () => { started = false; ST.saveSoon(); drawSoon(); });
      row.appendChild(r); row.appendChild(val);
      clipPane.appendChild(row);
    };
    const sec = (v) => (Math.round(v * 10) / 10) + ' s';
    clipPane.appendChild(el('div', 'ed-sec', tx('ድምፅ', 'Sound')));
    slider(tx('ድምፅ', 'Volume'), 'volume', 0, 1.5, 0.01, (v) => Math.round(v * 100) + '%');
    clipPane.lastChild.classList.add('simple-ok');
    slider(tx('ሲናገሩ ቀንስ', 'Duck under speech'), 'duck', 0, 1, 0.05, (v) => (v ? Math.round(v * 100) + '%' : tx('አይቀንስም', 'off')));
    clipPane.lastChild.classList.add('simple-ok');
    clipPane.appendChild(el('div', 'st-note', tx('ሰው ሲናገር ሙዚቃው ራሱ ይቀንሳል፤ ዝም ሲል ይመለሳል።', 'The music gets quieter by itself while someone speaks, and comes back in the pauses.')));
    clipPane.appendChild(el('div', 'ed-sec pro-only', tx('መግቢያና መውጫ', 'Fades')));
    slider(tx('መግቢያ', 'Fade in'), 'fadeIn', 0, 8, 0.1, sec);
    slider(tx('መውጫ', 'Fade out'), 'fadeOut', 0, 8, 0.1, sec);
    const row = el('div', 'st-row');
    row.appendChild(btn('st-btn', '⤓ ' + tx('ወደ ማጫወቻው', 'To playhead'), tx('እዚህ እንዲጀምር', 'Start it here'), () => change('move music', () => { mus = E.ovMove(mus, o.id, time()); })));
    row.appendChild(btn('st-btn', '↔ ' + tx('እስከ መጨረሻ', 'To the end'), tx('እስከ ቪዲዮው መጨረሻ ይርዘም', 'Make it last to the end of the video'), () => change('music', () => {
      mus = mus.map((x) => (x.id === o.id ? Object.assign({}, x, { out: Math.round(Math.min(x.in + (total() - x.start), media[x.m] ? media[x.m].dur : Infinity) * 1000) / 1000 }) : x));
    })));
    row.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(row);
  }

  // ── 🔊 Sound (right): for the whole video ───────────────────────────────
  const soundPane = el('div', 'ed-clip ed-sound');
  ST.addTab('sound', () => '🔊 ' + tx('ድምፅ', 'Sound'), soundPane);
  // ── 🔊 Sound effects (1.65): heard while playing, mixed into the export ──
  const sfxFile = (name) => path.join(((window.__AMH_APP__ || {}).appdir) || '', 'sfx', name + '.wav');
  const SFXURL = {};
  const sfxUrl = (name) => { if (!SFXURL[name]) { try { SFXURL[name] = APP.call('media', [sfxFile(name)]); } catch (e) { SFXURL[name] = ''; } } return SFXURL[name]; };
  const SFXNAME = () => ({ whoosh: tx('ዉሽ', 'Whoosh'), swish: tx('ስዊሽ', 'Swish'), boom: tx('ቡም', 'Boom'), pop: tx('ፖፕ', 'Pop'), click: tx('ክሊክ', 'Click'),
    ding: tx('ዲንግ', 'Ding'), riser: tx('ከፍ የሚል', 'Riser'), tick: tx('ቲክ', 'Tick') });
  function sfxPlay(name, vol) {
    const u = sfxUrl(name);
    if (!u) return;
    try { const a = new Audio(u); a.volume = Math.max(0, Math.min(1, vol)); a.play().catch(() => {}); } catch (e) {}
  }
  let sfxLastT = -1;
  function syncSfx(t) {
    if (!playing || !snd.sfx) { sfxLastT = t; return; }
    if (t < sfxLastT || t - sfxLastT > 0.5) { sfxLastT = t; return; }        // a seek: nothing plays
    const vol = snd.sfxVol == null ? 0.7 : Number(snd.sfxVol);
    E.sfxEvents({ snd, clips, ovl: ovl.filter((o) => !rowHidden('ov', rowOf(o))), txt: txt.filter((x) => !rowHidden('tx', rowOf(x))), zm }, total()).forEach((ev) => {
      const at = sfxAt(ev);                    // 📁 the editor's own sound, at its loudest moment
      if (at.t > sfxLastT && at.t <= t) playFile(at.file, vol * ev.vol);
    });
    sfxLastT = t;
  }
  // ⚙: an item's own sound (Auto = the Studio's choice for it)
  function sfxRow(cur, onPick) {
    clipPane.appendChild(el('div', 'ed-sec', '🔊 ' + tx('የድምፅ ውጤት', 'Sound effect') + (snd.sfx ? '' : ' · ' + tx('ጠፍቷል (🔊 ድምፅ ላይ ያብሩ)', 'off (turn on in 🔊 Sound)'))));
    const row = el('div', 'br-chips');
    const N = SFXNAME();
    [['auto', tx('ራስ-ሰር', 'Auto')], ['none', tx('የለም', 'None')]].concat(E.SFX.map((k) => [k, '▶ ' + N[k]])).forEach(([v, t]) => {
      row.appendChild(btn('br-chip' + ((cur || 'auto') === v ? ' on' : ''), t, '', () => { if (E.SFX.indexOf(v) >= 0) sfxPlay(v, 0.8); onPick(v); }));
    });
    clipPane.appendChild(row);
  }
  // ── 📁 My sounds (1.67): the editor's own sound folder ──────────────────
  // The Studio's sounds are made by tools/make_sfx.py; an editor who has
  // better ones (bought, or free for their own videos) points the Studio at
  // their folder. Each sound slot gets a file by its name (Deep Woosh ->
  // whoosh, bang / blast -> boom…), the loudest moment of each file is found
  // so it lands on the zoom / title, and any file can be dropped at the
  // playhead. Their files stay on this computer: nothing is copied or sent.
  const SFX_KEYS = {
    whoosh: /w+h?oo+sh|swoosh|air|wind/i, swish: /swish|swoosh|slice|swipe|fast|party/i, boom: /boom|bang|blast|impact|explosion|hits?/i,
    pop: /pop/i, click: /click|tap|button|\bui\b|ui\d|mouse/i, ding: /ding|ping|bell|success|bonus|glock|notification/i,
    riser: /riser|rise|build/i, tick: /typ|keyboard|tick|clock/i,
  };
  const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i;
  function myLib() { try { return loadSettings().sfxLib || {}; } catch (e) { return {}; } }
  function saveLib(lib) { try { saveSettings({ sfxLib: lib }); } catch (e) {} }
  // every audio file under the folder (two levels down), with its length
  function scanSounds(dir) {
    const out = [];
    const walk = (d, depth) => {
      let names = [];
      try { names = fs.readdirSync(d); } catch (e) { return; }
      names.forEach((n) => {
        const p = path.join(d, n);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { return; }
        if (st && st.isDirectory && st.isDirectory()) { if (depth < 2 && !/preview/i.test(n)) walk(p, depth + 1); return; }
        if (AUDIO_EXT.test(n)) out.push({ file: p, name: n.replace(/\.[^.]+$/, '') });
      });
    };
    walk(dir, 0);
    return out;
  }
  // where a sound is loudest (s) and how long it is, from ffmpeg's levels
  function soundShape(file) {
    return new Promise((resolve) => {
      let txt = '';
      let p;
      try {
        p = spawn(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'aresample=8000,asetnsamples=n=160,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-', '-f', 'null', '-']);
      } catch (e) { resolve(null); return; }
      p.stdout.on('data', (d) => { txt += String(d); });
      p.on('close', () => {
        let best = -1e9, at = 0, t = 0, end = 0;
        txt.split('\n').forEach((line) => {
          const m = /pts_time:([\d.]+)/.exec(line);
          if (m) { t = Number(m[1]); end = t; return; }
          const v = /Peak_level=(-?[\d.]+|-inf)/.exec(line);
          if (v && v[1] !== '-inf' && Number(v[1]) > best + 0.5) { best = Number(v[1]); at = t; }
        });
        resolve(end > 0 ? { peak: Math.round(at * 1000) / 1000, dur: Math.round((end + 0.02) * 1000) / 1000 } : null);
      });
    });
  }
  // the folder chosen: scan it, give each slot the best-named short file
  async function chooseSoundFolder(onStep) {
    let dir = '';
    try { const r = window.cep.fs.showOpenDialog(false, true, tx('የድምፅ ውጤቶች አቃፊ', 'Your sound effects folder')); dir = (r && r.data && r.data[0]) || ''; } catch (e) {}
    if (!dir) return null;
    return useSoundFolder(dir, onStep);
  }
  async function useSoundFolder(dir, onStep) {
    const files = scanSounds(dir);
    const lib = { dir, files: [], map: {} };
    // four at a time (a folder of 200 sounds in about half a minute)
    let next = 0, done = 0;
    const shapes = new Array(files.length);
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        shapes[i] = await soundShape(files[i].file);
        if (onStep) onStep(++done, files.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    files.forEach((f, i) => { const sh = shapes[i]; if (sh && sh.dur > 0.03) lib.files.push(Object.assign({}, f, sh)); });
    E.SFX.forEach((slot) => {
      const ok = lib.files.filter((f) => SFX_KEYS[slot].test(f.name) && f.dur <= (slot === 'riser' || slot === 'tick' ? 8 : 4));
      // the slot's own word first ("Boom…" before "Bang…"), then the cleanest (shortest) name
      const own = (f) => (new RegExp(slot === 'whoosh' ? 'w+h?oo+sh' : slot, 'i').test(f.name) ? 0 : 1);
      ok.sort((a, b) => own(a) - own(b) || a.name.length - b.name.length);
      if (ok.length) lib.map[slot] = { file: ok[0].file, peak: ok[0].peak };
    });
    saveLib(lib);
    return lib;
  }
  // a slot's sound now: the editor's file (when it is there) or ours
  function sfxSource(name) {
    const m = myLib().map || {};
    const own = m[name];
    if (own && own.file) { try { if (fs.existsSync(own.file)) return { file: own.file, peak: Number(own.peak) || 0, own: true }; } catch (e) {} }
    return { file: sfxFile(name), peak: 0, own: false };
  }
  const OWNURL = {};
  const fileUrlOf = (f) => { if (!OWNURL[f]) { try { OWNURL[f] = APP.call('media', [f]); } catch (e) { OWNURL[f] = ''; } } return OWNURL[f]; };
  function playFile(f, vol) {
    const u = fileUrlOf(f);
    if (!u) return;
    try { const a = new Audio(u); a.volume = Math.max(0, Math.min(1, vol)); a.play().catch(() => {}); } catch (e) {}
  }
  // an event's real start: our sounds lead by SFX_LEAD; the editor's by their loudest moment
  function sfxAt(ev) {
    const src = sfxSource(ev.name);
    const t = src.own ? Math.max(0, ev.t - (E.SFX_LEAD[ev.name] || 0) - src.peak) : ev.t;
    return { t, file: src.file };
  }
  // 📚 a sound from the library at the playhead: it goes on the ♪ track (drag it there)
  async function soundAtPlayhead(f) {
    const id = await addMedia(f.file);
    if (!id) return;
    const at = Math.max(0, Math.min(time() - (f.peak || 0), total() - 0.1));
    const len = Math.min(media[id].dur || f.dur || 1, total() - at);
    const mid = newId();
    change('add sound', () => { mus = mus.concat([{ id: mid, m: id, in: 0, out: Math.round(len * 1000) / 1000, start: Math.round(at * 1000) / 1000, volume: 0.8, fadeIn: 0, fadeOut: 0, duck: 0 }]); });
    drawSoon();
  }
  function renderMySounds() {
    const lib = myLib();
    soundPane.appendChild(el('div', 'ed-sec', '📁 ' + tx('የኔ ድምፆች', 'My sounds')));
    const head = el('div', 'st-row');
    const pick = btn('st-btn', lib.dir ? '📁 ' + tx('ሌላ አቃፊ', 'Another folder') : '📁 ' + tx('የድምፅ አቃፊዬን ምረጥ', 'Choose my sound folder'), '', async () => {
      const r = await chooseSoundFolder((i, n) => { pick.textContent = '⏳ ' + (i + 1) + ' / ' + n; });
      if (r) log('📁 ' + tx('ድምፆች ተገኝተዋል፦ ', 'Sounds found: ') + r.files.length);
      renderSound();
    });
    head.appendChild(pick);
    if (lib.dir) {
      head.appendChild(btn('st-btn', '↻ ' + tx('እንደገና ቃኝ', 'Scan again'), '', async () => { await useSoundFolder(lib.dir); renderSound(); }));
      head.appendChild(btn('st-btn', tx('የስቱዲዮውን ድምፆች ተጠቀም', 'Use the Studio\'s sounds'), '', () => { saveLib({}); renderSound(); }));
    }
    soundPane.appendChild(head);
    if (!lib.dir) {
      soundPane.appendChild(el('div', 'st-note', tx('የራስዎ የድምፅ ውጤቶች አሉ? አቃፊውን ይምረጡ — ስቱዲዮው በስማቸው ያስተካክላቸዋል (Woosh → ዉሽ፣ Boom → ቡም…)። ፋይሎቹ በዚህ ኮምፒውተር ብቻ ይቆያሉ።',
        'Have your own sound effects? Choose their folder — the Studio matches them by name (Woosh → whoosh, Boom → boom…). The files stay on this computer.')));
      return;
    }
    soundPane.appendChild(el('div', 'st-note', lib.dir + ' · ' + (lib.files || []).length + ' ' + tx('ድምፆች', 'sounds')));
    // each slot: which file plays (▶ to hear; "Studio" = ours)
    const N = SFXNAME();
    E.SFX.forEach((slot) => {
      const row = el('div', 'ed-row ms-row simple-ok');
      row.appendChild(el('span', 'ed-lab', N[slot]));
      const sel2 = el('select', 'ms-sel');
      const cur = (lib.map || {})[slot];
      const opt = (v, t) => { const o = el('option', '', t); o.value = v; if ((cur ? cur.file : '') === v) o.selected = true; sel2.appendChild(o); };
      opt('', '★ ' + tx('የስቱዲዮው', 'Studio\'s'));
      const files = (lib.files || []).slice().sort((a, b) => (SFX_KEYS[slot].test(b.name) - SFX_KEYS[slot].test(a.name)) || a.name.localeCompare(b.name));
      files.forEach((f) => opt(f.file, (SFX_KEYS[slot].test(f.name) ? '● ' : '') + f.name + ' · ' + f.dur.toFixed(1) + 's'));
      sel2.addEventListener('change', () => {
        const L2 = myLib();
        L2.map = L2.map || {};
        const f = (L2.files || []).find((x) => x.file === sel2.value);
        if (f) L2.map[slot] = { file: f.file, peak: f.peak }; else delete L2.map[slot];
        saveLib(L2);
        const s2 = sfxSource(slot);
        if (s2.own) playFile(s2.file, 0.8); else sfxPlay(slot, 0.8);
      });
      row.appendChild(sel2);
      row.appendChild(btn('br-chip', '▶', tx('ያዳምጡ', 'Listen'), () => { const s2 = sfxSource(slot); if (s2.own) playFile(s2.file, 0.8); else sfxPlay(slot, 0.8); }));
      soundPane.appendChild(row);
    });
    // 📚 the whole library: hear it, put it at the playhead
    soundPane.appendChild(el('div', 'ed-sec', '📚 ' + tx('የድምፅ ቤተ-መጽሐፍት', 'Sound library') + ' · ' + tx('በማጫወቻው ቦታ ያስገቡ', 'add at the playhead')));
    const q = el('input', 'ed-in ms-q');
    q.placeholder = tx('ፈልግ… (cash, camera, laugh)', 'Search… (cash, camera, laugh)');
    const list = el('div', 'ms-list');
    const fill = () => {
      list.textContent = '';
      (lib.files || []).filter((f) => !q.value || f.name.toLowerCase().indexOf(q.value.toLowerCase()) >= 0).slice(0, 120).forEach((f) => {
        const r = el('div', 'ms-item');
        r.appendChild(btn('br-chip', '▶', tx('ያዳምጡ', 'Listen'), () => playFile(f.file, 0.8)));
        r.appendChild(el('span', 'ms-name', f.name));
        r.appendChild(el('span', 'ms-dur', f.dur.toFixed(1) + 's'));
        r.appendChild(btn('br-chip', '＋', tx('በማጫወቻው ቦታ ጨምር', 'Add at the playhead'), () => soundAtPlayhead(f)));
        list.appendChild(r);
      });
    };
    q.addEventListener('input', fill);
    fill();
    soundPane.appendChild(q);
    soundPane.appendChild(list);
  }
  function renderSound() {
    soundPane.textContent = '';
    soundPane.appendChild(el('div', 'ed-sec', tx('የንግግር ድምፅ', 'Voice')));
    const cl = el('label', 'ed-check');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!snd.clean;
    cb.addEventListener('change', () => { change('sound', () => { snd = Object.assign({}, snd, { clean: cb.checked }); }); renderSound(); });
    cl.appendChild(cb);
    cl.appendChild(el('span', '', tx('ድምፁን አጽዳ — የጀርባ ጫጫታና ጉምጉምታ ይቀንሳል', 'Clean the voice — less background hiss and rumble')));
    soundPane.appendChild(cl);
    soundPane.appendChild(el('div', 'ed-sec', tx('የድምፅ መጠን (loudness)', 'Loudness')));
    const seg = el('div', 'st-seg ed-loud');
    [['off', tx('እንዳለ', 'As it is')], ['web', 'YouTube · TikTok'], ['tv', tx('ቲቪ', 'TV')]].forEach(([v, t]) => {
      seg.appendChild(btn((snd.loud || 'off') === v ? 'on' : '', t, '', () => { change('sound', () => { snd = Object.assign({}, snd, { loud: v }); }); renderSound(); }));
    });
    soundPane.appendChild(seg);
    soundPane.appendChild(el('div', 'st-note', snd.loud === 'web' ? tx('−14 LUFS፦ YouTube፣ TikTok፣ Instagram የሚጠብቁት — ቪዲዮዎ ከሌሎቹ እኩል ይሰማል።', '−14 LUFS: what YouTube, TikTok and Instagram expect — your video sounds as loud as the others.')
      : (snd.loud === 'tv' ? tx('−23 LUFS፦ የቲቪ ስርጭት መስፈርት (EBU R128)።', '−23 LUFS: the broadcast TV standard (EBU R128).') : tx('ድምፁ እንዳለ ይላካል።', 'The sound is exported as it is.'))));
    soundPane.appendChild(el('div', 'ed-sec', '🔊 ' + tx('የድምፅ ውጤቶች', 'Sound effects')));
    const fl = el('label', 'ed-check');
    const fcb = el('input'); fcb.type = 'checkbox'; fcb.checked = !!snd.sfx;
    fcb.addEventListener('change', () => { change('sound', () => { snd = Object.assign({}, snd, { sfx: fcb.checked }); }); renderSound(); drawSoon(); });
    fl.appendChild(fcb);
    fl.appendChild(el('span', '', tx('ራስ-ሰር የድምፅ ውጤቶች — በዙም ዉሽ፣ በርዕስ ፖፕ፣ በሽግግር ስዊሽ…', 'Automatic sound effects — a whoosh on zooms, a pop on titles, a swish on transitions…')));
    soundPane.appendChild(fl);
    if (snd.sfx) {
      const vr = el('div', 'ed-row simple-ok');
      vr.appendChild(el('span', 'ed-lab', tx('መጠን', 'Volume')));
      const r = el('input'); r.type = 'range'; r.min = 0.1; r.max = 1.5; r.step = 0.05; r.value = snd.sfxVol == null ? 0.7 : snd.sfxVol;
      const val = el('span', 'ed-val', Math.round(r.value * 100) + '%');
      r.addEventListener('input', () => { val.textContent = Math.round(r.value * 100) + '%'; });
      r.addEventListener('change', () => { change('sound', () => { snd = Object.assign({}, snd, { sfxVol: Number(r.value) }); }); sfxPlay('whoosh', Number(r.value) * 0.8); });
      vr.appendChild(r); vr.appendChild(val);
      soundPane.appendChild(vr);
      const n = E.sfxEvents({ snd, clips, ovl, txt, zm }, total()).length;
      soundPane.appendChild(el('div', 'st-note', n ? n + ' ' + tx('የድምፅ ውጤቶች በዚህ ቪዲዮ ውስጥ (በጊዜ መስመሩ ላይ 🔊)።', 'sound effects in this video (🔊 on the timeline).')
        : tx('ዙም፣ B-roll፣ ቴምፕሌት ወይም ሽግግር ሲጨምሩ ድምፁ ራሱ ይገባል።', 'Add a zoom, B-roll, template or transition — its sound comes by itself.')));
    }
    const tryRow = el('div', 'br-chips');
    const N = SFXNAME();
    E.SFX.forEach((k) => tryRow.appendChild(btn('br-chip', '▶ ' + N[k], tx('ያዳምጡ', 'Listen'), () => { const s2 = sfxSource(k); if (s2.own) playFile(s2.file, 0.8); else sfxPlay(k, 0.8); })));
    soundPane.appendChild(tryRow);
    renderMySounds();
    soundPane.appendChild(el('div', 'ed-sec', '♪ ' + tx('ሙዚቃ', 'Music')));
    if (!mus.length) {
      soundPane.appendChild(el('div', 'st-note', tx('ሙዚቃ ፋይል (mp3፣ wav፣ m4a) ወደ መስኮቱ ይጎትቱ ወይም ከ📁 ሚዲያ ያስገቡ — ከዋናው መስመር በታች ይገባል።', 'Drop a music file (mp3, wav, m4a) onto the window or import it in 📁 Media — it goes under the main track.')));
    } else {
      mus.forEach((o) => {
        const b = btn('st-btn ed-mrow', '♪ ' + (media[o.m] ? media[o.m].name : ''), '', () => { sel = o.id; renderInspector(); ST.showTab('clip'); frame(); drawSoon(); });
        soundPane.appendChild(b);
      });
    }
    soundPane.appendChild(el('div', 'st-note', tx('ማጽዳትና loudness ሲላክ ይሠራሉ።', 'Cleaning and loudness are applied when you export.')));
  }

  // ── 🇪🇹 Templates (1.62): the preview canvas, the gallery, ⚙ settings ──
  // The editor measures text with the real fonts — the export uses the same
  // numbers (E.setMeasure), so boxes fit the words in both.
  const mctx = document.createElement('canvas').getContext('2d');
  const fontCss = (font, S, bold) => (bold ? '700 ' : '400 ') + (S * E.fontInfo(font).css) + "px 'AC " + (FONTFILES[font] ? font : 'sans') + "', 'Abyssinica SIL', serif";
  E.setMeasure((text, font, S, bold, fsp) => {
    if (!mctx) return 0;
    mctx.font = fontCss(font, S, bold);
    try { mctx.letterSpacing = (fsp || 0) + 'px'; } catch (e) {}
    return mctx.measureText(String(text || '')).width;
  });
  let TPLCACHE = {};
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => { TPLCACHE = {}; });
  function tplLayersOf(it, W, H) {
    const key = JSON.stringify([it.tpl, it.text, it.sub, it.accent, it.color, it.font, it.size, it.fx, it.fy, it.speed, it.end, it.theme, it.in, it.out, W, H]);
    if (!TPLCACHE[key]) TPLCACHE[key] = E.tplLayers(it, W, H);
    return TPLCACHE[key];
  }
  // one template at τ seconds after its start, in canvas px (k = screen px per canvas px)
  function drawTpl(c2, it, tau, k, W, H, boxOut) {
    const T = tplLayersOf(it, W, H);
    let bb = null;
    T.layers.forEach((l) => {
      if (tau < l.on || tau >= l.off) return;
      const st = E.tplState(l, tau);
      const last = Math.abs(l.off - T.len) < 0.01;
      const fade = last ? E.tplFade(T, tau) : 1;
      const a = Math.max(0, Math.min(1, st.al)) * fade;
      if (a <= 0.001) return;
      c2.save();
      c2.scale(k, k);
      if (st.wipe < 1) {
        const bx = l.kind === 'text' ? { x0: l.x - l.w2 - l.S, x1: l.x + l.w2 + l.S, y0: l.y - l.S, y1: l.y + l.S }
          : { x0: l.x - (l.w || 0) / 2 - 2, x1: l.x + (l.w || 0) / 2 + 2, y0: l.y - (l.h || 0) / 2 - 2, y1: l.y + (l.h || 0) / 2 + 2 };
        c2.beginPath(); c2.rect(bx.x0, bx.y0, Math.max(0, (bx.x1 - bx.x0) * st.wipe), bx.y1 - bx.y0); c2.clip();
      }
      c2.translate(l.x + st.mv[0], l.y + st.mv[1]);
      if (st.rot) c2.rotate(st.rot * Math.PI / 180);
      const sc = Math.max(0, st.sc) / 100;
      c2.scale(l.sy ? 1 : sc, sc);
      if (l.kind === 'rect') {
        c2.globalAlpha = a * (l.a == null ? 1 : l.a);
        c2.fillStyle = l.color;
        c2.beginPath();
        const r = Math.min(l.r || 0, l.w / 2, l.h / 2);
        if (c2.roundRect) c2.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, r); else c2.rect(-l.w / 2, -l.h / 2, l.w, l.h);
        c2.fill();
      } else if (l.kind === 'poly') {
        c2.globalAlpha = a * (l.a == null ? 1 : l.a);
        c2.fillStyle = l.color;
        c2.beginPath();
        l.pts.forEach((p, i) => { if (i) c2.lineTo(p[0] - l.x, p[1] - l.y); else c2.moveTo(p[0] - l.x, p[1] - l.y); });
        c2.closePath(); c2.fill();
      } else {
        c2.font = fontCss(l.font, l.S, l.bold);
        try { c2.letterSpacing = (st.sp || 0) + 'px'; } catch (e) {}
        c2.textAlign = 'center'; c2.textBaseline = 'middle';
        c2.lineJoin = 'round';
        if (l.sh) { c2.globalAlpha = a * 0.55; c2.fillStyle = '#000'; if (l.ob) { c2.lineWidth = l.ob * 2; c2.strokeStyle = '#000'; c2.strokeText(l.text, l.sh, l.sh); } c2.fillText(l.text, l.sh, l.sh); }
        if (l.ob) { c2.globalAlpha = a; c2.lineWidth = l.ob * 2; c2.strokeStyle = l.oc || '#000'; c2.strokeText(l.text, 0, 0); }
        c2.globalAlpha = a * (l.a == null ? 1 : l.a);
        c2.fillStyle = l.color;
        c2.fillText(l.text, 0, 0);
      }
      c2.restore();
      const hw = l.kind === 'text' ? l.w2 : (l.w || 0) / 2, hh = l.kind === 'text' ? l.S / 2 : (l.h || 0) / 2;
      if (l.kind !== 'poly') bb = bb ? { x0: Math.min(bb.x0, l.x - hw), y0: Math.min(bb.y0, l.y - hh), x1: Math.max(bb.x1, l.x + hw), y1: Math.max(bb.y1, l.y + hh) }
        : { x0: l.x - hw, y0: l.y - hh, x1: l.x + hw, y1: l.y + hh };
    });
    if (boxOut) boxOut[it.id] = bb;
  }
  // the canvas over the picture (under the captions)
  const tcv = document.createElement('canvas');
  tcv.className = 'ed-tplcv';
  const TPLBOX = {};
  function syncTemplates(t) {
    if (!tcv.parentNode && stage) { const cap = $('appCap'); stage.insertBefore(tcv, cap && cap.parentNode === stage ? cap : null); }
    const { w: W, h: H } = E.canvasSize(fmt);
    const sw = stage.clientWidth || 0, shh = stage.clientHeight || 0, dpr = window.devicePixelRatio || 1;
    if (tcv.width !== Math.round(sw * dpr) || tcv.height !== Math.round(shh * dpr)) { tcv.width = Math.round(sw * dpr); tcv.height = Math.round(shh * dpr); tcv.style.width = sw + 'px'; tcv.style.height = shh + 'px'; }
    const c2 = tcv.getContext('2d');
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.clearRect(0, 0, tcv.width, tcv.height);
    Object.keys(TPLBOX).forEach((id) => { delete TPLBOX[id]; });
    const k = (sw / W) * dpr;
    txt.slice().sort((a, b) => rowOf(a) - rowOf(b)).forEach((it) => {
      if (!it.tpl || t < it.start || t >= it.start + E.ovLen(it) || t >= total() || rowHidden('tx', rowOf(it))) return;
      drawTpl(c2, it, t - it.start, k, W, H, TPLBOX);
      const b = TPLBOX[it.id];
      if (b && it.id === sel) {
        c2.save(); c2.scale(k, k); c2.strokeStyle = '#2ECC71'; c2.lineWidth = 2 / (k / dpr); c2.setLineDash([8 / (k / dpr), 6 / (k / dpr)]);
        c2.strokeRect(b.x0 - 10, b.y0 - 10, b.x1 - b.x0 + 20, b.y1 - b.y0 + 20); c2.restore();
      }
    });
  }
  // a press on a template in the picture: select it, drag it (its fx / fy)
  function tplAt(e) {
    const { w: W } = E.canvasSize(fmt);
    const r = stage.getBoundingClientRect(), k = (stage.clientWidth || 1) / W;
    const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
    const ids = Object.keys(TPLBOX).reverse();
    return ids.find((id) => { const b = TPLBOX[id]; return b && x >= b.x0 - 14 && x <= b.x1 + 14 && y >= b.y0 - 14 && y <= b.y1 + 14; }) || null;
  }
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const id = tplAt(e);
    if (!id) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const it = txt.find((x) => x.id === id);
    if (sel !== id) { sel = id; renderInspector(); ST.showTab('clip'); }
    const P = E.tplOf(it);
    const { w: W, h: H } = E.canvasSize(fmt);
    pushReviewUndo('move template');
    const k = stage.clientWidth / W, x0 = e.clientX, y0 = e.clientY;
    const mm = (ev) => {
      const fx = Math.round((P.fx + (ev.clientX - x0) / k / W) * 1000) / 1000, fy = Math.round((P.fy + (ev.clientY - y0) / k / H) * 1000) / 1000;
      txt = txt.map((x) => (x.id === id ? Object.assign({}, x, { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) }) : x));
      frame();
    };
    const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); renderInspector(); ST.saveSoon(); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }, true);

  // the gallery (＋ T Text): basics, then the template groups, with live thumbnails
  let TGROUP = 'mine';
  let thumbRaf = 0;
  const TW = 176, TH = 99;
  function myTemplates() { try { const l = loadSettings().myTemplates; return Array.isArray(l) ? l.filter((x) => x && x.tpl && E.TEMPLATES[x.tpl]) : []; } catch (e) { return []; } }
  function renderTextMenu() {
    tmenu.textContent = '';
    tmenu.className = 'ed-tmenu ed-tgal';
    const mine = myTemplates();
    if (TGROUP === 'mine' && !mine.length) TGROUP = 'basic';
    const tabs = el('div', 'tg-tabs');
    const groups = [['basic', tx('ቀላል ጽሑፍ', 'Basic text')]].concat(mine.length ? [['mine', '★ ' + tx('የኔ', 'Mine')]] : [])
      .concat(Object.keys(E.TPL_GROUPS).map((g) => [g, tx(E.TPL_GROUPS[g][0], E.TPL_GROUPS[g][1])]));
    groups.forEach(([g, name]) => tabs.appendChild(btn('tg-tab' + (TGROUP === g ? ' on' : ''), name, '', () => { TGROUP = g; renderTextMenu(); })));
    tmenu.appendChild(tabs);
    const grid = el('div', 'tg-grid');
    const thumbs = [];
    if (TGROUP === 'basic') {
      [['title', tx('ርዕስ', 'Title'), tx('ትልቅ፣ በመሃል', 'Big, in the middle')], ['lower', tx('የስም ጽሑፍ', 'Lower third'), tx('ስምና ማዕረግ ከታች', 'Name and title, bottom left')],
        ['box', tx('በሳጥን ላይ', 'On a box'), tx('ጽሑፍ በጨለማ ሳጥን ላይ', 'Text on a dark box')], ['plain', tx('ቀላል ጽሑፍ', 'Plain text'), tx('ነጭ ከጥቁር ጠርዝ ጋር', 'White with a dark edge')]].forEach(([pr, name, sub]) => {
        const b = btn('ed-tmi', '', '', () => { tmenu.style.display = 'none'; addText(pr); });
        b.appendChild(el('b', '', name)); b.appendChild(el('span', '', sub));
        grid.appendChild(b);
      });
      grid.classList.add('tg-basic');
    } else {
      const list = TGROUP === 'mine' ? mine.map((m) => Object.assign({}, m, { _mine: true }))
        : Object.keys(E.TEMPLATES).filter((id) => E.TEMPLATES[id].g === TGROUP).map((id) => ({ tpl: id }));
      list.forEach((spec) => {
        const D = E.TEMPLATES[spec.tpl];
        const card = btn('tg-card', '', '', () => { tmenu.style.display = 'none'; addTemplate(spec); });
        const cv = el('canvas', 'tg-cv');
        cv.width = TW * 2; cv.height = TH * 2;
        card.appendChild(cv);
        card.appendChild(el('b', '', spec._mine ? spec.name : tx(D.name[0], D.name[1])));
        if (spec._mine) {
          const del = el('i', 'tg-del', '✕');
          del.title = tx('ሰርዝ', 'Delete');
          del.addEventListener('click', (e) => { e.stopPropagation(); saveSettings({ myTemplates: myTemplates().filter((x) => x.name !== spec.name) }); renderTextMenu(); });
          card.appendChild(del);
        }
        grid.appendChild(card);
        thumbs.push({ cv, it: Object.assign({ id: 'thumb', start: 0, in: 0, out: 3.2 }, spec, { _mine: undefined, name: undefined }) });
      });
      if (TGROUP === 'holiday') {
        // one card per holiday
        grid.textContent = ''; thumbs.length = 0;
        Object.keys(E.HOLIDAYS).forEach((th) => {
          const card = btn('tg-card', '', '', () => { tmenu.style.display = 'none'; addTemplate({ tpl: 'holiday', theme: th }); });
          const cv = el('canvas', 'tg-cv'); cv.width = TW * 2; cv.height = TH * 2;
          card.appendChild(cv);
          card.appendChild(el('b', '', tx(E.HOLIDAYS[th].name[0], E.HOLIDAYS[th].name[1])));
          grid.appendChild(card);
          thumbs.push({ cv, it: { id: 'thumb', tpl: 'holiday', theme: th, start: 0, in: 0, out: 3.2, size: 1.25 } });
        });
      }
    }
    tmenu.appendChild(grid);
    tmenu.appendChild(el('div', 'st-note', tx('ካርዱ ላይ ሲያንዣብቡ ይንቀሳቀሳል — ይጫኑት፣ በማጫወቻው ቦታ ይገባል።', 'Each card plays its animation — click one to add it at the playhead.')));
    // the thumbnails play (only while the gallery is open)
    cancelAnimationFrame(thumbRaf);
    const t0 = performance.now();
    const loop = () => {
      if (tmenu.style.display === 'none' || !thumbs.length) return;
      const tau = ((performance.now() - t0) / 1000) % 3.4;
      thumbs.forEach(({ cv, it }) => {
        const c2 = cv.getContext('2d');
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.fillStyle = '#26323a'; c2.fillRect(0, 0, cv.width, cv.height);
        c2.fillStyle = '#31414b'; c2.fillRect(0, cv.height * 0.62, cv.width, cv.height * 0.38);
        if (!it._fit) {
          // zoom the card onto the design itself (it is small on a full frame)
          const T = tplLayersOf(it, 1920, 1080);
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          // a full-width banner: fit on its words, not the whole width
          const wide = T.layers.some((l) => l.kind === 'rect' && l.w > 1500);
          T.layers.filter((l) => !wide || l.kind === 'text').forEach((l) => {
            const hw = l.kind === 'text' ? l.w2 + l.S * 0.2 : l.kind === 'poly' ? Math.max.apply(null, l.pts.map((q) => Math.abs(q[0] - l.x))) : l.w / 2;
            const hh = l.kind === 'text' ? l.S * 0.6 : l.kind === 'poly' ? Math.max.apply(null, l.pts.map((q) => Math.abs(q[1] - l.y))) : l.h / 2;
            x0 = Math.min(x0, l.x - hw); x1 = Math.max(x1, l.x + hw); y0 = Math.min(y0, l.y - hh); y1 = Math.max(y1, l.y + hh);
          });
          const kk = Math.min(cv.width * 0.84 / Math.max(1, x1 - x0), cv.height * 0.72 / Math.max(1, y1 - y0), cv.width / 1920 * 3.2);
          it._fit = { k: kk, ox: cv.width / 2 - (x0 + x1) / 2 * kk, oy: cv.height / 2 - (y0 + y1) / 2 * kk };
        }
        c2.setTransform(1, 0, 0, 1, it._fit.ox, it._fit.oy);
        drawTpl(c2, it, tau, it._fit.k, 1920, 1080, null);
      });
      thumbRaf = requestAnimationFrame(loop);
    };
    thumbRaf = requestAnimationFrame(loop);
  }
  const TPL_LEN = { subscribe: 3.2, cta: 4, banner: 5, price: 3, holiday: 5, cinema: 4.5 };
  function addTemplate(spec) {
    const D = E.TEMPLATES[spec.tpl];
    const at = Math.min(time(), Math.max(0, total() - 0.5));
    const id = newId();
    const P = E.tplOf(spec);
    const it = Object.assign({ id, start: Math.round(at * 1000) / 1000, in: 0, out: TPL_LEN[spec.tpl] || 3.5, text: P.text, sub: P.sub }, spec);
    delete it._mine; delete it.name;
    if (it.tpl === 'holiday' && !spec.text) it.text = E.HOLIDAYS[it.theme || 'meskel'].text;
    it.out = Math.min(it.out, Math.max(0.5, total() - it.start));
    change('add template', () => { txt = txt.concat([it]); });
    sel = id; after(); ST.showTab('clip');
    void D;
  }
  const TPL_SUB = { subscribe: tx('ከተጫነ በኋላ', 'After the click'), follow: tx('የአዝራሩ ጽሑፍ', 'Button text'), number: tx('ቁጥር', 'Number'),
    price: tx('ከላይ ያለው ጽሑፍ', 'Small text on top'), quote: tx('ማን አለው', 'Who said it'), banner: tx('ሁለተኛ መስመር', 'Second line'),
    hook: tx('ከስር ያለ ትንሽ ጽሑፍ', 'Small line under it'), slam: tx('ከስር ያለ ጽሑፍ', 'Line under it'), cinema: tx('ከላይ ያለ ትንሽ ጽሑፍ', 'Small line above'),
    stack: tx('የላይኛው መስመር', 'Top line'), lower: tx('ማዕረግ', 'Title / role'), minimal: tx('ማዕረግ', 'Title / role'), holiday: tx('ከማን', 'From') };
  const BRAND = ['#2ECC71', '#FFD60A', '#FF0033', '#FE2C55', '#1565C0', '#42A5F5', '#AB47BC', '#FF9800', '#E8C77A', '#FFFFFF', '#111111'];
  function renderTemplateInspector(it) {
    const P = E.tplOf(it);
    const D = P.D;
    const setT = (props, undo) => {
      if (undo) pushReviewUndo('template');
      txt = txt.map((x) => (x.id === it.id ? Object.assign({}, x, props) : x));
      Object.assign(it, props);
      frame(); drawSoon();
    };
    const setC = (props) => change('template', () => { txt = txt.map((x) => (x.id === it.id ? Object.assign({}, x, props) : x)); });
    clipPane.appendChild(el('div', 'ed-cname', '✦ ' + tx(D.name[0], D.name[1]) + ' · ' + S.fmtClock(E.ovLen(it), true)));
    const field = (label, key, ph) => {
      clipPane.appendChild(el('div', 'ed-sec', label));
      const inp = el('input', 'ed-in');
      inp.dataset.amhType = '1';
      inp.value = it[key] == null ? '' : it[key];
      inp.placeholder = ph || '';
      let started = false;
      inp.addEventListener('input', () => { setT({ [key]: inp.value }, !started); started = true; });
      inp.addEventListener('change', () => { started = false; ST.saveSoon(); renderInspector(); });
      clipPane.appendChild(inp);
    };
    field(tx('ጽሑፍ', 'Text'), 'text');
    if (TPL_SUB[P.id] || P.id === 'subscribe') field(TPL_SUB[P.id] || tx('ሁለተኛ ጽሑፍ', 'Second text'), 'sub');
    if (P.id === 'holiday') {
      clipPane.appendChild(el('div', 'ed-sec', tx('በዓል', 'Holiday')));
      const hs = el('div', 'br-chips');
      Object.keys(E.HOLIDAYS).forEach((th) => hs.appendChild(btn('br-chip' + ((it.theme || 'meskel') === th ? ' on' : ''), tx(E.HOLIDAYS[th].name[0], E.HOLIDAYS[th].name[1]), '', () => {
        const old = E.HOLIDAYS[it.theme || 'meskel'];
        const props = { theme: th, accent: null, color: null };
        if (!it.text || it.text === old.text) props.text = E.HOLIDAYS[th].text;     // a text the editor did not change follows the holiday
        setC(props);
      })));
      clipPane.appendChild(hs);
    }
    const swatches = (label, key, cur, list) => {
      clipPane.appendChild(el('div', 'ed-sec', label));
      const sw = el('div', 'ed-swatches');
      list.forEach((c) => {
        const b = btn('ed-sw' + (cur.toUpperCase() === c ? ' on' : ''), '', c, () => setC({ [key]: c }));
        b.style.background = c;
        sw.appendChild(b);
      });
      const pick = el('input'); pick.type = 'color'; pick.className = 'ed-pick'; pick.value = cur;
      pick.title = tx('ማንኛውም ቀለም', 'Any colour');
      pick.addEventListener('change', () => setC({ [key]: pick.value.toUpperCase() }));
      sw.appendChild(pick);
      clipPane.appendChild(sw);
    };
    swatches(tx('ዋና ቀለም', 'Accent colour'), 'accent', P.accent, BRAND);
    swatches(tx('የጽሑፍ ቀለም', 'Text colour'), 'color', P.color, ['#FFFFFF', '#111111', '#FFD60A', '#2ECC71', '#E8C77A']);
    clipPane.appendChild(el('div', 'ed-sec', tx('ፊደል', 'Font')));
    const fr = el('div', 'st-seg ed-fonts');
    Object.keys(FONTFILES).forEach((f) => { const b = btn(P.font === f ? 'on' : '', 'ሰላም', f, () => setC({ font: f })); b.style.fontFamily = "'AC " + f + "', serif"; fr.appendChild(b); });
    clipPane.appendChild(fr);
    const row = el('div', 'ed-row');
    row.appendChild(el('span', 'ed-lab', tx('መጠን', 'Size')));
    const r = el('input'); r.type = 'range'; r.min = 0.5; r.max = 2; r.step = 0.01; r.value = P.size;
    const val = el('span', 'ed-val', Math.round(P.size * 100) + '%');
    let s3 = false;
    r.addEventListener('input', () => { setT({ size: Number(r.value) }, !s3); s3 = true; val.textContent = Math.round(r.value * 100) + '%'; });
    r.addEventListener('change', () => { s3 = false; ST.saveSoon(); });
    row.appendChild(r); row.appendChild(val);
    row.classList.add('simple-ok');
    clipPane.appendChild(row);
    clipPane.appendChild(el('div', 'ed-sec', tx('ቦታ', 'Position')));
    const pw = el('div', 'zm-focus-wrap');
    const pg = el('div', 'zm-focus');
    [0.15, 0.5, 0.85].forEach((fy) => [0.1, 0.5, 0.9].forEach((fx) => {
      const near = Math.abs(P.fx - fx) < 0.06 && Math.abs(P.fy - fy) < 0.06;
      pg.appendChild(btn('zm-dot' + (near ? ' on' : ''), '', '', () => setC({ fx: P.D.fx < 0.2 && fx === 0.1 ? P.D.fx : fx, fy })));
    }));
    pw.appendChild(pg);
    pw.appendChild(el('div', 'st-note', tx('ወይም በምስሉ ላይ ይጎትቱት።', 'Or drag it on the picture.')));
    clipPane.appendChild(pw);
    const seg = (label, opts, cur, key) => {
      clipPane.appendChild(el('div', 'ed-sec', label));
      const s2 = el('div', 'st-seg');
      opts.forEach(([v, t]) => s2.appendChild(btn(cur === v ? 'on' : '', t, '', () => setC({ [key]: v }))));
      clipPane.appendChild(s2);
    };
    seg(tx('የእንቅስቃሴ ፍጥነት', 'Animation speed'), [['slow', tx('ቀስ', 'Slow')], ['normal', tx('መደበኛ', 'Normal')], ['fast', tx('ፈጣን', 'Fast')]], it.speed || 'normal', 'speed');
    seg(tx('ሲጨርስ', 'At the end'), [['fade', tx('ደብዝዞ ይጠፋል', 'Fades out')], ['none', tx('በቀጥታ ይቆማል', 'Cuts')]], it.end === 'none' ? 'none' : 'fade', 'end');
    sfxRow(it.sfx, (v) => setC({ sfx: v }));
    const acts = el('div', 'st-row br-acts');
    acts.appendChild(btn('st-btn primary', '▶ ' + tx('አሳይ', 'Preview'), '', () => {
      seek(Math.max(0, it.start - 0.3)); play();
      const end = it.start + E.ovLen(it) + 0.4;
      const stop = () => { if (time() >= end) pause(); else if (playing) requestAnimationFrame(stop); };
      requestAnimationFrame(stop);
    }));
    acts.appendChild(btn('st-btn', '★ ' + tx('እንደ የኔ አስቀምጥ', 'Save as mine'), tx('ይህን መልክ በ«የኔ» ውስጥ ያስቀምጡ', 'Keep this look under «Mine»'), () => {
      const name = (it.text || tx(D.name[0], D.name[1])).slice(0, 24);
      const keep = { name, tpl: it.tpl };
      ['text', 'sub', 'accent', 'color', 'font', 'size', 'fx', 'fy', 'speed', 'end', 'theme'].forEach((k) => { if (it[k] != null) keep[k] = it[k]; });
      const list = myTemplates().filter((x) => x.name !== name).concat([keep]).slice(-24);
      saveSettings({ myTemplates: list });
      log('★ ' + tx('ተቀምጧል፦ ', 'Saved: ') + name);
    }));
    acts.appendChild(btn('st-btn', '⤓ ' + tx('ወደ ማጫወቻው', 'To playhead'), '', () => change('move text', () => { txt = E.ovMove(txt, it.id, time()); })));
    acts.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(acts);
  }

  function renderTextInspector(it) {
    const setT = (props, undo) => {
      if (undo) pushReviewUndo('text');
      txt = txt.map((x) => (x.id === it.id ? Object.assign({}, x, props) : x));
      Object.assign(it, props);
      frame(); drawSoon();
    };
    clipPane.appendChild(el('div', 'ed-sec', tx('ጽሑፍ', 'Text')));
    const ta = el('textarea', 'ed-ta');
    ta.dataset.amhType = '1';
    ta.value = it.text || '';
    ta.rows = 2;
    let started = false;
    ta.addEventListener('focus', () => { started = false; });
    ta.addEventListener('input', () => { setT({ text: ta.value }, !started); started = true; });
    ta.addEventListener('change', () => ST.saveSoon());
    clipPane.appendChild(ta);
    if (it.preset === 'lower') {
      const sb = el('input', 'ed-in');
      sb.dataset.amhType = '1';
      sb.value = it.sub || '';
      sb.placeholder = tx('ሁለተኛ መስመር (ማዕረግ)', 'Second line (title)');
      let s2 = false;
      sb.addEventListener('input', () => { setT({ sub: sb.value }, !s2); s2 = true; });
      sb.addEventListener('change', () => { s2 = false; ST.saveSoon(); });
      clipPane.appendChild(sb);
    }
    const seg = (label, opts, cur2, key) => {
      clipPane.appendChild(el('div', 'ed-sec', label));
      const row = el('div', 'st-seg');
      opts.forEach(([v, t]) => row.appendChild(btn(v === cur2 ? 'on' : '', t, '', () => { change('text', () => { txt = txt.map((x) => (x.id === it.id ? Object.assign({}, x, { [key]: v }) : x)); }); })));
      clipPane.appendChild(row);
    };
    seg(tx('አይነት', 'Kind'), [['title', tx('ርዕስ', 'Title')], ['lower', tx('ስም', 'Name')], ['box', tx('ሳጥን', 'Box')], ['plain', tx('ቀላል', 'Plain')]], it.preset || 'plain', 'preset');
    seg(tx('ፊደል', 'Font'), [['sans', 'Sans'], ['menbere', 'Menbere'], ['serif', 'Serif'], ['abyssinica', 'Abyssinica'], ['yebse', 'Yebse'],
      ['washra', 'WashRa'], ['agbalumo', 'Agbalumo'], ['tint', 'Tint'], ['fantuwua', 'Fantuwua'], ['jiret', 'Jiret'], ['hibur', 'Hibur'], ['gothic', 'Gothic']],
      it.font || 'sans', 'font');
    const fontRow = clipPane.lastChild;
    if (fontRow) fontRow.classList.add('ed-fonts');
    // every font name drawn in its own letters
    if (fontRow) Array.from(fontRow.children).forEach((b, k) => { const id = Object.keys(FONTFILES)[k]; if (id) b.style.fontFamily = "'AC " + id + "', serif"; });
    const row = el('div', 'ed-row');
    row.appendChild(el('span', 'ed-lab', tx('መጠን', 'Size')));
    const r = el('input'); r.type = 'range'; r.min = 0.02; r.max = 0.16; r.step = 0.002;
    r.value = Number(it.size) || E.TPRESETS[E.TPRESETS[it.preset] ? it.preset : 'plain'].size;
    const val = el('span', 'ed-val', Math.round(r.value * 1000) / 10 + '%');
    let s3 = false;
    r.addEventListener('input', () => { setT({ size: Number(r.value) }, !s3); s3 = true; val.textContent = Math.round(r.value * 1000) / 10 + '%'; });
    r.addEventListener('change', () => { s3 = false; ST.saveSoon(); });
    row.appendChild(r); row.appendChild(val);
    row.classList.add('simple-ok');
    clipPane.appendChild(row);
    clipPane.appendChild(el('div', 'ed-sec', tx('ቀለም', 'Colour')));
    const sw2 = el('div', 'ed-swatches');
    ['#FFFFFF', '#FFD60A', '#2ECC71', '#FF6B6B', '#7FD1FF', '#111111'].forEach((c) => {
      const b = btn('ed-sw' + ((it.color || '#FFFFFF').toUpperCase() === c ? ' on' : ''), '', c, () => change('text', () => { txt = txt.map((x) => (x.id === it.id ? Object.assign({}, x, { color: c }) : x)); }));
      b.style.background = c;
      sw2.appendChild(b);
    });
    clipPane.appendChild(sw2);
    seg(tx('እንቅስቃሴ', 'Animation'), [['auto', tx('ራስ-ሰር', 'Auto')], ['none', tx('የለም', 'None')], ['fade', 'Fade'], ['slide', 'Slide'], ['pop', 'Pop']], it.anim || 'auto', 'anim');
    const br = el('div', 'st-row');
    br.appendChild(btn('st-btn', '⤓ ' + tx('ወደ ማጫወቻው', 'To playhead'), '', () => change('move text', () => { txt = E.ovMove(txt, it.id, time()); })));
    br.appendChild(btn('st-btn', '🗑 ' + tx('ሰርዝ', 'Delete'), '', deleteSel));
    clipPane.appendChild(br);
    clipPane.appendChild(el('div', 'st-note', tx('በምስሉ ላይ ጎትተው ቦታውን ይቀይሩ።', 'Drag it on the picture to place it.')));
  }

  // ── export (1.25.0): jobs, the graphics card, the queue ────────────────
  // A job is a snapshot of the edit + where it goes; the captions (when a
  // style is chosen) are drawn in the SAME render as the edit (one encode).
  const snapshot = () => JSON.parse(JSON.stringify({ clips, ovl, txt, mus, snd, zm, trk, media, fmt }));
  let GPU = null;                                  // promise -> encoder name or null
  function detectGpu() {
    if (GPU) return GPU;
    const list = E.GPU_ENCODERS[process.platform] || [];
    GPU = list.reduce((pr, enc) => pr.then((found) => found || new Promise((res) => {
      execFile(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.3', '-c:v', enc, '-f', 'null', '-'],
        { timeout: 20000 }, (err) => res(err ? null : enc));
    })), Promise.resolve(null));
    return GPU;
  }
  // file names stay short and in Latin letters (they travel to phones, Telegram, YouTube)
  const FILE_TAGS = { youtube: 'YouTube', shorts: 'TikTok Reels Shorts', insta: 'Instagram 4x5', square: 'Square', telegram: 'Telegram 720p', master: 'Master' };
  const GPU_NAMES = { h264_nvenc: 'NVIDIA', h264_qsv: 'Intel', h264_amf: 'AMD', h264_videotoolbox: 'Apple' };
  function runFfmpeg(args, cwd, dur, onProgress, ctl) {
    return new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, args, cwd ? { cwd } : undefined);
      ctl.kill = () => { ctl.stopped = true; try { p.kill(); } catch (e) {} };
      let err = '';
      p.stdout.on('data', (d) => {
        const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
        if (m && onProgress) onProgress(Math.min(0.999, Number(m[m.length - 1].split('=')[1]) / 1e6 / Math.max(0.1, dur)));
      });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('close', (code) => {
        ctl.kill = null;
        if (ctl.stopped) reject(new Error('stopped'));
        else if (code === 0) resolve();
        else reject(new Error(err.trim().split('\n').pop() || ('ffmpeg ' + code)));
      });
    });
  }
  // job: { state, fmt, res, q, enc, caps: styled-caption args or null }
  async function renderJob(job, out, onProgress, ctl) {
    ctl = ctl || {};
    const st = E.trackedState(job.state);
    const f = job.fmt || st.fmt;
    const tot = E.total(st.clips);
    const used = [];
    st.clips.concat(st.ovl || [], st.mus || []).forEach((c) => { if (st.media[c.m] && used.indexOf(c.m) < 0) used.push(c.m); });
    const info = {};
    used.forEach((id, i) => { info[id] = Object.assign({ idx: i }, st.media[id]); });
    const { w: W, h: H } = E.canvasSize(f, job.res);
    const shown = (st.txt || []).filter((t) => t.start < tot && String(t.text || '').trim());
    let cwd = null;
    const made = [];
    const ass = [];
    const folder = () => {
      if (cwd) return;
      cwd = path.join(os.tmpdir(), 'amh_exp_' + Date.now() + '_' + (++nid));
      fs.mkdirSync(path.join(cwd, 'fonts'), { recursive: true });
      try { fs.readdirSync(fontsDir()).filter((x) => /\.(ttf|otf)$/i.test(x)).forEach((x) => { fs.copyFileSync(path.join(fontsDir(), x), path.join(cwd, 'fonts', x)); made.push(path.join(cwd, 'fonts', x)); }); } catch (e) {}
    };
    try {
      if (shown.length) {
        folder();
        fs.writeFileSync(path.join(cwd, 't.ass'), E.textAss(shown, W, H, tot), { encoding: 'utf8' });
        made.push(path.join(cwd, 't.ass')); ass.push('t.ass');
      }
      if (job.caps && typeof renderStyled === 'function') {
        folder();
        await renderStyled(Object.assign({}, job.caps, { mode: 'script', width: W, height: H, fps: 30, duration: tot, out: path.join(cwd, 'c.ass') }));
        made.push(path.join(cwd, 'c.ass')); ass.push('c.ass');
      }
      const sv = st.snd && st.snd.sfxVol != null ? Number(st.snd.sfxVol) : 0.7;
      const sfx = E.sfxEvents(st, tot).map((x) => Object.assign({}, x, sfxAt(x))).filter((x) => fs.existsSync(x.file))
        .map((x, k) => ({ idx: used.length + k, t: x.t, vol: sv * x.vol, file: x.file }));
      const g = E.editGraph(st.clips, info, f, 30, st.ovl || [], { ass: ass.length ? ass : null, res: job.res, mus: st.mus, snd: st.snd, zm: st.zm || [], sfx });
      let gfile = null;
      const args = (enc) => {
        const a = ['-v', 'error', '-y'];
        used.forEach((id) => { if (st.media[id].image) a.push('-loop', '1', '-framerate', '30'); a.push('-i', st.media[id].path); });
        sfx.forEach((x) => a.push('-i', x.file));
        if (g.graph.length > 6000) {
          if (!gfile) { gfile = path.join(os.tmpdir(), 'amh_edit_' + Date.now() + '_' + nid + '.txt'); fs.writeFileSync(gfile, g.graph, { encoding: 'utf8' }); made.push(gfile); }
          a.push('-/filter_complex', gfile);
        } else a.push('-filter_complex', g.graph);
        return a.concat(['-map', '[v]', '-map', '[a]', '-t', String(g.duration)], E.encoderArgs(enc, job.q, H), ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out]);
      };
      const enc = job.enc || 'libx264';
      try { await runFfmpeg(args(enc), cwd, g.duration, onProgress, ctl); }
      catch (e) {
        // the graphics card refused (driver, size, busy): the processor does it
        if (ctl.stopped || enc === 'libx264') throw e;
        job.enc = 'libx264'; if (ctl.onEncoder) ctl.onEncoder('libx264');
        await runFfmpeg(args('libx264'), cwd, g.duration, onProgress, ctl);
      }
      if (!fs.existsSync(out)) throw new Error('no file');
      if (onProgress) onProgress(1);
      return out;
    } finally {
      made.forEach((x) => { try { fs.unlinkSync(x); } catch (e) {} });
    }
  }
  // the old one-file calls (tests, the narrow window)
  function render(out, onProgress) { return renderJob({ state: snapshot(), res: 1080, q: 'high', enc: 'libx264' }, out, onProgress); }
  async function exportVideo(onProgress, styled) {
    const X = window.__amhAppExport;
    const c = window.__amhAppChosen && window.__amhAppChosen();
    const out = X.uniquePath(c ? path.dirname(c.path) : os.tmpdir(), X.baseName() + ' (' + fmt.replace(':', 'x') + ')', '.mp4');
    await renderJob({ state: snapshot(), res: 1080, q: 'high', enc: 'libx264', caps: styled ? capsNow() : null }, out, onProgress);
    return { file: out };
  }
  function capsNow() {
    if (typeof STYLE === 'undefined' || STYLE === 'plain' || !STYLE_OK) return null;
    const cues = ((typeof reviewCues !== 'undefined' && reviewCues) || []).filter((q) => String(q.text || '').trim());
    if (!cues.length) return null;
    return { cues: styleCues(cues), style: STYLE, opts: styleOpts(STYLE), tag: !LICENSED, ffmpeg: FFMPEG, fonts: fontsDir() };
  }
  // the queue: one export at a time, editing goes on meanwhile
  const QUEUE = [];
  const qWatch = [];
  let qTimer = 0;
  const qChanged = () => { qTimer = 0; qWatch.forEach((f) => { try { f(QUEUE); } catch (e) {} }); };
  const qSoon = () => { if (!qTimer) qTimer = setTimeout(qChanged, 250); };
  const taken = {};
  function freePath(dir, base) {
    const X = window.__amhAppExport;
    let p2 = X.uniquePath(dir, base, '.mp4');
    for (let n = 2; taken[p2]; n++) p2 = X.uniquePath(dir, base + ' (' + n + ')', '.mp4');
    taken[p2] = 1;
    return p2;
  }
  // ids: preset ids; styled: draw the captions; useGpu: the graphics card if found
  async function queueExports(ids, styled, useGpu, names) {
    const X = window.__amhAppExport;
    const c = window.__amhAppChosen && window.__amhAppChosen();
    const dir = c ? path.dirname(c.path) : os.tmpdir();
    const enc = useGpu ? ((await detectGpu()) || 'libx264') : 'libx264';
    const state = snapshot();
    const caps = styled ? capsNow() : null;
    (ids || []).forEach((id) => {
      const P = E.PRESETS[id];
      if (!P) return;
      const label = (names && names[id]) || id;
      QUEUE.push({ id: newId(), label, preset: id, out: freePath(dir, X.baseName() + ' (' + FILE_TAGS[id] + ')'),
        status: 'wait', p: 0, eta: null, enc, job: { state, fmt: P.fmt || state.fmt, res: P.res, q: P.q, enc, caps } });
    });
    qChanged();
    runQueue();
  }
  let qRunning = false;
  async function runQueue() {
    if (qRunning) return;
    qRunning = true;
    for (;;) {
      const it = QUEUE.find((x) => x.status === 'wait');
      if (!it) break;
      it.status = 'run'; it.t0 = Date.now(); it.ctl = { onEncoder: (e) => { it.enc = e; qSoon(); } };
      qChanged();
      try {
        await renderJob(it.job, it.out, (x) => { it.p = x; it.eta = E.eta(x, (Date.now() - it.t0) / 1000); qSoon(); }, it.ctl);
        it.status = 'done'; it.p = 1; it.secs = Math.round((Date.now() - it.t0) / 1000);
      } catch (e) {
        it.status = it.ctl.stopped ? 'stop' : 'fail';
        it.err = e && e.message ? e.message : String(e);
        try { fs.unlinkSync(it.out); } catch (x) {}
      }
      delete taken[it.out];
      qChanged();
    }
    qRunning = false;
  }
  function stopExport(id) {
    const it = QUEUE.find((x) => x.id === id);
    if (!it) return;
    if (it.status === 'wait') { it.status = 'stop'; delete taken[it.out]; qChanged(); }
    else if (it.status === 'run' && it.ctl && it.ctl.kill) it.ctl.kill();
  }
  function clearDone() { for (let k = QUEUE.length - 1; k >= 0; k--) if (/done|fail|stop/.test(QUEUE[k].status)) QUEUE.splice(k, 1); qChanged(); }

  // ── labels ─────────────────────────────────────────────────────────────
  function relabel() {
    bMedia.textContent = '📁 ' + tx('ሚዲያ', 'Media');
    bPro.textContent = '✨ ' + tx('ፕሮ አድርግ', 'Make it pro');
    bPro.title = tx('ዝምታና እ… ድምፆች፣ የድምፅ ማጽዳት፣ loudness — በአንድ ጊዜ', 'Pauses and እ… sounds, clean voice, loudness — in one click');
    bSplit.textContent = '✂ ' + tx('ቁረጥ', 'Split');
    bSplit.title = tx('በማጫወቻው ቦታ ቁረጥ (S)', 'Split at the playhead (S)');
    bDel.textContent = '🗑 ' + tx('ሰርዝ', 'Delete');
    bDel.title = tx('የተመረጠውን ሰርዝ (Delete)', 'Remove what is selected (Delete)');
    bDup.textContent = '⧉ ' + tx('ድገም', 'Duplicate');
    bDup.title = tx('ቅጂ ከተመረጠው በኋላ (Ctrl+D) · ቅዳ Ctrl+C · ለጥፍ Ctrl+V · ብዙ ለመምረጥ Shift + ጠቅ', 'A copy right after it (Ctrl+D) · Copy Ctrl+C · Paste Ctrl+V · Shift + click to select several');
    bTrans.textContent = '⧓ ' + tx('ሽግግር', 'Transition');
    bZoom.textContent = '🔍 ' + tx('ዙም', 'Zoom');
    bZoom.title = tx('በማጫወቻው ቦታ ለስላሳ ዙም — ስታይሉን በ⚙ ይምረጡ', 'A smooth zoom at the playhead — choose its style in ⚙');
    bTrans.title = tx('ከማጫወቻው አጠገብ ባለው ቁርጥ ላይ ሽግግር', 'A transition on the cut nearest the playhead');
    bUndo.title = tx('መልስ (Ctrl+Z)', 'Undo (Ctrl+Z)');
    bRedo.title = tx('እንደገና (Ctrl+Shift+Z)', 'Redo (Ctrl+Shift+Z)');
    bPlay.title = tx('አጫውት / አቁም (Space)', 'Play / pause (Space)');
    labelSig = '';
    renderLabels();
    bText.textContent = '＋ T ' + tx('ጽሑፍ እና ቴምፕሌቶች', 'Text & templates');
    bText.title = tx('ርዕሶች፣ የስም ጽሑፍ፣ ሰብስክራይብ፣ በዓላት… ተንቀሳቃሽ ቴምፕሌቶች', 'Titles, lower thirds, subscribe, holidays… animated templates');
    renderModeSw();
    renderSound();
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
    return { v: 1, fmt, clips, ovl, txt, mus, snd, zm, trk, media, S: SRC };
  }
  function loadState(ed, cues) {
    opening = null;
    if (ed && Array.isArray(ed.clips) && ed.clips.length && ed.media) {
      media = ed.media; clips = ed.clips; ovl = ed.ovl || []; txt = ed.txt || []; mus = ed.mus || []; snd = ed.snd || { clean: false, loud: 'off' }; zm = ed.zm || []; trk = ed.trk || { tx: [], ov: [], au: [] }; fmt = ed.fmt || '16:9'; SRC = ed.S || {};
      Object.keys(media).forEach(loadPeaks);
      Object.keys(media).forEach(previewCopy);
      built = true; fitted = false; cur = 0; ET = 0; sel = null;
      reviewCues = E.deriveCaptions(clips, SRC);
      renderReview();
      seek(0); after(); renderMedia(); syncUndo();
    } else {
      built = false; media = {}; clips = []; ovl = []; txt = []; mus = []; snd = { clean: false, loud: 'off' }; zm = []; trk = { tx: [], ov: [], au: [] }; SRC = {};
      void cues;
      open();
    }
  }
  function reset() {
    pause();
    built = false; media = {}; clips = []; ovl = []; txt = []; mus = []; snd = { clean: false, loud: 'off' }; zm = []; trk = { tx: [], ov: [], au: [] }; SRC = {}; sel = null; fitted = false; REDO.length = 0; opening = null;
    Object.keys(TXEL).forEach((id) => { TXEL[id].remove(); delete TXEL[id]; });
    Object.keys(OVEL).forEach((id) => { OVEL[id].remove(); delete OVEL[id]; });
    Object.keys(MUEL).forEach((id) => { MUEL[id].pause(); MUEL[id].remove(); delete MUEL[id]; });
    const v = V(); if (v) delete v.dataset.m;
    setLeft(false);
  }
  new MutationObserver(() => { if (!review.classList.contains('show')) reset(); }).observe(review, { attributes: true, attributeFilter: ['class'] });
  const shown = () => { const c = window.__amhAppChosen && window.__amhAppChosen(); if (c && !Object.keys(media).length) addMedia(c.path, { id: 'm1' }).then(() => { const v = V(); if (v) v.dataset.m = 'm1'; frame(); }); };

  relabel();
  loadFonts();
  ST.attachEditor({ draw, drawSoon, seek, duration: total, peaks: editPeaks, open, shown, saveState, loadState, exportVideo, format: () => fmt,
    queueExports, stopExport, clearDone, detectGpu, gpuName: (e) => GPU_NAMES[e] || '', queue: () => QUEUE, onQueue: (f) => qWatch.push(f),
    setFormat: (f) => { if (f !== fmt) { change('format', () => { fmt = f; reframeAll(); }); showRfOffer(); } } });
  window.__amhEditor = { renderJob, snapshot, open, copySel, paste, duplicate, togglePick, selected, state: () => ({ clips, ovl, txt, mus, snd, zm, media, SRC, fmt, sel, built }), addOverlay, addText, addZoom, autoZooms, addBroll, brollPicker, findFaces, followFaces, frameClips, useSoundFolder, addMusic, addTransition, seek, play, pause, time, splitHere, deleteSel, cutRanges, moveRange, total, redo,
    select: (id) => { sel = id; picks = []; renderInspector(); frame(); drawSoon(); }, addMedia: addAndPlace, render, exportVideo, frame, setFormat: (f) => { if (f !== fmt) { change('format', () => { fmt = f; reframeAll(); }); showRfOffer(); } } };
})();
