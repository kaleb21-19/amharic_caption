#!/usr/bin/env node
/*
 * test_panel_dom.js — DOM-level tests for panel/js/main.js.
 *
 * Loads main.js (plus core.js) inside Node's vm with a minimal no-dependency
 * DOM shim (tools/test/dom_shim.js), then drives the panel as a browser would:
 * segmented-control clicks, settings persistence across a reload, the license
 * gate (bad keys, trial exhausted, activation), and a full cache-hit
 * transcribe -> review -> edit -> export path writing real SRT/VTT/TXT files
 * to a temp folder with speaker tags intact.
 *
 * Run:  node tools/test/test_panel_dom.js
 * No dependencies (Node's assert + vm only). Exits non-zero on any failure.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const vm     = require('vm');

const REPO     = path.resolve(__dirname, '..', '..');
const PANEL_JS = path.join(REPO, 'panel', 'js');
const DEV      = path.join(os.homedir(), 'Documents', 'amharic-captions');
const { makeDocument, makeLocalStorage } = require('./dom_shim.js');

const CACHE_FILE = path.join(os.tmpdir(), 'amh_transcript_cache.json');
const ENGINE_FILES = ['ethio_srt.py','ctc_beam.py','amh_correct.py','amh_vad.py','amh_lm.py','amh_lm.json.gz'];

const CUE1 = '\u1230\u120b\u121d \u12a5\u1295\u12f5\u1275 \u1290\u1205';
const CUE2 = '\u12f0\u1205\u1293 \u1290\u129d \u12a0\u121d\u1235\u1325\u1293\u1208\u1209';
const CACHE_SEED_SRT = ['1','00:00:01,000 --> 00:00:03,000','[S1] '+CUE1,'','2','00:00:03,000 --> 00:00:06,000','[S2] '+CUE2,''].join('\n');

/* ---------- runtime replication ---------- */
function detectRuntime() {
  const dirs = [PANEL_JS,path.dirname(PANEL_JS),path.join(path.dirname(PANEL_JS),'js'),path.join(path.dirname(PANEL_JS),'..')];
  const roots = []; for (const d of dirs) { if (!d || roots.indexOf(d) >= 0) continue; roots.push(d); }
  const complete = (base) => {
    if (!base || !fs.existsSync(base)) return false;
    if (!fs.existsSync(path.join(base,'ethio_srt.py'))) return false;
    const modelOk = fs.existsSync(path.join(base,'model')) || fs.existsSync(path.join(base,'ethio-asr'));
    const binOk   = fs.existsSync(path.join(base,'bin','ffmpeg'))   || fs.existsSync(path.join(base,'bin','ffmpeg.exe'));
    const pyOk    = fs.existsSync(path.join(base,'python','bin','python3')) || fs.existsSync(path.join(base,'python','python.exe'));
    return modelOk && binOk && pyOk;
  };
  for (const base of roots) { const c = path.join(base,'runtime'); if (complete(c)) return c; }
  if (complete(path.join(DEV,'runtime'))) return path.join(DEV,'runtime');
  if (fs.existsSync(path.join(DEV,'ethio_srt.py'))) return DEV;
  throw new Error('cannot replicate runtime detection');
}
const RUNTIME   = detectRuntime();
const MODEL_DIR = (RUNTIME === DEV) ? path.join(RUNTIME,'ethio-asr') : path.join(RUNTIME,'model');

function engineHashFor() {
  const h = crypto.createHash('sha1');
  for (const f of ENGINE_FILES) {
    try { h.update(f + ':' + Math.floor(fs.statSync(path.join(RUNTIME,f)).mtimeMs)); }
    catch (e) { h.update(f + ':x'); }
  }
  return h.digest('hex').slice(0,8);
}

function cacheKeyFor(src, opts) {
  opts = opts || {};
  const h = crypto.createHash('sha1');
  h.update(src);
  if (opts.range) { h.update(':' + String(opts.range.sourceIn||0)); h.update(':' + String(opts.range.duration||0)); }
  h.update(':' + (opts.cap||'words') + ':' + (opts.group||3) + ':' + (opts.chars||42) + ':' + (opts.speakers?1:0));
  h.update(':' + engineHashFor() + ':' + MODEL_DIR);
  h.update(':' + String(opts.offset||0));
  try { const st = fs.statSync(src); h.update(':' + st.size + ':' + Math.floor(st.mtimeMs)); } catch (e) {}
  return h.digest('hex').slice(0,24);
}

function snapshotCache() { try { return fs.readFileSync(CACHE_FILE,'utf8'); } catch (e) { return null; } }
function restoreCache(raw) {
  try { if (raw === null) fs.unlinkSync(CACHE_FILE); else fs.writeFileSync(CACHE_FILE,raw,'utf8'); } catch (e) {}
}

/* ---------- harness ---------- */
const defaultFetch = async () => ({ ok: false, json: async () => null });
const csiReply = {ok:true,captionItemName:'Caption',placed:true,requestedStart:0,landedStart:1,landedEnd:3,note:null};

function loadPanel(opts) {
  opts = opts || {};
  const prevHome  = process.env.AMH_MACHINE_HOME;
  const storage   = opts.storage || makeLocalStorage();
  const document  = makeDocument();
  const madeHome  = opts.machineHome;
  const machineHome = madeHome || fs.mkdtempSync(path.join(os.tmpdir(),'amh_dom_mach_'));
  process.env.AMH_MACHINE_HOME = machineHome;

  const sandbox = {
    console,
    require:    module.require.bind(module),
    process, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    crypto: globalThis.crypto,
    navigator:  { userAgent: 'dom-shim-test' },
    localStorage: storage,
    document,
    CSInterface: class { evalScript(jsx,cb) { cb(JSON.stringify(csiReply)); } },
    cep: { fs:{ showOpenDialog(){ return opts.folderDialog ? opts.folderDialog() : {err:1}; } },
            util:{ openURLInDefaultBrowser(){} } },
    __adobe_cep__:{
      getHostEnvironment(){ return JSON.stringify({appSkinInfo:{appBackgroundColor:{red:30,green:30,blue:30}}}); },
      addEventListener(){},
    },
    fetch: opts.fetch || defaultFetch,
    addEventListener(){}, removeEventListener(){}, open(){},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  sandbox.window = sandbox;
  sandbox.__dirname  = PANEL_JS;
  sandbox.__filename = path.join(PANEL_JS,'main.js');

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PANEL_JS,'core.js'),'utf8'),  ctx);
  vm.runInContext(fs.readFileSync(path.join(PANEL_JS,'main.js'),'utf8'),  ctx);

  let mid = null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(machineHome,'.amharic_captions_machine.json'),'utf8'));
    if (rec && /^[0-9a-f]{8}$/.test(rec.id)) mid = rec.id;
  } catch (e) {}

  return {
    document, storage, machineHome, mid,
    els: (id) => document.getElementById(id),
    close() {
      process.env.AMH_MACHINE_HOME = prevHome;
      if (!madeHome) { try { fs.rmSync(machineHome,{recursive:true,force:true}); } catch(e){} }
    },
  };
}

const flush = (ms) => new Promise((r) => setTimeout(r, ms));

function mkKey(mid, exp, sig) { return 'AMH-' + (mid+exp+sig).match(/.{4}/g).join('-'); }
function has(text, needle, label) {
  assert.ok(String(text).indexOf(needle) >= 0,
    (label||'string') + ' should contain ' + JSON.stringify(needle) + ' got: ' + JSON.stringify(String(text).slice(0,300)));
}

/* ---------- tests ---------- */
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '\n        ' + (e.stack ? String(e.stack).split('\n').slice(0,4).join('\n        ') : e)); }
}

(async () => {
await t('1. load: theme, runtime, version, font pill, health rows, onboarding', async () => {
  const p = loadPanel();
  try {
    await flush(10);
    assert.ok(p.mid && /^[0-9a-f]{8}$/.test(p.mid), 'machine id created');
    assert.strictEqual(p.els('machineIdDisplay').textContent, p.mid);
    assert.strictEqual(p.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(p.els('panelVersion').textContent, '1.4.21');
    assert.ok(p.els('statusPill').classList.contains('ready'), 'status pill ready');
    assert.match(String(p.els('statusText').textContent), /^ready/);
    assert.strictEqual(p.els('healthList').children.length, 5, '5 health rows');
    assert.ok(['ok','warn'].includes(p.els('fontPill').className), 'font pill: ' + p.els('fontPill').className);
    await flush(80);
    assert.ok(p.els('onboard').classList.contains('show'), 'onboarding visible on first run');
  } finally { p.close(); }
});

await t('2. settings: defaults, live toggles, persistence across reload', async () => {
  const storage = makeLocalStorage();
  const p1 = loadPanel({ storage });
  const homeDir = p1.machineHome;
  p1.close();

  const p = loadPanel({ storage, machineHome: homeDir });
  try {
    assert.strictEqual(p.els('capWords').classList.contains('active'), true);
    assert.strictEqual(p.els('capGroup').classList.contains('active'), false);
    assert.strictEqual(p.els('groupSize').disabled, true, 'groupSize disabled in words mode');
    assert.strictEqual(p.els('speakersToggle').checked, false);
    assert.strictEqual(p.els('srcClip').classList.contains('active'), true);

    p.els('capGroup').fire('click');
    assert.strictEqual(p.els('capGroup').classList.contains('active'), true);
    assert.strictEqual(p.els('capWords').classList.contains('active'), false);
    assert.strictEqual(p.els('groupSize').disabled, false);
    assert.strictEqual(JSON.parse(storage.getItem('amh.settings')||'{}').cap, 'grouped');

    p.els('speakersToggle').checked = true;
    p.els('speakersToggle').fire('change');
    p.els('srcWork').fire('click');
    p.els('groupSize').value = '5';
    p.els('groupSize').fire('input');
    p.els('maxChars').value = '60';
    p.els('maxChars').fire('input');
    const s = JSON.parse(storage.getItem('amh.settings')||'{}');
    assert.strictEqual(s.speakers, true);
    assert.strictEqual(s.source, 'work');
    assert.strictEqual(s.group, 5);
    assert.strictEqual(s.chars, 60);
    // reset group so cache key stays deterministic
    p.els('groupSize').value = '3'; p.els('groupSize').fire('input');

    // reload: shared storage + same machine home
    const p2 = loadPanel({ storage, machineHome: homeDir, folderDialog: () => ({err:1}) });
    try {
      assert.strictEqual(p2.els('capGroup').classList.contains('active'), true, 'cap grouped remembered');
      assert.strictEqual(p2.els('speakersToggle').checked, true, 'speakers remembered');
      assert.strictEqual(p2.els('groupSize').disabled, false, 'syncStyleControls on reload');
      assert.strictEqual(p2.els('srcWork').classList.contains('active'), true, 'source remembered');
    } finally { p2.close(); }
  } finally { p.close(); }
});

await t('3. license: initial trial, bad keys, activation', async () => {
  const p = loadPanel();
  try {
    await flush(5);
    assert.strictEqual(p.els('runBtn').disabled, false);
    assert.ok(/Trial: 2 free transcription/.test(p.els('licenseStatus').textContent), 'trial text: ' + p.els('licenseStatus').textContent);

    // empty key
    p.els('licenseInput').value = '   ';
    p.els('licenseActivate').fire('click');
    assert.strictEqual(p.els('licenseStatus').textContent, 'Paste a license key first');

    // garbage
    p.els('licenseInput').value = 'hello';
    p.els('licenseActivate').fire('click');
    await flush(5);
    assert.strictEqual(p.els('licenseStatus').textContent, 'Invalid key format');

    // wrong machine
    p.els('licenseInput').value = mkKey('ffffffff','00000000','0123456789abcdef');
    p.els('licenseActivate').fire('click');
    await flush(5);
    assert.match(p.els('licenseStatus').textContent, /different machine/i);

    // valid key + server confirm -> Licensed
    const licFetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/validate')) return { ok:true, json:async()=>({valid:true}) };
      if (u.includes('/api/trial'))    return { ok:true, json:async()=>({used:0}) };
      return { ok:true, json:async()=>({ok:true}) };
    };
    const p2 = loadPanel({ storage: p.storage, machineHome: p.machineHome, fetch: licFetch, folderDialog: () => ({err:1}) });
    try {
      p2.els('licenseInput').value = mkKey(p.mid, '00000000', '0123456789abcdef');
      p2.els('licenseActivate').fire('click');
      await flush(30);
      assert.strictEqual(p2.els('licenseStatus').textContent, 'Licensed');
      assert.strictEqual(p2.els('runBtn').disabled, false);
      assert.strictEqual(p2.els('machineIdSection').style.display, 'none');
      assert.strictEqual(p2.els('licensedNote').style.display, 'block');
      // main.js must append the success message even when the log box is
      // empty (fresh panel), so it is the on-screen confirmation.
      assert.strictEqual(JSON.parse(p2.storage.getItem('amh.license') || 'null').valid, true);
      assert.ok(/License activated successfully./.test(p2.els('logBox').textContent),
        'activation message appended to log');
    } finally { p2.close(); }
  } finally { p.close(); }
});

await t('4. license: exhausted trial blocks Generate', async () => {
  const storage = makeLocalStorage();
  storage.setItem('amh.trial.used', '2');
  const p = loadPanel({ storage });
  try {
    await flush(10);
    assert.strictEqual(p.els('runBtn').disabled, true, 'Generate disabled');
    assert.ok(/Trial used/.test(p.els('licenseStatus').textContent), 'trial-used banner');
    assert.strictEqual(p.els('trialBanner').style.display, 'block');
    p.els('runBtn').fire('click');
    await flush(10);
    assert.ok(/free trial \(2 transcriptions\) is used up/.test(p.els('logBox').textContent), 'gate logged');
    assert.strictEqual(p.els('runBtn').disabled, true, 'still disabled');
  } finally { p.close(); }
});

await t('5. review: cache-hit transcribe -> edit -> export (speaker tags) -> nudge -> add -> discard', async () => {
  const fixture = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  assert.ok(fs.existsSync(fixture), 'fixture present');
  const key = cacheKeyFor(fixture, { cap:'words', group:3, chars:42, speakers:false });
  const snap = snapshotCache();
  try {
    const base = snap !== null ? JSON.parse(snap) : {};
    base[key] = { srt: CACHE_SEED_SRT, transcript: '', at: Date.now() };
    restoreCache(JSON.stringify(base));

    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_dom_export_'));
    const p = loadPanel({ folderDialog: () => ({err:0, data:[exportDir]}) });
    try {
      await flush(10);
      p.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
      p.els('fileInput').fire('change');
      await flush(40);

      assert.ok(p.els('review').classList.contains('show'), 'review overlay open');
      assert.strictEqual(p.els('reviewList').children.length, 2, 'two captions listed');
      assert.strictEqual(p.els('reviewCount').textContent, '2 captions');

      // speaker label stripped in editor
      const row0 = p.els('reviewList').children[0];
      const ta0  = row0.children[2];
      assert.strictEqual(ta0.value, CUE1, 'first cue text in editor');

      // edit first caption
      const EDITED = '\u12e8\u1274\u1235\u1274\u12ab\u1208 \u1325\u123d\u134d\u134d \u12a5\u1295\u12f5\u1275 \u1290\u1205';
      ta0.value = EDITED;
      ta0.fire('input');

      // export to chosen folder
      p.els('reviewExport').fire('click');
      await flush(20);

      const srt = fs.readFileSync(path.join(exportDir, 'twospeaker.srt'), 'utf8');
      const vtt = fs.readFileSync(path.join(exportDir, 'twospeaker.vtt'), 'utf8');
      const txt = fs.readFileSync(path.join(exportDir, 'twospeaker.txt'), 'utf8');
      has(srt, '[S1] ' + EDITED, 'SRT edited cue with speaker tag');
      has(srt, '[S2] ' + CUE2,   'SRT second cue with speaker');
      assert.ok(srt.indexOf('00:00:01,000 --> 00:00:03,000') >= 0, 'SRT times present');
      has(vtt, '<v S1>' + EDITED + '</v>', 'VTT voice tag');
      has(txt, 'S1: ' + EDITED, 'TXT speaker line');

      // nudge first cue back 0.1s
      p.els('reviewList').children[0].children[1].children[0].fire('click');
      const rowB = p.els('reviewList').children[0];
      assert.strictEqual(rowB.children[0].children[0].value, '0:00.90', 'nudged start: ' + rowB.children[0].children[0].value);

      // add cue -> 3
      p.els('reviewAdd').fire('click');
      assert.strictEqual(p.els('reviewList').children.length, 3);
      assert.strictEqual(p.els('reviewCount').textContent, '3 captions');

      // discard closes
      p.els('reviewDiscard').fire('click');
      assert.ok(!p.els('review').classList.contains('show'), 'review closed');
      assert.ok(/Discarded/.test(p.els('logBox').textContent), 'discard logged');
    } finally {
      p.close();
      try { fs.rmSync(exportDir, { recursive:true, force:true }); } catch(e) {}
    }
  } finally { restoreCache(snap); }
});


console.log('\n' + (fail===0 ? 'ALL PASS' : 'FAILURES: '+fail) + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail===0 ? 0 : 1);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
