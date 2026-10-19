/*
 * studio_subs.js — Amharic Captions Studio: the chosen caption style, live in
 * the player (1.29.0).
 *
 * The exported video gets its captions from libass (amh_styles writes an ASS
 * script, ffmpeg draws it). Here the very same script is drawn by libass
 * itself, compiled to WebAssembly (JASSUB, app/vendor), on a canvas over the
 * picture, at the editor's own time on every frame. So the player shows the
 * style exactly as it will be exported - animations, colours, fonts, the free
 * version's tag. Captions or style changed -> the script is made again.
 * Anything missing (an old browser engine, no WebAssembly) -> the plain
 * caption line as before.
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  const E = window.AmhEdit;
  if (!APP || !E || typeof renderStyled !== 'function') return;
  const VENDOR = '/__app/vendor/jassub/dist/';
  let JASSUB = null;           // the class, once loaded
  let jas = null;              // the renderer for the open project
  let canvas = null;
  let stage = null;
  let failed = false;
  let key = '';                // what the current script was made from
  let making = 0;              // a script is being made
  let want = '';               // the newest key asked for
  let fontsIn = {};            // font files already given to libass
  let size = { w: 1920, h: 1080 };
  let on = false;
  let retries = 0;             // the script could not be made: tries again
  let capY = 0.85;             // where the caption's bottom edge is (from the script, 1.32)
  let handle = null;           // the drag handle over the caption
  let guide = null;            // TikTok's bottom line (9:16), shown while dragging
  let liveT = '';              // a slider / drag shown before the captions are drawn again

  const styled = () => typeof STYLE !== 'undefined' && STYLE !== 'plain' && typeof STYLE_OK !== 'undefined' && STYLE_OK;
  const fontsDir = () => (typeof RUNTIME !== 'undefined' && RUNTIME ? path.join(RUNTIME, 'fonts') : '');
  // the font files of a style option id (amh_styles FONTS), and the fallback:
  // Menbere has Ethiopic AND Latin letters (Noto Sans Ethiopic has no Latin -
  // English words and the free version's tag were empty boxes, 1.32)
  const FILES = { sans: ['NotoSansEthiopic-Regular.ttf', 'NotoSansEthiopic-Bold.ttf'], menbere: ['Menbere-Regular.ttf', 'Menbere-Bold.ttf'],
    serif: ['NotoSerifEthiopic-Regular.ttf', 'NotoSerifEthiopic-Bold.ttf'], abyssinica: ['AbyssinicaSIL-Regular.ttf'],
    yebse: ['yebse.ttf'], washra: ['washrab.ttf'], agbalumo: ['Agbalumo-Regular.ttf'], tint: ['tint.ttf'], fantuwua: ['fantuwua.ttf'],
    jiret: ['jiret.ttf'], hibur: ['HiburMono-Regular.ttf'], gothic: ['yigezubisratgothic.ttf'] };
  function fontUrls(id) {
    const out = [];
    (FILES[id] || []).concat(FILES.sans, FILES.menbere).forEach((f) => {
      if (fontsIn[f]) return;
      const p = path.join(fontsDir(), f);
      try { if (fs.existsSync(p)) { out.push(APP.call('media', [p])); fontsIn[f] = 1; } } catch (e) {}
    });
    return out;
  }
  // a short fingerprint of everything the script depends on
  function fingerprint() {
    const st = window.__amhEditor ? window.__amhEditor.state() : null;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    let h = 0;
    const txt = cues.map((c) => c.start + ':' + c.end + ':' + c.text).join('|');
    for (let i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
    return [STYLE, JSON.stringify(styleOpts(STYLE)), st ? st.fmt : '', typeof LICENSED !== 'undefined' && LICENSED ? 1 : 0,
      cues.length, h, st ? E.total(st.clips) : 0].join('#');
  }
  async function load() {
    if (JASSUB || failed) return JASSUB;
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof WebAssembly === 'undefined') throw new Error('no OffscreenCanvas / WebAssembly');
      JASSUB = (await import(VENDOR + 'jassub.js')).default;
    } catch (e) {
      failed = true;
      log('The live caption style preview is not available here (' + (e && e.message ? e.message : e) + ') — the export is not affected.');
    }
    return JASSUB;
  }
  function show(yes) {
    on = !!yes;
    if (canvas) canvas.style.display = on ? '' : 'none';
    if (stage) stage.classList.toggle('ed-styled', on);
  }
  async function makeScript(k) {
    const st = window.__amhEditor.state();
    const { w, h } = E.canvasSize(st.fmt);
    const cues = ((typeof reviewCues !== 'undefined' && reviewCues) || []).filter((c) => String(c.text || '').trim());
    if (!cues.length) return null;
    const out = path.join(os.tmpdir(), 'amh_live_' + Date.now() + '.ass');
    try {
      await renderStyled({ cues: styleCues(cues), style: STYLE, opts: styleOpts(STYLE), mode: 'script', width: w, height: h, fps: 30,
        duration: Math.max(0.1, E.total(st.clips)), out, tag: typeof LICENSED !== 'undefined' ? !LICENSED : true });
      const text = fs.readFileSync(out, 'utf8');
      const m = /^; amh-bottom: ([\d.]+)/m.exec(text);
      return { text, w, h, y: m ? Number(m[1]) : null };
    } finally { try { fs.unlinkSync(out); } catch (e) {} }
  }
  async function refresh() {
    if (making || failed) return;
    stage = document.querySelector('.ed-canvas');
    const k = styled() && stage && window.__amhEditor && window.__amhEditor.state().built ? fingerprint() : '';
    if (!k) { show(false); key = ''; return; }
    if (k === key) return;
    want = k;
    making = 1;
    try {
      if (!(await load())) { show(false); return; }
      let s;
      try { s = await makeScript(k); } catch (e) {
        // making the script can be interrupted (the panel's own style preview
        // runs the same tool when a style is clicked): keep what is shown, try
        // again in a moment - only the renderer failing stops the live preview
        if (++retries <= 5) { want = ''; setTimeout(refresh, 600 * retries); }
        else log('The live caption style could not be updated (' + (e && e.message ? e.message : e) + ').');
        return;
      }
      retries = 0;
      if (!s) { show(false); key = k; return; }
      size = { w: s.w, h: s.h };
      if (!canvas || canvas.parentNode !== stage) {
        if (jas) { try { await jas.destroy(); } catch (e) {} jas = null; }
        if (canvas) canvas.remove();
        canvas = document.createElement('canvas');
        canvas.className = 'ed-subs';
        stage.appendChild(canvas);
        fontsIn = {};
      }
      const fonts = fontUrls(styleOpts(STYLE).font);
      if (!jas) {
        jas = new JASSUB({ canvas, subContent: s.text, fonts, defaultFont: 'menbere', queryFonts: false,
          workerUrl: VENDOR + 'worker/worker.js', wasmUrl: VENDOR + 'wasm/jassub-worker.wasm', modernWasmUrl: VENDOR + 'wasm/jassub-worker-modern.wasm' });
        await jas.ready;
      } else {
        if (fonts.length) await jas.renderer.addFonts(fonts);
        await jas.renderer.setTrack(s.text);
      }
      key = k;
      if (s.y) capY = s.y;
      show(true);
      draw(window.__amhEditTime ? window.__amhEditTime() : 0, true);
      // the new drawing is in: the slider / drag stand-in can go
      liveT = '';
      canvas.style.transform = '';
      placeHandle();
    } catch (e) {
      failed = true;
      show(false);
      log('The live caption style preview stopped (' + (e && e.message ? e.message : e) + ') — the export is not affected.');
    } finally {
      making = 0;
      if (want && want !== key) setTimeout(refresh, 50);
    }
  }
  // draw the captions of this moment of the edit
  function draw(t, repaint) {
    if (!jas || !on) return;
    try { jas.manualRender({ mediaTime: Math.max(0, Number(t) || 0), width: size.w, height: size.h, expectedDisplayTime: performance.now() }, !!repaint); } catch (e) {}
  }
  window.__amhSubsTick = (t) => draw(t, false);

  // ── move and size the caption in the video (1.32) ─────────────────────
  // While a slider moves or the caption is dragged, the drawn captions are
  // just moved / scaled on screen at once; when let go the setting is saved
  // and libass draws them again exactly (the export uses the same values).
  const BAND = 0.12;                                   // the handle's height (of the frame)
  const DESC = 0.025;                                  // letters reach a little under the bottom line
  function placeHandle() {
    if (!stage) return;
    if (!handle || handle.parentNode !== stage) {
      handle = document.createElement('div');
      handle.className = 'ed-caphandle';
      handle.innerHTML = '<span>⇕</span>';
      handle.addEventListener('mousedown', startDrag);
      stage.appendChild(handle);
      guide = document.createElement('div');
      guide.className = 'ed-capguide';
      guide.innerHTML = '<em>TikTok</em>';
      stage.appendChild(guide);
    }
    const tip = typeof tx === 'function' ? tx('ካፕሽኑን ወደ ላይ ወይም ወደ ታች ይጎትቱት', 'Drag the caption up or down')
      : 'Drag the caption up or down';
    handle.title = tip;
    handle.style.top = ((capY - BAND + DESC) * 100) + '%';
    handle.style.height = (BAND * 100) + '%';
    const st = window.__amhEditor && window.__amhEditor.state();
    const tall = st && st.fmt === '9:16';
    guide.classList.toggle('on', !!tall);
    guide.style.top = '80%';                            // under it TikTok / Reels put their buttons and text
  }
  function live(x) {
    if (!canvas || !on || !stage) return;
    const k0 = sizeNum(styleOpts(STYLE).size);
    if (x.size) {
      canvas.style.transformOrigin = '50% ' + (capY * 100) + '%';
      canvas.style.transform = 'scale(' + (x.size / k0) + ')';
    } else if (typeof x.y === 'number') {
      canvas.style.transform = 'translateY(' + ((x.y - capY) * stage.clientHeight) + 'px)';
      if (handle) handle.style.top = ((x.y - BAND + DESC) * 100) + '%';
    }
    liveT = JSON.stringify(x);
  }
  window.__amhCapLive = live;
  function startDrag(e) {
    e.preventDefault(); e.stopPropagation();
    if (!stage || !canvas) return;
    const H = stage.clientHeight || 1;
    const y0 = e.clientY;
    let y = capY;
    stage.classList.add('ed-capdrag');
    handle.classList.add('drag');
    const move = (ev) => {
      y = Math.min(0.97, Math.max(0.1, capY + (ev.clientY - y0) / H));
      live({ y });
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      stage.classList.remove('ed-capdrag');
      handle.classList.remove('drag');
      if (Math.abs(y - capY) < 0.002) { canvas.style.transform = ''; placeHandle(); return; }
      if (typeof setStyleOpt === 'function') setStyleOpt('y', Math.round(y * 1000) / 1000);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  window.__amhSubs = { refresh, state: () => ({ on, failed, key: !!key, ready: !!jas, capY, live: liveT }) };
  // captions, style or format changed: made again (a cheap check twice a second)
  setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, 500);
})();
