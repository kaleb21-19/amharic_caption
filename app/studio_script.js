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
 *
 * Edit the video by editing the text (1.34): select words and press Delete
 * (or ✂ Cut) - that part of the video goes, the captions with it. Drag a
 * paragraph by its ⋮⋮ to another place - the video moves with it. One ↶
 * (Ctrl+Z) brings either back.
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
    // a hidden list can't measure its boxes: size them once it shows (after
    // Media has let go of the column too), so long captions aren't cut
    else if (typeof fitReviewBoxes === 'function') setTimeout(fitReviewBoxes, 0);
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
  let paras = [];
  const editor = () => window.__amhEditor || null;
  const plainWord = (w) => String(w).replace(/[*~]/g, '');
  function marks(text, ranges) { return ranges.map((r) => [r.start, r.end]); }
  function render() {
    if (mode !== 'script') return;
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    words = cleanupWords(cues);
    // 1.56: a redraw (the list refreshing behind) used to drop the open bar
    // — and a ✎ Fix being typed; the same words get it back below
    const fixing = bar.querySelector('.st-fix');
    const keep = (bar.style.display !== 'none' && current.length && !bar.classList.contains('st-chk'))
      ? { ids: current.map((x) => x.i), ws: current.map((x) => x.w).join(' '), val: fixing ? fixing.value : null } : null;
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
    paras = S.scriptParagraphs(words);
    paras.forEach((para, k) => {
      const p = el('div', 'sp');
      p.dataset.k = k;
      if (editor() && paras.length > 1) {
        const g = el('span', 'sp-grip', '⋮⋮');
        g.title = tx('ይጎትቱ፦ ይህ ክፍል ከቪዲዮው ጋር ይንቀሳቀሳል', 'Drag: this part moves, video and all');
        g.addEventListener('mousedown', (e) => startDrag(e, k));
        p.appendChild(g);
      }
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
    bar.classList.remove('st-chk');
    if (keep) {
      const p = keep.ids.map((i) => words[i]);
      if (p.every(Boolean) && p.map((x) => x.w).join(' ') === keep.ws) {
        if (keep.val == null) showBar(p);
        else { openFix(p); const inp = bar.querySelector('.st-fix'); if (inp) inp.value = keep.val; }
      } else current = [];
    }
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
    if (!x) return;
    seek(x.s);
    // one click on a word shows its bar too (1.50: the owner looked for it
    // after a click; only a drag over words showed it)
    if (!(typeof checking !== 'undefined' && checking)) { wordClicked = true; showBar([x]); }
  });
  let wordClicked = false;
  // a press inside the bar (✎ Fix, its typing box) is not a click on the
  // text: it must not close the bar (1.56 — ✎ Fix closed itself at once)
  // (the press is noted when it starts: ✎ re-draws the bar under the mouse)
  let barPress = false;
  box.addEventListener('mouseup', (e) => setTimeout(() => {
    const own = barPress || !!(e && e.target && bar.contains(e.target));
    barPress = false;
    if (own) return;
    const p = picked();
    if (p.length) showBar(p);
    else if (!wordClicked) hideBar();
    wordClicked = false;
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
  bar.addEventListener('mousedown', () => { barPress = true; }, true);
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
    if (editor()) bar.appendChild(action('✂', tx('ከቪዲዮው ቁረጥ', 'Cut from video'), 'Delete', cut));
    else if (window.__amhStudioCuts) bar.appendChild(action('✂', tx('ቁረጥ', 'Cut'), 'Ctrl+D', cut));
    if (editor() && editor().addZoom) bar.appendChild(action('🔍', tx('ዙም', 'Zoom'), '', zoomHere));
    if (editor() && editor().brollPicker) bar.appendChild(action('🎞', 'B-roll', '', brollHere));
    bar.appendChild(action('✎', tx('አርም', 'Fix'), 'Enter', () => openFix(current)));
    bar.appendChild(action('▶', tx('አጫውት', 'Play'), '', play));
    bar.style.display = '';
    place(rectOf(p));
  }
  function hideBar() { bar.style.display = 'none'; current = []; }
  // 🎞 (1.61): B-roll over these words, or over their whole sentence
  function spanOf(p) {
    const cues = (typeof reviewCues !== 'undefined' && reviewCues) || [];
    const a = cues[p[0].cue], z = cues[p[p.length - 1].cue];
    return { word: { s: p[0].s, e: p[p.length - 1].e }, sentence: { s: a ? Number(a.start) : p[0].s, e: z ? Number(z.end) : p[p.length - 1].e } };
  }
  function brollHere() {
    const p = current;
    if (!p.length || !editor()) return;
    const r = spanOf(p);
    const anchor = spans[p[p.length - 1].i];
    hideBar();
    editor().brollPicker(anchor, r.word, r.sentence);
  }
  // a photo / video dropped on a word: B-roll for the word or its sentence (the last choice)
  box.addEventListener('dragover', (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains('w') || !editor() || !editor().addBroll) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (x) {}
    spans.forEach((sp) => sp && sp.classList.remove('drop'));
    t.classList.add('drop');
  });
  box.addEventListener('dragleave', (e) => { if (e.target.classList) e.target.classList.remove('drop'); });
  box.addEventListener('drop', (e) => {
    spans.forEach((sp) => sp && sp.classList.remove('drop'));
    const t = e.target;
    let id = '';
    try { id = e.dataTransfer.getData('text/amh-media'); } catch (x) {}
    if (!id || !t.classList || !t.classList.contains('w') || !editor()) return;
    e.preventDefault();
    const x = words[Number(t.dataset.i)];
    if (!x) return;
    const r = spanOf([x]);
    let mode = 'sentence';
    try { mode = (typeof loadSettings === 'function' && loadSettings().brollLen) === 'word' ? 'word' : 'sentence'; } catch (y) {}
    const g = mode === 'word' ? r.word : r.sentence;
    editor().addBroll(id, g.s, Math.max(g.e, g.s + 0.6));
  });
  // 🔍 (1.60): a smooth zoom on these words — its style in ⚙ (the last one used)
  function zoomHere() {
    const p = current;
    if (!p.length || !editor()) return;
    const a = p[0].s, z = p[p.length - 1].e;
    hideBar();
    editor().addZoom(Math.max(0, a - 0.05), p.length > 1 ? { len: Math.max(1, z - a + 0.6) } : null);
  }
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
  // ✂: in the Studio's editor the words leave the video at once (1.34). The
  // cut runs from the first word to just before the next one, so no half
  // word or breath is left; a long pause after the last word stays.
  function rangeOf(p) {
    const a = p[0], z = p[p.length - 1];
    const prev = words[a.i - 1], next = words[z.i + 1];
    const start = prev ? Math.max(prev.e, a.s - 0.06) : Math.max(0, a.s - 0.06);
    const end = next ? (next.s - z.e > 0.7 ? z.e + 0.15 : Math.max(z.e, next.s - 0.02))
      : Math.min(z.e + 0.2, editor() ? editor().total() : z.e + 0.2);
    return { start: Math.max(0, start), end: Math.max(start + 0.05, end) };
  }
  // separate runs of selected words (a selection is one run; kept general)
  function runs(p) {
    const out = [];
    p.slice().sort((x, y) => x.i - y.i).forEach((x) => {
      const last = out[out.length - 1];
      if (last && x.i === last[last.length - 1].i + 1) last.push(x); else out.push([x]);
    });
    return out;
  }
  function deleteWords(p) {
    const ed = editor();
    if (!ed || !p.length) return false;
    const rs = runs(p).map(rangeOf);
    const gone = rs.reduce((n, r) => n + r.end - r.start, 0);
    hideBar();
    if (window.getSelection) { try { window.getSelection().removeAllRanges(); } catch (e) {} }
    ed.cutRanges(rs);
    toast('✂ ' + gone.toFixed(1) + ' ' + tx('ሰከንድ ተቆርጧል', 's cut') + ' · ', '↶ ' + tx('መልስ', 'Undo'));
    return true;
  }
  // ✂ outside the editor: strike the words (~like this~) — ✂ Clean up then
  // cuts them from the exported video; again on struck words: keep them.
  function cut() {
    const p = current;
    if (!p.length) return;
    if (deleteWords(p)) return;
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
    inp.dataset.amhType = '1';
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
  document.addEventListener('mousedown', (e) => {
    // where the press WAS: ✎ swaps the bar's buttons for its typing box
    // before this runs, so the pressed button is no longer in the bar (1.56)
    const path = (e.composedPath && e.composedPath()) || [];
    if (bar.style.display === 'none' || path.indexOf(bar) >= 0 || bar.contains(e.target) || box.contains(e.target)) return;
    if (typeof checking !== 'undefined' && checking) { if (e.target.closest && e.target.closest('.st-player, .ed-tl, #appVideo')) return; stopCheck(); return; }
    hideBar();
  });
  document.addEventListener('keydown', (e) => {
    if (mode !== 'script' || !editor() || !review.classList.contains('show')) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
    const p = picked().length ? picked() : current;
    if (!p.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    deleteWords(p);
  }, true);

  // ── a small note after a cut / move, with ↶ right there ────────────────
  const note = el('div', 'st-toast');
  note.style.display = 'none';
  review.appendChild(note);
  let noteT = 0;
  function toast(text, undoLabel) {
    note.textContent = text;
    const u = el('button', '', undoLabel); u.type = 'button';
    u.addEventListener('click', () => { if (typeof undoReview === 'function') undoReview(); note.style.display = 'none'; });
    note.appendChild(u);
    const r = box.getBoundingClientRect();
    note.style.left = (r.left + 12) + 'px';
    note.style.top = (r.bottom - 48) + 'px';
    note.style.display = '';
    clearTimeout(noteT);
    noteT = setTimeout(() => { note.style.display = 'none'; }, 5000);
  }

  // ── drag a paragraph to another place (the video moves with it) ────────
  // A paragraph's part of the video runs from the middle of the pause before
  // it to the middle of the pause after it, so no word is clipped.
  function bounds() {
    const ed = editor();
    const end = ed ? ed.total() : 0;
    const B = [0];
    for (let k = 1; k < paras.length; k++) {
      const prev = paras[k - 1], cur = paras[k];
      B.push((prev[prev.length - 1].e + cur[0].s) / 2);
    }
    B.push(Math.max(end, paras.length ? paras[paras.length - 1].slice(-1)[0].e : 0));
    return B;
  }
  const dropLine = el('div', 'sp-drop');
  function startDrag(e, k) {
    if (e.button !== 0 || !editor()) return;
    e.preventDefault(); e.stopPropagation();
    hideBar();
    const ps = Array.from(box.querySelectorAll('.sp'));
    const src = ps[k];
    if (!src) return;
    src.classList.add('sp-moving');
    box.classList.add('sp-dragging');
    let gap = -1;
    const move = (ev) => {
      // the gap nearest the pointer: before paragraph j (j = length: the end)
      const y = ev.clientY;
      gap = ps.length;
      for (let j = 0; j < ps.length; j++) {
        const r = ps[j].getBoundingClientRect();
        if (y < r.top + r.height / 2) { gap = j; break; }
      }
      const same = gap === k || gap === k + 1;
      if (same) { dropLine.remove(); return; }
      if (gap < ps.length) box.insertBefore(dropLine, ps[gap]); else box.appendChild(dropLine);
      // keep scrolling while near the edges
      const br = box.getBoundingClientRect();
      if (y < br.top + 30) box.scrollTop -= 12; else if (y > br.bottom - 30) box.scrollTop += 12;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      src.classList.remove('sp-moving');
      box.classList.remove('sp-dragging');
      dropLine.remove();
      if (gap < 0 || gap === k || gap === k + 1) return;
      const B = bounds();
      editor().moveRange(B[k], B[k + 1], B[gap]);
      toast('↕ ' + tx('ክፍሉ ተንቀሳቅሷል', 'Moved') + ' · ', '↶ ' + tx('መልስ', 'Undo'));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
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

  // ── ✔ Check words (1.48): one fast pass over the doubtful (orange) words.
  // Each word plays by itself; Enter = it is right (or the typed fix goes in
  // and is learned for every video); Tab = next, Shift+Tab = back, ↑ = hear
  // it again, Esc = stop. Suggestions: 🧠 memory, then look-alike words of
  // this video. Every step is one ↶.
  let checking = false, chkAt = 0, chkDone = 0, chkNote = '';
  function doubtList() { const a = []; spans.forEach((s, i) => { if (s && s.classList.contains('doubt')) a.push(i); }); return a; }
  function startCheck() {
    if (mode !== 'script') setMode('script');
    checking = true; chkDone = 0; chkNote = '';
    if (typeof amhDict === 'function') amhDict();       // the dictionary: made once, in the background
    setTimeout(() => goCheck(0, false), 80);
  }
  function stopCheck() { checking = false; bar.classList.remove('st-chk'); hideBar(); }
  // the next (or previous) doubtful word from time t; wraps around
  function goCheck(t, back) {
    if (!checking) return;
    const all = doubtList();
    if (!all.length) { doneCheck(); return; }
    let i = back ? all.slice().reverse().find((k) => words[k].s < t - 0.001) : all.find((k) => words[k].s >= t - 0.001);
    if (i == null) i = back ? all[all.length - 1] : all[0];
    chkAt = words[i].s;
    showCheck(i, all.length);
  }
  let chkStop = null;
  function hear(x) {
    const v = video();
    if (!v) return;
    const ed = editor();
    if (chkStop) v.removeEventListener('timeupdate', chkStop);
    const end = x.e + 0.25;
    seek(Math.max(0, x.s - 0.3));
    chkStop = () => { if (nowT() >= end) { if (ed) ed.pause(); else v.pause(); v.removeEventListener('timeupdate', chkStop); chkStop = null; } };
    v.addEventListener('timeupdate', chkStop);
    if (ed) setTimeout(() => ed.play(), 60); else v.play().catch(() => {});
  }
  function memoryFixes() {
    let f = {};
    try { if (typeof loadFixStore === 'function' && typeof activeFixes === 'function') f = activeFixes(loadFixStore()); } catch (e) {}
    try { if (typeof REVIEW_AUTOFIX !== 'undefined' && REVIEW_AUTOFIX.rules) f = Object.assign({}, f, REVIEW_AUTOFIX.rules); } catch (e) {}
    return f;
  }
  function showCheck(i, left) {
    const x = words[i], s = spans[i];
    if (!x || !s) return;
    s.scrollIntoView({ block: 'center' });
    current = [x];
    bar.textContent = '';
    bar.classList.add('st-chk');
    const head = el('div', 'st-chk-h');
    head.appendChild(el('b', '', '⚠ ' + left + ' ' + tx('ቀርተዋል', 'left')));
    if (chkDone) head.appendChild(el('span', '', '✓ ' + chkDone + ' ' + tx('ተፈትሸዋል', 'checked')));
    if (chkNote) head.appendChild(el('span', 'st-chk-note', chkNote));
    head.appendChild(el('span', 'st-flex'));
    const close = el('button', 'st-chk-x', '✕'); close.type = 'button'; close.title = tx('አቁም (Esc)', 'Stop (Esc)');
    close.addEventListener('mousedown', (e) => { e.preventDefault(); stopCheck(); });
    head.appendChild(close);
    bar.appendChild(head);
    const row = el('div', 'st-chk-row');
    const was = plainWord(x.w);
    const inp = el('input', 'st-fix');
    inp.dataset.amhType = '1';
    inp.type = 'text';
    inp.value = was;
    inp.setAttribute('dir', 'auto');
    const okB = el('button', 'on', ''); okB.type = 'button';
    const sync = () => {
      const same = inp.value.replace(/\s+/g, ' ').trim() === was;
      okB.textContent = same ? '✓ ' + tx('ትክክል ነው', 'Correct') : '✓ ' + tx('አስተካክል', 'Fix');
      okB.title = 'Enter';
    };
    inp.addEventListener('input', sync);
    sync();
    const playB = el('button', '', '▶'); playB.type = 'button'; playB.title = tx('እንደገና ስማ (↑)', 'Hear it again (↑)');
    const nextB = el('button', '', '→'); nextB.type = 'button'; nextB.title = tx('ዝለል (Tab)', 'Skip (Tab)');
    [inp, okB, playB, nextB].forEach((b) => row.appendChild(b));
    bar.appendChild(row);
    const sug = S.checkSuggest(x.w, reviewCues, memoryFixes(), 3, typeof amhDict === 'function' ? amhDict() : null);
    if (sug.length) {
      const sr = el('div', 'st-chk-sug');
      sug.forEach((w2, k) => {
        const b = el('button', '', w2); b.type = 'button'; b.title = 'Alt+' + (k + 1);
        b.addEventListener('mousedown', (e) => { e.preventDefault(); inp.value = w2; sync(); apply(); });
        sr.appendChild(b);
      });
      bar.appendChild(sr);
    }
    bar.style.display = '';
    place(rectOf([x]));
    inp.focus(); inp.select();
    hear(x);
    function apply() {
      const v = inp.value.replace(/\s+/g, ' ').trim();
      if (v === was) markRight(x);
      else {
        fix([x], v);
        // one word for one word: learned for every new video (🧠, editable there)
        if (v && !/\s/.test(v) && typeof loadFixStore === 'function' && typeof rememberFix === 'function') {
          try {
            const st = loadFixStore();
            rememberFix(st, was, v, true);
            saveFixStore(st);
            if (typeof syncMemoryButton === 'function') syncMemoryButton();
            chkNote = '🧠 ' + was + ' → ' + v;
          } catch (e) {}
        }
      }
      chkDone++;
      setTimeout(() => goCheck(x.e, false), 140);
    }
    okB.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
    playB.addEventListener('mousedown', (e) => { e.preventDefault(); hear(x); });
    nextB.addEventListener('mousedown', (e) => { e.preventDefault(); goCheck(x.e, false); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
      else if (e.key === 'Tab') { e.preventDefault(); goCheck(e.shiftKey ? x.s : x.e, e.shiftKey); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hear(x); }
      else if (e.key === 'Escape') { e.preventDefault(); stopCheck(); }
      else if (e.altKey && /^[1-3]$/.test(e.key) && sug[Number(e.key) - 1]) { e.preventDefault(); inp.value = sug[Number(e.key) - 1]; sync(); apply(); }
    });
  }
  // "this word is right": it is no longer doubtful (one ↶)
  function markRight(x) {
    const c = reviewCues[x.cue];
    if (!c) return;
    const w = plainWord(x.w);
    const clean = (d) => plainWord(d).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const keep = (c.doubt || []).filter((d) => clean(d) !== clean(w));
    if (keep.length === (c.doubt || []).length) return;
    pushReviewUndo('check');
    c.doubt = keep;
    renderReview();
  }
  function doneCheck() {
    checking = false;
    bar.textContent = '';
    bar.classList.add('st-chk');
    const head = el('div', 'st-chk-h st-chk-done');
    head.appendChild(el('b', '', '✓ ' + tx('ሁሉም ቃላት ተፈትሸዋል', 'Every word is checked') + (chkDone ? ' (' + chkDone + ')' : '')));
    head.appendChild(el('span', 'st-flex'));
    const close = el('button', 'st-chk-x', '✕'); close.type = 'button';
    close.addEventListener('mousedown', (e) => { e.preventDefault(); bar.classList.remove('st-chk'); hideBar(); });
    head.appendChild(close);
    bar.appendChild(head);
    if (chkNote) bar.appendChild(el('div', 'st-chk-note', chkNote));
    bar.style.display = '';
    place(box.getBoundingClientRect());
    setTimeout(() => { if (!checking && bar.classList.contains('st-chk')) { bar.classList.remove('st-chk'); hideBar(); } }, 4000);
  }
  // ⚠ N (and F7): the check pass, in the script
  const studioDoubt = window.goFirstDoubtStudio;
  window.goFirstDoubtStudio = () => {
    if (mode !== 'script' && !box) { if (studioDoubt) studioDoubt(); return; }
    startCheck();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F7' || !review.classList.contains('show')) return;
    e.preventDefault();
    if (checking) stopCheck(); else startCheck();
  });
  window.__amhCheck = { start: startCheck, stop: stopCheck, active: () => checking };

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
    paras: () => paras, bounds, deleteWords, rangeOf,
    star: (p) => { current = p; star(); }, cut: (p) => { current = p; cut(); } };
})();
