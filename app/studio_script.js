/*
 * studio_script.js — Amharic Captions Studio, the Script view (1.18.1).
 * Design: docs/agent/STUDIO_DESIGN.md ("act where you look").
 *
 * The captions read as flowing paragraphs (a new paragraph after a pause),
 * a time at each paragraph start. Orange = a word to check, yellow = ★, green
 * underline = fixed from 🧠/👤, green background = being spoken now.
 * Click a word: the video goes there. Select words: a small bar appears right
 * there — ★ Pop · ✎ Fix · ▶ Play. Double-click a word: fix it. The caption
 * boxes (for exact timing) stay one click away ("☰ Captions").
 * Everything goes through the review's own functions (toggleEmphasis,
 * pushReviewUndo, renderReview), so undo, autosave and export just work.
 */
(function () {
  'use strict';
  const S = window.AmhStudio;
  const review = document.getElementById('review');
  if (!window.__amhApp || !S || !review || typeof cleanupWords !== 'function') return;
  const $ = (id) => document.getElementById(id);
  const tx = (am, en) => ((typeof AMH_LANG !== 'undefined' && AMH_LANG === 'am') ? am : en);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const VIEW_KEY = 'amh.studio.textView';
  let mode = 'script';
  try { mode = localStorage.getItem(VIEW_KEY) === 'captions' ? 'captions' : 'script'; } catch (e) {}

  // ── the view switch in the text column's head ──────────────────────────
  const thead = document.querySelector('.st-thead');
  const sw = el('div', 'st-viewsw');
  const bScript = el('button', '', ''); bScript.type = 'button';
  const bCaps = el('button', '', ''); bCaps.type = 'button';
  sw.appendChild(bScript); sw.appendChild(bCaps);
  if (thead) thead.insertBefore(sw, thead.children[1] || null);
  function setMode(m) {
    mode = m;
    try { localStorage.setItem(VIEW_KEY, m); } catch (e) {}
    review.classList.toggle('st-scriptmode', m === 'script');
    bScript.classList.toggle('on', m === 'script');
    bCaps.classList.toggle('on', m === 'captions');
    hideBar();
    if (m === 'script') render();
  }
  bScript.addEventListener('click', () => setMode('script'));
  bCaps.addEventListener('click', () => setMode('captions'));

  // ── the script ─────────────────────────────────────────────────────────
  const box = el('div', 'st-script');
  box.setAttribute('role', 'textbox');
  box.setAttribute('aria-readonly', 'true');
  const list = $('reviewList');
  if (list) list.after(box);
  let words = [];
  let spans = [];
  const plainWord = (w) => String(w).replace(/[*~]/g, '');
  function marks(text, ranges) { return ranges.map((r) => [r.start, r.end]); }
  function render() {
    if (mode !== 'script') return;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    words = cleanupWords(cues);
    words.forEach((x, i) => { x.i = i; });
    box.textContent = '';
    box.appendChild(bar);            // the selection bar lives in the script
    bar.style.display = 'none';
    spans = [];
    if (!words.length) return;
    // per caption: where its ★, ✂, doubtful and fixed words are (characters)
    const info = cues.map((c) => {
      const t = String(c.text || '').replace(/\n/g, ' ');
      const star = [];
      const re = /\*[^*]+\*/g;
      let m;
      while ((m = re.exec(t)) !== null) star.push([m.index, m.index + m[0].length]);
      return { r: S.wordRanges(t), star, cut: marks(t, cutRanges(t)), doubt: marks(t, doubtRanges(t, c.doubt)), fixed: marks(t, doubtRanges(t, c._fixed)) };
    });
    const inside = (wr, list2) => !!wr && list2.some((x) => wr[0] < x[1] && x[0] < wr[1]);
    S.scriptParagraphs(words).forEach((para) => {
      const p = el('div', 'sp');
      const tm = el('span', 'sp-t', S.fmtClock(para[0].s));
      tm.dataset.t = para[0].s;
      p.appendChild(tm);
      para.forEach((x) => {
        const i = x.i;
        const inf = info[x.cue];
        const wr = inf && inf.r[x.k];
        const s = el('span', 'w', plainWord(x.w));
        s.dataset.i = i;
        if (inside(wr, inf.star)) s.classList.add('star');
        if (inside(wr, inf.cut)) s.classList.add('cut');
        if (inside(wr, inf.doubt)) s.classList.add('doubt');
        else if (inside(wr, inf.fixed)) s.classList.add('fixed');
        p.appendChild(s);
        p.appendChild(document.createTextNode(' '));
        spans[i] = s;
      });
      box.appendChild(p);
    });
    nowIdx = -1;
    follow(false);
  }
  let renderT = 0;
  function renderSoon() { clearTimeout(renderT); renderT = setTimeout(render, 30); }
  if (list) new MutationObserver(renderSoon).observe(list, { childList: true });

  // ── click / select ─────────────────────────────────────────────────────
  const video = () => $('appVideo');
  function seek(t) {
    if (window.__amhSeek) { window.__amhSeek(Math.max(0, t + 0.01)); return; }
    const v = video(); if (v && v.getAttribute('src')) { try { v.currentTime = Math.max(0, t + 0.01); } catch (e) {} }
  }
  const nowT = () => { const v = video(); return window.__amhEditTime ? window.__amhEditTime() : (v ? v.currentTime : 0); };
  function picked() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    if (!box.contains(r.commonAncestorContainer)) return [];
    return spans.filter((s) => s && r.intersectsNode(s)).map((s) => words[Number(s.dataset.i)]).filter(Boolean);
  }
  box.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('sp-t')) { seek(Number(t.dataset.t)); return; }
    if (!t.classList || !t.classList.contains('w')) return;
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    const x = words[Number(t.dataset.i)];
    if (x) seek(x.s);
  });
  box.addEventListener('mouseup', () => setTimeout(() => {
    const p = picked();
    if (p.length) showBar(p); else hideBar();
  }, 0));
  box.addEventListener('dblclick', (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('w')) return;
    const x = words[Number(t.dataset.i)];
    if (x) { showBar([x]); openFix([x]); }
  });

  // ── the selection bar: ★ Pop · ✎ Fix · ▶ Play ─────────────────────────
  const bar = el('div', 'st-tb');
  bar.style.display = 'none';
  box.appendChild(bar);
  let current = [];
  function place(rect) {
    const b = box.getBoundingClientRect();
    bar.style.left = Math.max(6, Math.min(box.clientWidth - bar.offsetWidth - 6, rect.left - b.left + box.scrollLeft)) + 'px';
    let top = rect.top - b.top + box.scrollTop - bar.offsetHeight - 8;
    // no room above (the first line): open under the words instead
    if (top < box.scrollTop + 4) top = (rect.bottom || rect.top + 30) - b.top + box.scrollTop + 8;
    bar.style.top = top + 'px';
  }
  function rectOf(p) {
    const a = spans[p[0].i], z = spans[p[p.length - 1].i];
    if (!a || !z) return box.getBoundingClientRect();
    const ra = a.getBoundingClientRect(), rz = z.getBoundingClientRect();
    return { left: ra.left, top: Math.min(ra.top, rz.top), bottom: Math.max(ra.bottom, rz.bottom) };
  }
  function action(icon, label, key, fn) {
    const b = el('button', '', icon + ' ' + label);
    b.type = 'button';
    if (key) b.title = label + ' (' + key + ')';
    b.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
    return b;
  }
  function showBar(p) {
    current = p;
    bar.textContent = '';
    bar.appendChild(action('★', tx('ጎልቶ', 'Pop'), 'Ctrl+B', star));
    if (window.__amhStudioCuts) bar.appendChild(action('✂', tx('ቁረጥ', 'Cut'), 'Ctrl+D', cut));
    bar.appendChild(action('✎', tx('አርም', 'Fix'), 'Enter', () => openFix(current)));
    bar.appendChild(action('▶', tx('አጫውት', 'Play'), '', play));
    bar.style.display = '';
    place(rectOf(p));
  }
  function hideBar() { bar.style.display = 'none'; current = []; }
  function star() {
    const p = current;
    if (!p.length) return;
    const groups = S.selectionByCaption(reviewCues, p);
    const n = REVIEW_UNDO.length;
    groups.forEach((g) => toggleEmphasis(g.cue, g.from, g.to));
    // one action = one undo step, however many captions it touched
    if (REVIEW_UNDO.length > n + 1) { REVIEW_UNDO.splice(n + 1); if (typeof syncReviewUndo === 'function') syncReviewUndo(); }
    hideBar();
    if (typeof schedulePreview === 'function') schedulePreview();
  }
  // ✂: strike the words (~like this~) — ✂ Clean up then cuts them from the
  // exported video; again on struck words: keep them. One undo step.
  function cut() {
    const p = current;
    if (!p.length) return;
    const groups = S.selectionByCaption(reviewCues, p);
    const n = REVIEW_UNDO.length;
    groups.forEach((g) => toggleTextCut(g.cue, g.from, g.to));
    if (REVIEW_UNDO.length > n + 1) { REVIEW_UNDO.splice(n + 1); if (typeof syncReviewUndo === 'function') syncReviewUndo(); }
    hideBar();
    if (typeof schedulePreview === 'function') schedulePreview();
  }
  function play() {
    const p = current;
    if (!p.length) return;
    const v = video();
    if (!v) return;
    const end = p[p.length - 1].e;
    const ed = window.__amhEditor;
    seek(p[0].s);
    const stop = () => { if (nowT() >= end) { if (ed) ed.pause(); else v.pause(); v.removeEventListener('timeupdate', stop); } };
    v.addEventListener('timeupdate', stop);
    if (ed) setTimeout(() => ed.play(), 60); else v.play().catch(() => {});
    hideBar();
  }
  function openFix(p) {
    if (!p.length) return;
    current = p;
    bar.textContent = '';
    const inp = el('input', 'st-fix');
    inp.type = 'text';
    inp.value = p.map((x) => plainWord(x.w)).join(' ');
    inp.setAttribute('dir', 'auto');
    const ok = el('button', 'on', '✓'); ok.type = 'button';
    bar.appendChild(inp); bar.appendChild(ok);
    bar.style.display = '';
    place(rectOf(p));
    inp.focus(); inp.select();
    const apply = () => { fix(p, inp.value); };
    ok.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideBar(); }
    });
  }
  // Replace the selected words with what the editor typed: the new text goes
  // where the first selected word was; the other selected words go. ★ / ✂
  // marks around the words are kept. One undo step.
  function fix(p, text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    const groups = S.selectionByCaption(reviewCues, p);
    if (!groups.length) { hideBar(); return; }
    const before = groups.map((g) => reviewCues[g.cue].text.replace(/\n/g, ' ').slice(g.from, g.to)).join(' ');
    if (before.replace(/[*~]/g, '') === value) { hideBar(); return; }
    pushReviewUndo('edit');
    // last caption first: earlier character positions stay valid
    groups.slice().reverse().forEach((g, n) => {
      const c = reviewCues[g.cue];
      const t = String(c.text || '').replace(/\n/g, ' ');
      const old = t.slice(g.from, g.to);
      const lead = (old.match(/^[*~]+/) || [''])[0], trail = (old.match(/[*~]+$/) || [''])[0];
      const isFirst = n === groups.length - 1;
      const rep = isFirst && value ? lead + value + trail : '';
      c.text = (t.slice(0, g.from) + rep + t.slice(g.to)).replace(/\s{2,}/g, ' ').trim();
    });
    for (let i = reviewCues.length - 1; i >= 0; i--) if (!String(reviewCues[i].text || '').replace(/[*~]/g, '').trim()) reviewCues.splice(i, 1);
    hideBar();
    renderReview();
    if (typeof schedulePreview === 'function') schedulePreview();
  }
  document.addEventListener('mousedown', (e) => { if (bar.style.display !== 'none' && !bar.contains(e.target) && !box.contains(e.target)) hideBar(); });
  document.addEventListener('keydown', (e) => {
    if (mode !== 'script' || !review.classList.contains('show')) return;
    if ((e.ctrlKey || e.metaKey) && /^[bd]$/.test(String(e.key).toLowerCase())) {
      const p = picked();
      const k = String(e.key).toLowerCase();
      if (p.length && (k === 'b' || window.__amhStudioCuts)) { e.preventDefault(); current = p; if (k === 'b') star(); else cut(); }
    } else if (e.key === 'Enter' && bar.style.display !== 'none' && current.length && document.activeElement && !document.activeElement.classList.contains('st-fix')) {
      e.preventDefault(); openFix(current);
    } else if (e.key === 'Escape' && bar.style.display !== 'none') { e.preventDefault(); hideBar(); }
  });

  // ── the word being spoken ──────────────────────────────────────────────
  let nowIdx = -1;
  function follow(scroll) {
    const v = video();
    const i = v ? S.wordAt(words, nowT()) : -1;
    if (i === nowIdx) return;
    if (spans[nowIdx]) spans[nowIdx].classList.remove('now');
    nowIdx = i;
    const s = spans[i];
    if (s) {
      s.classList.add('now');
      if (scroll && bar.style.display === 'none') {
        const b = box.getBoundingClientRect(), r = s.getBoundingClientRect();
        if (r.top < b.top + 30 || r.bottom > b.bottom - 30) s.scrollIntoView({ block: 'center' });
      }
    }
  }
  let raf = 0;
  const tick = () => { const v = video(); if (v && !v.paused && mode === 'script') { follow(true); raf = requestAnimationFrame(tick); } else raf = 0; };
  function hook() {
    const v = video();
    if (!v || v.__script) return;
    v.__script = true;
    v.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
    ['seeked', 'pause'].forEach((ev) => v.addEventListener(ev, () => follow(false)));
  }

  // ⚠ N to check: in the script, the first doubtful word opens to be fixed
  const studioDoubt = window.goFirstDoubtStudio;
  window.goFirstDoubtStudio = () => {
    if (mode !== 'script') { if (studioDoubt) studioDoubt(); return; }
    const s = box.querySelector('.w.doubt');
    if (!s) return;
    s.scrollIntoView({ block: 'center' });
    const x = words[Number(s.dataset.i)];
    if (x) { seek(x.s); openFix([x]); }
  };

  function relabel() {
    bScript.textContent = '¶ ' + tx('ጽሑፍ', 'Script');
    bCaps.textContent = '☰ ' + tx('ዝርዝር', 'List');
    bScript.title = tx('እንደ ጽሑፍ ያንብቡና ያርሙ', 'Read and fix it as text');
    bCaps.title = tx('እያንዳንዱን ካፕሽን ከጊዜው ጋር', 'Each caption with its times');
    render();
  }
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setTimeout(relabel, 0));
  new MutationObserver(() => { if (review.classList.contains('show')) { hook(); render(); } else hideBar(); })
    .observe(review, { attributes: true, attributeFilter: ['class'] });
  relabel();
  setMode(mode);
  window.__amhScript = { render, setMode, mode: () => mode, words: () => words, showBar, openFix, fix: (p, t) => fix(p, t),
    star: (p) => { current = p; star(); }, cut: (p) => { current = p; cut(); } };
})();
