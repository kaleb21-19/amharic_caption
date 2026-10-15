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
  const list = [];
  const mk = (s, e, name) => {
    const c = { start: T(s), end: T(e), projectItem: { name: name || 'video.mp4' },
                remove() { list.splice(list.indexOf(c), 1); } };
    return c;
  };
  clips.forEach(([s, e, name]) => list.push(mk(s, e, name)));
  const placed = [];
  return { list, placed, clips: coll(list, 'numItems'),
           overwriteClip(item, at) { placed.push([item.name, at]); list.push(mk(at, at + 5, item.name)); return true; } };
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

test('cut parts of the same video: the next part does NOT remove the previous part\'s styled layer (1.16.12)', () => {
  // Owner report: 3 cut parts, part 1 placed in one style, part 2 in another
  // style removed part 1's layer (same name prefix, the layers only touch).
  const part1 = 'amhstyle_sequence__glide_1.mov';
  const pp = makePremiere([[[0, 30]], [[0, 10.4, part1]]]);
  const r = pp.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp, startSeconds: 9.8, duration: 10,
    replacePrefix: 'amhstyle_sequence__' })) + ')');
  assert.ok(r.ok && r.placed, JSON.stringify(r));
  assert.strictEqual(r.replaced, 0, 'part 1 only touches part 2: it stays');
  assert.ok(pp.vt[1].list.some((c) => c.projectItem.name === part1), 'part 1\'s layer is still there');
  // placing part 1 again (same time) still replaces it
  const r2 = pp.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp, startSeconds: 0, duration: 10.2,
    replacePrefix: 'amhstyle_sequence__' })) + ')');
  assert.strictEqual(r2.replaced, 1, 'the same captions placed again replace the old layer');
});

test('placing again replaces our earlier layer for the same captions, nothing else', () => {
  const old = 'amhstyle_interview__karaoke_111.mov';
  const pp = makePremiere([[[0, 60]], [[0, 30, old], [40, 50, 'amhstyle_interview__pop_9.mov']], [[5, 8, 'title.mov']]]);
  const r = pp.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp, startSeconds: 0, duration: 30,
    replacePrefix: 'amhstyle_interview__' })) + ')');
  assert.ok(r.ok && r.placed, JSON.stringify(r));
  assert.strictEqual(r.replaced, 1, 'the old layer in this range is removed');
  assert.ok(!pp.vt[1].list.some((c) => c.projectItem.name === old));
  assert.ok(pp.vt[1].list.some((c) => /pop_9/.test(c.projectItem.name)), 'a styled layer outside the range stays');
  assert.ok(pp.vt[2].list.some((c) => c.projectItem.name === 'title.mov'), 'the title stays');
  assert.strictEqual(r.track, 4, 'still above the title on V3');
  // a prefix that is not ours removes nothing
  const qq = makePremiere([[[0, 60]], [[0, 30, 'video2.mp4']]]);
  const r2 = qq.call('amh_placeOverlay(' + JSON.stringify(JSON.stringify({ path: tmp, startSeconds: 0, duration: 30, replacePrefix: 'video' })) + ')');
  assert.strictEqual(r2.replaced, 0);
  assert.strictEqual(qq.vt[1].list.length, 1);
});

console.log('\nALL PASS  (' + passed + ' tests)');
