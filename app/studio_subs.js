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

  const styled = () => typeof STYLE !== 'undefined' && STYLE !== 'plain' && typeof STYLE_OK !== 'undefined' && STYLE_OK;
  const fontsDir = () => (typeof RUNTIME !== 'undefined' && RUNTIME ? path.join(RUNTIME, 'fonts') : '');
  // the font files of a style option id (amh_styles FONTS), and Noto Sans as the fallback
  const FILES = { sans: ['NotoSansEthiopic-Regular.ttf', 'NotoSansEthiopic-Bold.ttf'], menbere: ['Menbere-Regular.ttf', 'Menbere-Bold.ttf'],
    serif: ['NotoSerifEthiopic-Regular.ttf', 'NotoSerifEthiopic-Bold.ttf'], abyssinica: ['AbyssinicaSIL-Regular.ttf'],
    yebse: ['yebse.ttf'], washra: ['washrab.ttf'], agbalumo: ['Agbalumo-Regular.ttf'], tint: ['tint.ttf'], fantuwua: ['fantuwua.ttf'],
    jiret: ['jiret.ttf'], hibur: ['HiburMono-Regular.ttf'], gothic: ['yigezubisratgothic.ttf'] };
  function fontUrls(id) {
    const out = [];
    (FILES[id] || []).concat(FILES.sans).forEach((f) => {
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
      return { text: fs.readFileSync(out, 'utf8'), w, h };
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
        jas = new JASSUB({ canvas, subContent: s.text, fonts, defaultFont: 'noto sans ethiopic', queryFonts: false,
          workerUrl: VENDOR + 'worker/worker.js', wasmUrl: VENDOR + 'wasm/jassub-worker.wasm', modernWasmUrl: VENDOR + 'wasm/jassub-worker-modern.wasm' });
        await jas.ready;
      } else {
        if (fonts.length) await jas.renderer.addFonts(fonts);
        await jas.renderer.setTrack(s.text);
      }
      key = k;
      show(true);
      draw(window.__amhEditTime ? window.__amhEditTime() : 0, true);
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
  window.__amhSubs = { refresh, state: () => ({ on, failed, key: !!key, ready: !!jas }) };
  // captions, style or format changed: made again (a cheap check twice a second)
  setInterval(() => { if (document.visibilityState !== 'hidden') refresh(); }, 500);
})();
