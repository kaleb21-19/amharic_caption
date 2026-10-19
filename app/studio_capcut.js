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

  function draftsDir() {
    const env = (window.process && window.process.env) || {};
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
  }
  // CapCut running? (Windows: tasklist; elsewhere not checked)
  function capcutRunning() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') { resolve(false); return; }
      let out = '';
      try {
        const p = spawn('tasklist', ['/FI', 'IMAGENAME eq CapCut.exe', '/NH']);
        p.stdout.on('data', (d) => { out += d; });
        p.on('close', () => resolve(/capcut\.exe/i.test(out)));
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
    const built = C.buildTrack(d, video, fileCues(video), look);
    if (!built.placed) {
      out.appendChild(el('div', 'st-warn', tx('በዚህ ፕሮጀክት ውስጥ የዚህ ቪዲዮ ክፍል ከካፕሽኖቹ ጋር አልተገኘም።', 'No part of this video with captions was found in the project.')));
      return;
    }
    try {
      fs.copyFileSync(file, file + BACKUP);                         // the project as it was
      fs.writeFileSync(file, JSON.stringify(C.addTrack(d, built)), { encoding: 'utf8' });
    } catch (e) {
      out.appendChild(el('div', 'st-warn', tx('አልተሳካም፦ ', 'Failed: ') + (e && e.message ? e.message : e)));
      return;
    }
    out.appendChild(el('div', 'st-ok', '✓ ' + built.placed + ' ' + tx('ካፕሽኖች ወደ «' + p.name + '» ተጨመሩ — CapCutን ይክፈቱ።', 'captions added to «' + p.name + '» — open CapCut.')));
    if (built.skipped) out.appendChild(el('div', 'st-sub', built.skipped + ' ' + tx('ካፕሽኖች ቪዲዮው በፕሮጀክቱ ውስጥ በሌለበት ክፍል ስለሆኑ አልተጨመሩም።', 'captions are in parts of the video that are not in the project, so they were left out.')));
    out.appendChild(el('div', 'st-sub', tx('እያንዳንዱ ካፕሽን በCapCut ውስጥ እንደሚታረም ጽሑፍ ነው። እንቅስቃሴ (animation) በCapCut ውስጥ ለሁሉም በአንድ ጊዜ መጨመር ይቻላል።',
      'Each caption is a normal CapCut text you can edit. Add a CapCut animation to all of them at once there if you like.')));
    out.appendChild(btn('st-btn', '↶ ' + tx('የCapCut ለውጡን መልስ', 'Undo the CapCut change'), '', () => undo(p, out)));
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
  window.__amhCapCut = { draftsDir, projectsFor, fileCues, send, undo, capcutRunning };
})();
