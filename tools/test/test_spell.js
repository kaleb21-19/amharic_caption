#!/usr/bin/env node
/*
 * test_spell.js — 🔤 spelling hints (1.94.59, Studio S4; panel/js/core.js
 * spellCheck). With the real word list (amh_lm.json.gz, 109,612 words) it
 * holds the numbers the owner chose "Balanced" on:
 *   - correct words underlined: speech transcripts (fixtures + Common Voice)
 *     2.0%, the panel's own Amharic UI text 10.6% (loanwords like ካፕሽን);
 *   - 50 seeded typos (fixtures/spell_typos.tsv: a wrong vowel form, a
 *     look-alike sound, a dropped or doubled letter) 39 caught, 26 with the
 *     right word as the hint;
 *   - fast: a caption well under a millisecond (typing stays smooth).
 *
 * Run:  node tools/test/test_spell.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../../panel/js/core.js');

const REPO = path.resolve(__dirname, '..', '..');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

const lm = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'amh_lm.json.gz'))).toString('utf8'));
const dictText = Object.entries(lm.counts).filter(([k]) => /^[ሀ-፿]+$/.test(k)).map(([k, v]) => k + '\t' + v).join('\n');
let t0 = Date.now();
const idx = C.spellIndex(dictText, 5);
const buildMs = Date.now() - t0;
const words = (t) => (t.replace(/፡/g, ' ').match(/[ሀ-ፚ]+/g) || []).filter((w) => w.length >= 2);
const pct = (ws) => 100 * ws.filter((w) => C.spellCheck(w, idx)).length / ws.length;

test('the word list is read into the index once, quickly', () => {
  assert.ok(idx.counts.size > 100000, String(idx.counts.size));
  assert.ok(buildMs < 3000, buildMs + ' ms');
});

test('letters Amharic writers swap freely count as the same (ሀ ሐ ኀ, ሰ ሠ, ጸ ፀ, አ ዐ)', () => {
  assert.strictEqual(C.spellNorm('ሠላም'), C.spellNorm('ሰላም'));
  assert.strictEqual(C.spellNorm('ሐበሻ'), C.spellNorm('ሀበሻ'));
  assert.strictEqual(C.spellNorm('ፀሐይ'), C.spellNorm('ጸሀይ'));
  assert.strictEqual(C.spellNorm('ዓመት'), C.spellNorm('ኣመት'));
  assert.notStrictEqual(C.spellNorm('ሰላም'), C.spellNorm('ሸላም'), 'other letters stay different');
});

test('endings and prefixes come off: a known word with -ም -ና -ን, በ- የ-, the -u merged into the last letter', () => {
  const st = (w) => C.spellStems(w).map((x) => x.s);
  assert.ok(st('ዳንስም').includes('ዳንስ'));
  assert.ok(st('በኢትዮጵያም').includes('ኢትዮጵያ'));
  assert.ok(st('ካፕሽኑን').includes('ካፕሽን'), 'ካፕሽኑን -> ካፕሽን');
  assert.strictEqual(C.spellCheck('በኢትዮጵያም', idx), null);
  // a hint on a stem comes back with the word's own ending
  const one = C.spellStems('ቤተስብም').find((x) => x.s === 'ቤተስብ');
  assert.strictEqual(one.wrap('ቤተሰብ'), 'ቤተሰብም');
});

test('only Amharic words of 2+ letters are judged; the editor\'s "right" words never', () => {
  assert.strictEqual(C.spellCheck('Premiere', idx), null);
  assert.strictEqual(C.spellCheck('2026', idx), null);
  assert.strictEqual(C.spellCheck('እ', idx), null);
  assert.strictEqual(C.spellCheck(null, idx), null);
  assert.strictEqual(C.spellCheck('ቤተሰብ', null), null, 'no index yet: nothing underlined');
  const w = 'ካፕሽኑ';
  assert.ok(C.spellCheck(w, idx), 'a loanword the list does not have');
  assert.strictEqual(C.spellCheck(w, idx, { [w]: 1 }), null, 'kept as a right word');
});

test('Balanced, measured: correct words underlined 2.0% in speech transcripts, 10.6% in technical UI text', () => {
  const tr = [];
  for (const d of ['tools/test/fixtures', 'tools/test/fixtures_real']) {
    for (const f of fs.readdirSync(path.join(REPO, d)).filter((x) => x.endsWith('.txt'))) tr.push(...words(fs.readFileSync(path.join(REPO, d, f), 'utf8')));
  }
  const ui = [];
  for (const m of fs.readFileSync(path.join(REPO, 'panel/js/i18n.js'), 'utf8').matchAll(/:\s*'([^']*[ሀ-፿][^']*)'/g)) ui.push(...words(m[1]));
  const a = pct(tr), b = pct(ui);
  console.log('        transcripts ' + tr.length + ' words ' + a.toFixed(1) + '%, UI ' + ui.length + ' words ' + b.toFixed(1) + '%');
  assert.ok(tr.length > 600 && a <= 2.5, a.toFixed(1));
  assert.ok(ui.length > 2500 && b <= 11.5, b.toFixed(1));
});

test('Balanced, measured: 39 of 50 seeded typos caught, 26 with the right word as the hint', () => {
  const ty = fs.readFileSync(path.join(REPO, 'tools/test/fixtures/spell_typos.tsv'), 'utf8').trim().split(/\r?\n/).map((l) => l.split('\t'));
  assert.strictEqual(ty.length, 50);
  const caught = ty.filter(([, t]) => C.spellCheck(t, idx));
  const right = ty.filter(([w, t]) => { const r = C.spellCheck(t, idx); return r && C.spellNorm(r.suggest) === C.spellNorm(w); });
  console.log('        caught ' + caught.length + '/50, right hint ' + right.length);
  assert.ok(caught.length >= 38, String(caught.length));
  assert.ok(right.length >= 24, String(right.length));
});

test('fast: a caption is checked well under a millisecond', () => {
  const cap = 'ዛሬ ስለ ኢትዮጵያ ታሪክ እንነጋገራለን ቤተስብ ሁሉ ተሰብስቦ ነበር';
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 500; i++) C.spellWordsIn(cap, idx);
  const ms = Number(process.hrtime.bigint() - t1) / 1e6 / 500;
  console.log('        ' + ms.toFixed(3) + ' ms a caption');
  assert.ok(ms < 1, ms.toFixed(3));
  assert.deepStrictEqual(C.spellWordsIn('ቤተስብ ቤተስብ ~ቤተስብ~', idx).length <= 1, true, 'each word once, struck words not judged');
});

console.log('ALL PASS  (' + passed + ' tests)');
