/*
 * dom_shim.js — a tiny no-dependency DOM for driving panel/js/main.js inside
 * Node's `vm` (exact same zero-dependency policy as test_panel.js). Implements
 * just enough of the DOM surface main.js touches; nothing more.
 *
 * Run:  const { makeDocument, makeLocalStorage } = require('./dom_shim.js');
 */
'use strict';

class ClassList {
  constructor(el) { this.el = el; this._ = new Set(); }
  add(c) { this._.add(c); }
  remove(c) { this._.delete(c); }
  toggle(c, force) {
    const on = (force === undefined) ? !this._.has(c) : !!force;
    if (on) this._.add(c); else this._.delete(c);
    return on;
  }
  contains(c) { return this._.has(c); }
}

class El {
  constructor(tag, id) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.id = id || '';
    this.className = '';
    this.dataset = {};
    const style = { setProperty() {}, removeProperty() {} };
    this.style = new Proxy(style, {
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.placeholder = '';
    this.type = '';
    this.accept = '';
    this.files = null;
    this.text = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this._cmp = null; // component/opaque tag for tests (e.g. 'textarea')
  }
  get classList() { return this._cl || (this._cl = new ClassList(this)); }
  get textContent() { return this._text === undefined ? '' : this._text; }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.children = []; // setting textContent clears child nodes
  }
  setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = String(v); }
  getAttribute(k) {
    if (this._attrs && k in this._attrs) return this._attrs[k];
    if (String(k).indexOf('data-') === 0) {
      const key = String(k).slice(5);
      return (key in this.dataset) ? this.dataset[key] : null;
    }
    return null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(type, fn, opts) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
    if (opts && opts.once) this._once = this._once || {}; // once handled in fire()
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  fire(type, evt) {
    const handlers = (this.listeners[type] || []).slice();
    for (const fn of handlers) {
      fn(evt && evt.target ? evt : Object.assign({ target: this }, evt || {}));
    }
  }
  click() { this.fire('click', { target: this }); }
  set setScrollTop(v) { this.scrollTop = v; }
  scrollIntoView() {}
  select() {}
  // ── minimal querySelector / querySelectorAll ─────────────────────────────
  _all() { // depth-first descendants
    const out = [];
    const walk = (node) => { for (const c of node.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  _match(sel) {
    const parts = sel.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    let pool = this._all();
    let i = 0;
    // Optional id anchor as the first token, e.g. '#healthList .row-check'.
    if (parts[0].charAt(0) === '#') {
      const anchor = pool.find((n) => (n.id || '').toLowerCase() === parts[0].slice(1));
      if (!anchor) return [];
      pool = [anchor].concat(anchor._all());
      i = 1;
    } else {
      // No anchor: qualify tokens against this element's own descendants.
      pool = [this];
    }
    for (; i < parts.length; i++) {
      const tok = parts[i];
      const next = [];
      for (const n of pool) {
        for (const c of n._all()) {
          let ok = false;
          if (tok.charAt(0) === '.') {
            ok = (c.className || '').split(/\s+/).includes(tok.slice(1));
          } else if (tok === 'span:first-child') {
            ok = c.tagName === 'SPAN' && c.parentNode &&
                 c.parentNode.children.find((x) => x.tagName === 'SPAN') === c;
          } else {
            ok = c.tagName === tok.toUpperCase();
          }
          if (ok) next.push(c);
        }
      }
      pool = next;
      if (!pool.length) return [];
    }
    const seen = new Set(); const out = [];
    for (const n of pool) { if (!seen.has(n)) { seen.add(n); out.push(n); } }
    return out;
  }
  querySelectorAll(sel) { return this._match(sel); }
  querySelector(sel) { return this._match(sel)[0] || null; }
}

function makeLocalStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    __keys: () => Object.keys(store),
    __raw: store,
  };
}

const KNOWN = [
  // brand + pills
  'fontPill', 'fontText', 'statusPill', 'statusText',
  // onboarding
  'onboard', 'onboardStart', 'healthList',
  // source / file
  'srcSeg', 'srcClip', 'srcWork', 'srcWhole',
  'choose', 'fileInput', 'picked',
  // style
  'capSeg', 'capWords', 'capGroup', 'groupSize', 'maxChars', 'speakersToggle',
  'runBtn', 'cancelBtn', 'progBar', 'progLabel',
  // license
  'machineIdSection', 'machineIdDisplay', 'machineIdCopy', 'machineMismatch',
  'licensedNote', 'licenseInput', 'licenseActivate', 'licenseStatus', 'trialBanner',
  // logs
  'logDisc', 'logWrap', 'logBox',
  // footer
  'panelVersion', 'supportLink', 'diag',
  // review overlay
  'review', 'reviewList', 'reviewCount', 'reviewSearch', 'reviewAdd',
  'reviewExport', 'reviewDiscard', 'reviewBurn', 'reviewPlace',
  'burnStatus', 'burnFileInput',
  // misc
  'brandSub',
];

function makeDocument(tagFor) {
  const ids = {};
  const mk = (tag, id) => {
    const el = new El(tag, id);
    if (tagFor) el._cmp = tagFor(id);
    return el;
  };
  for (const id of KNOWN) ids[id] = mk('div', id);

  // stamped elements with the right tag/types so main.js behaves like the browser
  const stamp = {
    srcClip: ['button', 'clip'], srcWork: ['button', 'work'], srcWhole: ['button', 'whole'],
    capWords: ['button', 'words'], capGroup: ['button', 'grouped'],
    groupSize: ['input', null], maxChars: ['input', null], speakersToggle: ['input', null],
    fileInput: ['input', null], burnFileInput: ['input', null],
    licenseInput: ['input', null], reviewSearch: ['input', null],
    runBtn: ['button', null], cancelBtn: ['button', null], choose: ['button', null],
    diag: ['a', null], onboardStart: ['button', null],
    licenseActivate: ['button', null], machineIdCopy: ['button', null],
    reviewAdd: ['button', null], reviewExport: ['button', null],
    reviewDiscard: ['button', null], reviewBurn: ['button', null],
    reviewPlace: ['button', null], reviewList: ['div', null],
    panelVersion: ['span', null], supportLink: ['a', null],
    machineIdDisplay: ['span', null], licenseStatus: ['span', null],
    fontText: ['span', null],
  };
  for (const id in stamp) {
    const [tag, ds] = stamp[id];
    ids[id].tagName = tag.toUpperCase();
    ids[id].type = (tag === 'input') ? 'text' : '';
    ids[id].accept = (id === 'fileInput') ? 'audio/*,video/*' : ((id === 'burnFileInput') ? 'video/*' : '');
    ids[id]._cmp = tagFor ? tagFor(id) : null;
    if (ds) ids[id].dataset.ds = ds; // positional dataset key set below
  }
  // segmented controls + health rows get their dataset keys
  ids.srcClip.dataset.src = 'clip'; ids.srcWork.dataset.src = 'work'; ids.srcWhole.dataset.src = 'whole';
  ids.capWords.dataset.cap = 'words'; ids.capGroup.dataset.cap = 'grouped';
  ids.srcSeg.appendChild(ids.srcClip); ids.srcSeg.appendChild(ids.srcWork); ids.srcSeg.appendChild(ids.srcWhole);
  ids.capSeg.appendChild(ids.capWords); ids.capSeg.appendChild(ids.capGroup);
  // initial active states as in index.html
  ids.srcClip.classList.add('active');
  ids.capWords.classList.add('active');

  // health list rows (label span + state span), data-check like index.html
  for (const key of ['runtime', 'model', 'ffmpeg', 'python', 'font']) {
    const row = mk('div', '');
    row.className = 'row-check';
    row.dataset.check = key;
    const label = mk('span', '');
    const state = mk('span', '');
    state.className = 'state';
    row.appendChild(label);
    row.appendChild(state);
    ids.healthList.appendChild(row);
  }

  const registry = ids;
  const doc = {
    documentElement: mk('html', ''),
    body: mk('body', ''),
    _ids: registry,
    fonts: null,
    getElementById: (id) => registry[id] || null,
    createElement(tag) { return mk(tag, ''); },
    querySelectorAll(sel) { return doc.documentElement._match(sel); },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; },
  };
  // root the known elements under <body> so '#id button' style queries resolve
  doc.body.children = KNOWN.map((id) => ids[id]);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

module.exports = { makeDocument, makeLocalStorage, El };