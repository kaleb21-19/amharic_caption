#!/usr/bin/env node
/*
 * test_host_workarea.js — Work Area / Whole Edit clip reading in Premiere
 * (amharic_getSequenceInfo in panel/jsx/host.jsx).
 *
 * A customer got "no clips" (err_no_clips). Two causes are covered here:
 *   - the edit is made of NESTED sequences: a nested sequence has no media
 *     file, so every clip was skipped. Now its own clips are read, at the
 *     right place on the outer timeline.
 *   - the Work Area bar is not over the clips: the result now says where the
 *     clips are, so the panel can tell the editor what to do.
 *
 * Run:  node tools/test/test_host_workarea.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');

function coll(arr, countName) {
  return new Proxy(arr, {
    get(target, prop) { return prop === countName ? target.length : target[prop]; },
  });
}
const T = (s) => ({ seconds: s });
let nextNode = 1;
function media(name, file) {
  return { name, nodeId: String(nextNode++), getMediaPath: () => file || '', isSequence: () => false };
}
// A clip: placed at [start, end) on its timeline, showing source [inPoint, inPoint + (end - start)).
function clip(item, start, end, inPoint, extra) {
  const src = inPoint || 0;
  return Object.assign({ projectItem: item, start: T(start), end: T(end), duration: T(end - start),
                         inPoint: T(src), outPoint: T(src + (end - start)) }, extra || {});
}
function sequence(name, videoClips, audioClips) {
  const item = { name, nodeId: String(nextNode++), getMediaPath: () => '', isSequence: () => true };
  const tr = (clips) => coll([{ clips: coll(clips, 'numItems') }], 'numTracks');
  return { name, projectItem: item, videoTracks: tr(videoClips), audioTracks: tr(audioClips || []),
           workAreaBarStart: T(0), workAreaBarEnd: T(1e6) };
}
function load(active, all) {
  const ctx = { app: { project: { activeSequence: active, sequences: coll(all, 'numSequences') } }, JSON };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  return (all) => JSON.parse(vm.runInContext('amharic_getSequenceInfo(' + (all ? 'true' : 'false') + ')', ctx));
}
const rows = (r) => r.clips.map((c) => [c.sourcePath, c.timelineStart, c.sourceIn, c.duration]);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('plain clips: work area cuts them, whole edit takes all (unchanged)', () => {
  const a = media('a.mp4', 'C:/v/a.mp4'), b = media('b.mp4', 'C:/v/b.mp4');
  const seq = sequence('Main', [clip(a, 0, 15), clip(b, 15, 40, 5)], [clip(a, 0, 15), clip(b, 15, 40, 5)]);
  seq.workAreaBarStart = T(10); seq.workAreaBarEnd = T(20);
  const get = load(seq, [seq]);
  assert.deepStrictEqual(rows(get(false)), [['C:/v/a.mp4', 10, 10, 5], ['C:/v/b.mp4', 15, 5, 5]]);
  assert.deepStrictEqual(rows(get(true)), [['C:/v/a.mp4', 0, 0, 15], ['C:/v/b.mp4', 15, 5, 25]]);
  assert.strictEqual(get(false).outside, undefined);
  // The sequence's own name travels with the result: the panel links a client's
  // word list to the project by it (never to the run's temporary .srt).
  assert.strictEqual(get(false).sequence, 'Main', 'the sequence name comes back');
});

test('a nested sequence is opened: its clips land at the right outer time', () => {
  const a = media('a.mp4', 'C:/v/a.mp4'), b = media('b.mp4', 'C:/v/b.mp4');
  // Nest: a at 0-30, b at 30-60 (b starts 2 s into its file).
  const nest = sequence('Nested 01', [clip(a, 0, 30), clip(b, 30, 60, 2)], [clip(a, 0, 30), clip(b, 30, 60, 2)]);
  // Outer: the nest placed at 100 s, trimmed to show nest time 20..50.
  const outer = sequence('Main', [clip(nest.projectItem, 100, 130, 20)], [clip(nest.projectItem, 100, 130, 20)]);
  const get = load(outer, [outer, nest]);
  const whole = get(true);
  assert.deepStrictEqual(rows(whole), [['C:/v/a.mp4', 100, 20, 10], ['C:/v/b.mp4', 110, 2, 20]]);
  assert.strictEqual(whole.noMedia, 0);
  // Work area over part of it.
  outer.workAreaBarStart = T(105); outer.workAreaBarEnd = T(115);
  assert.deepStrictEqual(rows(get(false)), [['C:/v/a.mp4', 105, 25, 5], ['C:/v/b.mp4', 110, 2, 5]]);
});

test('a nest inside a nest is opened too', () => {
  const a = media('a.wav', 'C:/v/a.wav');
  const inner = sequence('Inner', [], [clip(a, 0, 20)]);
  const mid = sequence('Mid', [], [clip(inner.projectItem, 5, 25)]);
  const outer = sequence('Main', [], [clip(mid.projectItem, 50, 70)]);
  const get = load(outer, [outer, mid, inner]);
  assert.deepStrictEqual(rows(get(true)), [['C:/v/a.wav', 55, 0, 15]]);
});

test('a sped-up nest is reported, not placed at the wrong time', () => {
  const a = media('a.mp4', 'C:/v/a.mp4');
  const nest = sequence('Fast', [], [clip(a, 0, 60)]);
  const fast = clip(nest.projectItem, 0, 30, 0, { outPoint: T(60) });   // 200 %
  const outer = sequence('Main', [], [fast]);
  const r = load(outer, [outer, nest])(true);
  assert.strictEqual(r.clips.length, 0);
  assert.strictEqual(r.unsupported.length, 1);
  assert.match(r.unsupported[0].reason, /speed/);
});

test('work area bar away from the clips: says where the clips are', () => {
  const a = media('a.mp4', 'C:/v/a.mp4');
  const seq = sequence('Main', [clip(a, 60, 300)], [clip(a, 60, 300)]);
  seq.workAreaBarStart = T(0); seq.workAreaBarEnd = T(20);
  const r = load(seq, [seq])(false);
  assert.strictEqual(r.clips.length, 0);
  assert.deepStrictEqual(r.outside, { count: 1, first: 60, last: 300 });
});

test('titles / graphics without a file are counted as "no media"', () => {
  const title = media('Graphic', '');
  const seq = sequence('Main', [clip(title, 0, 10)], []);
  const r = load(seq, [seq])(true);
  assert.strictEqual(r.clips.length, 0);
  assert.strictEqual(r.noMedia, 1);
  assert.strictEqual(r.outside, undefined);
});

console.log('\nALL PASS  (' + passed + ' tests)');
