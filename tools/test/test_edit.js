#!/usr/bin/env node
/*
 * test_edit.js — Amharic Captions Studio editor (1.20.0): the edit itself
 * (app/studio_edit_core.js): the magnetic main track (split, trim, delete,
 * move, cut a range), captions that follow the edit and whose fixes go back
 * to the source, and the one-pass export graph.
 *
 * Run:  node tools/test/test_edit.js
 */
'use strict';
const assert = require('assert');
const E = require('../../app/studio_edit_core.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }
let n = 0;
const id = () => 'c' + (++n);

test('the main track: clips one after another, the second of the file under any edit time', () => {
  const clips = [{ id: 'a', m: 'v', in: 10, out: 14 }, { id: 'b', m: 'v', in: 2, out: 5 }];
  assert.deepStrictEqual(E.layout(clips).map((c) => [c.s, c.e]), [[0, 4], [4, 7]]);
  assert.strictEqual(E.total(clips), 7);
  assert.deepStrictEqual(E.locate(clips, 5).src, 3);
  assert.strictEqual(E.locate(clips, 99).i, 1, 'past the end: the last clip');
  assert.deepStrictEqual(E.sourceToEdit(clips, 'v', 12), [2]);
});

test('split, trim, delete, move — and cut a range out', () => {
  let c = [{ id: 'a', m: 'v', in: 0, out: 10 }];
  c = E.splitAt(c, 4, id());
  assert.deepStrictEqual(c.map((x) => [x.in, x.out]), [[0, 4], [4, 10]]);
  assert.strictEqual(E.splitAt(c, 4, id()), c, 'at a clip edge: nothing');
  c = E.trimClip(c, c[1].id, 'in', 6, 10);
  assert.deepStrictEqual(c.map((x) => [x.in, x.out]), [[0, 4], [6, 10]]);
  assert.strictEqual(E.trimClip(c, c[0].id, 'out', 99, 10)[0].out, 10, 'never past the end of the file');
  assert.strictEqual(E.trimClip(c, c[0].id, 'out', -5, 10)[0].out, 0.1, 'never shorter than 0.1 s');
  c = E.moveClip(c, c[1].id, 0);
  assert.deepStrictEqual(c.map((x) => x.in), [6, 0]);
  assert.strictEqual(E.dropIndex(c, c[0].id, 0.5), 0);
  c = E.removeClip(c, c[0].id);
  assert.deepStrictEqual(c.map((x) => [x.in, x.out]), [[0, 4]]);
  const r = E.cutRange([{ id: 'a', m: 'v', in: 0, out: 10 }], 3, 5, id);
  assert.deepStrictEqual(r.map((x) => [x.in, x.out]), [[0, 3], [5, 10]]);
  assert.strictEqual(E.total(r), 8);
});

const S0 = { v: [
  { text: 'ሰላም ናችሁ', start: 1, end: 2, wt: [[1, 1.4], [1.5, 2]] },
  { text: 'ዛሬ ስለ *ቡና*', start: 3, end: 4.5, doubt: ['ቡና'] },
  { text: 'ታሪክ እናወራለን', start: 6, end: 7 },
] };

test('captions follow the edit: times of the edit, a split caption keeps only its own words', () => {
  const clips = [{ id: 'x', m: 'v', in: 2.9, out: 6.5 }, { id: 'y', m: 'v', in: 0.5, out: 1.45 }];
  const D = E.deriveCaptions(clips, S0);
  assert.deepStrictEqual(D.map((d) => [d.text, d.start, d.end]),
    [['ዛሬ ስለ *ቡና*', 0.1, 1.6], ['ታሪክ', 3.1, 3.464], ['ሰላም', 4.1, 4.5]]);   // a cut caption: its own words' times
  assert.deepStrictEqual(D[0].doubt, ['ቡና'], 'the doubtful mark travels');
  assert.deepStrictEqual(D[2].wt, [[4.1, 4.5]], 'exact word times follow');
  assert.ok(D[1]._part && D[1]._m === 'v');
});

test('nothing changed: the source stays the same (derive -> sync back)', () => {
  const clips = [{ id: 'a', m: 'v', in: 0, out: 10 }];
  const back = E.syncBack(clips, S0, E.deriveCaptions(clips, S0));
  assert.deepStrictEqual(back.v.map((q) => [q.text, q.start, q.end]), S0.v.map((q) => [q.text, q.start, q.end]));
  assert.deepStrictEqual(back.v[0].wt, S0.v[0].wt);
  assert.ok(!('_m' in back.v[0]) && !('_id' in back.v[0]), 'no edit bookkeeping in the source');
});

test('a word fixed in the edit is fixed in the source — and survives deleting / bringing back the clip', () => {
  let clips = [{ id: 'a', m: 'v', in: 0, out: 10 }];
  const D = E.deriveCaptions(clips, S0);
  D[1].text = 'ዛሬ ስለ *ቡና* ታሪክ';           // the editor fixed it
  const S1 = E.syncBack(clips, S0, D);
  assert.strictEqual(S1.v[1].text, 'ዛሬ ስለ *ቡና* ታሪክ');
  clips = E.splitAt(clips, 2.5, id());
  clips = E.removeClip(clips, clips[1].id);    // the part with the fix is gone from the edit…
  const S2 = E.syncBack(clips, S1, E.deriveCaptions(clips, S1));
  assert.strictEqual(S2.v.find((q) => q.start === 3).text, 'ዛሬ ስለ *ቡና* ታሪክ', '…but not from the source');
  clips = E.trimClip(clips, clips[0].id, 'out', 10, 10);   // brought back by trimming
  assert.ok(E.deriveCaptions(clips, S2).some((d) => d.text === 'ዛሬ ስለ *ቡና* ታሪክ'));
});

test('captions deleted, added or regrouped in the edit land in the source; what the edit does not show stays', () => {
  const clips = [{ id: 'a', m: 'v', in: 2.5, out: 5 }];
  const D = E.deriveCaptions(clips, S0);           // only 'ዛሬ ስለ ቡና'
  const S1 = E.syncBack(clips, S0, D.concat([{ text: 'አዲስ', start: 2, end: 2.4 }]));
  assert.deepStrictEqual(S1.v.map((q) => q.text), ['ሰላም ናችሁ', 'ዛሬ ስለ *ቡና*', 'አዲስ', 'ታሪክ እናወራለን']);
  assert.deepStrictEqual([S1.v[2].start, S1.v[2].end], [4.5, 4.9], 'added at the file second it was shown');
  const S2 = E.syncBack(clips, S0, []);            // the shown caption deleted
  assert.deepStrictEqual(S2.v.map((q) => q.text), ['ሰላም ናችሁ', 'ታሪክ እናወራለን']);
});

test('export: the whole edit is one ffmpeg graph (fill the canvas, the clip\'s own size/position, sound joined softly)', () => {
  const media = { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true }, p: { idx: 1, w: 1000, h: 1000, video: true, audio: false } };
  const g = E.editGraph([{ id: 'a', m: 'v', in: 1, out: 3 }, { id: 'b', m: 'p', in: 0, out: 2, scale: 1.2, x: 0.1 }], media, '9:16', 30);
  assert.deepStrictEqual([g.w, g.h, g.duration], [1080, 1920, 4]);
  assert.ok(g.graph.includes('[0:v]trim=start=1:end=3,setpts=PTS-STARTPTS,fps=30,scale=3414:1920'), g.graph.slice(0, 200));
  assert.ok(g.graph.includes('[b0][s0]overlay=-1167:0'), 'centred');
  assert.ok(g.graph.includes('scale=2304:2304') && g.graph.includes('overlay=-504:-192'), 'scale 120 %, moved right 10 %');
  assert.ok(g.graph.includes('anullsrc=r=48000:cl=stereo,atrim=duration=2[a1]'), 'a picture without sound: silence');
  assert.ok(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/.test(g.graph));
  assert.deepStrictEqual(E.canvasSize('4:5'), { w: 1080, h: 1350 });
});

test('overlay track: free in time; move, trim (start edge moves where the file starts), what is on screen at t', () => {
  let o = [{ id: 'o', m: 'b', in: 2, out: 6, start: 3 }];
  assert.strictEqual(E.ovEnd(o[0]), 7);
  assert.deepStrictEqual(E.ovAt(o, 5).map((x) => x.id), ['o']);
  assert.deepStrictEqual(E.ovAt(o, 7), []);
  o = E.ovMove(o, 'o', -4);
  assert.strictEqual(o[0].start, 0, 'never before the start');
  o = E.ovTrim([{ id: 'o', m: 'b', in: 2, out: 6, start: 3 }], 'o', 'in', 4, 30);
  assert.deepStrictEqual([o[0].start, o[0].in, o[0].out], [4, 3, 6], 'the start edge: later start, later in the file');
  o = E.ovTrim([{ id: 'o', m: 'b', in: 2, out: 6, start: 3 }], 'o', 'in', 0, 30);
  assert.deepStrictEqual([o[0].start, o[0].in], [1, 0], 'not before the file starts');
  o = E.ovTrim([{ id: 'o', m: 'b', in: 2, out: 6, start: 3 }], 'o', 'out', 99, 10);
  assert.strictEqual(o[0].out, 10, 'not past the file');
  o = E.ovTrim([{ id: 'p', m: 'l', in: 0, out: 5, start: 0 }], 'p', 'out', 20);
  assert.strictEqual(o[0].out, 20, 'a photo can show as long as you like');
});

test('export with overlays: drawn above the edit at their time, photos whole, B-roll silent unless raised', () => {
  const media = { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true }, b: { idx: 1, w: 1080, h: 1920, video: true, audio: true },
    l: { idx: 2, w: 400, h: 400, video: true, image: true } };
  const ovl = [{ id: 'o1', m: 'b', in: 2, out: 6, start: 3 }, { id: 'o2', m: 'l', in: 0, out: 12, start: 0, scale: 0.2, opacity: 0.85 }];
  const g = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 12 }], media, '16:9', 30, ovl);
  assert.ok(g.graph.includes('concat=n=1:v=1:a=1[vm][am]'));
  assert.ok(g.graph.includes("[1:v]trim=start=2:end=6,setpts=PTS-STARTPTS+3/TB"), 'B-roll from its own second, at its time');
  assert.ok(g.graph.includes("overlay=0:-1167:enable='between(t,3,7)':eof_action=pass[vo0]"), g.graph);
  assert.ok(g.graph.includes('[2:v]trim=duration=12,setpts=PTS-STARTPTS+0/TB') && g.graph.includes('colorchannelmixer=aa=0.85'), 'the logo: whole length, see-through');
  assert.ok(g.graph.includes('scale=216:216'), 'a photo fits whole (contain) × its size');
  assert.ok(g.graph.includes('[am]anull[a]'), 'B-roll silent');
  const loud = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 12 }], media, '16:9', 30, [Object.assign({}, ovl[0], { volume: 0.5 })]);
  assert.ok(loud.graph.includes('adelay=3000|3000') && loud.graph.includes('amix=inputs=2:duration=first:normalize=0[a]'), 'raised: mixed in at its time');
  assert.ok(!E.editGraph([{ id: 'a', m: 'v', in: 0, out: 12 }], media, '16:9', 30, [{ id: 'z', m: 'b', in: 0, out: 2, start: 30 }]).graph.includes('[vm]'), 'past the end: ignored');
});

console.log('ALL PASS  (' + passed + ' tests)');
