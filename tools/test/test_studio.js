#!/usr/bin/env node
/*
 * test_studio.js — Amharic Captions Studio (1.17.0): the timeline maths,
 * what the mouse is on, and the project files (app/studio_core.js).
 *
 * Run:  node tools/test/test_studio.js
 */
'use strict';
const assert = require('assert');
const S = require('../../app/studio_core.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('the whole video fits; zoom keeps the second under the mouse; never past the ends', () => {
  const v = S.fitView(120, 600);
  assert.deepStrictEqual(v, { start: 0, pps: 5 });
  const z = S.zoomAt(v, 4, 300, 120, 600);           // 60 s is under x=300
  assert.strictEqual(z.pps, 20);
  assert.ok(Math.abs(S.xToTime(300, z) - 60) < 1e-9, 'still 60 s under the mouse');
  assert.deepStrictEqual(S.zoomAt(v, 0.1, 300, 120, 600), v, 'not smaller than the whole video');
  assert.strictEqual(S.zoomAt(v, 1e6, 0, 120, 600).pps, S.MAX_PPS);
  assert.strictEqual(S.clampView({ start: 500, pps: 20 }, 120, 600).start, 90, 'the end stays on screen');
  assert.strictEqual(S.clampView({ start: -5, pps: 20 }, 120, 600).start, 0);
});

test('while playing the view pages forward with the playhead', () => {
  const v = { start: 0, pps: 20 };                    // 30 s visible
  assert.strictEqual(S.follow(v, 10, 120, 600), v, 'inside: no jump');
  const f = S.follow(v, 45, 120, 600);
  assert.ok(f.start > 40 && f.start < 45, JSON.stringify(f));
});

test('the mouse on a caption: its edges resize, its body selects; nearest edge wins', () => {
  const cues = [{ start: 1, end: 2 }, { start: 2.1, end: 3 }];
  const v = { start: 0, pps: 100 };                   // 1 s = 100 px
  assert.deepStrictEqual(S.hitCaption(cues, v, 101), { i: 0, edge: 'start' });
  assert.deepStrictEqual(S.hitCaption(cues, v, 150), { i: 0, edge: 'body' });
  assert.deepStrictEqual(S.hitCaption(cues, v, 199), { i: 0, edge: 'end' });
  assert.deepStrictEqual(S.hitCaption(cues, v, 208), { i: 1, edge: 'start' }, 'between two blocks: the nearer edge');
  assert.strictEqual(S.hitCaption(cues, v, 500), null);
});

test('ruler marks every ~80 px with readable clock times', () => {
  const t = S.ticks({ start: 0, pps: 10 }, 400);      // 40 s visible -> every 10 s
  assert.deepStrictEqual(t.map((k) => k.label), ['0:00', '0:10', '0:20', '0:30', '0:40']);
  assert.strictEqual(S.fmtClock(3725), '1:02:05');
  assert.strictEqual(S.fmtClock(9.34, true), '0:09.3');
});

test('projects: one file per video, only what is needed, broken files ignored, newest first', () => {
  assert.strictEqual(S.projectId('C:\\V\\Talk.mp4'), S.projectId('c:/v/talk.mp4'), 'the same video = the same project');
  assert.notStrictEqual(S.projectId('C:/v/a.mp4'), S.projectId('C:/v/b.mp4'));
  assert.ok(/^My Talk __[0-9a-z]+\.amhproj$/.test(S.projectFileName('C:/v/My:Talk?.mp4'.replace(':T', ' T').replace('?', ''))));
  const p = S.makeProject({ video: 'C:/v/a.mp4', name: 'a.mp4', duration: 30, style: 'glide', at: 5,
    cues: [{ start: 1, end: 2, text: 'ሰላም *ቃል*', wt: [[1, 1.4], [1.5, 2]], _id: 7, junk: 1 }] });
  assert.deepStrictEqual(p.cues, [{ start: 1, end: 2, text: 'ሰላም *ቃል*', wt: [[1, 1.4], [1.5, 2]] }]);
  const back = S.parseProject(JSON.stringify(p));
  assert.strictEqual(back.style, 'glide');
  assert.strictEqual(back.cues[0].text, 'ሰላም *ቃል*');
  assert.strictEqual(S.parseProject('{bad'), null);
  assert.strictEqual(S.parseProject(JSON.stringify({ kind: 'other', cues: [], video: 'x' })), null);
  const list = S.recentProjects([{ at: 1 }, null, { at: 3 }, { at: 2 }], 2);
  assert.deepStrictEqual(list.map((x) => x.at), [3, 2]);
});

test('Script view: paragraphs at pauses and sentence ends; long stretches break at a small pause', () => {
  const w = (t, s, e) => ({ w: t, s, e });
  const paras = S.scriptParagraphs([w('ሰላም', 0, 0.4), w('ናችሁ።', 0.5, 1), w('ዛሬ', 1.6, 2), w('ቡና', 2.1, 2.5), w('ነው', 4, 4.4)]);
  assert.deepStrictEqual(paras.map((p) => p.map((x) => x.w)), [['ሰላም', 'ናችሁ።'], ['ዛሬ', 'ቡና'], ['ነው']]);
  const many = [];
  for (let i = 0; i < 70; i++) many.push(w('ቃል', i * 0.5, i * 0.5 + 0.2));       // a 0.3 s gap after every word
  assert.ok(S.scriptParagraphs(many).every((p) => p.length <= 60) && S.scriptParagraphs(many).length >= 2, 'no wall of text');
});

test('Script view: the word being spoken; the selected words per caption', () => {
  const words = [{ s: 0, e: 0.4 }, { s: 0.5, e: 1 }, { s: 3, e: 3.5 }];
  assert.strictEqual(S.wordAt(words, 0.2), 0);
  assert.strictEqual(S.wordAt(words, 1.1), 1, 'just after a word: still that word');
  assert.strictEqual(S.wordAt(words, 2), -1, 'in a pause: none');
  assert.strictEqual(S.wordAt(words, -1), -1);
  assert.deepStrictEqual(S.wordRanges('ሰላም  *ቡና*\nነው'), [[0, 3], [5, 9], [10, 12]]);
  const cues = [{ text: 'ሰላም ናችሁ ዛሬ' }, { text: 'ስለ ቡና' }];
  assert.deepStrictEqual(S.selectionByCaption(cues, [{ cue: 1, k: 0 }, { cue: 0, k: 2 }, { cue: 0, k: 1 }]),
    [{ cue: 0, from: 4, to: 10, words: [1, 2] }, { cue: 1, from: 0, to: 2, words: [0] }]);
});

console.log('ALL PASS  (' + passed + ' tests)');
