#!/usr/bin/env node
/*
 * test_host_overlay.js — styled captions (1.11): the transparent caption
 * video goes on the first empty video track ABOVE everything in its time
 * range; a track is added only when none is free; the frame size and rate
 * come from the sequence.
 *
 * Run:  node tools/test/test_host_overlay.js
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

function makeTrack(clips) {
  const list = clips.map(([s, e]) => ({ start: T(s), end: T(e) }));
  const placed = [];
  return { list, placed, clips: coll(list, 'numItems'),
           overwriteClip(item, at) { placed.push([item.name, at]); list.push({ start: T(at), end: T(at + 5) }); return true; } };
}
function makePremiere(trackClips, opts) {
  opts = opts || {};
  const kids = [];
  const bin = { name: 'Amharic Captions', type: 2, children: coll(kids, 'numItems') };
  const rootKids = [bin];
  const root = { children: coll(rootKids, 'numItems'), createBin() { return bin; } };
  const vt = trackClips.map(makeTrack);
  const seq = {
    frameSizeHorizontal: 1080, frameSizeVertical: 1920, timebase: String(254016000000 / 25),
    getSettings() { return opts.noRate ? {} : { videoFrameRate: { seconds: 1 / 29.97 } }; },
    videoTracks: coll(vt, 'numTracks'),
  };
  const qeLog = [];
  const ctx = {
    JSON,
    File: class { constructor(p) { this.p = p; } get exists() { return fs.existsSync(this.p); } },
    app: {
      project: {
        activeSequence: seq, rootItem: root,
        importFiles(paths) { if (opts.refuse) return false; for (const p of paths) kids.push({ name: path.basename(p) }); return true; },
      },
      enableQE() {},
    },
    qe: { project: { getActiveSequence: () => ({ addTracks(nv) { qeLog.push(nv); if (!opts.noQE) vt.push(makeTrack([])); } }) } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  const call = (js) => JSON.parse(vm.runInContext(js, ctx));
  return { ctx, vt, qeLog, call };
}
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amhov-')), 'captions_karaoke.mov');
fs.writeFileSync(tmp, 'x');
const place = (pp, start, dur) => pp.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp, startSeconds: start, duration: dur })) + ')');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('frame size and rate come from the sequence (rate from the timebase if settings have none)', () => {
  let r = makePremiere([[[0, 10]]]).call('amharic_getFrame()');
  assert.deepStrictEqual([r.width, r.height, Math.round(r.fps * 100) / 100], [1080, 1920, 29.97]);
  r = makePremiere([[[0, 10]]], { noRate: true }).call('amharic_getFrame()');
  assert.strictEqual(Math.round(r.fps), 25);
});

test('goes on the first empty track above the video (V2 when V1 has the clip)', () => {
  const pp = makePremiere([[[0, 60]], [], []]);
  const r = place(pp, 3, 20);
  assert.ok(r.ok && r.placed, JSON.stringify(r));
  assert.strictEqual(r.track, 2);
  assert.deepStrictEqual(pp.vt[1].placed, [['captions_karaoke.mov', 3]]);
  assert.strictEqual(r.addedTrack, false);
});

test('never under a title or B-roll that is in the same time range (above the highest used track)', () => {
  const pp = makePremiere([[[0, 60]], [], [[10, 15]], []]);   // a title on V3 at 10-15 s
  const r = place(pp, 0, 30);
  assert.strictEqual(r.track, 4, 'V4, above the title on V3');
  // something on V3 outside the range does not matter
  const qq = makePremiere([[[0, 60]], [], [[40, 45]]]);
  assert.strictEqual(place(qq, 0, 30).track, 2);
});

test('every track busy: one track is added on top', () => {
  const pp = makePremiere([[[0, 60]], [[0, 60]]]);
  const r = place(pp, 0, 30);
  assert.deepStrictEqual(pp.qeLog, [1]);
  assert.strictEqual(r.track, 3);
  assert.strictEqual(r.addedTrack, true);
});

test('no track could be added: a clear message, nothing placed', () => {
  const pp = makePremiere([[[0, 60]]], { noQE: true });
  const r = place(pp, 0, 30);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Add one video track/);
});

test('missing file / refused import: clear errors', () => {
  const pp = makePremiere([[[0, 60]], []]);
  let r = pp.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp + '.nope', startSeconds: 0, duration: 5 })) + ')');
  assert.match(r.error, /not found/);
  r = place(makePremiere([[[0, 60]], []], { refuse: true }), 0, 5);
  assert.match(r.error, /refused/);
});

console.log('\nALL PASS  (' + passed + ' tests)');
