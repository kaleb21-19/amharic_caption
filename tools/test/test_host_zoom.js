#!/usr/bin/env node
/*
 * test_host_zoom.js — 🔍 Auto zoom (1.16.23): Scale keyframes on the footage
 * at the moments that matter, relative to the clip's own scale, at the
 * clip's own (source) time; on a copy (or on our own "- clean" copy); never
 * over the editor's own Scale animation, never on a title or our styled
 * caption layer above the footage.
 *
 * Run:  node tools/test/test_host_zoom.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => (p === n ? t.length : t[p]) });
const VIDEO = 'C:/v/interview.mp4';

function scaleProp(v, animated) {
  const keys = {};
  return {
    displayName: 'Scale', keys, v, tv: !!animated,
    getValue() { return this.v; }, isTimeVarying() { return this.tv; }, setTimeVarying(b) { this.tv = b; },
    addKey(t) { keys[Math.round(t * 1000) / 1000] = this.v; },
    setValueAtKey(t, val) { keys[Math.round(t * 1000) / 1000] = val; },
  };
}
// clip spec: [start, end, name, media, { inPoint, scale, animated }]
function mkClip(c) {
  const o = c[4] || {};
  const scale = scaleProp(o.scale || 100, o.animated);
  return {
    name: c[2], start: { seconds: c[0] }, end: { seconds: c[1] }, inPoint: { seconds: o.inPoint || 0 },
    projectItem: { name: c[2], getMediaPath: () => c[3] || '' }, scale, spec: c,
    components: coll([{ matchName: 'AE.ADBE Opacity', displayName: 'Opacity', properties: coll([], 'numItems') },
      { matchName: 'AE.ADBE Motion', displayName: 'Motion', properties: coll([{ displayName: 'Position' }, scale], 'numItems') }], 'numItems'),
  };
}
function makePremiere(v, name) {
  let nextId = 1;
  const mkSeq = (nm, tracks) => {
    const vt = tracks.map((list) => { const l = list.map(mkClip); return { list: l, clips: coll(l, 'numItems'), isLocked: () => false }; });
    const s = {
      name: nm, sequenceID: String(nextId++), vt,
      videoTracks: coll(vt, 'numTracks'), audioTracks: coll([], 'numTracks'),
      frameSizeHorizontal: 1920, frameSizeVertical: 1080,
      getSettings: () => ({ videoFrameRate: { seconds: 1 / 25 } }),
      clone() { seqs.push(mkSeq(nm + ' Copy', vt.map((t) => t.list.map((c) => c.spec)))); return true; },
    };
    return s;
  };
  const seqs = [mkSeq(name || 'Interview', v)];
  const project = {
    activeSequence: seqs[0], sequences: coll(seqs, 'numSequences'),
    openSequence(id) { project.activeSequence = seqs.find((s) => s.sequenceID === String(id)); return true; },
  };
  const ctx = { JSON, app: { project, enableQE() {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  const zoom = (args) => JSON.parse(vm.runInContext('amh_autoZoom(' + JSON.stringify(JSON.stringify(Object.assign({ media: [VIDEO] }, args))) + ')', ctx));
  return { project, seqs, zoom };
}
const footage = (o) => [[[0, 60, 'interview.mp4', VIDEO, o]], [[20, 25, 'title']]];
const keysOf = (pp) => pp.project.activeSequence.vt[0].list[0].scale.keys;

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('smooth: a slow push-in across the caption, back at its end; on a copy named "- zoom"', () => {
  const pp = makePremiere(footage());
  const r = pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }], style: 'smooth', strength: 115 });
  assert.ok(r.ok && r.zoomed === 1 && r.copied, JSON.stringify(r));
  assert.strictEqual(r.sequence, 'Interview - zoom');
  assert.deepStrictEqual(keysOf(pp), { 4: 100, 6: 115, 6.04: 100 });
  assert.deepStrictEqual(pp.seqs[0].vt[0].list[0].scale.keys, {}, 'the original is untouched');
});

test('punch: jumps in at the word, out at the end of the caption', () => {
  const pp = makePremiere(footage());
  pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }], style: 'punch', strength: 125 });
  assert.deepStrictEqual(keysOf(pp), { 4.46: 100, 4.5: 125, 6: 125, 6.04: 100 });
});

test('relative to the clip\'s own scale, at the clip\'s own (source) time', () => {
  const pp = makePremiere([[[10, 60, 'interview.mp4', VIDEO, { inPoint: 100, scale: 56 }]]]);
  pp.zoom({ moments: [{ start: 14, word: 14.5, end: 16 }], style: 'smooth', strength: 110 });
  assert.deepStrictEqual(keysOf(pp), { 104: 56, 106: 61.6, 106.04: 56 });
});

test('the editor\'s own Scale animation is never touched', () => {
  const pp = makePremiere(footage({ animated: true }));
  const r = pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }] });
  assert.deepStrictEqual([r.zoomed, r.animated], [0, 1]);
  assert.deepStrictEqual(keysOf(pp), {});
});

test('the footage, not the title above it; several moments on one clip', () => {
  const pp = makePremiere(footage());
  const r = pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }, { start: 21, word: 22, end: 24 }], style: 'smooth', strength: 115 });
  assert.strictEqual(r.zoomed, 2);
  assert.deepStrictEqual(keysOf(pp), { 4: 100, 6: 115, 6.04: 100, 21: 100, 24: 115, 24.04: 100 });
  assert.deepStrictEqual(pp.project.activeSequence.vt[1].list[0].scale.keys, {}, 'the title stays still');
});

test('on our own "- clean" copy: zoomed as it is, no new copy', () => {
  const pp = makePremiere(footage(), 'Interview - clean');
  const r = pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }] });
  assert.ok(r.ok && !r.copied);
  assert.strictEqual(pp.seqs.length, 1);
  assert.strictEqual(Object.keys(keysOf(pp)).length, 3);
});

test('keys stay inside the clip (a moment at a cut point)', () => {
  const pp = makePremiere([[[0, 5, 'interview.mp4', VIDEO], [5, 30, 'interview.mp4', VIDEO, { inPoint: 8 }]]]);
  pp.zoom({ moments: [{ start: 3, word: 4, end: 7 }], style: 'smooth' });
  const k = pp.project.activeSequence.vt[0].list[0].scale.keys;
  assert.ok(Object.keys(k).every((t) => Number(t) <= 5.0001), JSON.stringify(k));
});

test('wrong sequence open: nothing copied, a clear message', () => {
  const pp = makePremiere(footage());
  const r = pp.zoom({ moments: [{ start: 4, word: 4.5, end: 6 }], media: ['C:/v/other.mp4'] });
  assert.match(r.error, /not the one these captions were made from/);
  assert.strictEqual(pp.seqs.length, 1);
});

console.log('ALL PASS  (' + passed + ' tests)');
