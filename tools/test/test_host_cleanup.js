#!/usr/bin/env node
/*
 * test_host_cleanup.js — ✂ Clean-up cut (1.16.20): the ticked pauses /
 * repeats / hesitations leave the timeline on EVERY track (picture, voice,
 * music, titles stay in sync), always on a COPY of the sequence (the
 * original is never touched), frame-exact, and never on the wrong sequence
 * or a locked track.
 *
 * Run:  node tools/test/test_host_cleanup.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => (p === n ? t.length : t[p]) });
const r3 = (x) => Math.round(x * 1000) / 1000;

// A fake Premiere: clips on tracks, QE razor, ripple delete (closes the gap on
// THAT track only, like Premiere), move, sequence clone/open.
function makePremiere(spec, opts) {
  opts = opts || {};
  let nextId = 1;
  function mkTrack(clips, locked) {
    const list = [];
    const track = { list, clips: coll(list, 'numItems'), isLocked: () => !!locked };
    const add = (s, e, name, media) => {
      const c = {
        name, start: { seconds: s }, end: { seconds: e },
        projectItem: { name, getMediaPath: () => media || '' },
        remove(ripple) {
          const i = list.indexOf(c);
          if (i < 0) return;
          list.splice(i, 1);
          if (ripple && !opts.liftOnly) {
            const len = c.end.seconds - c.start.seconds;
            list.forEach((o) => { if (o.start.seconds >= c.end.seconds - 1e-6) { o.start.seconds -= len; o.end.seconds -= len; } });
          }
        },
        move(t) { c.start.seconds += t.seconds; c.end.seconds += t.seconds; },
      };
      list.push(c);
      return c;
    };
    clips.forEach((c) => add(c[0], c[1], c[2], c[3]));
    track.razor = (t) => {
      const c = list.find((o) => o.start.seconds < t - 1e-6 && o.end.seconds > t + 1e-6);
      if (!c) return;
      const end = c.end.seconds;
      c.end.seconds = t;
      add(t, end, c.name, c.projectItem.getMediaPath());
      list.sort((x, y) => x.start.seconds - y.start.seconds);
    };
    track.snap = () => list.map((c) => [r3(c.start.seconds), r3(c.end.seconds), c.name]).sort((x, y) => x[0] - y[0]);
    return track;
  }
  function mkSeq(name, v, a, locked) {
    const vt = v.map((c, i) => mkTrack(c, locked && i === 0));
    const at = a.map((c) => mkTrack(c));
    return {
      name, sequenceID: String(nextId++), spec: { v, a },
      videoTracks: coll(vt, 'numTracks'), audioTracks: coll(at, 'numTracks'), vt, at,
      frameSizeHorizontal: 1920, frameSizeVertical: 1080,
      getSettings: () => ({ videoFrameRate: { seconds: 1 / (opts.fps || 25) }, videoDisplayFormat: 101 }),
      clone() {
        const cp = (tr) => tr.list.map((c) => [c.start.seconds, c.end.seconds, c.name, c.projectItem.getMediaPath()]);
        if (opts.noClone) return false;
        seqs.push(mkSeq(name + ' Copy', vt.map(cp), at.map(cp)));
        return true;
      },
    };
  }
  const seqs = [mkSeq('Interview', spec.v, spec.a, spec.locked)];
  const project = {
    activeSequence: seqs[0],
    sequences: coll(seqs, 'numSequences'),
    openSequence(id) { project.activeSequence = seqs.find((s) => s.sequenceID === String(id)) || project.activeSequence; return true; },
  };
  class Time {
    constructor() { this.seconds = 0; }
    getFormatted() { return String(this.seconds); }
  }
  const ctx = {
    JSON, Time,
    app: { project, enableQE() {} },
    qe: { project: { getActiveSequence: () => {
      const s = project.activeSequence;
      return { getVideoTrackAt: (i) => ({ razor: (tc) => s.vt[i].razor(Number(tc)) }),
               getAudioTrackAt: (i) => ({ razor: (tc) => s.at[i].razor(Number(tc)) }) };
    } } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  const cut = (cuts, media) => JSON.parse(vm.runInContext('amh_cleanupCut(' + JSON.stringify(JSON.stringify({ cuts, media: media || ['C:/v/interview.mp4'] })) + ')', ctx));
  return { project, seqs, cut };
}
const VIDEO = 'C:/v/interview.mp4';
const base = () => ({
  v: [[[0, 60, 'interview.mp4', VIDEO]], [[40, 45, 'title']]],      // V2: a title at 40-45 s
  a: [[[0, 60, 'interview.mp4', VIDEO]], [[0, 60, 'music.mp3', 'C:/v/music.mp3']]],
});

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('cuts on a COPY: the original sequence is untouched, the copy is opened and named "- clean"', () => {
  const pp = makePremiere(base());
  const before = JSON.stringify(pp.seqs[0].vt.map((t) => t.snap()).concat(pp.seqs[0].at.map((t) => t.snap())));
  const r = pp.cut([[10, 12], [30, 31]]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(pp.seqs.length, 2);
  assert.strictEqual(pp.project.activeSequence, pp.seqs[1]);
  assert.strictEqual(r.sequence, 'Interview - clean');
  assert.strictEqual(r.original, 'Interview');
  assert.strictEqual(JSON.stringify(pp.seqs[0].vt.map((t) => t.snap()).concat(pp.seqs[0].at.map((t) => t.snap()))), before, 'original unchanged');
  assert.strictEqual(r.removedSeconds, 3);
});

test('every track loses the same time: picture, voice and music stay in sync, no gaps', () => {
  const pp = makePremiere(base());
  pp.cut([[10, 12], [30, 31]]);
  const s = pp.project.activeSequence;
  const cover = (t) => t.snap().filter((c) => c[2] !== 'title');
  for (const t of [s.vt[0], s.at[0], s.at[1]]) {
    const c = cover(t);
    assert.strictEqual(c[0][0], 0);
    for (let i = 1; i < c.length; i++) assert.strictEqual(c[i][0], c[i - 1][1], 'no gap: ' + JSON.stringify(c));
    assert.strictEqual(c[c.length - 1][1], 57, 'ends 3 s earlier');
  }
});

test('a title further on (nothing of its track inside the cut) moves with the cut', () => {
  const pp = makePremiere(base());
  pp.cut([[10, 12], [30, 31]]);
  assert.deepStrictEqual(pp.project.activeSequence.vt[1].snap(), [[37, 42, 'title']]);
});

test('Premiere versions where a delete leaves the gap: everything after is still moved into place', () => {
  const pp = makePremiere(base(), { liftOnly: true });
  pp.cut([[10, 12]]);
  const s = pp.project.activeSequence;
  assert.deepStrictEqual(s.vt[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
  assert.deepStrictEqual(s.at[1].snap(), [[0, 10, 'music.mp3'], [10, 58, 'music.mp3']]);
  assert.deepStrictEqual(s.vt[1].snap(), [[38, 43, 'title']]);
});

test('frame-exact: cut edges land on frames (25 fps), a cut under 2 frames is skipped', () => {
  const pp = makePremiere(base());
  const r = pp.cut([[1.01, 2.02], [5, 5.05]]);
  assert.strictEqual(r.cuts, 1);
  assert.strictEqual(r.removedSeconds, 0.96);    // 1.04 .. 2.00
  assert.deepStrictEqual(pp.project.activeSequence.vt[0].snap()[0], [0, 1.04, 'interview.mp4']);
});

test('the wrong sequence is open: nothing copied, nothing cut, a clear message', () => {
  const pp = makePremiere(base());
  const r = pp.cut([[10, 12]], ['C:/v/other.mp4']);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not the one these captions were made from/);
  assert.strictEqual(pp.seqs.length, 1);
});

test('a locked track: nothing copied, says to unlock', () => {
  const sp = base(); sp.locked = true;
  const pp = makePremiere(sp);
  const r = pp.cut([[10, 12]]);
  assert.match(r.error, /locked/);
  assert.strictEqual(pp.seqs.length, 1);
});

test('the copy cannot be made: nothing is cut on the original', () => {
  const pp = makePremiere(base(), { noClone: true });
  const r = pp.cut([[10, 12]]);
  assert.match(r.error, /could not copy/);
  assert.deepStrictEqual(pp.seqs[0].vt[0].snap(), [[0, 60, 'interview.mp4']]);
});

console.log('ALL PASS  (' + passed + ' tests)');
