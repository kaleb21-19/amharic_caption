#!/usr/bin/env node
/*
 * test_capcut.js — styled, editable captions in a CapCut project (1.35.0,
 * app/capcut_core.js). The project here is made up: the same shape CapCut 9.x
 * writes, no real project's content.
 *
 * Run:  node tools/test/test_capcut.js
 */
'use strict';
const assert = require('assert');
const C = require('../../app/capcut_core.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

// a project: the video trimmed (file 10-40 s) and placed at 5 s, then again
// file 50-60 s at 2x after it; another clip and a text the editor made
function project() {
  return {
    id: 'P', canvas_config: { width: 1080, height: 1920 }, duration: 60e6,
    materials: {
      videos: [{ id: 'V1', path: 'C:/Users/me/Videos/talk.mp4' }, { id: 'V2', path: 'C:/other.mp4' }],
      texts: [{ id: 'T0', type: 'text', content: '{"text":"mine"}' }],
      material_animations: [{ id: 'A0', type: 'sticker_animation', animations: [] }],
    },
    tracks: [
      { id: 'tv', type: 'video', segments: [
        { material_id: 'V1', source_timerange: { start: 10e6, duration: 30e6 }, target_timerange: { start: 5e6, duration: 30e6 }, speed: 1 },
        { material_id: 'V1', source_timerange: { start: 50e6, duration: 10e6 }, target_timerange: { start: 35e6, duration: 5e6 }, speed: 2 },
        { material_id: 'V2', source_timerange: { start: 0, duration: 5e6 }, target_timerange: { start: 40e6, duration: 5e6 }, speed: 1 },
      ] },
      { id: 'tt', type: 'text', name: '', segments: [{ id: 'S0', material_id: 'T0', extra_material_refs: ['A0'] }] },
    ],
  };
}
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const look = C.lookFor('bounce', { size: 1, color: '#FF3B30', emph: 'auto' }, 'C:/Fonts/NotoSansEthiopic-Bold.ttf', true);

test('where the video is on CapCut\'s timeline: trimmed, moved, sped up; the same file however the path is written', () => {
  const pl = C.placements(project(), 'c:\\users\\me\\videos\\TALK.mp4');
  assert.deepStrictEqual(pl.map((p) => [p.src, p.at, p.speed]), [[[10, 40], 5, 1], [[50, 60], 35, 2]]);
  const a = C.placeCue(pl, 12, 14);
  assert.deepStrictEqual([a.start, a.end], [7, 9], 'file 12 s = timeline 7 s');
  const b = C.placeCue(pl, 52, 54);
  assert.deepStrictEqual([b.start, b.end], [36, 37], 'at 2x: half as long');
  assert.strictEqual(C.placeCue(pl, 2, 4), null, 'a part not in the project');
});

test('the text: ★ words and numbers in the highlight colour, ✂ words out', () => {
  const t = C.styledText('ዛሬ *ቡና* ~እ~ 5,000 ብር', look);
  assert.strictEqual(t.text, 'ዛሬ ቡና 5,000 ብር');
  assert.deepStrictEqual(t.ranges, [[3, 5], [6, 11], [12, 14]]);
  const c = JSON.parse(C.contentOf(t, look));
  assert.strictEqual(c.text, t.text);
  assert.deepStrictEqual(c.styles.map((s) => s.range), [[0, 3], [3, 5], [5, 6], [6, 11], [11, 12], [12, 14]], 'every letter has one style');
  assert.deepStrictEqual(c.styles[1].fill.content.solid.color, [1, 0.231, 0.188], 'highlight = the chosen colour');
  assert.deepStrictEqual(c.styles[0].fill.content.solid.color, [1, 1, 1]);
  assert.strictEqual(c.styles[0].font.path, 'C:/Fonts/NotoSansEthiopic-Bold.ttf');
  assert.ok(c.styles[0].strokes && c.styles[0].strokes.length === 1, 'a black outline');
  const off = C.styledText('ዛሬ 5,000', C.lookFor('bounce', { emph: 'off' }, '', true));
  assert.deepStrictEqual(off.ranges, [], '"My ★ only": numbers stay plain');
});

test('the look: size, height (dragged or the style\'s), box', () => {
  const big = C.lookFor('karaoke', { size: 1.5 }, '', true);
  assert.ok(big.fontSize > C.lookFor('karaoke', {}, '', true).fontSize);
  assert.ok(C.lookFor('karaoke', { y: 0.5 }, '', true).y > 0 && C.lookFor('karaoke', { y: 0.5 }, '', true).y < 0.1, 'bottom edge at the middle: centre just above it');
  assert.ok(C.lookFor('karaoke', {}, '', true).y < -0.4, 'the style\'s own place: low');
  const box = C.lookFor('karaoke', { box: true }, '', true);
  assert.strictEqual(box.stroke, '', 'a box, no outline');
});

test('a new track: one text per caption, timed on CapCut\'s timeline, word times; the rest of the project untouched', () => {
  const p = project();
  const before = JSON.stringify(p);
  const cues = [
    { start: 12, end: 14, text: 'ሰላም *ናችሁ*', wt: [[12, 12.8], [13, 14]] },
    { start: 2, end: 3, text: 'not in the project' },
    { start: 52, end: 54, text: 'በፍጥነት' },
    { start: 20, end: 21, text: '~ሁሉ ተቆርጧል~' },
  ];
  const built = C.buildTrack(p, 'C:/Users/me/Videos/talk.mp4', cues, look, { rand });
  assert.deepStrictEqual([built.placed, built.skipped, built.found], [2, 1, 2]);
  const seg = built.track.segments[0];
  assert.deepStrictEqual(seg.target_timerange, { start: 7e6, duration: 2e6 });
  assert.strictEqual(seg.clip.transform.y, look.y);
  const mat = built.texts[0];
  assert.strictEqual(mat.type, 'subtitle');
  assert.strictEqual(seg.material_id, mat.id);
  assert.deepStrictEqual(mat.words, { start_time: [0, 800, 1000], end_time: [800, 1000, 2000], text: ['ሰላም', ' ', 'ናችሁ'] });
  assert.strictEqual(built.track.segments[1].target_timerange.duration, 1e6, 'the 2x part');
  const out = C.addTrack(p, built);
  assert.strictEqual(JSON.stringify(p), before, 'the input is not changed');
  assert.strictEqual(out.tracks.length, 3);
  assert.strictEqual(out.materials.texts.length, 3, 'the editor\'s own text stays');
  assert.strictEqual(out.materials.texts[0].id, 'T0');
  // every reference points at something that exists; ids are unique
  const ids = new Set();
  out.materials.texts.concat(out.materials.material_animations).forEach((m) => { assert.ok(!ids.has(m.id)); ids.add(m.id); });
  out.tracks.forEach((t) => (t.segments || []).forEach((s) => {
    if (t.type !== 'text') return;
    assert.ok(ids.has(s.material_id));
    (s.extra_material_refs || []).forEach((r) => assert.ok(ids.has(r)));
  }));
  // every field CapCut writes for a caption is there
  Object.keys(C.TEMPLATE.text).forEach((k) => assert.ok(k in mat, 'text field ' + k));
  Object.keys(C.TEMPLATE.segment).forEach((k) => assert.ok(k in seg, 'segment field ' + k));
  assert.doesNotThrow(() => JSON.parse(mat.content));
});

test('sending again replaces our track (never doubled); removing leaves the project as it was', () => {
  const p = project();
  const once = C.addTrack(p, C.buildTrack(p, 'C:/Users/me/Videos/talk.mp4', [{ start: 12, end: 14, text: 'ሀ' }], look, { rand }));
  const twice = C.addTrack(once, C.buildTrack(once, 'C:/Users/me/Videos/talk.mp4', [{ start: 15, end: 16, text: 'ለ' }], look, { rand }));
  assert.strictEqual(C.ourTracks(twice).length, 1);
  assert.strictEqual(twice.materials.texts.length, 2);
  assert.deepStrictEqual(C.removeOurs(twice), p);
  assert.deepStrictEqual(C.summary(twice).ours, 1);
});

test('1.36: a project with several videos — each video once, pictures skipped; all captions in one track, never overlapping', () => {
  const p = project();
  p.materials.videos.push({ id: 'PH', path: 'C:/pics/a.jpg', type: 'photo' });
  p.tracks[0].segments.push({ material_id: 'PH', source_timerange: { start: 0, duration: 3e6 }, target_timerange: { start: 45e6, duration: 3e6 } });
  assert.deepStrictEqual(C.videosOf(p), ['C:/Users/me/Videos/talk.mp4', 'C:/other.mp4'], 'timeline order, each once, no photo');
  const built = C.buildTrackAll(p, [
    { video: 'C:/Users/me/Videos/talk.mp4', cues: [{ start: 12, end: 14, text: 'ሀ' }, { start: 38, end: 39.5, text: 'ለ' }] },
    { video: 'C:/other.mp4', cues: [{ start: 0.5, end: 2, text: 'ሐ' }] },
  ], look, { rand });
  const segs = built.track.segments;
  assert.deepStrictEqual(segs.map((s) => s.target_timerange.start), [7e6, 33e6, 40.5e6]);
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i - 1].target_timerange.start + segs[i - 1].target_timerange.duration <= segs[i].target_timerange.start, 'no overlap');
  }
  assert.strictEqual(built.texts.length, segs.length);
  assert.ok(segs.every((s, i) => s.material_id === built.texts[i].id && s.extra_material_refs[0] === built.animations[i].id));
  const out = C.addTrack(p, built);
  assert.strictEqual(C.ourTracks(out).length, 1, 'one track for all videos');
});

test('1.37: the animation the editor gave ONE caption in CapCut goes on all, fitted to each; Update keeps it; text edits stay', () => {
  const p = project();
  const built = C.buildTrack(p, 'C:/Users/me/Videos/talk.mp4', [{ start: 12, end: 14, text: 'ሀ' }, { start: 15, end: 15.5, text: 'ለ' }, { start: 20, end: 23, text: 'ሐ' }], look, { rand });
  let d = C.addTrack(p, built);
  assert.deepStrictEqual(C.chosenAnims(d), {}, 'nothing chosen yet');
  // the editor animates the 2nd caption in CapCut and edits the 3rd's text
  const segs = C.ourTracks(d)[0].segments;
  const am = d.materials.material_animations.find((x) => x.id === segs[1].extra_material_refs[0]);
  am.animations = [{ id: '7664535055594802453', type: 'in', start: 0, duration: 500000, path: 'C:/cache/effect/7664535055594802453/x', resource_id: '7664535055594802453', name: 'Cyan Slide', category_name: 'In' }];
  const t3 = d.materials.texts.find((x) => x.id === segs[2].material_id);
  t3.content = JSON.stringify({ styles: [], text: 'የተስተካከለ' });
  const ch = C.chosenAnims(d);
  assert.strictEqual(ch.in.name, 'Cyan Slide');
  const r = C.spreadAnims(d);
  assert.deepStrictEqual([r.n, r.names], [3, ['Cyan Slide']]);
  const animOn = (dd, i) => dd.materials.material_animations.find((x) => x.id === C.ourTracks(dd)[0].segments[i].extra_material_refs[0]).animations;
  assert.deepStrictEqual(animOn(r.draft, 0).map((x) => [x.name, x.start, x.duration]), [['Cyan Slide', 0, 500000]]);
  assert.deepStrictEqual(animOn(r.draft, 1).map((x) => x.duration), [300000], 'a 0.5 s caption: the animation fits inside');
  assert.strictEqual(JSON.parse(r.draft.materials.texts.find((x) => x.id === C.ourTracks(r.draft)[0].segments[2].material_id).content).text, 'የተስተካከለ', 'text edits made in CapCut stay');
  // in + out together: both fit, out at the end
  const both = C.fitAnims({ in: { name: 'A', type: 'in', duration: 500000 }, out: { name: 'B', type: 'out', duration: 500000 } }, 1000000);
  assert.deepStrictEqual(both.map((x) => [x.type, x.start, x.duration]), [['in', 0, 400000], ['out', 600000, 400000]]);
  // Update (send again) keeps the chosen animation on the new captions
  const again = C.addTrack(r.draft, C.buildTrack(r.draft, 'C:/Users/me/Videos/talk.mp4', [{ start: 12, end: 14, text: 'ሀ' }], look, { rand }));
  assert.strictEqual(animOn(again, 0)[0].name, 'Cyan Slide');
  assert.strictEqual(C.ourTracks(again).length, 1);
});

test('no personal data in the template (from a real CapCut project)', () => {
  const t = JSON.stringify(C.TEMPLATE);
  assert.ok(!/Users|Desktop|\.ttf|\.mp4/i.test(t), 'no paths');
  assert.strictEqual(C.TEMPLATE.text.content, '');
  assert.strictEqual(C.TEMPLATE.text.type, 'subtitle');
});

console.log('ALL PASS  (' + passed + ' tests)');
