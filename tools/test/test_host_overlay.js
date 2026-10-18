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
           overwriteClip(item, at) {
             placed.push([item.name, at]);
             const len = item._in != null && item._out != null ? item._out - item._in : 5;
             list.push(mk(at, at + len, item.name));
             return true;
           } };
}
// a project item; range: how the fake Premiere reads setInPoint / setOutPoint
// ('seconds', 'ticks' = a ticks string or number, 'ignore' = in / out do nothing)
function makeItem(name, range) {
  const TPS = 254016000000;
  const conv = (v) => (range === 'ticks' ? (typeof v === 'string' || v > 1e6 ? Number(v) / TPS : null) : (typeof v === 'number' && v < 1e6 ? v : null));
  return {
    name, _in: null, _out: null,
    setInPoint(v) { if (range !== 'ignore') { const x = conv(v); if (x != null) this._in = x; } return 0; },
    setOutPoint(v) { if (range !== 'ignore') { const x = conv(v); if (x != null) this._out = x; } return 0; },
    getInPoint() { return { seconds: this._in == null ? 0 : this._in }; },
    getOutPoint() { return { seconds: this._out == null ? 5 : this._out }; },
    clearInPoint() { this._in = null; }, clearOutPoint() { this._out = null; },
  };
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
    getSelection() { return opts.selection ? opts.selection(vt) : []; },
  };
  const qeLog = [];
  const ctx = {
    JSON,
    File: class { constructor(p) { this.p = p; } get exists() { return fs.existsSync(this.p); } },
    app: {
      project: {
        activeSequence: seq, rootItem: root,
        importFiles(paths) { if (opts.refuse) return false; for (const p of paths) kids.push(makeItem(path.basename(p), opts.range || 'seconds')); return true; },
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

// ── 1.27.0: one clip per phrase, so each caption can be edited on its own ──
const J = (o) => JSON.stringify(JSON.stringify(o));
function placeCut(pp, spans, extra) {
  const prep = pp.call('amh_overlayPrepare(' + J(Object.assign({ path: tmp, rangeStart: 10 + spans[0][0], rangeEnd: 10 + spans[spans.length - 1][1],
    replacePrefix: 'amhstyle_talk__' }, extra || {})) + ')');
  if (!prep.ok) return { prep };
  const r = pp.call('amh_overlaySpans(' + J({ itemName: prep.itemName, track: prep.track, base: 10, spans, check: true }) + ')');
  return { prep, r };
}
const SP = [[0.25, 1.4], [1.4, 2.6], [4, 5.5]];
for (const range of ['seconds', 'ticks']) {
  test('one clip per phrase, each exactly its phrase (Premiere reads in / out as ' + range + ')', () => {
    const pp = makePremiere([[[0, 60]], []], { range });
    const { prep, r } = placeCut(pp, SP);
    assert.ok(prep.ok && r.ok, JSON.stringify([prep, r]));
    assert.strictEqual(r.placed, 3);
    assert.strictEqual(prep.track, 2);
    const got = pp.vt[1].list.map((c) => [c.start.seconds, Math.round(c.end.seconds * 100) / 100]);
    assert.deepStrictEqual(got, [[10.25, 11.4], [11.4, 12.6], [14, 15.5]]);
    const item = pp.ctx.app.project.rootItem.children[0].children[0];
    assert.strictEqual(item._in, null, 'the in / out points are cleared afterwards');
  });
}
test('Premiere ignores in / out points: nothing is left on the timeline, the panel is told to place one layer', () => {
  const pp = makePremiere([[[0, 60]], []], { range: 'ignore' });
  const { r } = placeCut(pp, SP);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.range, true);
  assert.strictEqual(pp.vt[1].list.length, 0);
});
test('an edit: only our clips in that range are replaced, on the same track; the rest stays', () => {
  const nm = 'amhstyle_talk__bold_1.mov';
  const pp = makePremiere([[[0, 60]], [[10.25, 11.4, nm], [11.4, 12.6, nm], [14, 15.5, nm], [30, 31, nm]], [[0, 60, 'title.mov']]]);
  const prep = pp.call('amh_overlayPrepare(' + J({ path: tmp, rangeStart: 13.9, rangeEnd: 15.6, replacePrefix: 'amhstyle_talk__', preferTrack: 2 }) + ')');
  assert.ok(prep.ok, JSON.stringify(prep));
  assert.strictEqual(prep.replaced, 1, 'only the edited phrase');
  assert.strictEqual(prep.track, 2, 'back where it was, under the title on V3');
  const r = pp.call('amh_overlaySpans(' + J({ itemName: prep.itemName, track: prep.track, base: 13.75, spans: [[0.25, 1.9]] }) + ')');
  assert.ok(r.ok && r.placed === 1);
  assert.deepStrictEqual(pp.vt[1].list.map((c) => c.start.seconds).sort((a, b) => a - b), [10.25, 11.4, 14, 30]);
});
test('a caption deleted in the panel: its clip is taken off, nothing else', () => {
  const nm = 'amhstyle_talk__bold_1.mov';
  const pp = makePremiere([[[0, 60]], [[10.25, 11.4, nm], [14, 15.5, nm], [14.2, 15, 'title.mov']]]);
  const r = pp.call('amh_removeStyledRange(' + J({ replacePrefix: 'amhstyle_talk__', rangeStart: 13.9, rangeEnd: 16.1 }) + ')');
  assert.strictEqual(r.removed, 1);
  assert.deepStrictEqual(pp.vt[1].list.map((c) => c.projectItem.name), [nm, 'title.mov']);
});
test('the selected caption clip is found (ours only)', () => {
  const nm = 'amhstyle_talk__bold_1.mov';
  let pp = makePremiere([[[0, 60]], [[10.25, 11.4, nm]]], { selection: (vt) => [vt[0].list[0], vt[1].list[0]] });
  let r = pp.call('amh_selectedStyled()');
  assert.deepStrictEqual([r.name, r.start, r.end], [nm, 10.25, 11.4]);
  pp = makePremiere([[[0, 60]], [[10.25, 11.4, nm]]], { selection: (vt) => [vt[0].list[0]] });
  assert.strictEqual(pp.call('amh_selectedStyled()').none, true);
});

console.log('\nALL PASS  (' + passed + ' tests)');
