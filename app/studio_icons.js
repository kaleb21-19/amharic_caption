/*
 * studio_icons.js — Amharic Captions Studio: one icon set (1.46.0).
 *
 * The Studio's buttons and labels start with a symbol (⌂ ↶ ✂ 🎨 …). Emoji
 * look different on every PC and childish next to a professional editor, so
 * this file turns each known leading symbol into a drawn line icon (our own
 * simple drawings, 24×24, the colour of the text). One table = every icon the
 * same weight and size everywhere; labels keep working unchanged (they are
 * re-drawn whenever their text changes). Caption text is never touched.
 */
(function () {
  'use strict';
  if (!document.documentElement.classList.contains('amh-studio')) return;
  // 24×24, stroke = currentColor, round ends
  const P = {
    home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
    redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
    upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
    download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
    cut: 'M8.5 8.5L20 20M8.5 15.5L20 4M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    music: 'M9 18V5l11-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM20 16a3 3 0 11-6 0 3 3 0 016 0z',
    play: 'M7 4l13 8-13 8z',
    pause: 'M7 4v16M17 4v16',
    prev: 'M18 5l-9 7 9 7zM6 5v14',
    next: 'M6 5l9 7-9 7zM18 5v14',
    refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
    warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
    wait: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
    sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v3M17.5 4.5h3',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
    brain: 'M9 4a3 3 0 00-3 3 3 3 0 00-2 5 3 3 0 002 5 3 3 0 003 3h1V4zM15 4a3 3 0 013 3 3 3 0 012 5 3 3 0 01-2 5 3 3 0 01-3 3h-1V4z',
    video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3',
    image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5a1.5 1.5 0 100-.01',
    split: 'M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4',
    folder: 'M3 6h6l2 2h10v11H3z',
    gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.6-1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 15.3H3a2 2 0 110-4h.1a1.6 1.6 0 001.2-2.6l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009.7 4.6V3a2 2 0 114 0v.1a1.6 1.6 0 002.6 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1.2z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    captions: 'M3 5h18v12H8l-5 4zM7 10h4M13 10h4M7 13h7',
    more: 'M12 5v.5M12 12v.5M12 19v.5',
    pen: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
    back: 'M19 12H5M11 18l-6-6 6-6',
    phone: 'M7 2h10v20H7zM11 18h2',
    monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
    subs: 'M5 3h10l4 4v14H5zM8 12h8M8 16h5',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    key: 'M15 7a4 4 0 11-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0115 7zM16.5 8.5v.01',
    full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    duck: 'M4 6v12M8 9v6M12 11v2M16 9v6M20 6v12',
    fast: 'M3 6l8 6-8 6zM13 6l8 6-8 6z',
    swap: 'M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4',
    sound: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    updown: 'M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    para: 'M13 4v16M17 4v16M19 4H10a4 4 0 000 8h3',
    palette: 'M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5S14.5 15 16 15h2a3 3 0 003-3c0-5-4-9-9-9zM7.5 11v.01M10.5 7.5v.01M15 7.5v.01',
    link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
    text: 'M5 5h14M12 5v14M9 19h6',
  };
  // the symbols the Studio's labels start with -> icon
  const MAP = {
    '⌂': 'home', '⬇': 'download', '↶': 'undo', '↷': 'redo', '⬆': 'upload', '⤓': 'download', '✂': 'cut', '＋': 'plus', '−': 'minus', '✕': 'close',
    '♪': 'music', '▶': 'play', '⏸': 'pause', '⏮': 'prev', '⏭': 'next', '↻': 'refresh', '⚠': 'warn', '⏳': 'wait', '🗑': 'trash',
    '✨': 'sparkle', '🎞': 'film', '🧠': 'brain', '🎬': 'video', '🖼': 'image', '⧓': 'split', '📁': 'folder', '📂': 'folder', '⚙': 'gear',
    '⚡': 'bolt', '💬': 'captions', '⋮': 'more', '✍': 'pen', '✏': 'pen', '✎': 'pen', '👤': 'user', '←': 'back', '📱': 'phone', '🖥': 'monitor',
    '📝': 'subs', '📄': 'file', '🔑': 'key', '⛶': 'full', '⤢': 'full', '⤵': 'duck', '⏩': 'fast', '↔': 'swap', '🔊': 'sound', '★': 'star',
    '↕': 'updown', '⇕': 'updown', '☰': 'list', '¶': 'para', '🎨': 'palette', '🔗': 'link',
  };
  const NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'amh-ic amh-ic-' + name);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', P[name]);
    s.appendChild(p);
    return s;
  }
  // where icons belong: buttons, tabs, card / section heads, timeline labels
  const WHERE = 'button, label, .st-tab, .st-card-ico, .st-home-h, .ed-labels > div, .ed-mthumb, .ed-cname, .st-ednote > b, .st-capsec, .st-sheet-head > b, .style-title, .app-drop-icon, .st-cchint, .st-how-ic';
  const NOT = '[contenteditable="true"], textarea, input, .review-text, .st-script-body';
  const LEAD = /^\s*([^\s\wሀ-፿])️?\s?/u;
  function fix(node) {
    if (node.nodeType !== 3) return;
    const host = node.parentNode;
    if (!host || host.nodeType !== 1 || !host.closest || !host.closest(WHERE) || host.closest(NOT)) return;
    const m = LEAD.exec(node.nodeValue);
    if (!m) return;
    const ch = Array.from(m[1])[0];
    const name = MAP[ch];
    if (!name || !P[name]) return;
    node.nodeValue = node.nodeValue.slice(m[0].length);
    // one icon per label: a label re-written keeps a single icon
    const prev = node.previousSibling;
    if (prev && prev.nodeType === 1 && prev.classList && prev.classList.contains('amh-ic')) prev.remove();
    host.insertBefore(icon(name), node);
    if (!node.nodeValue.trim()) host.classList.add('amh-ic-only');
    else host.classList.remove('amh-ic-only');
  }
  function walk(root) {
    if (root.nodeType === 3) { fix(root); return; }
    if (root.nodeType !== 1) return;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const todo = [];
    for (let n = it.nextNode(); n; n = it.nextNode()) todo.push(n);
    todo.forEach(fix);
  }
  let queued = new Set();
  let timer = 0;
  const flush = () => { timer = 0; const q = queued; queued = new Set(); q.forEach((n) => { if (n.isConnected) walk(n); }); };
  new MutationObserver((list) => {
    list.forEach((m) => {
      if (m.type === 'characterData') queued.add(m.target);
      else m.addedNodes.forEach((n) => queued.add(n));
    });
    if (!timer) timer = requestAnimationFrame(flush);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  walk(document.body);
  window.__amhIcons = { icon, MAP, P, walk };
})();
