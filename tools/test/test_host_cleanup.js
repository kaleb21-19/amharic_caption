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
// READS counts every clip/track Premiere is asked for: each one crosses the
// panel-Premiere bridge, which is what makes a long clean-up slow.
let READS = 0;
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => { if (typeof p === 'string' && /^\d+$/.test(p)) READS++; return p === n ? t.length : t[p]; } });
const r3 = (x) => Math.round(x * 1000) / 1000;

// A fake Premiere: clips on tracks, QE razor, ripple delete (closes the gap on
// THAT track only, like Premiere), move, sequence clone/open.
function makePremiere(spec, opts) {
  opts = opts || {};
  let nextId = 1;
  function mkTrack(clips, locked) {
    const list = [];
    const frozen = list;   // opts.domBlind: the script view never sees new pieces (an old handle)
    const track = { list, get clips() { return coll(opts.domBlind ? frozen.slice(0, frozen._n == null ? frozen.length : frozen._n) : list, 'numItems'); }, isLocked: () => !!locked };
    const add = (s, e, name, media) => {
      const c = {
        name, start: { seconds: s }, end: { seconds: e },
        projectItem: { name, getMediaPath: () => media || '' },
        remove(ripple, align, viaQe) {
          if (opts.domRemoveNoop && !viaQe) return;          // a Premiere that ignores remove()
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
    list._n = list.length;
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
      name, sequenceID: String(nextId++), spec: { v, a }, pos: 0,
      getPlayerPosition() { return { ticks: String(this.pos) }; },
      setPlayerPosition(t) { this.pos = Number(t); },
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
    // opts.mixedTimecode: a sequence shown in another rate's timecode (the
    // owner's 24 fps in 30 fps timecode) - Time.getFormatted gives the wrong place
    getFormatted() { return String(opts.mixedTimecode ? this.seconds * 0.8 : this.seconds); }
  }
  const ctx = {
    JSON, Time,
    app: { project, enableQE() {} },
    qe: { project: { getActiveSequence: () => {
      const s = project.activeSequence;
      // QE: razor, and the pieces as Premiere's own timeline sees them (ripple delete)
      const qt = (tr) => ({ razor: (tc) => tr.razor(Number(tc)),
        get numItems() { return tr.list.length; },
        getItemAt: (j) => { const c = tr.list.slice().sort((x, y) => x.start.seconds - y.start.seconds)[j];
          return c && { type: 'Clip', start: { secs: c.start.seconds }, end: { secs: c.end.seconds }, rippleDelete: () => c.remove(true, true, true) }; } });
      const ctiOff = opts.noCti ? undefined : { get timecode() { return String(s.pos / 254016000000); } };
      return { getVideoTrackAt: (i) => qt(s.vt[i]), getAudioTrackAt: (i) => qt(s.at[i]), CTI: ctiOff };
    } } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  const cut = (cuts, media) => JSON.parse(vm.runInContext('amh_cleanupCut(' + JSON.stringify(JSON.stringify({ cuts, media: media || ['C:/v/interview.mp4'] })) + ')', ctx));
  return { project, seqs, cut, ctx };
}
const VIDEO = 'C:/v/interview.mp4';
const base = () => ({
  v: [[[0, 60, 'interview.mp4', VIDEO]], [[40, 45, 'title']]],      // V2: a title at 40-45 s
  a: [[[0, 60, 'interview.mp4', VIDEO]], [[0, 60, 'music.mp3', 'C:/v/music.mp3']]],
});


// A long podcast: 20 minutes, cuts every few seconds, 4 tracks.
function longEdit(nCuts) {
  const L = 1200;
  const sp = { v: [[[0, L, 'interview.mp4', VIDEO]], [[600, 610, 'title']]],
               a: [[[0, L, 'interview.mp4', VIDEO]], [[0, L, 'music.mp3', 'C:/v/music.mp3']]] };
  const pp = makePremiere(sp);
  const step = (L - 20) / nCuts;
  const cuts = [];
  for (let i = 0; i < nCuts; i++) cuts.push([10 + i * step, 10 + i * step + 0.6]);
  return { pp, cuts };
}
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

test('captions made from a NESTED sequence: its video counts, the cut works (owner report 1.16.20)', () => {
  const pp = makePremiere({ v: [[[0, 60, 'Nested', '']]], a: [[[0, 60, 'Nested', '']]] });
  const inner = { name: 'Inner', sequenceID: 'in1', videoTracks: [], audioTracks: [] };
  const vclip = { start: { seconds: 0 }, end: { seconds: 60 }, projectItem: { getMediaPath: () => VIDEO } };
  inner.videoTracks = coll([{ clips: coll([vclip], 'numItems') }], 'numTracks');
  inner.audioTracks = coll([], 'numTracks');
  const item = pp.seqs[0].vt[0].list[0].projectItem;
  item.isSequence = () => true;
  inner.projectItem = item;
  pp.seqs.push(inner);
  const r = pp.cut([[10, 12]]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.removedSeconds, 2);
});

test('the same file with other letter case / slashes is the same file', () => {
  const pp = makePremiere(base());
  const r = pp.cut([[10, 12]], ['c:\\V\\Interview.MP4']);
  assert.ok(r.ok, JSON.stringify(r));
});

test('fast on long videos: 200 cuts ask Premiere for few clips (1.16.22: was ~8 million reads)', () => {
  const { pp, cuts } = longEdit(200);
  READS = 0;
  const r = pp.cut(cuts);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(READS < 30000, 'clip reads: ' + READS);
  // and still right: every track ends at the same, shorter length
  const s = pp.project.activeSequence;
  const ends = [s.vt[0], s.at[0], s.at[1]].map((t) => t.snap().slice(-1)[0][1]);
  assert.ok(ends.every((e) => Math.abs(e - (1200 - r.removedSeconds)) < 0.001), JSON.stringify(ends));
});

test('step by step (progress + Stop in the panel): prepare, then cuts in groups, last group first', () => {
  const { pp, cuts } = longEdit(12);
  const call = (fn, a) => JSON.parse(vm.runInContext(fn + '(' + JSON.stringify(JSON.stringify(a)) + ')', pp.ctx));
  const p = call('amh_cleanupPrepare', { cuts, media: [VIDEO] });
  assert.ok(p.ok && p.list.length === 12 && p.sequenceID, JSON.stringify(p));
  assert.strictEqual(pp.project.activeSequence.vt[0].snap().length, 1, 'prepare copies, cuts nothing');
  const a = call('amh_cleanupSome', { sequenceID: p.sequenceID, fps: p.fps, cuts: p.list.slice(8) });
  const b = call('amh_cleanupSome', { sequenceID: p.sequenceID, fps: p.fps, cuts: p.list.slice(4, 8) });
  assert.ok(a.ok && b.ok);
  // stopped here: the first 4 stay, the copy is still in sync
  const s = pp.project.activeSequence;
  const ends = [s.vt[0], s.at[0], s.at[1]].map((t) => r3(t.snap().slice(-1)[0][1]));
  assert.strictEqual(new Set(ends).size, 1, JSON.stringify(ends));
  assert.strictEqual(ends[0], r3(1200 - a.removedSeconds - b.removedSeconds));
  // the editor opened another sequence meanwhile: nothing is cut there
  pp.project.activeSequence = pp.seqs[0];
  const c = call('amh_cleanupSome', { sequenceID: p.sequenceID, fps: p.fps, cuts: p.list.slice(0, 4) });
  assert.match(c.error, /no longer the open sequence/);
  assert.deepStrictEqual(pp.seqs[0].vt[0].snap(), [[0, 1200, 'interview.mp4']]);
});

test('1.74 several clips: a cut on the transcribed clip cuts there; a cut on another clip is refused, nothing is cut', () => {
  const A = 'C:/v/a.mp4', B = 'C:/v/b.mp4', C = 'C:/v/c.mp4';
  const spec = () => ({ v: [[[0, 10, 'a.mp4', A], [10, 25, 'b.mp4', B], [25, 40, 'c.mp4', C]]],
                        a: [[[0, 10, 'a.mp4', A], [10, 25, 'b.mp4', B], [25, 40, 'c.mp4', C]]] });
  let pp = makePremiere(spec());
  let r = pp.cut([[14, 15]], [B]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(pp.project.activeSequence.vt[0].snap(), [[0, 10, 'a.mp4'], [10, 14, 'b.mp4'], [14, 24, 'b.mp4'], [24, 39, 'c.mp4']]);
  // the captions were made from b.mp4, but the cut would land on a.mp4
  pp = makePremiere(spec());
  r = pp.cut([[4, 5]], [B]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /0:04\.0-0:05\.0 would remove part of "a\.mp4", not the clip these captions were made from\. Nothing was cut/);
  assert.strictEqual(pp.seqs.length, 1, 'no copy made');
  assert.deepStrictEqual(pp.seqs[0].vt[0].snap(), [[0, 10, 'a.mp4'], [10, 25, 'b.mp4'], [25, 40, 'c.mp4']], 'nothing touched');
  // one of several cuts on the wrong clip: none is made
  pp = makePremiere(spec());
  r = pp.cut([[12, 13], [30, 31]], [B]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /"c\.mp4"/);
  // captions from all three (Whole edit): every clip is theirs
  pp = makePremiere(spec());
  r = pp.cut([[4, 5], [30, 31]], [A, B, C]);
  assert.ok(r.ok, JSON.stringify(r));
});

// ── 1.93 ✂ one click = cut, on the open sequence
const nowCut = (pp, a) => JSON.parse(vm.runInContext('amh_textCutNow(' + JSON.stringify(JSON.stringify(a)) + ')', pp.ctx));
test('one-click cut: the OPEN sequence loses the part on every track at once; an untouched copy is kept once', () => {
  const pp = makePremiere(base());
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.ok(r.ok, JSON.stringify(r));
  const s = pp.project.activeSequence;
  assert.strictEqual(s, pp.seqs[0], 'the editor stays in their own sequence');
  assert.deepStrictEqual(s.vt[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
  assert.deepStrictEqual(s.at[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']], 'the sound is cut too');
  assert.deepStrictEqual(s.at[1].snap().slice(-1)[0][1], 58, 'music moves with it');
  assert.deepStrictEqual(s.vt[1].snap(), [[38, 43, 'title']], 'a title later on moves with the cut');
  assert.strictEqual(r.kept, 'Interview - before text edit');
  const keep = pp.seqs.find((q) => q.name === 'Interview - before text edit');
  assert.ok(keep && keep.vt[0].snap().length === 1 && keep.vt[0].snap()[0][1] === 60, 'the copy is untouched');
  assert.strictEqual(r.removedSeconds, 2);
  const r2 = nowCut(pp, { cuts: [[20, 21]], media: [VIDEO] });
  assert.ok(r2.ok && !r2.kept, 'the copy is made once');
  assert.strictEqual(pp.seqs.length, 2);
  assert.strictEqual(s.vt[0].snap().slice(-1)[0][1], 57);
});
test('one-click cut: wrong sequence, a locked track, or under 2 frames: nothing cut, no copy', () => {
  let pp = makePremiere(base());
  let r = nowCut(pp, { cuts: [[10, 12]], media: ['C:/v/other.mp4'] });
  assert.match(r.error, /not the one these captions were made from/);
  assert.strictEqual(pp.seqs.length, 1);
  assert.strictEqual(pp.seqs[0].vt[0].snap().length, 1);
  pp = makePremiere(Object.assign(base(), { locked: true }));
  r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.match(r.error, /locked/);
  assert.strictEqual(pp.seqs.length, 1);
  pp = makePremiere(base());
  r = nowCut(pp, { cuts: [[10, 10.03]], media: [VIDEO] });
  assert.match(r.error, /Too short/);
});

test('1.93.1 Premiere ignores remove(): the piece still goes (its own ripple delete), the cut is real', () => {
  const pp = makePremiere(base(), { domRemoveNoop: true });
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.ok(r.ok, JSON.stringify(r));
  const s = pp.seqs[0];
  assert.deepStrictEqual(s.vt[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
  assert.deepStrictEqual(s.at[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
});
test('1.93.1 the script view does not see the razor pieces: Premiere own view finds and removes them', () => {
  const pp = makePremiere(base(), { domBlind: true });
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(pp.seqs[0].at[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
});
test('1.93.1 a piece that cannot be removed at all: says so (never "cut"), and nothing slides over it', () => {
  const pp = makePremiere(base(), { domRemoveNoop: true });
  pp.ctx.qe.project.getActiveSequence = () => ({ getVideoTrackAt: (i) => ({ razor: (tc) => pp.seqs[0].vt[i].razor(Number(tc)) }),
    getAudioTrackAt: (i) => ({ razor: (tc) => pp.seqs[0].at[i].razor(Number(tc)) }) });
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.match(r.error, /kept the piece between them/);
  assert.deepStrictEqual(pp.seqs[0].vt[0].snap(), [[0, 10, 'interview.mp4'], [10, 12, 'interview.mp4'], [12, 60, 'interview.mp4']]);
});

test('1.93.2 timecode shown in another rate (24 fps as 30 fps timecode): Premiere own timecode is used, the cut lands right', () => {
  const pp = makePremiere(base(), { mixedTimecode: true });
  pp.seqs[0].pos = 5 * 254016000000;
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(pp.seqs[0].vt[0].snap(), [[0, 10, 'interview.mp4'], [10, 58, 'interview.mp4']]);
  assert.strictEqual(pp.seqs[0].pos, 5 * 254016000000, 'the playhead is put back');
});
test('1.93.2 a Premiere without the QE playhead: the old timecode way still works', () => {
  const pp = makePremiere(base(), { noCti: true });
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.ok(r.ok, JSON.stringify(r));
});
// 1.94 templates: a fake importMGT — a template clip with two text lines and a colour
function withMgt(pp) {
  const s = pp.seqs[0];
  pp.ctx.File = function (f) { this.fsName = f; this.exists = true; };
  s.importMGT = (p, ticks, track) => {
    const t0 = Number(ticks) / 254016000000;
    const list = s.vt[track].list;
    const txt = (v) => JSON.stringify({ capPropTextRunCount: 2, fontEditValue: ['Inter-Regular', 'Inter-Bold'], fontSizeEditValue: [100, 120], fontTextRunLength: [5, 3], textEditValue: v });
    const vals = ['a0b2cdff-97d3-4720-ad53-9cd44a9705c0;07cd4fe6-c326-49cc-be58-defc2f07bd9f;', '#FFFFFF', txt('It rewards'), txt('strategy')];
    const props = vals.map((v, i) => ({ displayName: ['Group', 'Color', 'Text', 'Text'][i], getValue: () => vals[i], setValue: (x) => { vals[i] = x; } }));
    const c = { name: 'Template', start: { seconds: t0 }, end: { seconds: t0 + 5 }, projectItem: { name: 'Template', getMediaPath: () => '' },
      remove() { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); }, getMGTComponent: () => ({ properties: coll(props, 'numItems') }), vals };
    list.push(c);
    list.sort((x, y) => x.start.seconds - y.start.seconds);
    return c;
  };
  return s;
}
const mgtCall = (pp, fn, a) => JSON.parse(vm.runInContext(fn + '(' + JSON.stringify(JSON.stringify(a)) + ')', pp.ctx));

test('templates: each caption one graphic on a free track, its words over the lines, in the Amharic font, named to be found again', () => {
  const pp = makePremiere(base());
  const s = withMgt(pp);
  const items = [{ n: 1, path: 'C:/t/two.mogrt', start: 1, end: 3, parts: ['ሰላም ለሁላችሁ', 'እንኳን ደህና መጣችሁ'], font: 'NotoSansEthiopic-Bold' },
    { n: 2, path: 'C:/t/two.mogrt', start: 3, end: 5.5, parts: ['ዛሬ', ' '], font: 'NotoSansEthiopic-Bold' }];
  const r = mgtCall(pp, 'amh_mogrtPlace', { tag: 'amhmogrt_talk_', items, first: true, rangeStart: 1, rangeEnd: 5.5 });
  assert.ok(r.ok && r.placed === 2, JSON.stringify(r));
  assert.strictEqual(r.track, 1, 'V2 is free there (the title is at 40-45 s)');
  const clips = s.vt[1].list.filter((c) => /^amhmogrt_talk_/.test(c.name));
  assert.deepStrictEqual(clips.map((c) => [c.name, c.start.seconds, c.end.seconds]), [['amhmogrt_talk_1', 1, 3], ['amhmogrt_talk_2', 3, 5.5]]);
  const t1 = JSON.parse(clips[0].vals[2]), t2 = JSON.parse(clips[0].vals[3]);
  assert.deepStrictEqual([t1.textEditValue, t1.fontEditValue, t1.fontTextRunLength, t1.capPropTextRunCount, t1.fontSizeEditValue], ['ሰላም ለሁላችሁ', ['NotoSansEthiopic-Bold'], [9], 1, [100]]);
  assert.strictEqual(t2.textEditValue, 'እንኳን ደህና መጣችሁ');
  // placed again (an edit): the earlier ones in that range go, the new ones come
  const r2 = mgtCall(pp, 'amh_mogrtPlace', { tag: 'amhmogrt_talk_', items: items.slice(0, 1), first: true, rangeStart: 1, rangeEnd: 5.5 });
  assert.ok(r2.ok && r2.removed === 2 && r2.placed === 1, JSON.stringify(r2));
  assert.strictEqual(s.vt.reduce((n, t) => n + t.list.filter((c) => /^amhmogrt_/.test(c.name)).length, 0), 1);
});
test('templates: Apply to all copies the selected caption\'s look (colour, font, size) and keeps every caption\'s own words', () => {
  const pp = makePremiere(base());
  const s = withMgt(pp);
  const items = [1, 2, 3].map((n) => ({ n, path: 'C:/t/two.mogrt', start: n * 2, end: n * 2 + 2, parts: ['ቃል' + n, 'ሁለት' + n], font: 'NotoSansEthiopic-Bold' }));
  mgtCall(pp, 'amh_mogrtPlace', { tag: 'amhmogrt_talk_', items, first: true, rangeStart: 2, rangeEnd: 8 });
  const ours = s.vt[1].list.filter((c) => /^amhmogrt_/.test(c.name));
  // the editor changes caption 2 in Essential Graphics: yellow, Menbere, bigger
  ours[1].vals[1] = '#FFD400';
  const o = JSON.parse(ours[1].vals[2]); o.fontEditValue = ['Menbere-Bold']; o.fontSizeEditValue = [140]; ours[1].vals[2] = JSON.stringify(o);
  s.getSelection = () => [ours[1]];
  const sel = JSON.parse(vm.runInContext('amh_mogrtSelected()', pp.ctx));
  assert.deepStrictEqual([sel.ok, sel.tag], [true, 'amhmogrt_talk_']);
  const r = mgtCall(pp, 'amh_mogrtApplyLook', { tag: sel.tag });
  assert.ok(r.ok && r.changed === 2, JSON.stringify(r));
  for (const c of [ours[0], ours[2]]) {
    assert.strictEqual(c.vals[1], '#FFD400', 'the colour');
    const t = JSON.parse(c.vals[2]);
    assert.deepStrictEqual([t.fontEditValue, t.fontSizeEditValue], [['Menbere-Bold'], [140]], 'the font and size');
    assert.ok(/^ቃል[13]$/.test(t.textEditValue), 'its own words stay: ' + t.textEditValue);
    assert.deepStrictEqual(t.fontTextRunLength, [t.textEditValue.length]);
  }
  s.getSelection = () => [];
  assert.match(mgtCall(pp, 'amh_mogrtApplyLook', { tag: sel.tag }).error, /Select one of the template captions/);
});
test('templates: a Premiere-made template (mTextParam, like Premiere\u2019s own Captions and Subtitles) takes the words and the font', () => {
  const pp = makePremiere(base());
  const s = pp.seqs[0];
  pp.ctx.File = function (f) { this.fsName = f; this.exists = true; };
  const made = [];
  s.importMGT = (p, ticks, track) => {
    const t0 = Number(ticks) / 254016000000;
    let val = JSON.stringify({ mTextParam: { mAlignment: 2, mStyleSheet: { mFontName: { mParamValues: [[0, 'MyriadPro-Regular']] },
      mFontSize: { mParamValues: [[0, 100], [8, 120]] }, mFillColor: { mParamValues: [[0, 16777215]] }, mText: 'Captions and Subtitles for online' } }, mVersion: 1 });
    const c = { name: 'T', start: { seconds: t0 }, end: { seconds: t0 + 5 }, projectItem: { name: 'T', getMediaPath: () => '' }, remove() {},
      getMGTComponent: () => ({ properties: coll([{ displayName: 'Source Text', getValue: () => val, setValue: (x) => { val = x; } }], 'numItems') }), get val() { return val; } };
    s.vt[track].list.push(c);
    made.push(c);
    return c;
  };
  const r = mgtCall(pp, 'amh_mogrtPlace', { tag: 'amhmogrt_t_', items: [{ n: 1, path: 'C:/pr/Modern Web Caption.mogrt', start: 1, end: 3, parts: ['ሰላም ለሁላችሁ'], font: 'NotoSansEthiopic-Bold' }], first: true, rangeStart: 1, rangeEnd: 3 });
  assert.ok(r.ok && r.placed === 1 && !r.noText, JSON.stringify(r));
  const ss = JSON.parse(made[0].val).mTextParam.mStyleSheet;
  assert.deepStrictEqual([ss.mText, ss.mFontName.mParamValues, ss.mFontSize.mParamValues], ['ሰላም ለሁላችሁ', [[0, 'NotoSansEthiopic-Bold']], [[0, 100]]]);
});
test('templates: a Premiere without importMGT says so (nothing placed)', () => {
  const pp = makePremiere(base());
  const r = mgtCall(pp, 'amh_mogrtPlace', { tag: 'amhmogrt_x_', items: [], first: true, rangeStart: 0, rangeEnd: 1 });
  assert.match(r.error, /cannot place Motion Graphics templates/);
});

test('1.93.1 the razor lands somewhere else (nothing between the lines): says so with the times, never "cut"', () => {
  const pp = makePremiere(base());
  const off = (tr) => ({ razor: (tc) => tr.razor(Number(tc) + 30), get numItems() { return tr.list.length; }, getItemAt: () => null });
  pp.ctx.qe.project.getActiveSequence = () => ({ getVideoTrackAt: (i) => off(pp.seqs[0].vt[i]), getAudioTrackAt: (i) => off(pp.seqs[0].at[i]) });
  const r = nowCut(pp, { cuts: [[10, 12]], media: [VIDEO] });
  assert.match(r.error, /did not cut at 10\.00-12\.00 s = 10-12/);
});

console.log('ALL PASS  (' + passed + ' tests)');
