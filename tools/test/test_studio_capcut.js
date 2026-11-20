#!/usr/bin/env node
/*
 * test_studio_capcut.js - the Studio's "Add captions" to an existing CapCut
 * project (app/studio_capcut.js). CapCut saves its own edits when it closes,
 * so the draft we write must be the one we read AFTER the editor closed, not
 * the one we read before transcription (1.94.13).
 *
 * Run:  node tools/test/test_studio_capcut.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'studio_capcut.js'), 'utf8');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  [OK] ' + name); }
  catch (e) { failed++; console.log('  [FAIL] ' + name + '\n         ' + (e && e.stack || e)); }
}

function fakeEl(tag) {
  return {
    tag, className: '', textContent: '', value: '', children: [], firstChild: null,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }
  };
}

// reads: what draft_content.json returns on the 1st, 2nd, ... read. CapCut's
// save during transcription is simulated by a different second answer.
function load(dir, reads) {
  let count = 0, built = 0;
  const draftFile = path.join(dir, 'draft_content.json');
  const fakeFs = Object.assign({}, fs, {
    readFileSync(p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(draftFile)) {
        return reads[Math.min(count++, reads.length - 1)];
      }
      return fs.readFileSync(p, ...rest);
    }
  });
  const C = {
    CC_ANIMS: {},
    normPath: (p) => String(p || '').replace(/\\/g, '/'),
    videosOf: (d) => ((d && d.materials && d.materials.videos) || []).filter((v) => v.type !== 'photo').map((v) => v.path),
    summary: () => ({ videos: [], ours: false }),
    ourTracks: () => [], expectedSent: () => null, userEdits: () => [],
    keepEdits: (b) => b, sentMap: () => ({}), lookFor: () => ({}),
    buildTrackAll: () => { built++; return { placed: 1 }; },
    addTrack: (d) => d
  };
  const sb = {
    console, require, setTimeout, clearTimeout, setImmediate,
    MutationObserver: class { observe() {} disconnect() {} }, addEventListener() {},
    fs: fakeFs, path, os, AmhCapCut: C,
    process: { platform: 'win32', env: { LOCALAPPDATA: path.join(dir, 'local') } },
    spawn: () => ({ stdout: { on() {} }, on(e, f) { if (e === 'close') setImmediate(() => f(0)); } }),
    document: { createElement: (tag) => fakeEl(tag), getElementById: () => fakeEl('div') },
    AMH_LANG: 'en', loadSettings: () => ({ ccAnim: 'none' }), saveSettings() {},
    reviewCues: [], transcribeExtra: async () => []
  };
  sb.window = sb;
  sb.__amhApp = { call() {} };
  sb.__amhStudio = { projDir: () => path.join(dir, 'studio'), listProjects: () => [] };
  sb.AmhStudio = { projectId: () => 'test' };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'studio_capcut.js' });
  return { sb, built: () => built };
}

function draftWith(video) {
  return { canvas_config: { width: 1080, height: 1920 },
           materials: { videos: [{ id: 'v1', path: video }] }, tracks: [] };
}

(async () => {
  await t('captions use the draft CapCut saved while Studio was transcribing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_capcut_'));
    try {
      const video = path.join(dir, 'talk.mp4');
      fs.writeFileSync(video, 'x');
      const v1 = draftWith(video);
      const file = path.join(dir, 'draft_content.json');
      fs.writeFileSync(file, JSON.stringify(v1));
      const v2 = JSON.parse(JSON.stringify(v1));
      v2.editorFix = true;                       // the editor's change in CapCut
      const { sb, built } = load(dir, [JSON.stringify(v1), JSON.stringify(v2)]);
      await sb.__amhCapCut.captionProject({ name: 'Demo', dir }, fakeEl('div'));
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(written.editorFix, true, 'the change made in CapCut was not overwritten');
      assert.strictEqual(built(), 1, 'the captions were still written');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('a video removed from the project while transcribing is not written back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_capcut_'));
    try {
      const video = path.join(dir, 'talk.mp4');
      fs.writeFileSync(video, 'x');
      const v1 = draftWith(video);
      const file = path.join(dir, 'draft_content.json');
      fs.writeFileSync(file, JSON.stringify(v1));
      const v2 = JSON.parse(JSON.stringify(v1));
      v2.materials.videos = [];                  // the editor removed the clip
      const out = fakeEl('div');
      const { sb, built } = load(dir, [JSON.stringify(v1), JSON.stringify(v2)]);
      await sb.__amhCapCut.captionProject({ name: 'Demo', dir }, out);
      assert.strictEqual(built(), 0, 'no captions built for a video no longer in the project');
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).editorFix, undefined, 'the project file was left alone');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
