#!/usr/bin/env node
/*
 * test_host_ae.js — logic tests for panel/jsx/host_ae.jsx (After Effects host
 * layer) against a small simulated After Effects object model.
 *
 * host.jsx + host_ae.jsx are evaluated in a Node vm (the ExtendScript
 * `#include` line is stripped; JSON is native in Node) with mock CompItem /
 * FootageItem / layer / TextDocument objects. This checks the time mapping,
 * work-area clipping, retime rejection and caption-layer placement logic; it
 * does not replace a real run inside After Effects.
 *
 * Run:  node tools/test/test_host_ae.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');

// ── mock After Effects object model ────────────────────────────────────────
class FootageItem {
  constructor(name, file, hasAudio = true) {
    this.name = name; this.file = file ? { fsName: file, name: path.basename(file) } : null;
    this.hasAudio = hasAudio; this.typeName = 'Footage';
  }
}
class CompItem {
  constructor(o) {
    Object.assign(this, { name: 'Comp 1', width: 1920, height: 1080, duration: 60, time: 0,
      workAreaStart: 0, workAreaDuration: 60, typeName: 'Composition' }, o);
    this._layers = [];
    const comp = this;
    this.layers = {
      addText(text) {
        const L = new TextLayer(comp, text);
        comp._layers.unshift(L);
        return L;
      },
    };
  }
  get numLayers() { return this._layers.length; }
  layer(i) { return this._layers[i - 1]; }
  get selectedLayers() { return this._layers.filter((l) => l.selected); }
}
class AVLayer {
  constructor(comp, o) {
    Object.assign(this, { name: 'L', startTime: 0, inPoint: 0, outPoint: 10, stretch: 100,
      timeRemapEnabled: false, hasAudio: true, audioEnabled: true, selected: false, comment: '' }, o);
    this.comp = comp;
  }
  remove() { this.comp._layers = this.comp._layers.filter((l) => l !== this); }
}
class TextDocument { constructor(text) { this.text = text; this.font = 'ArialMT'; } }
class TextLayer extends AVLayer {
  constructor(comp, text) {
    super(comp, { inPoint: 0, outPoint: comp.duration, hasAudio: false });
    this.source = null;
    const doc = new TextDocument(text);
    this.keys = [];
    this.pos = null;
    const self = this;
    this.sourceText = {
      get value() { return Object.assign(new TextDocument(''), self._doc); },
      setValue(v) { self._doc = Object.assign(new TextDocument(''), v); },
      setValueAtTime(t, v) { self.keys.push({ t, text: v.text, font: v.font, fontSize: v.fontSize }); },
    };
    this._doc = doc;
  }
  property(name) {
    if (name === 'ADBE Text Properties') return { property: () => this.sourceText };
    if (name === 'ADBE Transform Group') return { property: () => ({ setValue: (v) => { this.pos = v; } }) };
    throw new Error('no property ' + name);
  }
  moveToBeginning() {}
}

function makeCtx(comp, installedFonts, opts) {
  opts = opts || {};
  const undo = [];
  const ctx = {
    // opts.frozenClock: every new Date() reports the same millisecond, the way
    // a fast CI machine can run two placements (the flaky-tag regression).
    ...(opts.frozenClock ? { Date: class extends Date { getTime() { return 1700000000000; } } } : {}),
    app: {
      version: '24.3', project: { activeItem: comp, numItems: 0, item: () => null, file: null },
      beginUndoGroup: (n) => undo.push('begin:' + n), endUndoGroup: () => undo.push('end'),
      fonts: installedFonts ? {
        getFontsByFamilyNameAndStyleName: (fam) => installedFonts.filter((f) => f.family === fam),
      } : undefined,
    },
    CompItem, FootageItem, TextDocument,
    ParagraphJustification: { CENTER_JUSTIFY: 'center' },
    File: class {
      constructor(p) { this.p = p; }
      get exists() { return fs.existsSync(this.p); }
      open() { return true; } close() {}
      read() { return fs.readFileSync(this.p, 'utf8'); }
    },
    JSON,
  };
  ctx._undo = undo;
  vm.createContext(ctx);
  const strip = (src) => src.replace(/^#include.*$/m, '');
  vm.runInContext(strip(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8')), ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host_ae.jsx'), 'utf8'), ctx);
  return ctx;
}
const call = (ctx, expr) => JSON.parse(vm.runInContext(expr, ctx));

function footageLayer(comp, o) {
  const L = new AVLayer(comp, o);
  L.source = new FootageItem(o.srcName || 'clip.mp4', o.file === undefined ? 'C:/v/clip.mp4' : o.file, true);
  comp._layers.push(L);
  return L;
}

function srtFile(body) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amh_ae_')), 'c.srt');
  fs.writeFileSync(p, body, 'utf8');
  return p;
}
const SRT = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nሰላም እንደምን\r\n\r\n' +
            '2\r\n00:00:02,500 --> 00:00:04,000\r\nአለህ\r\n\r\n' +
            '3\r\n00:00:06,000 --> 00:00:07,000\r\n[S2] ደህና ነኝ\r\nሁለተኛ መስመር\r\n';

// ── tests ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '\n        ' + e.message); }
}

t('selected layer: source range from startTime/inPoint/outPoint', () => {
  const comp = new CompItem();
  // Layer placed at comp 5s, trimmed so its visible part is comp 7..12s:
  // source in = 7 - 5 = 2s, duration 5s.
  footageLayer(comp, { startTime: 5, inPoint: 7, outPoint: 12, selected: true, srcName: 'interview.mp4' });
  const r = call(makeCtx(comp), 'amharic_getSelectedClip()');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.sourcePath, 'C:/v/clip.mp4');
  assert.strictEqual(r.sourceIn, 2);
  assert.strictEqual(r.duration, 5);
  assert.strictEqual(r.timelineStart, 7);
  assert.strictEqual(r.name, 'interview.mp4');
  assert.strictEqual(r.via, 'selected');
});

t('no selection: falls back to the audio layer under the time indicator', () => {
  const comp = new CompItem({ time: 20 });
  footageLayer(comp, { inPoint: 0, outPoint: 10, file: 'C:/v/a.mp4' });
  footageLayer(comp, { inPoint: 15, outPoint: 30, file: 'C:/v/b.mp4' });
  const r = call(makeCtx(comp), 'amharic_getSelectedClip()');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.sourcePath, 'C:/v/b.mp4');
  assert.match(r.via, /time indicator/);
});

t('rejects time-stretched, time-remapped and audio-less layers', () => {
  let comp = new CompItem();
  footageLayer(comp, { selected: true, stretch: 50 });
  assert.match(call(makeCtx(comp), 'amharic_getSelectedClip()').error, /speed\/stretch/);
  comp = new CompItem();
  footageLayer(comp, { selected: true, timeRemapEnabled: true });
  assert.match(call(makeCtx(comp), 'amharic_getSelectedClip()').error, /time remapping/);
  comp = new CompItem();
  footageLayer(comp, { selected: true, audioEnabled: false });
  assert.match(call(makeCtx(comp), 'amharic_getSelectedClip()').error, /no audio/);
});

t('no active comp gives a clear error', () => {
  const ctx = makeCtx(null);
  const r = call(ctx, 'amharic_getSelectedClip()');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /No active composition/);
});

t('work area clips layers; whole comp does not; retimed layers reported', () => {
  const comp = new CompItem({ workAreaStart: 10, workAreaDuration: 10 });
  footageLayer(comp, { startTime: 0, inPoint: 0, outPoint: 15, file: 'C:/v/a.mp4' });
  footageLayer(comp, { startTime: 12, inPoint: 12, outPoint: 40, file: 'C:/v/b.mp4' });
  footageLayer(comp, { inPoint: 0, outPoint: 60, file: 'C:/v/c.mp4', stretch: 200 });
  footageLayer(comp, { inPoint: 0, outPoint: 60, file: null });            // solid / no file
  const ctx = makeCtx(comp);
  const wa = call(ctx, 'amharic_getSequenceInfo(false)');
  assert.deepStrictEqual(wa.clips.map((c) => [c.sourcePath, c.timelineStart, c.sourceIn, c.duration]),
    [['C:/v/a.mp4', 10, 10, 5], ['C:/v/b.mp4', 12, 0, 8]]);
  assert.strictEqual(wa.unsupported.length, 1);
  const whole = call(ctx, 'amharic_getSequenceInfo(true)');
  assert.deepStrictEqual(whole.clips.map((c) => [c.timelineStart, c.duration]), [[0, 15], [12, 28]]);
});

t('import: one text layer, a keyframe per cue, blanks in gaps, offset applied', () => {
  const comp = new CompItem({ duration: 60 });
  const ctx = makeCtx(comp);
  const args = JSON.stringify({ srtPath: srtFile(SRT), startSeconds: 10, baseName: 'interview', font: '' });
  const r = call(ctx, 'amh_importCaptions(' + JSON.stringify(args) + ')');
  assert.ok(r.ok && r.placed === true, JSON.stringify(r));
  assert.strictEqual(comp.numLayers, 1);
  const L = comp.layer(1);
  assert.strictEqual(L.name, 'Amharic Captions - interview');
  assert.deepStrictEqual(L.keys.map((k) => [k.t, k.text]), [
    [11, 'ሰላም እንደምን'], [12.5, 'አለህ'], [14, ' '], [16, '[S2] ደህና ነኝ\rሁለተኛ መስመር'], [17, ' '],
  ]);
  assert.strictEqual(L.inPoint, 11);
  assert.strictEqual(L.outPoint, 17);
  assert.deepStrictEqual(Array.from(L.pos), [960, 1080 * 0.88]);
  assert.strictEqual(r.landedStart, 11);
  assert.deepStrictEqual(ctx._undo, ['begin:Amharic Captions', 'end'], 'one undo step');
});

t('import: re-run replaces the older layer for the same clip, keeps others', () => {
  const comp = new CompItem();
  const ctx = makeCtx(comp);
  const run = (base) => call(ctx, 'amh_importCaptions(' + JSON.stringify(JSON.stringify(
    { srtPath: srtFile(SRT), startSeconds: 0, baseName: base })) + ')');
  run('interview');
  run('b-roll');
  const r = run('interview');
  assert.ok(r.placed, JSON.stringify(r));
  const names = comp._layers.map((l) => l.name).sort();
  assert.deepStrictEqual(names, ['Amharic Captions - b-roll', 'Amharic Captions - interview']);
  assert.match(r.note, /replaced 1 older/);
});

t('import: re-run within the same millisecond still replaces the older layer', () => {
  const comp = new CompItem();
  const ctx = makeCtx(comp, null, { frozenClock: true });
  const run = () => call(ctx, 'amh_importCaptions(' + JSON.stringify(JSON.stringify(
    { srtPath: srtFile(SRT), startSeconds: 0, baseName: 'interview' })) + ')');
  run();
  const r = run();
  assert.strictEqual(comp.numLayers, 1, 'no duplicate caption layer');
  assert.match(r.note, /replaced 1 older/);
  const tags = new Set();
  for (let i = 0; i < 20; i++) { run(); tags.add(String(comp.layer(1).comment)); }
  assert.strictEqual(tags.size, 20, 'every placement gets its own tag');
});

t('import: cues past the comp end are dropped; none inside -> placed:false', () => {
  const comp = new CompItem({ duration: 5 });
  const ctx = makeCtx(comp);
  const args = JSON.stringify({ srtPath: srtFile(SRT), startSeconds: 0, baseName: 'x' });
  const r = call(ctx, 'amh_importCaptions(' + JSON.stringify(args) + ')');
  assert.ok(r.placed);
  assert.strictEqual(comp.layer(1).keys.filter((k) => k.text.trim()).length, 2, 'third cue (6s) dropped');
  const late = JSON.stringify({ srtPath: srtFile(SRT), startSeconds: 100, baseName: 'y' });
  const r2 = call(ctx, 'amh_importCaptions(' + JSON.stringify(late) + ')');
  assert.strictEqual(r2.placed, false);
  assert.strictEqual(comp.numLayers, 1, 'nothing added, nothing removed');
});

t('import: uses the detected Ethiopic font when After Effects knows it', () => {
  const comp = new CompItem();
  const ctx = makeCtx(comp, [{ family: 'Abyssinica SIL', postScriptName: 'AbyssinicaSIL-Regular' }]);
  const args = JSON.stringify({ srtPath: srtFile(SRT), startSeconds: 0, baseName: 'f', font: 'Abyssinica SIL' });
  const r = call(ctx, 'amh_importCaptions(' + JSON.stringify(args) + ')');
  assert.match(r.note, /font AbyssinicaSIL-Regular/);
  assert.strictEqual(comp.layer(1).keys[0].font, 'AbyssinicaSIL-Regular');
});

t('seek moves the comp time indicator (clamped to duration)', () => {
  const comp = new CompItem({ duration: 30 });
  const ctx = makeCtx(comp);
  call(ctx, 'amharic_seekPlayhead(' + JSON.stringify(JSON.stringify(12.5)) + ')');
  assert.strictEqual(comp.time, 12.5);
  call(ctx, 'amharic_seekPlayhead(' + JSON.stringify(JSON.stringify(99)) + ')');
  assert.strictEqual(comp.time, 30);
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail) + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail === 0 ? 0 : 1);
