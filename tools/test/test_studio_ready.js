#!/usr/bin/env node
/*
 * test_studio_ready.js - the Studio's "captions are ready" toast (1.94.15,
 * Save SRT in the toast since 1.94.17). A new editor saw the count but not
 * what to do next: the old "next step" bar in studio.js was never shown, and
 * Save SRT was buried in the Export sheet. The real captionsReady() body is
 * taken from app/studio_edit.js and driven with a tiny DOM, so the wording
 * and both buttons are tested where they are written.
 *
 * Run:  node tools/test/test_studio_ready.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../../app/studio_core.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'studio_edit.js'), 'utf8');
function fnSource(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists in studio_edit.js');
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('no closing brace for ' + name);
}
const FN = fnSource('captionsReady');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  [OK] ' + name); }
  catch (e) { failed++; console.log('  [FAIL] ' + name + '\n         ' + (e && e.stack || e)); }
}

function fakeEl(tag) {
  return {
    tagName: tag, className: '', textContent: '', children: [], style: {}, title: '', type: '', disabled: false,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener(ev, h) { if (ev === 'click') this.click = h; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); },
    classList: { add() {}, remove() {}, contains(c) { return c === 'show'; } },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 })
  };
}
function run(editor, lang, live, srtFail) {
  const calls = [], srtCalls = [], review = fakeEl('div');
  const sb = {
    console, AMH_LANG: lang, S, REVIEW_LIVE: !!live,
    ST: { openExport: (o) => calls.push({ focus: o.focus, run: o.run }) },
    __amhAppExport: { srt: () => {
      srtCalls.push(1);
      if (srtFail) throw new Error(srtFail);
      return { file: 'C:\\videos\\clip.srt', count: 3 };
    } },
    APP: { path: { basename: (p) => String(p).split(/[\\/]/).pop() } },
    tx: (am, en) => (lang === 'am' ? am : en),
    el: (tag, cls, text) => { const e = fakeEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
    btn: (cls, text, title, fn) => { const b = fakeEl('button'); b.className = cls; b.textContent = text; b.title = title; if (fn) b.addEventListener('click', fn); return b; },
    review, stage: fakeEl('div'), loadSettings: () => ({ editor }),
    hideReady() {}, seek: async () => {}, play() {},
    setTimeout: () => 1, clearTimeout() {}
  };
  sb.window = sb;
  // readyEl / readyT are module-level let bindings in studio_edit.js
  vm.runInNewContext('let readyEl = null, readyT = 0;\n' + FN, sb, { filename: 'studio_edit.js:captionsReady' });
  sb.captionsReady(3);
  return { review, calls, srtCalls };
}

(async () => {
  await t('CapCut: the toast says what to do next and its button opens the editor sheet', async () => {
    const { review, calls } = run('capcut', 'en');
    const toast = review.children[0];
    assert.strictEqual(toast.className, 'st-toast ed-ready');
    const texts = toast.children.map((c) => c.textContent);
    assert.ok(texts.some((x) => x.indexOf('3 captions are ready') >= 0), texts);
    assert.ok(texts.indexOf('Check the words → choose a style → send to CapCut') >= 0, texts);
    const exp = toast.children.find((c) => c.textContent.indexOf('Export') >= 0);
    assert.ok(exp, 'there is an Export button right in the toast');
    exp.click();
    assert.deepStrictEqual(calls, [{ focus: 'capcut', run: true }], 'the chosen editor is opened');
  });

  await t('Amharic comes first, and DaVinci is named when that is the editor', async () => {
    const { review, calls } = run('davinci', 'am');
    const texts = review.children[0].children.map((c) => c.textContent);
    assert.ok(texts.some((x) => x.indexOf('3 ካፕሽኖች ዝግጁ ናቸው') >= 0), texts);
    assert.ok(texts.some((x) => x.indexOf('ቃላቱን ያረጋግጡ → ስታይል ይምረጡ → ወደ DaVinci ይላኩ') >= 0), texts);
    review.children[0].children.find((c) => typeof c.click === 'function' && c.textContent.indexOf('ይላኩ') >= 0).click();
    assert.deepStrictEqual(calls, [{ focus: 'davinci', run: true }]);
  });

  await t('with no editor chosen the next step is a plain export', async () => {
    const { review, calls } = run('', 'en');
    const texts = review.children[0].children.map((c) => c.textContent);
    assert.ok(texts.indexOf('Check the words → choose a style → export') >= 0, texts);
    review.children[0].children.find((c) => c.textContent.indexOf('Export') >= 0).click();
    assert.deepStrictEqual(calls, [{ focus: '', run: true }]);
  });

  await t('Save SRT is one click in the toast, and it does not open the sheet', async () => {
    const { review, calls, srtCalls } = run('capcut', 'en');
    const toast = review.children[0];
    const s = toast.children.find((c) => typeof c.click === 'function' && c.textContent.indexOf('Save SRT') >= 0);
    assert.ok(s, 'the Save SRT button is right in the ready toast');
    s.click();
    assert.strictEqual(srtCalls.length, 1, 'the .srt was saved');
    assert.strictEqual(s.textContent, '✓ SRT saved clip.srt');
    assert.strictEqual(s.disabled, true, 'a second click cannot write another file');
    assert.strictEqual(calls.length, 0, 'the Export sheet was not opened');
  });

  await t('the Save SRT button speaks Amharic first', async () => {
    const { review, srtCalls } = run('davinci', 'am');
    const s = review.children[0].children.find((c) => typeof c.click === 'function' && c.textContent.indexOf('SRT አስቀምጥ') >= 0);
    assert.ok(s, '💾 SRT አስቀምጥ is in the toast');
    s.click();
    assert.strictEqual(srtCalls.length, 1);
    assert.ok(s.textContent.indexOf('✓ SRT ተቀምጧል') === 0, s.textContent);
  });

  await t('a live transcription cannot be saved half-written; a disk error is shown', async () => {
    const live = run('capcut', 'en', true);
    const liveBtn = live.review.children[0].children.find((c) => typeof c.click === 'function' && c.textContent.indexOf('Save SRT') >= 0);
    liveBtn.click();
    assert.strictEqual(live.srtCalls.length, 0, 'nothing is written while captions are still arriving');

    const bad = run('capcut', 'en', false, 'disk full');
    const badBtn = bad.review.children[0].children.find((c) => typeof c.click === 'function' && c.textContent.indexOf('Save SRT') >= 0);
    badBtn.click();
    assert.strictEqual(bad.srtCalls.length, 1);
    assert.strictEqual(badBtn.textContent, '⚠ disk full');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
