#!/usr/bin/env node
/*
 * test_host_captions.js — placing captions again must REPLACE the previous
 * ones, never stack a second caption track (which shows every word twice).
 *
 * panel/jsx/host.jsx runs in a Node vm against a small Premiere model that
 * matches the real scripting API where it matters: a caption Track has NO
 * remove() method, a TrackItem has remove(ripple, alignToVideo). The old
 * cleanup called track.remove(), which threw silently in real Premiere.
 *
 * Run:  node tools/test/test_host_captions.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const JSX = path.resolve(__dirname, '..', '..', 'panel', 'jsx');

// Array-like Premiere collection: numItems/numTracks + [i].
function coll(arr, countName) {
  return new Proxy(arr, {
    get(target, prop) {
      if (prop === countName) return target.length;
      return target[prop];
    },
  });
}
class ProjectItem {
  constructor(name, bin) { this.name = name; this.bin = bin; }
  deleteSelf() { const k = this.bin._kids; k.splice(k.indexOf(this), 1); }
}
class Bin {
  constructor(name) { this.name = name; this.type = 2; this._kids = []; this.children = coll(this._kids, 'numItems'); }
  createBin(name) { const b = new Bin(name); this._kids.push(b); return b; }
}
class TrackItem {
  constructor(track, projectItem) { this.track = track; this.projectItem = projectItem; this.name = projectItem.name; }
  remove() { const c = this.track._clips; c.splice(c.indexOf(this), 1); }   // (inRipple, inAlignToVideo)
}
class CaptionTrack {   // NB: no remove() — like Premiere's scripting Track
  constructor() { this._clips = []; this.clips = coll(this._clips, 'numItems'); }
}
function makePremiere() {
  const root = new Bin('root');
  const tracks = [];
  const seq = {
    name: 'Sequence 01',
    captionTracks: coll(tracks, 'numTracks'),
    createCaptionTrack(item) {
      const t = new CaptionTrack();
      t._clips.push(new TrackItem(t, item));
      tracks.push(t);
      return true;
    },
  };
  root._kids.push(seq);
  const app = {
    project: {
      rootItem: root,
      activeSequence: seq,
      sequences: coll([seq], 'numItems'),
      importFiles(paths, suppress, bin) {
        for (const p of paths) bin._kids.push(new ProjectItem(path.basename(p), bin));
        return true;
      },
    },
  };
  return { app, seq, tracks, root };
}
function load(pp) {
  const ctx = {
    app: pp.app,
    Sequence: { CAPTION_FORMAT_SUBTITLE: 6 },
    File: class { constructor(p) { this.p = p; } get exists() { return fs.existsSync(this.p); } },
    JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JSX, 'host.jsx'), 'utf8').replace(/^#include.*$/m, ''), ctx);
  return ctx;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amhcap-'));
function srt(name, text) {
  const p = path.join(tmp, name + '.srt');
  fs.writeFileSync(p, '1\n00:00:00,000 --> 00:00:01,000\n' + text + '\n');
  return p;
}
function place(ctx, srtPath, baseName) {
  const args = JSON.stringify({ srtPath, baseName, startSeconds: 0 });
  return JSON.parse(vm.runInContext('amh_importCaptions(' + JSON.stringify(args) + ')', ctx));
}
const visible = (tracks) => tracks.filter((t) => t._clips.length).map((t) => t._clips.map((c) => c.projectItem.name).join(','));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS  ' + name); }

test('placing again replaces the previous captions (no second visible track)', () => {
  const pp = makePremiere();
  const ctx = load(pp);
  assert.ok(place(ctx, srt('amh_review_1', 'ሰላም'), 'interview').placed);
  assert.deepStrictEqual(visible(pp.tracks), ['amh_review_1.srt']);
  assert.ok(place(ctx, srt('amh_review_2', 'ሰላም'), 'interview').placed);
  assert.deepStrictEqual(visible(pp.tracks), ['amh_review_2.srt'], 'old captions gone, only the new set shows');
  assert.ok(place(ctx, srt('amh_review_3', 'ሰላም'), 'interview').placed);
  assert.deepStrictEqual(visible(pp.tracks), ['amh_review_3.srt'], 'third try: still one set');
});

test('the replaced caption items are removed from the bin too', () => {
  const pp = makePremiere();
  const ctx = load(pp);
  place(ctx, srt('amh_review_10', 'a'), 'clip');
  place(ctx, srt('amh_review_11', 'b'), 'clip');
  const bin = pp.root._kids.find((k) => k.name === 'Amharic Captions');
  assert.deepStrictEqual(bin._kids.map((k) => k.name), ['amh_review_11.srt']);
});

test('a caption track the user made is never touched', () => {
  const pp = makePremiere();
  const ctx = load(pp);
  const mine = new CaptionTrack();
  mine._clips.push(new TrackItem(mine, new ProjectItem('my_english_subs.srt', pp.root)));
  pp.tracks.push(mine);
  place(ctx, srt('amh_review_20', 'a'), 'clip');
  place(ctx, srt('amh_review_21', 'b'), 'clip');
  assert.deepStrictEqual(visible(pp.tracks).sort(), ['amh_review_21.srt', 'my_english_subs.srt']);
});

test('several stacked old tracks (from older versions) are all cleared in one go', () => {
  const pp = makePremiere();
  const ctx = load(pp);
  const bin = new Bin('Amharic Captions');
  pp.root._kids.push(bin);
  for (const n of ['amh_review_30.srt', 'amh_review_31.srt', 'amh_review_32.srt']) {
    const t = new CaptionTrack();
    const item = new ProjectItem(n, bin);
    bin._kids.push(item);
    t._clips.push(new TrackItem(t, item));
    pp.tracks.push(t);
  }
  place(ctx, srt('amh_review_33', 'a'), 'clip');
  assert.deepStrictEqual(visible(pp.tracks), ['amh_review_33.srt']);
});

console.log('\n' + passed + ' caption placement checks — all green ✅');
