#!/usr/bin/env node
/*
 * test_host_mogrt.js — 1.94.20: clicking an editable template in the Premiere
 * style strip calls Sequence.importMGT() at the playhead on the topmost empty
 * video track. No text is written into the template (1.94.1 trap).
 *
 * Run:  node tools/test/test_host_mogrt.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => (p === n ? t.length : t[p]) });
const T = (s) => ({ seconds: s });
const TPS = 254016000000;

function makeTrack(clips) {
  const list = clips.map(([s, e]) => ({ start: T(s), end: T(e) }));
  return { list, clips: coll(list, 'numItems') };
}
function makePremiere(opts) {
  opts = opts || {};
  const tracks = (opts.tracks || [[], []]).map(makeTrack);
  const imports = [];
  const seq = {
    videoTracks: coll(tracks, 'numTracks'),
    getPlayerPosition() { return { seconds: opts.at == null ? 3.5 : opts.at, ticks: String((opts.at == null ? 3.5 : opts.at) * TPS) }; },
    importMGT(p, ticks, v, a) {
      imports.push({ p, ticks, v, a });
      if (opts.refuse) return null;
      return { name: 'Placed template' };
    }
  };
  const ctx = {
    JSON, Math, String, Number,
    File: class { constructor(p) { this.p = p; } get exists() { return this.p === opts.file || fs.existsSync(this.p); } },
    app: { project: { activeSequence: opts.noSeq ? null : seq } }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  return { ctx, imports, seq };
}
const call = (pp, p) => JSON.parse(vm.runInContext('amh_placeMOGRT(' + JSON.stringify(JSON.stringify({ path: p })) + ')', pp.ctx));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

const tpl = path.join(os.tmpdir(), 'amh_test_mogrt_' + Date.now() + '.mogrt');
fs.writeFileSync(tpl, 'x');

test('a click imports the .mogrt at the playhead on the topmost free video track', () => {
  const pp = makePremiere({ file: tpl, at: 3.5, tracks: [[[0, 10]], [[0, 1]]] });
  const r = call(pp, tpl);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.placed, true);
  assert.strictEqual(r.track, 2);
  assert.strictEqual(r.atSeconds, 3.5);
  assert.strictEqual(pp.imports.length, 1);
  assert.strictEqual(pp.imports[0].p, tpl);
  assert.strictEqual(pp.imports[0].ticks, String(Math.round(3.5 * TPS)));
  assert.strictEqual(pp.imports[0].v, 1);
  assert.strictEqual(pp.imports[0].a, 0);
});

test('the playhead can be at the start; track 0 is used when it is free', () => {
  const pp = makePremiere({ file: tpl, at: 0, tracks: [[]] });
  const r = call(pp, tpl);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(pp.imports[0].ticks, '0');
  assert.strictEqual(pp.imports[0].v, 0);
});

test('a missing .mogrt is a clear error, not a Premiere crash', () => {
  const pp = makePremiere({ file: tpl });
  const r = call(pp, path.join(os.tmpdir(), 'not_there_' + Date.now() + '.mogrt'));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Template not found/);
  assert.strictEqual(pp.imports.length, 0);
});

test('no sequence / no free track / Premiere refusal all report a reason', () => {
  assert.match(call(makePremiere({ file: tpl, noSeq: true }), tpl).error, /No active sequence/);
  assert.match(call(makePremiere({ file: tpl, tracks: [[[0, 10]]] }), tpl).error, /No empty video track/);
  assert.match(call(makePremiere({ file: tpl, refuse: true }), tpl).error, /could not place/);
});

console.log('\ntest_host_mogrt: ' + passed + ' checks — all green ✅');
