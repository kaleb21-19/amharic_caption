#!/usr/bin/env node
/*
 * test_host_search.js — 🔎 Footage search (1.75), the Premiere side: the
 * project's media for the panel to listen to (bins walked, sequences and our
 * own caption layers left out, each file once), and a found moment put on the
 * open sequence at the playhead on a free track (never over the edit).
 *
 * Run:  node tools/test/test_host_search.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => (p === n ? t.length : t[p]) });

function makePremiere(opts) {
  const placed = [];
  const item = (name, media) => {
    const it = { name, getMediaPath: () => media || '', inP: null, outP: null,
      setInPoint(s) { it.inP = s; }, setOutPoint(s) { it.outP = s; }, clearInPoint() { it.inP = null; }, clearOutPoint() { it.outP = null; } };
    return it;
  };
  const bin = (name, kids) => ({ name, children: coll(kids, 'numItems') });
  const seqItem = { name: 'Main', getMediaPath: () => '', isSequence: () => true };
  const root = bin('root', [
    item('interview.mp4', 'C:/v/interview.mp4'),
    bin('B-roll', [item('market.mov', 'C:/v/market.mov'), item('interview copy', 'C:\\v\\INTERVIEW.mp4')]),
    item('amhstyle_123.mov', 'C:/tmp/amhstyle_123.mov'),
    seqItem,
    item('music.mp3', 'C:/v/music.mp3'),
  ]);
  const track = (clips, kind, i) => ({
    clips: coll(clips.map((c) => ({ start: { seconds: c[0] }, end: { seconds: c[1] } })), 'numItems'),
    overwriteClip(it, at) { placed.push({ track: kind + (i + 1), name: it.name, in: it.inP, out: it.outP, at }); },
  });
  const v = (opts.v || [[[0, 60]], [[5, 8]], []]).map((c, i) => track(c, 'V', i));
  const a = (opts.a || [[[0, 60]], [], []]).map((c, i) => track(c, 'A', i));
  const seq = { name: 'Main', projectItem: seqItem, videoTracks: coll(v, 'numTracks'), audioTracks: coll(a, 'numTracks'),
    getPlayerPosition: () => ({ seconds: opts.playhead == null ? 10 : opts.playhead }) };
  const imported = [];
  const project = {
    rootItem: root, activeSequence: seq, sequences: coll([seq], 'numSequences'),
    importFiles(files) { files.forEach((f) => { imported.push(f); root.children.push ? 0 : 0; }); root.children = coll([].concat(Array.from({ length: root.children.length }, (_, k) => root.children[k]), files.map((f) => item(path.basename(f), f))), 'numItems'); },
  };
  const ctx = { JSON, app: { project } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  const call = (fn, args) => JSON.parse(vm.runInContext(fn + '(' + (args ? JSON.stringify(JSON.stringify(args)) : '') + ')', ctx));
  return { call, placed, imported };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('the project media: every file once, bins included, no sequences, no caption layers', () => {
  const pp = makePremiere({});
  const r = pp.call('amh_projectMedia');
  assert.ok(r.ok);
  assert.deepStrictEqual(r.media.map((m) => m.name), ['interview.mp4', 'market.mov', 'music.mp3'], JSON.stringify(r.media));
});

test('a found moment goes at the playhead on the first free track above V1, its in/out set then cleared', () => {
  const pp = makePremiere({});
  const r = pp.call('amh_insertFound', { path: 'C:/v/market.mov', start: 3.4, end: 7.9, video: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.track, 'V2', 'V2 is free at 10 s (its clip is at 5-8 s)');
  assert.deepStrictEqual(pp.placed, [{ track: 'V2', name: 'market.mov', in: 3.4, out: 7.9, at: 10 }]);
  // V2 busy at the playhead: V3
  const pp2 = makePremiere({ playhead: 6 });
  assert.strictEqual(pp2.call('amh_insertFound', { path: 'C:/v/market.mov', start: 0, end: 2, video: true }).track, 'V3');
});

test('a file not in the project is imported first; no free track = a clear message, nothing placed', () => {
  const pp = makePremiere({});
  const r = pp.call('amh_insertFound', { path: 'D:/new/clip.mp4', start: 1, end: 3, video: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(pp.imported, ['D:/new/clip.mp4']);
  const full = makePremiere({ v: [[[0, 60]], [[0, 60]]], a: [[[0, 60]], [[0, 60]]] });
  const r2 = full.call('amh_insertFound', { path: 'C:/v/market.mov', start: 0, end: 2, video: true });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /No free track/);
  assert.deepStrictEqual(full.placed, []);
});

test('a sound-only file goes on a free audio track', () => {
  const pp = makePremiere({});
  const r = pp.call('amh_insertFound', { path: 'C:/v/music.mp3', start: 0, end: 4, video: false });
  assert.strictEqual(r.track, 'A2');
});

console.log('ALL PASS  (' + passed + ' tests)');
