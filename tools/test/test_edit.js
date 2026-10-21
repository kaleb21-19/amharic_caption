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
  // 1.34: move a range (a sentence dragged in the Script view)
  const one = [{ id: 'a', m: 'v', in: 0, out: 10 }];
  let mv = E.moveRange(one, 6, 8, 2, id);
  assert.deepStrictEqual(mv.map((x) => [x.in, x.out]), [[0, 2], [6, 8], [2, 6], [8, 10]], 'later sentence moved earlier');
  assert.strictEqual(E.total(mv), 10, 'nothing lost');
  mv = E.moveRange(one, 1, 3, 10, id);
  assert.deepStrictEqual(mv.map((x) => [x.in, x.out]), [[0, 1], [3, 10], [1, 3]], 'to the very end');
  mv = E.moveRange(one, 1, 3, 0, id);
  assert.deepStrictEqual(mv.map((x) => [x.in, x.out]), [[1, 3], [0, 1], [3, 10]], 'to the very start');
  assert.strictEqual(E.moveRange(one, 2, 6, 4, id), one, 'into itself: nothing');
  const two = [{ id: 'a', m: 'v', in: 0, out: 4 }, { id: 'b', m: 'w', in: 10, out: 14, speed: 2 }];
  mv = E.moveRange(two, 3, 5, 0, id);           // across two clips, one at 2x
  assert.deepStrictEqual(mv.map((x) => [x.m, x.in, x.out]), [['v', 3, 4], ['w', 10, 12], ['v', 0, 3], ['w', 12, 14]]);
  assert.strictEqual(E.total(mv), E.total(two));
  assert.ok(new Set(mv.map((x) => x.id)).size === mv.length, 'every piece has its own id');
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

test('text track: titles, lower thirds, boxes as libass lines — our fonts, colours, times, animations', () => {
  const items = [
    { text: 'ቡና፦ የኢትዮጵያ ስጦታ', preset: 'title', start: 0.3, in: 0, out: 3, font: 'menbere' },
    { text: 'ዶ/ር መሰረት', sub: 'የቡና ተመራማሪ', preset: 'lower', start: 3.5, in: 0, out: 4 },
    { text: 'ዋጋው {5,000} ብር\nብቻ', preset: 'box', start: 9, in: 0, out: 9, color: '#FFD60A', y: -0.3, anim: 'none' },
    { text: '   ', preset: 'plain', start: 1, in: 0, out: 2 },
  ];
  const a = E.textAss(items, 1920, 1080, 12);
  assert.ok(a.includes('PlayResX: 1920') && a.includes('PlayResY: 1080'));
  assert.ok(a.includes('Dialogue: 0,0:00:00.30,0:00:03.30,T,,0,0,0,,{\\an5\\fnMenbere\\fs92\\c&H00FFFFFF&\\bord5\\shad2\\fad(120,180)\\pos(960,540)'), 'the title: Menbere, big, pops in, centred');
  assert.ok(a.includes('\\fnNoto Sans Ethiopic\\fs54') && a.includes('\\move('), 'the lower third slides in');
  assert.ok(/\\an7\\bord0\\shad0\\c&H0071CC2E&.*\\p1\}m 0 0 l 6 0 6 \d+ 0 \d+\{\\p0\}/.test(a), 'its accent bar is drawn from the top-left');
  assert.ok(a.includes(',B,,0,0,0,,{\\an1\\fnNoto Sans Ethiopic\\fs33\\c&H00CFD6C9&\\b0'), 'its second line: smaller, softer');
  assert.ok(a.includes('0:00:09.00,0:00:12.00,B,'), 'a text past the end stops with the video');
  assert.ok(a.includes('\\c&H000AD6FF&\\pos(960,216)}ዋጋው 5,000 ብር\\Nብቻ'), 'yellow, moved up, braces removed, two lines');
  assert.ok(!a.includes('0:00:01.00,0:00:03.00'), 'an empty text is not drawn');
  assert.deepStrictEqual(E.textAnchor({ preset: 'lower' }, 1080, 1920), { an: 1, x: 65, y: 1382 }, 'a lower third sits higher on a vertical video');
  const g = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 12 }], { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true } }, '16:9', 30, [], { ass: 't.ass' });
  assert.ok(g.graph.endsWith('concat=n=1:v=1:a=1[vx][a];[vx]subtitles=t.ass:fontsdir=fonts,format=yuv420p[v]'), 'drawn over everything in the same pass');
});

test('sound: music with fades, ducked under the voice by a sidechain, clean voice, loudness', () => {
  const media = { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true }, s: { idx: 1, audio: true } };
  const clips = [{ id: 'a', m: 'v', in: 0, out: 12 }];
  const mus = [{ id: 'u', m: 's', in: 5, out: 65, start: 2, volume: 0.4, fadeIn: 1, fadeOut: 3, duck: 0.5 }];
  const g = E.editGraph(clips, media, '16:9', 30, [], { mus, snd: { clean: true, loud: 'web' } }).graph;
  assert.ok(g.includes('concat=n=1:v=1:a=1[v][av]'), 'the voice goes on to the sound chain');
  assert.ok(g.includes('[av]highpass=f=80,afftdn=nr=12:nf=-40[vcl]'), 'clean voice');
  assert.ok(g.includes('[vcl]asplit=2[vmain][vk0]'), 'the voice also drives the ducking');
  assert.ok(g.includes('[1:a]atrim=start=5:end=15,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=0.4,afade=t=in:d=1,afade=t=out:st=7:d=3,adelay=2000|2000,apad[mu0]'), 'music: cut to the edit, fades, at its time');
  assert.ok(g.includes('[mu0][vk0]sidechaincompress=threshold=0.01:ratio=20:attack=20:release=800:mix=0.5[md0]'), 'ducked by the voice');
  assert.ok(g.endsWith('[vmain][md0]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]'), 'mixed, as long as the edit, YouTube loudness');
  const nod = E.editGraph(clips, media, '16:9', 30, [], { mus: [Object.assign({}, mus[0], { duck: 0 })] }).graph;
  assert.ok(!nod.includes('sidechaincompress') && nod.endsWith('[av][md0]amix=inputs=2:duration=first:normalize=0[a]'), 'no ducking: just mixed');
  assert.ok(E.editGraph(clips, media, '16:9', 30, [], { snd: { loud: 'tv' } }).graph.endsWith('[av]loudnorm=I=-23:TP=-1.5:LRA=11,aresample=48000[a]'), 'TV loudness alone');
  assert.ok(E.editGraph(clips, media, '16:9', 30, [], { mus: [Object.assign({}, mus[0], { start: 20 })] }).graph.endsWith('[av]anull[a]'), 'music past the end: ignored');
  // the preview hears the same: fades and ducking while a caption is on
  const sp = [{ start: 6, end: 8 }];
  assert.strictEqual(E.musicGain(mus[0], 2.5, 12, sp), 0.2, 'half way into the fade in');
  assert.strictEqual(E.musicGain(mus[0], 5, 12, sp), 0.4);
  assert.ok(Math.abs(E.musicGain(mus[0], 7, 12, sp) - 0.4 * (1 - 0.375)) < 1e-9, 'ducked while speaking');
  assert.ok(Math.abs(E.musicGain(mus[0], 10.5, 12, sp) - 0.2) < 1e-9, 'fading out at the end of the edit');
  assert.strictEqual(E.musicGain(mus[0], 1, 12, sp), 0, 'before it starts');
});

test('speed: a clip lasts (out-in)/speed, captions keep their words, every change goes back to the file', () => {
  const S = { v: [{ start: 2, end: 4, text: 'ሰላም ለሁሉም', wt: [[2, 3], [3, 4]] }, { start: 6, end: 8, text: 'እንኳን ደህና' }] };
  const clips = [{ id: 'a', m: 'v', in: 0, out: 10, speed: 2 }];
  assert.strictEqual(E.total(clips), 5);
  assert.deepStrictEqual(E.locate(clips, 1.5).src, 3, 'edit 1.5 s = file 3 s at 2x');
  assert.deepStrictEqual(E.sourceToEdit(clips, 'v', 6), [3]);
  const D = E.deriveCaptions(clips, S);
  assert.deepStrictEqual([D[0].start, D[0].end, D[0].wt], [1, 2, [[1, 1.5], [1.5, 2]]], 'times halve, word times too');
  D[1] = Object.assign({}, D[1], { text: 'እንኳን ደህና መጡ' });
  const back = E.syncBack(clips, S, D);
  assert.deepStrictEqual([back.v[1].start, back.v[1].end, back.v[1].text], [6, 8, 'እንኳን ደህና መጡ'], 'a fix lands at the file time');
  assert.deepStrictEqual(E.syncBack(clips, S, E.deriveCaptions(clips, S)), S, 'nothing changed: the same source');
  const sp = E.splitAt(clips, 2.5, 'b');
  assert.deepStrictEqual(sp.map((c) => [c.in, c.out, c.speed]), [[0, 5, 2], [5, 10, 2]], 'split at edit 2.5 = file 5');
  assert.deepStrictEqual(E.atempo(4), ['atempo=2', 'atempo=2']);
  assert.deepStrictEqual(E.atempo(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepStrictEqual(E.atempo(1), []);
  const g = E.editGraph(clips, { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true, dur: 10 } }, '16:9', 30, []).graph;
  assert.ok(g.includes('setpts=(PTS-STARTPTS)/2,fps=30') && g.includes(',atempo=2,') && g.includes(':d=5[b0]'), 'picture and voice at 2x, pitch kept');
});

test('transitions: centred on the cut, from the media past it (or the edge frame held) — the video keeps its length', () => {
  const media = { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true, dur: 30 } };
  const clips = [{ id: 'a', m: 'v', in: 0, out: 6 }, { id: 'b', m: 'v', in: 10, out: 16, tr: { type: 'fade', d: 1 } },
    { id: 'c', m: 'v', in: 0, out: 5, tr: { type: 'fadeblack', d: 0.8 } }, { id: 'd', m: 'v', in: 20, out: 21, tr: { type: 'wipeleft', d: 5 } }];
  assert.deepStrictEqual(clips.map((c, i) => E.trDur(clips, i)), [0, 1, 0.8, 1], 'never longer than the clips around it');
  const g = E.editGraph(clips, media, '16:9', 30, []).graph;
  assert.ok(g.includes('[0:v]trim=start=0:end=6.5,'), 'A plays half the transition past its end');
  assert.ok(g.includes('[0:v]trim=start=9.5:end=16.4,'), 'B starts half before its start');
  assert.ok(g.includes('[0:v]trim=start=0:end=5.5,setpts=PTS-STARTPTS,fps=30,tpad=start_mode=clone:start_duration=0.4,'), 'a file start: the first frame is held');
  assert.ok(g.includes('adelay=400:all=1'), 'and silence under it');
  assert.ok(g.includes('[v0][v1]xfade=transition=fade:duration=1:offset=5.5[jv1]') && g.includes('[a0][a1]acrossfade=d=1:c1=tri:c2=tri[ja1]'));
  assert.ok(g.includes('xfade=transition=fadeblack:duration=0.8:offset=11.6[jv2]'), 'offsets add up (cut at 12 s)');
  assert.ok(g.includes('xfade=transition=wipeleft:duration=1:offset=16.5[v]'), 'the last one ends the video (cut at 17 s)');
  const mixed = E.editGraph([clips[0], Object.assign({}, clips[1], { tr: null }), clips[2]], media, '16:9', 30, []).graph;
  assert.ok(mixed.includes('[v0][a0][v1][a1]concat=n=2:v=1:a=1[jc1][ja1];[jc1]settb=1/30[jv1]') && mixed.includes('[jv1][v2]xfade='), 'a plain cut then a transition: same time base for xfade');
  const plain = E.editGraph([clips[0], Object.assign({}, clips[1], { tr: null })], media, '16:9', 30, []).graph;
  assert.ok(plain.includes('concat=n=2:v=1:a=1[v][a]') && !plain.includes('xfade'), 'no transitions: the same graph as before');
});

test('colour: one matrix for the export and the preview; looks; nothing added when neutral', () => {
  assert.strictEqual(E.colorFilter(null), '');
  assert.strictEqual(E.colorFilter(E.LOOKS.none), '');
  const bw = E.colorMatrix(E.LOOKS.bw);
  assert.ok(bw.m.slice(0, 3).every((v, i) => v === bw.m[3 + i] && v === bw.m[6 + i]), 'black and white: every channel the same');
  const warm = E.colorMatrix({ temp: 1 });
  assert.ok(warm.m[0] > 1 && warm.m[8] < 1 && warm.o === 0, 'warm: more red, less blue');
  assert.strictEqual(E.colorMatrix({ contrast: 1.2 }).o, -0.1, 'contrast around the middle');
  assert.strictEqual(E.colorMatrix({ bright: 0.4 }).o, 0.1);
  const f = E.colorFilter({ sat: 0, bright: 0.2 });
  assert.ok(f.startsWith(',colorchannelmixer=rr=0.213:rg=0.715:rb=0.072:') && f.includes("lutrgb=r='clip(val+13,0,255)'"), f);
});

test('export choices: presets, 720p, encoders (graphics card or x264), captions drawn in the same pass, time left', () => {
  assert.deepStrictEqual(E.canvasSize('9:16', 720), { w: 720, h: 1280 });
  assert.deepStrictEqual(E.canvasSize('4:5', 720), { w: 720, h: 900 });
  assert.deepStrictEqual(E.canvasSize('16:9'), { w: 1920, h: 1080 });
  assert.strictEqual(E.presetFor('9:16'), 'shorts');
  assert.strictEqual(E.presetFor('3:2'), 'youtube');
  const x = E.encoderArgs('libx264', 'high', 1080).join(' ');
  assert.ok(x.startsWith('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k'), x);
  assert.ok(E.encoderArgs('h264_nvenc', 'small', 720).join(' ').includes('-cq 27 -b:v 0 -maxrate 2500k'), 'a light file for Telegram');
  assert.ok(E.encoderArgs('h264_videotoolbox', 'high', 1080).join(' ').includes('-b:v 12M'));
  assert.ok(E.encoderArgs('h264_amf', 'master', 1080).join(' ').includes('-qp_i 16 -qp_p 18') && E.encoderArgs('h264_amf', 'master', 1080).includes('320k'));
  const g = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 12 }], { v: { idx: 0, w: 1920, h: 1080, video: true, audio: true } }, '9:16', 30, [], { ass: ['t.ass', 'c.ass'], res: 720 }).graph;
  assert.ok(g.includes('s=720x1280') && g.endsWith('[vx]subtitles=t.ass:fontsdir=fonts,subtitles=c.ass:fontsdir=fonts,format=yuv420p[v]'), 'text, then captions on top, one pass');
  assert.strictEqual(E.eta(0.01, 5), null, 'no guess at the very start');
  assert.strictEqual(E.eta(0.25, 30), 90);
});

test('fonts (1.28.0): 12 Amharic fonts, each the same size on screen, and the preview sized exactly like the export', () => {
  assert.strictEqual(Object.keys(E.TFONTS).length, 12);
  const metrics = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'fonts', 'metrics.json'), 'utf8'));
  E.setFontInfo(metrics);
  assert.deepStrictEqual(E.fontInfo('sans'), { scale: 1, css: 1000 / 1362 }, 'Noto Sans: unchanged, a browser px is 0.734 libass sizes');
  assert.strictEqual(E.fontInfo('menbere').scale, 1, 'the first four fonts keep their size');
  assert.ok(E.fontInfo('yebse').scale < 0.8 && E.fontInfo('agbalumo').scale > 1.2, 'big letters drawn smaller, small letters bigger');
  const t = { preset: 'title', font: 'yebse' };
  assert.strictEqual(E.textSize(t, 1920), Math.round(1920 * 0.085 * E.fontInfo('yebse').scale));
  assert.ok(E.textAss([Object.assign({ text: 'ሰላም', start: 0, in: 0, out: 2 }, t)], 1080, 1920, 5).includes('\\fs' + E.textSize(t, 1920) + '\\'), 'the export uses that size');
  assert.deepStrictEqual(E.fontInfo('nope'), E.fontInfo('sans'), 'an unknown font: the default');
  E.setFontInfo(null);
  assert.deepStrictEqual(E.fontInfo('yebse'), { scale: 1, css: 1 }, 'no measurements: plain sizes');
});

// 🔍 Zoom (1.60): the export's ffmpeg expressions = the preview's curves
test('zoom: seven styles, the export expressions draw exactly what the preview shows', () => {
  // ffmpeg's expression language (the part zoomExprs uses) as JavaScript
  const run = (expr, W, H, frame) => {
    const js = expr.replace(/;/g, ',').replace(/\bPI\b/g, 'Math.PI').replace(/\bin\b/g, 'IN').replace(/\bif\(/g, 'IF(');
    const f = new Function('W', 'H', 'IN', 'IF', 'lt', 'gte', 'clip', 'pow', 'sin', 'cos', 'max', 'st', 'ld',
      'const R = []; return (' + js.replace(/\bst\(/g, 'st(R,').replace(/\bld\(/g, 'ld(R,') + ');');
    return f(W, H, frame, (a, b, c) => (a ? b : c), (a, b) => (a < b ? 1 : 0), (a, b) => (a >= b ? 1 : 0),
      (x, a, b) => Math.max(a, Math.min(b, x)), Math.pow, Math.sin, Math.cos, Math.max,
      (R, i, v) => { R[i] = v; return v; }, (R, i) => R[i]);
  };
  assert.deepStrictEqual(Object.keys(E.ZOOM_STYLES), ['push', 'punch', 'creep', 'bounce', 'pulse', 'reveal', 'impact']);
  const W = 1280, H = 720, fps = 30;
  Object.keys(E.ZOOM_STYLES).forEach((style, i) => {
    ['slow', 'normal', 'fast'].forEach((speed) => {
      const zm = [{ id: 'z', start: 0.5, in: 0, out: 1.8, style, amt: 1.35, speed, fx: 0.3 + i * 0.05, fy: 0.6 }];
      const ex = E.zoomExprs(zm, fps);
      for (let n = 0; n < 90; n++) {
        const r = E.zoomRect(zm, n / fps, W, H);
        const x0 = run(ex.x0, W, H, n), y0 = run(ex.y0, W, H, n), x3 = run(ex.x3, W, H, n), y3 = run(ex.y3, W, H, n);
        assert.ok(Math.abs(x0 - r.x) < 0.01 && Math.abs(y0 - r.y) < 0.01 && Math.abs(x3 - (r.x + r.w)) < 0.01 && Math.abs(y3 - (r.y + r.h)) < 0.01,
          style + '/' + speed + ' frame ' + n + ': ' + [x0, y0, x3, y3].join(',') + ' vs ' + JSON.stringify(r));
      }
    });
  });
  // before and after: the whole picture; at the top: the full amount
  const zm = [{ id: 'z', start: 1, in: 0, out: 2, style: 'push', amt: 1.25 }];
  assert.strictEqual(E.zoomRect(zm, 0.5, W, H).z, 1);
  assert.ok(Math.abs(E.zoomRect(zm, 2, W, H).z - 1.25) < 1e-9);
  assert.strictEqual(E.zoomRect(zm, 3.01, W, H).z, 1);
  assert.ok(E.zoomEnv({ start: 0, in: 0, out: 2, style: 'bounce', amt: 1.2 }, 0.4) > 1, 'a bounce overshoots');
  assert.strictEqual(E.zoomEnv({ start: 0, in: 0, out: 2, style: 'reveal', amt: 1.2 }, 0), 1, 'a reveal starts close');
  // the window never leaves the picture, even with the focus at the very edge
  const edge = E.zoomRect([{ start: 0, in: 0, out: 2, style: 'push', amt: 1.5, fx: 0, fy: 1 }], 1, W, H);
  assert.deepStrictEqual([edge.x, Math.round(edge.y + edge.h)], [0, H]);
  // the export: one perspective filter on the main track, before overlays and text
  const g = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 5 }], { v: { idx: 0, video: true, audio: true, w: 1920, h: 1080, dur: 5 } }, '16:9', 30, [],
    { zm: [{ id: 'z', start: 1, in: 0, out: 2, style: 'punch', amt: 1.3 }] }).graph;
  assert.ok(/concat=n=1:v=1:a=1\[vzm\]\[a\];\[vzm\]perspective=x0='st\(0,max\(1,1\+/.test(g) && /interpolation=cubic:eval=frame\[v\]/.test(g), g.slice(0, 300));
  assert.ok(!/perspective/.test(E.editGraph([{ id: 'a', m: 'v', in: 0, out: 5 }], { v: { idx: 0, video: true, audio: true, w: 1920, h: 1080, dur: 5 } }, '16:9', 30, [], {}).graph), 'no zoom: no filter');
});

// 🎞 B-roll (1.61): layouts, slides and motion — the export = the preview
test('B-roll looks: layouts, slides in / out, motion; old overlays unchanged', () => {
  const W = 1920, H = 1080, m = { w: 800, h: 1000, image: true };
  const evalX = (expr, t) => Function('t', 'clip', 'pow', 'return (' + expr + ');')(t, (x, a, b) => Math.max(a, Math.min(b, x)), Math.pow);
  ['full', 'whole', 'blur', 'pip', 'top', 'bottom'].forEach((layout) => {
    E.OV_ANIMS.forEach((ain) => E.OV_ANIMS.forEach((aout) => {
      const o = { id: 'x', m: 'p', start: 2, in: 0, out: 3, layout, ain, aout, ad: 0.4, corner: 'bl' };
      const box = E.ovBox(o, m, W, H);
      const pos = E.ovPos(o, box, W, H);
      for (let t = 2; t < 5; t += 0.05) {
        const a = E.ovAnim(o, t, box, W, H);
        const x = evalX(pos.x, t), y = evalX(pos.y, t);
        assert.ok(Math.abs(x - (box.x - box.b + a.dx)) < 0.01 && Math.abs(y - (box.y - box.b + a.dy)) < 0.01, layout + ' ' + ain + '/' + aout + ' t=' + t);
      }
    }));
  });
  // where things sit
  assert.deepStrictEqual(E.ovBox({ layout: 'full' }, m, W, H), { x: 0, y: 0, w: W, h: H, fit: 'cover', b: 0 });
  assert.deepStrictEqual(E.ovBox({ layout: 'bottom' }, m, W, H), { x: 0, y: 540, w: W, h: 540, fit: 'cover', b: 0 });
  const pip = E.ovBox({ layout: 'pip', corner: 'tr', size: 0.38 }, m, W, H);
  assert.ok(pip.x + pip.w + pip.b <= W && pip.y - pip.b >= 0 && pip.b > 0 && pip.w % 2 === 0 && pip.h % 2 === 0, JSON.stringify(pip));
  // fade: 0 at the start, full in the middle, 0 at the very end
  const f = { start: 1, in: 0, out: 2, layout: 'full', ain: 'fade', aout: 'fade', ad: 0.4 };
  const bx = E.ovBox(f, m, W, H);
  assert.strictEqual(E.ovAnim(f, 1, bx, W, H).a, 0);
  assert.strictEqual(E.ovAnim(f, 2, bx, W, H).a, 1);
  assert.ok(E.ovAnim(f, 2.999, bx, W, H).a < 0.01);
  // motion: never under 1 (ffmpeg refuses 0.9999999), zooms in / out / pans
  ['in', 'out', 'pan'].forEach((mot) => { for (let t = 1; t <= 3; t += 0.01) assert.ok(E.ovAnim(Object.assign({}, f, { mot }), t, bx, W, H).z >= 1); });
  assert.ok(/max\(1,1\.15-0\.15\*/.test(E.ovChain(Object.assign({}, f, { mot: 'out' }), m, W, H, 30, 0).steps.join(',')));
  // an old overlay (no look) exports exactly as before
  const media = { v: { idx: 0, video: true, audio: true, w: 1920, h: 1080, dur: 5 }, p: { idx: 1, image: true, w: 800, h: 1000 } };
  const g = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 5 }], media, '16:9', 30, [{ id: 'o', m: 'p', start: 1, in: 0, out: 2, volume: 0 }], {}).graph;
  assert.ok(/\[1:v\]trim=duration=2,setpts=PTS-STARTPTS\+1\/TB,fps=30,scale=\d+:\d+,setsar=1,format=yuva420p\[o0\]/.test(g), g);
  const g2 = E.editGraph([{ id: 'a', m: 'v', in: 0, out: 5 }], media, '16:9', 30, [Object.assign({ id: 'o', m: 'p', volume: 0 }, f, { layout: 'blur', mot: 'in' })], {}).graph;
  assert.ok(/split=2\[ob0\]\[of0\]/.test(g2) && /boxblur/.test(g2) && /fade=t=in:st=1:d=0\.4:alpha=1/.test(g2) && /perspective=/.test(g2), g2);
});

// 🇪🇹 Templates (1.62): every template draws; the libass maths = the preview's
test('templates: all draw, animate like libass, follow their settings', () => {
  const ids = Object.keys(E.TEMPLATES);
  assert.ok(ids.length >= 15 && Object.keys(E.HOLIDAYS).length >= 7);
  ids.forEach((id) => {
    ['16:9', '9:16'].forEach((fmt) => {
      const { w: W, h: H } = E.canvasSize(fmt);
      const T = E.tplLayers({ tpl: id, start: 0, in: 0, out: 4 }, W, H);
      assert.ok(T.layers.length >= 1, id);
      T.layers.forEach((l) => assert.ok(isFinite(l.x) && isFinite(l.y) && l.off > l.on, id + ' ' + JSON.stringify(l).slice(0, 80)));
      const ass = E.textAss([{ id: 't', tpl: id, start: 1, in: 0, out: 4 }], W, H, 10);
      const lines = ass.split('\n').filter((x) => x.startsWith('Dialogue'));
      assert.strictEqual(lines.length, T.layers.length, id + ': one libass line per layer');
      assert.ok(lines.every((x) => !/NaN|undefined/.test(x)), id);
    });
  });
  // \t progress = ((τ - t0) / (t1 - t0)) ^ accel, like libass; the first value holds before
  const l = { an: [{ p: 'sc', t0: 1, t1: 2, from: 0, to: 100, accel: 0.5 }, { p: 'mv', t0: 0, t1: 1, from: [0, 50], to: [0, 0] }] };
  assert.strictEqual(E.tplState(l, 0.5).sc, 0);
  assert.ok(Math.abs(E.tplState(l, 1.25).sc - 50) < 1e-9, 'accel 0.5 at a quarter = half way');
  assert.deepStrictEqual(E.tplState(l, 0.5).mv, [0, 25], 'a move is linear');
  assert.strictEqual(E.tplState(l, 3).sc, 100);
  // settings: text, colours, size, position, speed, the end
  const a = E.tplLayers({ tpl: 'hook', start: 0, in: 0, out: 3, text: 'ሰላም', accent: '#123456', size: 1.5, fx: 0.2, fy: 0.7, speed: 'slow' }, 1920, 1080);
  assert.strictEqual(a.layers[0].color, '#123456');
  assert.strictEqual(a.layers[1].text, 'ሰላም');
  assert.ok(Math.abs(a.layers[0].x - 384) < 1e-6 && Math.abs(a.layers[0].y - 756) < 1e-6);
  assert.ok(Math.abs(a.layers[1].S - 86 * 1.5) < 1e-6, 'size');
  assert.ok(a.layers[0].an.some((x) => x.p === 'sc' && Math.abs(x.t1 - 0.18 * 1.4) < 1e-9), 'slow = 1.4x the time');
  assert.ok(/\\fad\(0,350\)/.test(E.textAss([{ id: 't', tpl: 'hook', start: 0, in: 0, out: 3 }], 1920, 1080, 10)), 'fades out at the end');
  assert.ok(!/\\fad\(/.test(E.textAss([{ id: 't', tpl: 'hook', start: 0, in: 0, out: 3, end: 'none' }], 1920, 1080, 10)), 'or cuts');
  // holidays: each its own greeting and colours; subscribe: pressed after 1.2 s
  assert.strictEqual(E.tplOf({ tpl: 'holiday', theme: 'timket' }).text, E.HOLIDAYS.timket.text);
  assert.strictEqual(E.tplOf({ tpl: 'holiday', theme: 'genna' }).accent, E.HOLIDAYS.genna.a);
  const sub = E.tplLayers({ tpl: 'subscribe', start: 0, in: 0, out: 3 }, 1920, 1080).layers;
  assert.ok(sub.some((x) => x.color === '#3A3A3A' && Math.abs(x.on - 1.3) < 1e-9) && sub.some((x) => x.color === '#FF0033' && Math.abs(x.off - 1.3) < 1e-9));
  // the editor's text measuring is used by the export too
  E.setMeasure(() => 500);
  assert.strictEqual(E.tplLayers({ tpl: 'hook', start: 0, in: 0, out: 3 }, 1920, 1080).layers[0].w, 500 + 60);
  E.setMeasure(null);
});

console.log('ALL PASS  (' + passed + ' tests)');
