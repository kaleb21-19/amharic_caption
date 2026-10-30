/*
 * studio_davinci.js — Amharic Captions Studio, ⬆ Export → DaVinci (1.43.0).
 *
 * The captions, styled, as editable Text+ titles in DaVinci Resolve (the free
 * one too). The Studio writes the captions + the style to its own folder and
 * installs one script in DaVinci's Workspace → Scripts menu; in DaVinci the
 * editor opens the timeline and picks Workspace → Scripts → Amharic Captions.
 * The script (app/amh_davinci.lua) puts them on ONE new track on top, with
 * every other track locked, and checks nothing of the editor's moved.
 * "Decompose in Place" then makes every caption its own Text+.
 * Nothing of DaVinci's own is changed: one file in its Scripts folder.
 */
(function () {
  'use strict';
  const V = window.AmhDaVinci;
  const APP = window.__amhApp;
  if (!V || !APP) return;
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (cls, text, title, fn) => { const b = el('button', cls, text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', fn); return b; };
  const env = () => (window.process && window.process.env) || {};

  const resolveHome = () => V.resolveHome(process.platform, env(), os.homedir(), path.join);
  const scriptsDir = () => V.scriptsDir(process.platform, env(), os.homedir(), path.join);
  const dataFile = () => path.join(window.__amhStudio.projDir(), 'davinci', 'captions.lua');

  // every video of the edit with its captions, in that FILE's seconds (the
  // script finds each piece of each video on the DaVinci timeline itself)
  function items(videoPath) {
    const ed = window.__amhEditor, E = window.AmhEdit;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const st = ed && E && ed.state ? ed.state() : null;
    if (st && st.built) {
      const S = E.syncBack(st.clips, st.SRC, cues);
      const out = Object.keys(st.media || {}).filter((id) => S[id] && S[id].length)
        .map((id) => ({ path: st.media[id].path, cues: S[id] }));
      if (out.length) return out;
    }
    return [{ path: videoPath, cues }];
  }

  let busy = false;
  async function send(videoPath, out) {
    if (busy) return;
    busy = true;
    try { await sendNow(videoPath, out); } finally { busy = false; }
  }
  async function sendNow(videoPath, out) {
    out.textContent = '';
    const say = (t, cls) => { const d = el('div', cls || 'st-sub', t); out.appendChild(d); return d; };
    const home = resolveHome();
    if (!home || !fs.existsSync(home)) {
      say(tx('DaVinci Resolve በዚህ ኮምፒውተር ላይ አልተገኘም። ከጫኑት በኋላ አንድ ጊዜ ይክፈቱትና እንደገና ይሞክሩ።',
        'DaVinci Resolve was not found on this PC. After installing it, open it once, then try again.'), 'st-warn');
      return;
    }
    const style = typeof STYLE !== 'undefined' ? STYLE : 'plain';
    const o = typeof styleOpts === 'function' ? styleOpts(style) : {};
    const look = V.lookFor(style, o, window.__amhSubs && window.__amhSubs.state().capY);
    const data = V.dataLua(items(videoPath), look, typeof AMH_LANG !== 'undefined' ? AMH_LANG : 'am');
    if (!data.cues) { say(tx('የሚላክ ካፕሽን የለም።', 'There are no captions to send.'), 'st-warn'); return; }
    const wait = say('⏳ ' + tx('እየተዘጋጀ ነው…', 'Getting it ready…'));
    // the fonts on this PC first, so DaVinci can draw them
    let fresh = 0;
    try { const r = typeof installFonts === 'function' ? await installFonts() : null; fresh = ((r && r.installed) || []).length; } catch (e) {}
    try {
      const src = await (await fetch('/__app/amh_davinci.lua')).text();
      const df = dataFile();
      if (!fs.existsSync(path.dirname(df))) fs.mkdirSync(path.dirname(df), { recursive: true });
      fs.writeFileSync(df, data.text, { encoding: 'utf8' });
      const dir = scriptsDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, V.SCRIPT_NAME), V.withData(src, df), { encoding: 'utf8' });
    } catch (e) {
      wait.remove();
      say(tx('አልተሳካም፦ ', 'Failed: ') + (e && e.message ? e.message : e), 'st-warn');
      return;
    }
    wait.remove();
    say('✓ ' + data.cues + ' ' + tx('ካፕሽኖች ለDaVinci ተዘጋጅተዋል።', 'captions are ready for DaVinci.'), 'st-ok');
    if (window.__amhMarkDone) window.__amhMarkDone('davinci');
    const ol = el('ol', 'st-steps');
    [tx('DaVinciን ከፍተው ማንኛውንም Project ይክፈቱ (ወይም New Project) — ቪዲዮው Timeline ላይ ከሌለ ስክሪፕቱ ራሱ ያስገባዋል።',
        'Open DaVinci and open any project (or New Project) — if the video is not on a timeline yet, the script brings it in by itself.'),
      tx('Workspace → Scripts → Amharic Captions ይጫኑ — ካፕሽኖቹ ከቪዲዮው በላይ በአዲስ track ይገባሉ (ቪዲዮዎ አይነካም)።',
        'Click Workspace → Scripts → Amharic Captions — the captions go on a new track above the video (your video is not touched).'),
      tx('ለማረም፦ ብሎኩን Right-click → «Decompose in Place» — እያንዳንዱ ካፕሽን Text+ ይሆናል (Inspector → Text)።',
        'To edit: right-click the block → «Decompose in Place» — every caption becomes a Text+ (Inspector → Text).')]
      .forEach((t) => ol.appendChild(el('li', '', t)));
    out.appendChild(ol);
    if (fresh) say(tx('DaVinci አሁን ክፍት ከሆነ አንድ ጊዜ ዘግተው ይክፈቱት — አዲሶቹን የአማርኛ ፎንቶች እንዲያይ።',
      'If DaVinci is open now, close and open it once — so it sees the new Amharic fonts.'));
    say(tx('ቪዲዮውን በDaVinci ውስጥ ቢቆርጡ፣ ብቻ Scriptሩን እንደገና ያስኪዱ — ካፕሽኖቹ ከአዲሱ ቆረጣ ጋር ይስተካከላሉ (የቀድሞው track ይጠፋል እንጂ አይሰረዝም)።',
      'Cut the video again in DaVinci? Just run the script again — the captions follow the new cut (the older track is turned off, not deleted).'));
    let here = {};
    try { here = (window.__amhAppExport && window.__amhAppExport.editors && window.__amhAppExport.editors()) || {}; } catch (e) {}
    // 1.80.2: the owner opened DaVinci, saw an empty project and stopped — the
    // script step was a line in a list. Now it is the big last thing said.
    const next = el('div', 'st-ok st-dv-next', '👉 ' + tx('በDaVinci ውስጥ፦ Project ይክፈቱ፣ ከዚያ ከላይ ሜኑ Workspace → Scripts → Amharic Captions ይጫኑ — ቪዲዮውና ካፕሽኖቹ በራሳቸው ይገባሉ።',
      'In DaVinci: open a project, then in the top menu click Workspace → Scripts → Amharic Captions — the video and the captions come in by themselves.'));
    if (here.davinci) {
      out.appendChild(btn('st-btn primary', '🎞️ ' + tx('DaVinciን ክፈት', 'Open DaVinci'), '', () => {
        try { APP.call('openEditor', ['davinci']); } catch (e) {}
        next.classList.add('st-dv-flash');
      }));
    }
    out.appendChild(next);
  }

  // the card in ⬆ Export (studio.js openExport calls this)
  window.__amhDaVinciCard = function (card) {
    const c = window.__amhAppChosen && window.__amhAppChosen();
    if (!c) return;
    const k = card('🎞️', 'DaVinci Resolve — ' + tx('የሚታረሙ ካፕሽኖች', 'editable captions'),
      tx('በስታይሉ ያሉ ካፕሽኖች እንደ Text+ በDaVinci Timelineዎ ላይ — እያንዳንዱ ይታረማል። ነፃው DaVinciም ይሰራል።',
        'The captions, styled, as Text+ on your DaVinci timeline — each one editable. The free DaVinci works too.'));
    k.h.appendChild(btn('st-btn primary', tx('ወደ DaVinci ላክ', 'Send to DaVinci'), '', () => send(c.path, k.out)));
    k.run = () => send(c.path, k.out);
    return k;
  };
  window.__amhDaVinci = { send, items, dataFile, scriptsDir };
})();
