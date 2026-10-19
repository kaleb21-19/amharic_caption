/*
 * studio_capcut.js — Amharic Captions Studio, ⬆ Export → CapCut (1.35.0).
 *
 * Adds the captions, styled, as real editable texts to the editor's own
 * CapCut project (the maths: capcut_core.js). Safe by design:
 *  - only projects that use THIS video are offered;
 *  - never while CapCut is running (it would overwrite the change, or the
 *    project could be damaged) — "close CapCut first";
 *  - a backup of the project file first; ↶ puts it back exactly;
 *  - sending again replaces our captions, never doubles them;
 *  - nothing else in the project is touched.
 * The fonts are installed on this PC first (Windows' own font folder) so
 * CapCut finds the Amharic font the captions use.
 *
 * 1.36: the Studio home lists your CapCut projects — "Add captions" makes the
 * captions for EVERY video in the project (kept, so "Update" after re-cutting
 * in CapCut takes seconds; a Studio project's fixed captions are used when
 * there is one) and puts them back in, one track. Mac's CapCut too.
 */
(function () {
  'use strict';
  const C = window.AmhCapCut;
  const APP = window.__amhApp;
  if (!C || !APP) return;
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text, title, fn) => { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  const BACKUP = '.amharic-captions.bak';     // draft_content.json + this: the project before our last change

  // where CapCut keeps its projects: Windows AppData\Local, Mac ~/Movies (1.36)
  function draftsDir() {
    const env = (window.process && window.process.env) || {};
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  // CapCut running? (Windows: tasklist; Mac: pgrep)
  function capcutRunning() {
    return new Promise((resolve) => {
      let out = '';
      try {
        const mac = process.platform === 'darwin';
        const p = mac ? spawn('pgrep', ['-x', 'CapCut']) : spawn('tasklist', ['/FI', 'IMAGENAME eq CapCut.exe', '/NH']);
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => resolve(mac ? /\d/.test(out) : /capcut\.exe/i.test(out)));
        p.on('error', () => resolve(false));
      } catch (e) { resolve(false); }
    });
  }
  function readDraft(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'draft_content.json'))); } catch (e) { return null; }
  }
  // the CapCut projects that use this video, newest first
  function projectsFor(videoPath) {
    const root = draftsDir();
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return { root, list: [], none: true }; }
    const want = C.normPath(videoPath);
    const list = [];
    names.forEach((n) => {
      if (n.charAt(0) === '.') return;
      const dir = path.join(root, n);
      let st = null;
      try { st = fs.statSync(path.join(dir, 'draft_content.json')); } catch (e) { return; }
      const d = readDraft(dir);
      if (!d) return;
      const s = C.summary(d);
      if (!s.videos.some((v) => C.normPath(v) === want)) return;
      list.push({ name: n, dir, at: st.mtimeMs, ours: s.ours, backup: fs.existsSync(path.join(dir, 'draft_content.json' + BACKUP)) });
    });
    return { root, list: list.sort((a, b) => b.at - a.at) };
  }

  // every CapCut project, newest first (the Studio home, 1.36)
  function allProjects(limit) {
    const root = draftsDir();
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return null; }
    const list = [];
    names.forEach((n) => {
      if (n.charAt(0) === '.') return;
      const dir = path.join(root, n);
      try { list.push({ name: n, dir, at: fs.statSync(path.join(dir, 'draft_content.json')).mtimeMs }); } catch (e) {}
    });
    list.sort((a, b) => b.at - a.at);
    return list.slice(0, limit || 8).map((p) => {
      const d = readDraft(p.dir);
      const vids = d ? C.videosOf(d) : [];
      const ch = d ? C.chosenAnims(d) : {};
      return Object.assign(p, { videos: vids, here: vids.filter((v) => fs.existsSync(v)), ours: d ? C.ourTracks(d).length : 0,
        anim: Object.keys(ch).map((k) => ch[k].name).filter(Boolean).join(' + '),
        backup: fs.existsSync(path.join(p.dir, 'draft_content.json' + BACKUP)) });
    }).filter((p) => p.videos.length);
  }

  // ── the words of a video, kept (1.36): "Update" after re-cutting in CapCut
  // takes seconds, no new transcription. The Studio project's own captions
  // (with the editor's fixes) win when there is one for that video.
  const cacheDir = () => path.join(window.__amhStudio.projDir(), 'capcut-words');
  const cacheFile = (v) => path.join(cacheDir(), window.AmhStudio.projectId(v) + '.json');
  function stamp(v) { try { const s = fs.statSync(v); return s.size + ':' + Math.round(s.mtimeMs); } catch (e) { return ''; } }
  function studioCues(v) {
    const p = (window.__amhStudio.listProjects() || []).find((x) => C.normPath(x.video) === C.normPath(v));
    if (!p || !p.cues || !p.cues.length) return null;
    const ed = p.edit;
    if (ed && ed.S && ed.media) {
      const id = Object.keys(ed.media).find((k) => C.normPath(ed.media[k].path) === C.normPath(v));
      if (id && ed.S[id] && ed.S[id].length) return ed.S[id];
    }
    return ed ? null : p.cues;            // no edit: the captions are in the file's time
  }
  function cachedCues(v) {
    const own = studioCues(v);
    if (own) return own;
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile(v)));
      if (c && c.stamp === stamp(v) && Array.isArray(c.cues)) return c.cues;
    } catch (e) {}
    return null;
  }
  function keepCues(v, cues) {
    try {
      if (!fs.existsSync(cacheDir())) fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(cacheFile(v), JSON.stringify({ video: v, stamp: stamp(v), cues }), { encoding: 'utf8' });
    } catch (e) {}
  }

  // ── what we sent to each CapCut project (1.39), so fixes made in CapCut
  // are recognised on Update — kept in the Studio's own folder, not CapCut's
  const sentFile = (dir) => path.join(cacheDir(), 'sent-' + window.AmhStudio.projectId(dir) + '.json');
  function loadSent(dir) { try { return JSON.parse(fs.readFileSync(sentFile(dir))); } catch (e) { return null; } }
  function saveSent(dir, draft) {
    try {
      if (!fs.existsSync(cacheDir())) fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(sentFile(dir), JSON.stringify(C.sentMap(draft)), { encoding: 'utf8' });
    } catch (e) {}
  }
  // the editor's CapCut fixes -> 🧠 memory (word for word) ; returns the pairs
  function learn(edits) {
    const pairs = [];
    edits.forEach((e) => C.wordPairs(e.was, e.text).forEach((p) => pairs.push(p)));
    if (!pairs.length || typeof loadFixStore !== 'function') return [];
    const st = loadFixStore();
    pairs.forEach(([w, r]) => rememberFix(st, w, r, true));
    saveFixStore(st);
    return pairs;
  }
  // the remembered fixes on captions made before they were learned
  function withMemory(cues) {
    if (typeof loadFixStore !== 'function' || typeof applyFixes !== 'function') return cues;
    const fx = activeFixes(loadFixStore());
    if (!Object.keys(fx).length) return cues;
    return cues.map((c) => Object.assign({}, c, { text: applyFixes(c.text, fx).text }));
  }
  // build for these items, keep the editor's fixes, write (backup first);
  // returns { built, kept, lost, learned } or throws
  function writeProject(p, d, items, look) {
    // what we sent (or, for a project sent before 1.39, what we would have)
    const sent = loadSent(p.dir) || (C.ourTracks(d).length ? C.expectedSent(d, C.buildTrackAll(d, items, look)) : null);
    const edits = C.userEdits(d, sent);
    const learned = learn(edits);
    const built = C.buildTrackAll(d, items.map((it) => ({ video: it.video, cues: withMemory(it.cues) })), look);
    const k = C.keepEdits(built, edits);
    if (!built.placed) return { built, kept: 0, lost: k.lost, learned };
    const file = path.join(p.dir, 'draft_content.json');
    const out = C.addTrack(d, built);
    fs.copyFileSync(file, file + BACKUP);
    fs.writeFileSync(file, JSON.stringify(out), { encoding: 'utf8' });
    saveSent(p.dir, out);
    return { built, kept: k.kept, lost: k.lost, learned };
  }
  function fixesNote(r, out) {
    if (r.kept) out.appendChild(el('div', 'st-sub', '✍ ' + r.kept + ' ' + tx('በCapCut ያረሙት ካፕሽን(ኖች) እንዳሉ ቀርተዋል።', 'caption(s) you fixed in CapCut were kept.')));
    if (r.learned && r.learned.length) out.appendChild(el('div', 'st-sub', '🧠 ' + tx('ተማረ፦ ', 'Learned: ') +
      r.learned.slice(0, 4).map((x) => x[0] + ' → ' + x[1]).join(' · ') + tx(' — ከአሁን በኋላ በሁሉም ቪዲዮዎች ይስተካከላል።', ' — fixed in every video from now on.')));
    if (r.lost && r.lost.length) out.appendChild(el('div', 'st-warn', '⚠ ' + r.lost.length + ' ' + tx('ያረሙት ካፕሽን ቦታው ስለተቆረጠ አልተቀመጠም፦ ', 'fixed caption(s) were in a part that is cut now: ') +
      r.lost.slice(0, 2).map((e) => '«' + e.text + '»').join(', ')));
  }

  // the captions in the video FILE's time (the edit may have cut or moved them)
  function fileCues(videoPath) {
    const ed = window.__amhEditor, E = window.AmhEdit;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    if (!ed || !E || !ed.state) return cues;
    const st = ed.state();
    if (!st.built) return cues;
    const S = E.syncBack(st.clips, st.SRC, cues);
    const id = Object.keys(st.media || {}).find((k) => C.normPath(st.media[k].path) === C.normPath(videoPath));
    return (id && S[id]) || cues;
  }
  const FONT_FILES = { sans: ['NotoSansEthiopic-Bold.ttf', 'NotoSansEthiopic-Regular.ttf'], menbere: ['Menbere-Bold.ttf', 'Menbere-Regular.ttf'],
    serif: ['NotoSerifEthiopic-Bold.ttf', 'NotoSerifEthiopic-Regular.ttf'], abyssinica: ['AbyssinicaSIL-Regular.ttf'],
    yebse: ['yebse.ttf'], washra: ['washrab.ttf'], agbalumo: ['Agbalumo-Regular.ttf'], tint: ['tint.ttf'], fantuwua: ['fantuwua.ttf'],
    jiret: ['jiret.ttf'], hibur: ['HiburMono-Regular.ttf'], gothic: ['yigezubisratgothic.ttf'] };
  // the font file CapCut should use: installed in Windows' font folder (so it
  // stays when the Studio updates); the Studio's own copy if that fails
  async function fontPath(id) {
    const names = FONT_FILES[id] || FONT_FILES.sans;
    let dir = '';
    try { const r = typeof installFonts === 'function' ? await installFonts() : null; dir = (r && r.dir) || ''; } catch (e) {}
    const own = typeof RUNTIME !== 'undefined' && RUNTIME ? path.join(RUNTIME, 'fonts') : '';
    for (const d of [dir, own]) {
      if (!d) continue;
      for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p.replace(/\\/g, '/'); }
    }
    return '';
  }

  async function send(p, video, out) {
    out.textContent = '';
    if (await capcutRunning()) {
      out.appendChild(el('div', 'st-warn', tx('እባክዎ መጀመሪያ CapCutን ይዝጉ፣ ከዚያ እንደገና ይሞክሩ።', 'Please close CapCut first, then try again.')));
      return;
    }
    const file = path.join(p.dir, 'draft_content.json');
    const d = readDraft(p.dir);
    if (!d) { out.appendChild(el('div', 'st-warn', tx('ፕሮጀክቱ ሊነበብ አልቻለም።', 'The project could not be read.'))); return; }
    const style = typeof STYLE !== 'undefined' ? STYLE : 'plain';
    const o = typeof styleOpts === 'function' ? styleOpts(style) : {};
    const cv = d.canvas_config || {};
    const portrait = (cv.height || 1920) > (cv.width || 1080);
    const look = C.lookFor(style, o, await fontPath(o.font || 'sans'), portrait, window.__amhSubs && window.__amhSubs.state().capY);
    void file;
    let r;
    try { r = writeProject(p, d, [{ video, cues: fileCues(video) }], look); } catch (e) {
      out.appendChild(el('div', 'st-warn', tx('አልተሳካም፦ ', 'Failed: ') + (e && e.message ? e.message : e)));
      return;
    }
    const built = r.built;
    if (!built.placed) {
      out.appendChild(el('div', 'st-warn', tx('በዚህ ፕሮጀክት ውስጥ የዚህ ቪዲዮ ክፍል ከካፕሽኖቹ ጋር አልተገኘም።', 'No part of this video with captions was found in the project.')));
      return;
    }
    out.appendChild(el('div', 'st-ok', '✓ ' + built.placed + ' ' + tx('ካፕሽኖች ወደ «' + p.name + '» ተጨመሩ — CapCutን ይክፈቱ።', 'captions added to «' + p.name + '» — open CapCut.')));
    if (built.skipped) out.appendChild(el('div', 'st-sub', built.skipped + ' ' + tx('ካፕሽኖች ቪዲዮው በፕሮጀክቱ ውስጥ በሌለበት ክፍል ስለሆኑ አልተጨመሩም።', 'captions are in parts of the video that are not in the project, so they were left out.')));
    fixesNote(r, out);
    out.appendChild(el('div', 'st-sub', tx('እያንዳንዱ ካፕሽን በCapCut ውስጥ እንደሚታረም ጽሑፍ ነው። እንቅስቃሴ (animation) በCapCut ውስጥ ለሁሉም በአንድ ጊዜ መጨመር ይቻላል።',
      'Each caption is a normal CapCut text you can edit. Add a CapCut animation to all of them at once there if you like.')));
    out.appendChild(btn('st-btn', '↶ ' + tx('የCapCut ለውጡን መልስ', 'Undo the CapCut change'), '', () => undo(p, out)));
  }
  // Caption a whole CapCut project (1.36): every video in it (made once,
  // kept), all into one track; the same safety as the Export card.
  let busy = false;
  async function captionProject(p, out, onDone) {
    if (busy) return;
    out.textContent = '';
    const say = (t, cls) => { const d = el('div', cls || 'st-sub', t); out.appendChild(d); return d; };
    if (await capcutRunning()) { say(tx('እባክዎ መጀመሪያ CapCutን ይዝጉ፣ ከዚያ እንደገና ይሞክሩ።', 'Please close CapCut first, then try again.'), 'st-warn'); return; }
    const d = readDraft(p.dir);
    if (!d) { say(tx('ፕሮጀክቱ ሊነበብ አልቻለም።', 'The project could not be read.'), 'st-warn'); return; }
    const vids = C.videosOf(d);
    const missing = vids.filter((v) => !fs.existsSync(v));
    busy = true;
    const items = [];
    try {
      for (let i = 0; i < vids.length; i++) {
        const v = vids[i];
        if (!fs.existsSync(v)) continue;
        let cues = cachedCues(v);
        if (!cues) {
          const line = say('⏳ ' + tx('ካፕሽን እየተሰራ ነው', 'Making captions') + ' (' + (i + 1) + '/' + vids.length + ') · ' + path.basename(v));
          try { cues = await transcribeExtra(v); } catch (e) { line.textContent = '⚠ ' + path.basename(v) + ': ' + (e && e.message ? e.message : e); line.className = 'st-warn'; continue; }
          keepCues(v, cues);
          line.textContent = '✓ ' + path.basename(v);
        }
        items.push({ video: v, cues });
      }
    } finally { busy = false; }
    if (!items.length) { say(tx('ምንም ካፕሽን አልተሰራም።', 'No captions were made.'), 'st-warn'); return; }
    if (await capcutRunning()) { say(tx('CapCut ተከፍቷል — ይዝጉትና እንደገና ይጫኑ (ካፕሽኖቹ ተቀምጠዋል፣ እንደገና አይሰሩም)።', 'CapCut is open — close it and press again (the captions are kept, nothing is made again).'), 'st-warn'); return; }
    const style = typeof STYLE !== 'undefined' ? STYLE : 'plain';
    const o = typeof styleOpts === 'function' ? styleOpts(style) : {};
    const cv = d.canvas_config || {};
    const portrait = (cv.height || 1920) > (cv.width || 1080);
    const look = C.lookFor(style, o, await fontPath(o.font || 'sans'), portrait);
    let r;
    try { r = writeProject(p, d, items, look); } catch (e) { say(tx('አልተሳካም፦ ', 'Failed: ') + (e && e.message ? e.message : e), 'st-warn'); return; }
    const built = r.built;
    if (!built.placed) { say(tx('በፕሮጀክቱ ውስጥ ካፕሽን የሚገባበት ቦታ አልተገኘም።', 'No place for captions was found in the project.'), 'st-warn'); return; }
    out.textContent = '';
    say('✓ ' + built.placed + ' ' + tx('ካፕሽኖች ወደ «' + p.name + '» ገብተዋል — CapCutን ይክፈቱ።', 'captions are in «' + p.name + '» — open CapCut.'), 'st-ok');
    if (missing.length) say(tx(missing.length + ' ቪዲዮ(ዎች) በዚህ ኮምፒውተር ላይ አልተገኙም፦ ', missing.length + ' video(s) not found on this PC: ') + missing.map((v) => path.basename(v)).join(', '));
    fixesNote(r, out);
    say(tx('በCapCut ውስጥ ቪዲዮውን ቢቆርጡ፣ እዚህ "አዘምን" ይጫኑ — በሰከንዶች ይስተካከላል።', 'Cut the video again in CapCut? Press "Update" here — it is redone in seconds.'));
    out.appendChild(btn('st-btn', '↶ ' + tx('የCapCut ለውጡን መልስ', 'Undo the CapCut change'), '', () => undo(p, out)));
    if (onDone) onDone('✓ ' + built.placed + ' ' + tx('ካፕሽኖች ወደ «' + p.name + '» ገብተዋል — CapCutን ይክፈቱ።', 'captions are in «' + p.name + '» — open CapCut.') +
      (r.kept ? ' ✍ ' + r.kept + ' ' + tx('ያረሙት ቀርቷል', 'of your fixes kept') : '') +
      (r.learned && r.learned.length ? ' · 🧠 ' + r.learned.map((x) => x[0] + '→' + x[1]).slice(0, 3).join(', ') : ''));
  }

  // the Studio home: your CapCut projects
  function homeCard(note) {
    const anchor = document.getElementById('studioRecent');
    if (!anchor || !anchor.parentNode) return;
    let card = document.getElementById('studioCapcut');
    if (!card) {
      card = el('div', 'card studio-recent st-cchome');
      card.id = 'studioCapcut';
    }
    // a CapCut user (1.38): their CapCut projects come first, above Recent
    let ed = '';
    try { ed = (typeof loadSettings === 'function' && loadSettings().editor) || ''; } catch (e) {}
    if (ed === 'capcut') { if (card.nextSibling !== anchor) anchor.before(card); }
    else if (card.previousSibling !== anchor) anchor.after(card);
    const list = allProjects(6);
    card.textContent = '';
    card.style.display = list && list.length ? '' : 'none';
    if (!list || !list.length) return;
    const head = el('div', 'st-home-h', '✏️ ' + tx('የCapCut ፕሮጀክቶችዎ — ካፕሽን ይጨምሩ', 'Your CapCut projects — add captions'));
    card.appendChild(head);
    if (typeof note === 'string' && note) card.appendChild(el('div', 'st-ok', note));
    const style = typeof STYLE !== 'undefined' ? STYLE : 'plain';
    const sname = typeof STYLE_NAMES !== 'undefined' ? (typeof L === 'function' ? L(STYLE_NAMES[style] || style) : style) : style;
    card.appendChild(el('div', 'st-sub', tx('ስታይል፦ ', 'Style: ') + sname + ' · ' + tx('CapCutን ይዝጉ፣ ከዚያ ይጫኑ።', 'Close CapCut, then press.')));
    list.forEach((p) => {
      const row = el('div', 'st-row st-ccrow');
      const name = el('span', 'st-ccname', p.name);
      name.title = p.dir;
      row.appendChild(name);
      const info = p.videos.length + ' ' + tx('ቪዲዮ', p.videos.length === 1 ? 'video' : 'videos') + ' · ' + new Date(p.at).toLocaleDateString() +
        (p.ours ? ' · ✓ ' + tx('ካፕሽን አለው', 'has captions') : '') + (p.here.length < p.videos.length ? ' · ⚠ ' + tx('ቪዲዮ ጠፍቷል', 'video missing') : '');
      row.appendChild(el('span', 'st-sub', info));
      row.appendChild(el('span', 'st-flex'));
      const res = el('div', 'st-ccres');
      const go = btn('st-btn primary', p.ours ? '↻ ' + tx('አዘምን', 'Update') : tx('ካፕሽን ጨምር', 'Add captions'), '', async () => {
        go.disabled = true;
        try { await captionProject(p, res, (msg) => setTimeout(() => homeCard(msg), 300)); } finally { go.disabled = false; }
      });
      if (!p.here.length) go.disabled = true;
      row.appendChild(go);
      if (p.backup) row.appendChild(btn('st-btn', '↶', tx('የመጨረሻውን ለውጥ መልስ', 'Undo the last change'), () => undo(p, res)));
      card.appendChild(row);
      // 1.37: an animation given to one caption in CapCut -> all captions
      if (p.ours && p.anim) {
        const ar = el('div', 'st-row st-ccanim');
        ar.appendChild(el('span', 'st-sub', '✨ ' + tx('በCapCut የሰጡት እንቅስቃሴ፦ ', 'Animation you gave in CapCut: ') + p.anim));
        ar.appendChild(el('span', 'st-flex'));
        ar.appendChild(btn('st-btn', tx('ለሁሉም ካፕሽኖች', 'Use for all captions'), '', () => spread(p, res)));
        card.appendChild(ar);
      } else if (p.ours) {
        card.appendChild(el('div', 'st-sub st-cchint', '✨ ' + tx('በCapCut ውስጥ ለአንድ ካፕሽን እንቅስቃሴ (Animation) ይስጡ — እዚህ ለሁሉም ይገለበጣል።',
          'Give one caption an animation in CapCut — it can be copied to all of them here.')));
      }
      card.appendChild(res);
    });
  }
  // the home shows: refresh the list (CapCut may have saved new projects)
  const review = document.getElementById('review');
  if (review) new MutationObserver(() => { if (!review.classList.contains('show')) setTimeout(homeCard, 50); })
    .observe(review, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('focus', () => { if (!busy && (!review || !review.classList.contains('show'))) homeCard(); });
  setTimeout(homeCard, 400);

  // copy the chosen CapCut animation to every caption of ours (1.37)
  async function spread(p, out) {
    out.textContent = '';
    if (await capcutRunning()) { out.appendChild(el('div', 'st-warn', tx('እባክዎ መጀመሪያ CapCutን ይዝጉ።', 'Please close CapCut first.'))); return; }
    const file = path.join(p.dir, 'draft_content.json');
    const d = readDraft(p.dir);
    if (!d) return;
    if (!loadSent(p.dir)) saveSent(p.dir, d);
    const r = C.spreadAnims(d);
    if (!r.n) { out.appendChild(el('div', 'st-warn', tx('የተሰጠ እንቅስቃሴ አልተገኘም።', 'No animation was found.'))); return; }
    try {
      fs.copyFileSync(file, file + BACKUP);
      fs.writeFileSync(file, JSON.stringify(r.draft), { encoding: 'utf8' });
    } catch (e) { out.appendChild(el('div', 'st-warn', tx('አልተሳካም፦ ', 'Failed: ') + (e && e.message ? e.message : e))); return; }
    out.appendChild(el('div', 'st-ok', '✓ «' + r.names.join(' + ') + '» ' + tx('ለ ' + r.n + ' ካፕሽኖች ተሰጥቷል — CapCutን ይክፈቱ።', 'is on all ' + r.n + ' captions — open CapCut.')));
    out.appendChild(btn('st-btn', '↶ ' + tx('መልስ', 'Undo'), '', () => undo(p, out)));
  }
  async function undo(p, out) {
    if (await capcutRunning()) { out.appendChild(el('div', 'st-warn', tx('መጀመሪያ CapCutን ይዝጉ።', 'Close CapCut first.'))); return; }
    const file = path.join(p.dir, 'draft_content.json');
    try {
      fs.copyFileSync(file + BACKUP, file);
      fs.unlinkSync(file + BACKUP);
      out.textContent = '';
      out.appendChild(el('div', 'st-ok', '✓ ' + tx('«' + p.name + '» እንደነበረው ተመልሷል።', '«' + p.name + '» is back as it was.')));
    } catch (e) { out.appendChild(el('div', 'st-warn', tx('መመለስ አልተቻለም፦ ', 'Could not undo: ') + (e && e.message ? e.message : e))); }
  }

  // the card in ⬆ Export (studio.js openExport calls this)
  window.__amhCapCutCard = function (card) {
    const c = window.__amhAppChosen && window.__amhAppChosen();
    if (!c) return;
    const k = card('✏️', 'CapCut — ' + tx('የሚታረሙ ካፕሽኖች', 'editable captions'),
      tx('በስታይሉ ያሉ ካፕሽኖችን ወደ CapCut ፕሮጀክትዎ ይጨምራል። መጀመሪያ ቪዲዮውን በCapCut ውስጥ ያስገቡና CapCutን ይዝጉ።',
        'Adds the captions, styled, to your CapCut project. First import this video in CapCut, then close CapCut.'));
    const show = () => {
      k.out.textContent = '';
      const r = projectsFor(c.path);
      if (r.none) { k.out.appendChild(el('div', 'st-sub', tx('CapCut በዚህ ኮምፒውተር ላይ አልተገኘም።', 'CapCut was not found on this PC.'))); return; }
      if (!r.list.length) {
        k.out.appendChild(el('div', 'st-sub', tx('ይህን ቪዲዮ የያዘ CapCut ፕሮጀክት የለም። በCapCut ውስጥ አዲስ ፕሮጀክት ከፍተው ይህን ቪዲዮ ያስገቡ፣ ይዝጉት፣ ከዚያ ↻ ይጫኑ።',
          'No CapCut project uses this video yet. In CapCut, start a project with this video, close CapCut, then press ↻.')));
        k.out.appendChild(btn('st-btn', '↻ ' + tx('እንደገና ፈልግ', 'Look again'), '', show));
        return;
      }
      r.list.slice(0, 6).forEach((p) => {
        const row = el('div', 'st-row st-ccrow');
        const name = el('span', 'st-ccname', p.name);
        name.title = p.dir;
        row.appendChild(name);
        row.appendChild(el('span', 'st-sub', new Date(p.at).toLocaleDateString() + (p.ours ? ' · ' + tx('ካፕሽኖች አሉት', 'has our captions') : '')));
        row.appendChild(el('span', 'st-flex'));
        const res = el('div', 'st-ccres');
        row.appendChild(btn('st-btn primary', p.ours ? tx('አዘምን', 'Update') : tx('ካፕሽኖችን ጨምር', 'Add captions'), '', () => send(p, c.path, res)));
        if (p.backup) row.appendChild(btn('st-btn', '↶', tx('የመጨረሻውን ለውጥ መልስ', 'Undo the last change'), () => undo(p, res)));
        k.out.appendChild(row);
        k.out.appendChild(res);
      });
    };
    k.h.appendChild(btn('st-btn', tx('ፕሮጀክቶች', 'Projects'), '', show));
  };
  window.__amhCapCut = { draftsDir, projectsFor, allProjects, fileCues, send, undo, spread, capcutRunning, captionProject, homeCard, cachedCues };
})();
