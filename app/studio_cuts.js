/*
 * studio_cuts.js — Amharic Captions Studio, ✂ Clean up (1.19.0).
 * Design: docs/agent/STUDIO_DESIGN.md — non-destructive ("never lose work").
 *
 * A tab lists what can go: your own ✂ cuts (struck words), long pauses (from
 * the sound itself), repeated takes and እ… sounds (the same finders as the
 * Premiere panel, core.js). Tick what goes. Nothing is cut while you work:
 * the player skips the ticked parts (you hear the clean edit at once) and the
 * timeline shows them as red stripes. Export makes the cleaned files: the
 * video with captions, the cleaned video without captions, and the .srt that
 * matches it. The original video is never changed. The choices live in the
 * project. Pure maths: studio_core.js (keepRanges, cutFilter).
 */
(function () {
  'use strict';
  const APP = window.__amhApp;
  const S = window.AmhStudio;
  const ST = window.__amhStudio;
  const review = document.getElementById('review');
  if (!APP || !S || !ST || !review || typeof findSilences !== 'function') return;
  window.__amhStudioCuts = true;            // ✂ in the captions and the Script bar (main.js textCutAvailable)
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const video = () => $('appVideo');
  const chosen = () => (window.__amhAppChosen && window.__amhAppChosen()) || null;

  const PAUSES = [0.5, 0.8, 1.2];
  let pause = 0.8;
  let preview = true;
  let overrides = {};               // the editor's own ticks, by item key
  let items = [];
  const key = (it) => it.kind + ':' + Math.round(it.start * 20);

  // loudness 50 times a second, from the timeline's sound wave (0-100 → dB)
  let envFrom = null, envCache = null;
  function env() {
    const p = ST.peaks();
    if (!p || !p.length) return null;
    if (p !== envFrom) { envFrom = p; envCache = { t0: 0, step: 0.02, db: p.map((v) => 20 * Math.log10(Math.max(v, 0.3) / 100)) }; }
    return envCache;
  }

  function analyze() {
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const e = env();
    const out = [];
    const on = (it, dflt) => { const k = key(it); it.on = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : dflt; return it; };
    findTextCuts(cues).forEach((c) => {
      const r = c.exact ? 0.06 : 0.15;
      out.push(on({ kind: 'text', text: c.text, words: c.words, start: c.whole ? c.start : snapQuiet(c.start, e, r), end: c.whole ? c.end : snapQuiet(c.end, e, r) }, true));
    });
    if (e) findSilences(e, { minLen: pause }).forEach((s) => out.push(on({ kind: 'pause', start: s.start, end: s.end }, true)));
    findRepeats(cues).forEach((r) => out.push(on({ kind: 'repeat', start: r.start, end: r.end, text: r.text, words: r.words }, true)));
    findFillers(cues).forEach((f) => {
      const r = f.exact ? 0.06 : 0.2;
      out.push(on({ kind: f.word ? 'word' : 'filler', text: f.text, words: f.words, start: snapQuiet(f.start, e, r), end: snapQuiet(f.end, e, r) }, !f.word));
    });
    items = out.filter((x) => x.end - x.start > 0.05).sort((a, b) => a.start - b.start);
    render();
    ST.drawSoon();
  }
  const cuts = () => mergeRanges(items.filter((x) => x.on));
  const active = () => items.some((x) => x.on);
  const fmt = (s) => S.fmtClock(Math.round(s));
  function summary() {
    const c = cuts();
    const gone = c.reduce((n, x) => n + x.end - x.start, 0);
    return c.length + ' ' + tx('ቁርጦች', 'cuts') + ' · ' + tx('የሚቆረጠው ', 'removes ') + fmt(gone) + ' · ' + tx('አዲስ ርዝመት ', 'new length ') + fmt(ST.dur() - gone);
  }
  // the captions of the cleaned video: times follow the cuts, cut words leave
  function cleanCues() {
    const drop = [];
    items.forEach((it) => { if (it.on && it.words) it.words.forEach((w) => drop.push(w)); });
    return remapCuesAfterCut(reviewCues, cuts(), drop).map((c) => Object.assign({}, c, { text: String(c.text).replace(/~[^~]*~/g, '').replace(/\s{2,}/g, ' ').trim() }))
      .filter((c) => c.text);
  }
  const hasPicture = () => { const v = video(); return !!(v && v.videoWidth); };
  function cleanPath() {
    const X = window.__amhAppExport;
    const src = chosen();
    const dir = src ? path.dirname(src.path) : os.tmpdir();
    return X.uniquePath(dir, X.baseName() + ' (' + tx('የጸዳ', 'clean') + ')', hasPicture() ? '.mp4' : '.m4a');
  }
  // One ffmpeg pass: keep the stretches between the cuts, join them frame-exact
  // with a 10 ms sound fade at every join. `fast`: an in-between file for the
  // captioned video (near-lossless, quick).
  function renderClean(out, onProgress, fast) {
    return new Promise((resolve, reject) => {
      const c = chosen();
      if (!c || typeof FFMPEG === 'undefined' || !FFMPEG) { reject(new Error('no video')); return; }
      const keeps = S.keepRanges(cuts(), ST.dur());
      if (!keeps.length) { reject(new Error(tx('ሁሉም ተቆርጧል', 'Everything is cut'))); return; }
      const pic = hasPicture();
      const graph = S.cutFilter(keeps, pic);
      const args = ['-v', 'error', '-y', '-i', c.path];
      if (graph.length > 6000) {
        const f = path.join(os.tmpdir(), 'amh_cut_' + Date.now() + '.txt');
        fs.writeFileSync(f, graph, { encoding: 'utf8' });
        args.push('-/filter_complex', f);
      } else args.push('-filter_complex', graph);
      if (pic) args.push('-map', '[v]');
      args.push('-map', '[a]');
      if (pic) args.push('-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'medium', '-crf', fast ? '16' : '18', '-pix_fmt', 'yuv420p');
      args.push('-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
      const total = S.keptLength(keeps);
      const p = spawn(FFMPEG, args);
      let err = '';
      p.stdout.on('data', (d) => {
        const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
        if (m && onProgress) onProgress(Math.min(1, Number(m[m.length - 1].split('=')[1]) / 1e6 / Math.max(0.1, total)));
      });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('close', (code) => {
        if (code === 0 && fs.existsSync(out)) { if (onProgress) onProgress(1); resolve(out); }
        else reject(new Error(err.trim().split('\n').pop() || ('ffmpeg ' + code)));
      });
    });
  }

  // ── the tab ────────────────────────────────────────────────────────────
  const pane = el('div', 'st-cleanpane');
  ST.addTab('cleanup', () => '✂ ' + tx('ማጽዳት', 'Clean up'), pane);
  const names = () => ({ text: '✂ ' + tx('የእርስዎ ቁርጥ', 'Your cut'), pause: tx('ዝምታ', 'Pause'), repeat: tx('የተደገመ', 'Repeated take'),
    filler: tx('ድምፅ', 'Sound'), word: tx('ሙሌት ቃል?', 'Filler word?') });
  function render() {
    pane.textContent = '';
    if (typeof reviewOpen === 'undefined' || !reviewOpen) return;
    pane.appendChild(el('div', 'st-note', tx('ዝምታ፣ የተደገመ አባባልና እ… ድምፆች ይገኛሉ። የሚቆረጠውን ምልክት ያድርጉ — ቪዲዮዎ አይነካም፤ ሲልኩ ብቻ ይቆረጣል።',
      'Pauses, repeated takes and እ… sounds are found. Tick what goes — your video is not touched; the cut happens when you export.')));
    const f = el('div', 'st-field');
    f.appendChild(el('div', 'st-lab', tx('ከዚህ የሚረዝሙ ዝምታዎች', 'Pauses longer than')));
    const seg = el('div', 'st-seg');
    PAUSES.forEach((v) => {
      const b = el('button', v === pause ? 'on' : '', v + ' s');
      b.type = 'button';
      b.addEventListener('click', () => { pause = v; analyze(); ST.saveSoon(); });
      seg.appendChild(b);
    });
    f.appendChild(seg);
    pane.appendChild(f);
    const pv = el('label', 'st-check');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = preview;
    cb.addEventListener('change', () => { preview = cb.checked; ST.saveSoon(); });
    pv.appendChild(cb); pv.appendChild(el('span', '', tx('▶ ሲጫወት የሚቆረጠውን ዝለል (ቅድመ እይታ)', '▶ Skip the cuts while playing (preview)')));
    pane.appendChild(pv);
    if (!env()) pane.appendChild(el('div', 'st-note', tx('የድምፅ ሞገዱ እየተዘጋጀ ነው — ዝምታዎች በቅርቡ ይታያሉ።', 'The sound wave is being drawn — pauses appear in a moment.')));
    const list = el('div', 'st-cutlist');
    if (!items.length) list.appendChild(el('div', 'st-note', tx('የሚጸዳ ነገር የለም — አስቀድሞ ጥብቅ ነው።', 'Nothing to clean — it is already tight.')));
    const nm = names();
    items.forEach((it) => {
      const row = el('label', 'st-cutrow' + (it.on ? '' : ' off'));
      const c = el('input'); c.type = 'checkbox'; c.checked = it.on;
      c.addEventListener('change', () => { it.on = c.checked; overrides[key(it)] = c.checked; render(); ST.drawSoon(); ST.saveSoon(); });
      row.appendChild(c);
      row.appendChild(el('span', 'st-cut-t', S.fmtClock(it.start, true)));
      const what = el('span', 'st-cut-w', nm[it.kind] + (it.text ? ' «' + String(it.text).replace(/[*~]/g, '') + '»' : '') + ' · ' + (it.end - it.start).toFixed(1) + ' s');
      what.title = tx('ያዳምጡ', 'Listen');
      what.addEventListener('click', (e) => { e.preventDefault(); ST.seek(Math.max(0, it.start - 1)); const v = video(); if (v) v.play().catch(() => {}); });
      row.appendChild(what);
      list.appendChild(row);
    });
    pane.appendChild(list);
    if (active()) pane.appendChild(el('div', 'st-cutsum', summary()));
    const ex = el('button', 'st-btn primary st-wide', '✂ ' + tx('ከጊዜ መስመሩ ቁረጣቸው', 'Cut them from the timeline'));
    ex.type = 'button';
    ex.disabled = !active() || !window.__amhEditor;
    ex.addEventListener('click', () => {
      const list2 = cuts();
      // the cut words leave the captions too
      const drop = [];
      items.forEach((it) => { if (it.on && it.words) it.words.forEach((w) => drop.push(w)); });
      window.__amhEditor.cutRanges(list2);
      overrides = {};
      analyze();
      ST.saveSoon();
    });
    pane.appendChild(ex);
    pane.appendChild(el('div', 'st-note', tx('አንድ ጊዜ ↶ ሲጫኑ ሁሉም ይመለሳል።', 'One ↶ brings it all back.')));
  }

  // ── preview: the player skips the ticked parts ─────────────────────────
  let raf = 0;
  function skip() {
    const v = video();
    if (window.__amhEditor) return;           // the editor cuts the timeline itself
    if (!v || v.paused || !preview || !active()) return;
    const t = v.currentTime;
    const c = cuts().find((x) => t >= x.start && t < x.end - 0.02);
    if (c) { try { v.currentTime = Math.min(ST.dur(), c.end + 0.001); } catch (e) {} }
  }
  const tick = () => { const v = video(); if (v && !v.paused) { skip(); raf = requestAnimationFrame(tick); } else raf = 0; };
  function hook() {
    const v = video();
    if (!v || v.__cuts) return;
    v.__cuts = true;
    v.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
    v.addEventListener('timeupdate', skip);
  }

  // ── the timeline: red stripes where it will be cut ─────────────────────
  ST.overlays.push((ctx, view, w, h, g) => {
    // only while the ✂ Clean up tab is open (elsewhere they would look like cuts)
    if (!active() || pane.offsetParent === null) return;
    cuts().forEach((c) => {
      const x0 = S.timeToX(c.start, view), x1 = S.timeToX(c.end, view);
      if (x1 < 0 || x0 > w) return;
      ctx.fillStyle = 'rgba(231,76,60,.22)';
      ctx.fillRect(x0, g.ruler, Math.max(2, x1 - x0), h - g.ruler);
      ctx.strokeStyle = 'rgba(255,107,107,.55)';
      ctx.lineWidth = 1;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, g.ruler, Math.max(2, x1 - x0), h - g.ruler); ctx.clip();
      for (let x = x0 - h; x < x1; x += 7) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, g.ruler); ctx.stroke(); }
      ctx.restore();
    });
  });

  // ── project ────────────────────────────────────────────────────────────
  window.__amhCuts = {
    active, cues: cleanCues, summary, render: renderClean, cleanPath, items: () => items, analyze,
    save: () => ({ pause, preview, overrides }),
    load: (o) => {
      o = o || {};
      pause = PAUSES.indexOf(Number(o.pause)) >= 0 ? Number(o.pause) : 0.8;
      preview = o.preview !== false;
      overrides = (o.overrides && typeof o.overrides === 'object') ? Object.assign({}, o.overrides) : {};
      analyze();
    },
    reset: () => { overrides = {}; pause = 0.8; preview = true; items = []; },
  };

  // again when the words change, when the wave arrives, when the tab opens
  let t = 0;
  const soon = () => { clearTimeout(t); t = setTimeout(analyze, 350); };
  const list = $('reviewList');
  if (list) new MutationObserver(soon).observe(list, { childList: true });
  let waveSeen = null;
  setInterval(() => { if (reviewOpen && ST.peaks() && ST.peaks() !== waveSeen) { waveSeen = ST.peaks(); analyze(); } }, 1000);
  new MutationObserver(() => {
    if (review.classList.contains('show')) hook();
    else window.__amhCuts.reset();
  }).observe(review, { attributes: true, attributeFilter: ['class'] });
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(render, 0));
})();
