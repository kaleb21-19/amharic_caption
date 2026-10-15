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

function pick(video, audio, playhead) {
  const seq = {
    videoTracks: coll(video.map(track), 'numTracks'),
    audioTracks: coll(audio.map(track), 'numTracks'),
    getPlayerPosition: () => T(playhead),
  };
  const ctx = { JSON, app: { project: { activeSequence: seq } } };
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

t('no clip anywhere: a clear "no clip found" answer', () => {
  const r = pick([[]], [[]], 3);
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error || r.message || JSON.stringify(r)), /No clip found/);
});

console.log(fails ? '\nFAILURES: ' + fails : '\nALL PASS');
process.exit(fails ? 1 : 0);
