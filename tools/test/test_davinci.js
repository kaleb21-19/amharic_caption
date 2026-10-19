#!/usr/bin/env node
/*
 * test_davinci.js — ⬆ Export → DaVinci (1.43.0, app/davinci_core.js + the
 * script app/amh_davinci.lua it installs). The script itself runs inside
 * DaVinci Resolve only; here: the captions file it reads, the style, the
 * install places, and that the script keeps its safety steps.
 *
 * Run:  node tools/test/test_davinci.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../../app/davinci_core.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }
const LUA = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'amh_davinci.lua'), 'utf8');

test('Lua strings: quotes, backslashes, new lines and Amharic are safe', () => {
  assert.strictEqual(V.luaStr('ሰላም'), '"ሰላም"');
  assert.strictEqual(V.luaStr('a "b" \\ c\nd'), '"a \\"b\\" \\\\ c\\nd"');
  assert.strictEqual(V.luaStr(null), '""');
  assert.ok(!/\n/.test(V.luaStr('x\r\ny')), 'one line');
});

test('caption text: no *pop* marks, no ~cut~ words', () => {
  assert.strictEqual(V.plain('ዛሬ *100* ብር ~እህ~ ነው'), 'ዛሬ 100 ብር ነው');
  assert.strictEqual(V.plain('  a\n b '), 'a b');
});

test('the style -> font family, size, colour, place', () => {
  const l = V.lookFor('karaoke', { font: 'menbere', size: 'l', text: '#FFE500', pos: 'top', box: false });
  assert.deepStrictEqual([l.font, l.style, l.k, l.pos, l.box, l.outline], ['Menbere', 'Bold', 1.2, 'top', false, true]);
  assert.deepStrictEqual(l.color, [1, 0.898, 0]);
  assert.strictEqual(l.y, null, 'no dragged height: the position decides');
  const d = V.lookFor('plain', { font: 'nope', size: 1.33, y: 0.7, box: true });
  assert.deepStrictEqual([d.font, d.k, d.y, d.box, d.outline, d.pos], ['Noto Sans Ethiopic', 1.33, 0.7, true, false, 'bottom']);
  assert.strictEqual(V.lookFor('plain', {}, 0.81).y, 0.81, 'the Studio\'s dragged caption height');
  assert.deepStrictEqual(V.lookFor('plain', {}).color, [1, 1, 1]);
  assert.strictEqual(V.lookFor('x', { font: 'yebse' }).style, 'Regular', 'one-file fonts are Regular');
});

test('the captions file: every video, file seconds, bad cues left out', () => {
  const look = V.lookFor('plain', { font: 'sans' });
  const r = V.dataLua([
    { path: 'C:\\Users\\me\\Videos\\talk "1".mp4', cues: [{ start: 1, end: 2.2, text: 'ሰላም *ለሁላችሁ*' }, { start: 3, end: 3, text: 'zero' },
      { start: 4, end: 5.25, text: '~እህ~' }, { start: 5.5, end: 6.123456, text: 'line\nbreak' }] },
    { path: 'D:/b.mp4', cues: [] },
    { path: '', cues: [{ start: 0, end: 1, text: 'no path' }] },
  ], look, 'am');
  assert.strictEqual(r.cues, 2);
  assert.ok(r.text.includes('path = "C:/Users/me/Videos/talk \\"1\\".mp4"'), 'forward slashes, quotes escaped');
  assert.ok(r.text.includes('{ 1, 2.2, "ሰላም ለሁላችሁ" },'));
  assert.ok(r.text.includes('{ 5.5, 6.123, "line break" },'));
  assert.ok(!r.text.includes('D:/b.mp4') && !r.text.includes('no path'), 'videos without captions are left out');
  assert.ok(/^return \{$/m.test(r.text) && r.text.trim().endsWith('}'), 'one Lua table');
  assert.ok(r.text.includes('lang = "am"') && r.text.includes('font = "Noto Sans Ethiopic", style = "Bold", k = 1'));
  assert.ok(!/ y = /.test(r.text), 'no y without a dragged height');
  assert.ok(V.dataLua([], look, 'en').text.includes('lang = "en"'));
  // balanced braces = the table closes (the script dofile()s it)
  const open = (r.text.match(/\{/g) || []).length, close = (r.text.match(/\}/g) || []).length;
  assert.strictEqual(open, close);
});

test('two lines (1.50): the look carries it, the script breaks in two', () => {
  const l = V.lookFor('plain', { lines: 2 });
  assert.strictEqual(l.lines, 2);
  assert.ok(V.dataLua([{ path: 'a.mp4', cues: [{ start: 0, end: 1, text: 'a b' }] }], l, 'am').text.includes(', lines = 2'));
  assert.ok(!V.dataLua([{ path: 'a.mp4', cues: [{ start: 0, end: 1, text: 'a b' }] }], V.lookFor('plain', {}), 'am').text.includes('lines ='));
  assert.ok(LUA.includes('L.lines == 2'), 'the script knows two lines');
});

test('the installed script knows where the captions file is', () => {
  const s = V.withData(LUA, 'C:\\Users\\me\\Documents\\AmharicCaptions\\Studio\\davinci\\captions.lua');
  assert.ok(s.includes('local DATA = "C:/Users/me/Documents/AmharicCaptions/Studio/davinci/captions.lua"'));
  assert.strictEqual((s.match(/^local DATA = /gm) || []).length, 1);
  assert.throws(() => V.withData('print(1)', 'x'), /DATA/);
});

test('where DaVinci looks for scripts (Windows, Mac)', () => {
  const j = (...p) => p.join('/');
  assert.strictEqual(V.scriptsDir('win32', { APPDATA: 'C:/U/AppData/Roaming' }, 'C:/U', j),
    'C:/U/AppData/Roaming/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Utility');
  assert.strictEqual(V.scriptsDir('darwin', {}, '/Users/me', j),
    '/Users/me/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
  assert.strictEqual(V.scriptsDir('win32', {}, 'C:/U', j), '');
  assert.strictEqual(V.resolveHome('win32', { APPDATA: 'A' }, 'H', j), 'A/Blackmagic Design/DaVinci Resolve');
  assert.strictEqual(V.SCRIPT_NAME, 'Amharic Captions.lua');
});

test('the script keeps its safety steps', () => {
  assert.ok(/^local DATA = nil\b/m.test(LUA), 'the DATA line the Studio fills in');
  assert.ok(!/\bio\.|os\.execute|os\.remove/.test(LUA), 'no file writing or programs (DaVinci has no io anyway)');
  assert.ok(LUA.includes('DuplicateTimeline(name)'), 'the captions are built in their own timeline');
  assert.ok(/SetTrackLock\(kind, t, true\)/.test(LUA) && /SetTrackLock\(l\[1\], l\[2\], l\[3\]\)/.test(LUA), 'your tracks locked, then back as they were');
  assert.ok(LUA.includes('AddTrack("video")') && LUA.includes('trackIndex = top'), 'one new track on top');
  assert.ok(LUA.includes('SetTrackEnable("video", t, false)') && !/DeleteTrack/.test(LUA), 'an older captions track is turned off, never deleted');
  assert.ok(!/ImportMedia|\.srt/.test(LUA), 'no subtitle-file import (a partial one crashed DaVinci 21)');
  assert.ok(LUA.includes('snapshot()') && LUA.includes('Ctrl+Z'), 'checks nothing of yours moved');
  assert.ok(LUA.includes('item:AddMarker(0, "Green"') && LUA.includes('t:AddMarker(at + i, "Red"'), 'the result as a marker (DaVinci free shows no script windows)');
});

console.log('\n' + passed + ' passed');
