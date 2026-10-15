#!/usr/bin/env node
/*
 * test_host_pick.js — which clip "Generate" listens to in Premiere
 * (amharic_getSelectedClip). With nothing selected, the clip under the
 * playhead is used, and a clip on an AUDIO track wins: a stock video with no
 * sound on V1 and the voice on A1 must give the voice (problem report
 * 1.16.1). An explicit selection always wins over the playhead.
 *
 * Run:  node tools/test/test_host_pick.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');
const coll = (arr, n) => new Proxy(arr, { get: (t, p) => (p === n ? t.length : t[p]) });
const T = (s) => ({ seconds: s, ticks: String(Math.round(s * 254016000000)) });

function clip(file, start, dur, selected) {
  return {
    start: T(start), duration: T(dur), end: T(start + dur), inPoint: T(0), outPoint: T(dur), selected: !!selected,
    name: path.basename(file),
    projectItem: { name: path.basename(file), getMediaPath: () => file },
  };
}
function track(clips) { return { clips: coll(clips, 'numItems') }; }

// A nested sequence: a clip whose projectItem IS a sequence (no media file).
function seqOf(video, audio, name) {
  const item = { name: name || 'Nested Sequence 01', nodeId: 'n-' + (name || 'x'), getMediaPath: () => '', isSequence: () => true };
  return { name: item.name, projectItem: item, videoTracks: coll(video.map(track), 'numTracks'),
           audioTracks: coll(audio.map(track), 'numTracks') };
}
function nestedClip(inner, start, dur, selected) {
  return { start: T(start), duration: T(dur), end: T(start + dur), inPoint: T(0), outPoint: T(dur),
           selected: !!selected, name: inner.name, projectItem: inner.projectItem };
}

function pick(video, audio, playhead, sequences) {
  const seq = {
    videoTracks: coll(video.map(track), 'numTracks'),
    audioTracks: coll(audio.map(track), 'numTracks'),
    getPlayerPosition: () => T(playhead),
  };
  const ctx = { JSON, app: { project: { activeSequence: seq, sequences: coll(sequences || [], 'numSequences') } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  return JSON.parse(vm.runInContext('amharic_getSelectedClip()', ctx));
}

let fails = 0;
function t(name, fn) {
  try { fn(); console.log('  [OK] ' + name); } catch (e) { fails++; console.log('  [FAIL] ' + name + '\n        ' + e.message); }
}

t('nothing selected: the voice on A1 is used, not the silent stock video on V1', () => {
  const r = pick([[clip('C:/stock/broll.mp4', 0, 10)]], [[clip('C:/rec/voice.wav', 0, 10)]], 3);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.sourcePath, 'C:/rec/voice.wav');
});

t('nothing selected and only a video clip: that clip is used (its own sound)', () => {
  const r = pick([[clip('C:/cam/talk.mp4', 0, 10)]], [], 3);
  assert.strictEqual(r.sourcePath, 'C:/cam/talk.mp4');
});

t('the playhead counts only clips under it', () => {
  const r = pick([[clip('C:/cam/talk.mp4', 0, 10)]], [[clip('C:/rec/later.wav', 20, 5)]], 3);
  assert.strictEqual(r.sourcePath, 'C:/cam/talk.mp4');
});

t('an explicit selection always wins over the playhead', () => {
  const r = pick([[clip('C:/cam/talk.mp4', 0, 10, true)]], [[clip('C:/rec/voice.wav', 0, 10)]], 3);
  assert.strictEqual(r.sourcePath, 'C:/cam/talk.mp4');
});

// After cutting, the selection also holds titles / captions / nested sequences
// (no media file). The clip that HAS a file is used (owner report, 1.16.6).
t('selected: a cut video clip + a title (no media file) -> the video clip', () => {
  const r = pick([[clip('', 4, 6, true)], [clip('C:/cam/talk.mp4', 4, 6, true)]], [], 5);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.sourcePath, 'C:/cam/talk.mp4');
});

t('selected: only a title -> a clear "no media file" answer', () => {
  const r = pick([[clip('', 4, 6, true)]], [], 5);
  assert.strictEqual(r.ok, false);
  assert.match(JSON.stringify(r), /no on-disk source path/);
});

t('playhead: a title above the video does not hide the video', () => {
  const r = pick([[clip('', 0, 10)], [clip('C:/cam/talk.mp4', 0, 10)]], [], 3);
  assert.strictEqual(r.sourcePath, 'C:/cam/talk.mp4');
});

// A video file without sound + the voice as a separate clip on A1 (owner
// report, 1.16.8): the audio clip under the selected part comes along, mapped
// to the same timeline range.
t('selected video + a voice clip under it -> audioAlt with the same timeline part', () => {
  const r = pick([[clip('C:/cam/silent.mp4', 4, 6, true)]], [[clip('C:/rec/voice.wav', 0, 20)]], 5);
  assert.strictEqual(r.sourcePath, 'C:/cam/silent.mp4');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.audioAlt)),
    { sourcePath: 'C:/rec/voice.wav', sourceIn: 4, duration: 6, timelineStart: 4, name: 'voice.wav' });
});

t('the video\'s own linked audio (same file, same offset) is not an alternative', () => {
  const r = pick([[clip('C:/cam/talk.mp4', 4, 6, true)]], [[clip('C:/cam/talk.mp4', 4, 6)]], 5);
  assert.strictEqual(r.audioAlt, null);
});

// Our own styled caption layers ("amhstyle_...mov", no sound) are never the
// clip to listen to (owner report 1.16.8: after cutting, the playhead picked
// the Glide layer above the video).
t('playhead over a cut video with our Glide layer above it -> the video', () => {
  const r = pick([[clip('C:/cam/part2.mp4', 10, 10)], [clip('C:/Docs/AmharicCaptions/amhstyle_sequence__glide_1.mov', 0, 25)]], [], 12);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.sourcePath, 'C:/cam/part2.mp4');
});

t('selected: our Glide layer + the cut video -> the video', () => {
  const r = pick([[clip('C:/Docs/AmharicCaptions/amhstyle_sequence__glide_1.mov', 0, 25, true)], [clip('C:/cam/part2.mp4', 10, 10, true)]], [], 12);
  assert.strictEqual(r.sourcePath, 'C:/cam/part2.mp4');
});

t('only our Glide layer selected -> a clear "caption layer" answer', () => {
  const r = pick([[clip('C:/Docs/AmharicCaptions/amhstyle_sequence__glide_1.mov', 0, 25, true)]], [], 12);
  assert.strictEqual(r.ok, false);
  assert.match(JSON.stringify(r), /caption layer made by Amharic Captions/);
});

// The owner's case (1.16.9 "No clip found"): the edit is a NESTED sequence,
// cut in two parts, with our Glide layer above. Single-clip mode looks inside.
t('playhead over a cut nested sequence (+ our Glide layer) -> the clip inside, same timeline part', () => {
  const inner = seqOf([[clip('C:/cam/full.mp4', 0, 30)]], [[clip('C:/cam/full.mp4', 0, 30)]], 'Nested Sequence 01');
  const part2 = nestedClip(inner, 10, 10);
  part2.inPoint = T(10); part2.outPoint = T(20);   // the second part shows inner 10..20
  const r = pick([[nestedClip(inner, 0, 10), part2], [clip('C:/Docs/amhstyle_sequence__glide_1.mov', 0, 25)]], [], 12, [inner]);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([r.sourcePath, r.sourceIn, r.duration, r.timelineStart], ['C:/cam/full.mp4', 10, 10, 10]);
  assert.match(r.via, /nested/);
});

t('a selected nested sequence part -> the clip inside; a silent video inside gets the voice as audioAlt', () => {
  const inner = seqOf([[clip('C:/stock/silent.mp4', 0, 30)]], [[clip('C:/rec/voice.wav', 0, 20)]], 'Edit');
  const r = pick([[nestedClip(inner, 0, 30, true)]], [], 0, [inner]);
  assert.strictEqual(r.sourcePath, 'C:/stock/silent.mp4');
  assert.strictEqual(r.audioAlt.sourcePath, 'C:/rec/voice.wav');
});

t('no clip anywhere: a clear "no clip found" answer', () => {
  const r = pick([[]], [[]], 3);
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error || r.message || JSON.stringify(r)), /No clip found/);
});

console.log(fails ? '\nFAILURES: ' + fails : '\nALL PASS');
process.exit(fails ? 1 : 0);
