#!/usr/bin/env node
/*
 * test_panel_dom.js — DOM-level tests for panel/js/main.js.
 *
 * Loads main.js (plus core.js) inside Node's vm with a minimal no-dependency
 * DOM shim (tools/test/dom_shim.js), then drives the panel as a browser would:
 * segmented-control clicks, settings persistence across a reload, the license
 * gate (bad keys, trial exhausted, activation), a full cache-hit
 * transcribe -> review -> edit -> export path writing real SRT/VTT/TXT files
 * to a temp folder with speaker tags intact, and the per-clip batch cache:
 * a sequence run serves unchanged clips from the single-clip-entry cache and
 * re-transcribes only the clips whose key changed. Warm-worker IO is faked
 * (opts.hooks warmStart/warmSend) so no python process is needed.
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
    const modelOk = fs.existsSync(path.join(base,'model','model_meta.json')) || fs.existsSync(path.join(base,'ethio-asr','config.json'));
    const binOk   = fs.existsSync(path.join(base,'bin','ffmpeg'))   || fs.existsSync(path.join(base,'bin','ffmpeg.exe'));
    const pyOk    = fs.existsSync(path.join(base,'python','bin','python3')) || fs.existsSync(path.join(base,'python','python.exe'));
    const featureOk = ['amh_lm.py','amh_lm.json.gz','amh_vad.py','silero_vad.onnx','amh_diarize.py','speaker_embed.onnx']
      .every((f) => fs.existsSync(path.join(base, f)));
    return modelOk && binOk && pyOk && featureOk;
  };
  for (const base of roots) { const c = path.join(base,'runtime'); if (complete(c)) return c; }
  if (complete(path.join(DEV,'runtime'))) return path.join(DEV,'runtime');
  if (fs.existsSync(path.join(DEV,'ethio_srt.py'))) return DEV;
  // Portable last resort: REPO is derived from this file's own location
  // (path.resolve(__dirname, '..', '..')), so it's correct in ANY checkout —
  // local dev under a differently-named folder, a fresh clone, or a CI
  // runner (whose $HOME never matches the hardcoded DEV guess above, so a
  // freshly checked-out CI repo used to throw here before this fallback
  // existed). MODEL_DIR only ever feeds a cache-key hash in this file, never
  // reads from disk, so it doesn't need to actually exist.
  if (fs.existsSync(path.join(REPO,'ethio_srt.py'))) return REPO;
  throw new Error('cannot replicate runtime detection');
}
const RUNTIME   = detectRuntime();
const MODEL_DIR = (RUNTIME === DEV || RUNTIME === REPO) ? path.join(RUNTIME,'ethio-asr') : path.join(RUNTIME,'model');

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
const defaultCsiReply = {ok:true,captionItemName:'Caption',placed:true,requestedStart:0,landedStart:1,landedEnd:3,note:null};

function loadPanel(opts) {
  opts = opts || {};
  const prevHome  = process.env.AMH_MACHINE_HOME;
  const storage   = opts.storage || makeLocalStorage();
  // New installs default to Amharic; these tests assert the English strings,
  // so pin English unless a test chose a language itself.
  if (!storage.getItem('amh.lang')) storage.setItem('amh.lang', 'en');
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
    CSInterface: class { evalScript(jsx,cb) {
      if (opts.evalLog) opts.evalLog.push(jsx);
      cb(JSON.stringify(opts.csiReply || defaultCsiReply));
    } },
    cep: { fs:{ showOpenDialog(){ return opts.folderDialog ? opts.folderDialog() : {err:1}; } },
            util:{ openURLInDefaultBrowser(){} } },
    __adobe_cep__:{
      getHostEnvironment(){ return JSON.stringify({appName: opts.hostApp || 'PPRO', appSkinInfo:{appBackgroundColor:{red:30,green:30,blue:30}}}); },
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
  vm.runInContext(fs.readFileSync(path.join(PANEL_JS,'i18n.js'),'utf8'),  ctx);
  vm.runInContext(fs.readFileSync(path.join(PANEL_JS,'main.js'),'utf8'),  ctx);

  // Optional warm-worker fakes (so batch-transcribe tests never spawn python).
  // main.js's function declarations are writable globals, so reassigning them
  // here bypasses the real warmStart()/warmSend() transport entirely.
  if (opts.hooks) {
    ctx.__hooks = opts.hooks;
    vm.runInContext('warmStart = __hooks.warmStart; warmSend = __hooks.warmSend;', ctx);
  }

  let mid = null;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(machineHome,'.amharic_captions_machine.json'),'utf8'));
    if (rec && /^(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(rec.id)) mid = rec.id;
  } catch (e) {}

  return {
    document, storage, machineHome, mid,
    els: (id) => document.getElementById(id),
    // Evaluate an expression inside the main.js vm context (e.g. fetch a
    // function declaration by name: evalVm('clipCacheKey')).
    evalVm: (code) => vm.runInContext(code, ctx),
    close() {
      // Assigning undefined to process.env stores the string "undefined",
      // which later panels treat as a relative home dir (./undefined/).
      if (prevHome === undefined) delete process.env.AMH_MACHINE_HOME;
      else process.env.AMH_MACHINE_HOME = prevHome;
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
    assert.ok(p.mid && /^(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(p.mid), 'machine id created');
    assert.strictEqual(p.els('machineIdDisplay').textContent, p.mid);
    assert.strictEqual(p.document.documentElement.getAttribute('data-theme'), 'dark');
    assert.strictEqual(p.els('panelVersion').textContent, '1.7.1');
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
      if (u.includes('/api/validate')) return { ok:true, json:async()=>({valid:true, token:'v1.b1b2c3d400000000.' + '0'.repeat(128)}) };
      if (u.includes('/api/trial'))    return { ok:true, json:async()=>({used:0}) };
      return { ok:true, json:async()=>({ok:true}) };
    };
    const p2 = loadPanel({ storage: p.storage, machineHome: p.machineHome, fetch: licFetch, folderDialog: () => ({err:1}) });
    try {
      p2.evalVm('verifyLicenseToken = async (t, pk, m) => ({ ok: true, expiry: "00000000" });');
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
      assert.ok(fs.existsSync(path.join(p2.machineHome, '.amharic_captions_license.json')),
        'activation persists a durable license file');
      assert.ok(/License activated successfully./.test(p2.els('logBox').textContent),
        'activation message appended to log');
    } finally { p2.close(); }
  } finally { p.close(); }
});

await t('3.5 license: unsigned legacy state is always refused', async () => {
  // Legacy-shaped state is not a license. It is rejected even when its
  // timestamp is current or in the future.
  const forged = makeLocalStorage();
  forged.setItem('amh.trial.used', '2');
  forged.setItem('amh.license', JSON.stringify({
    key: mkKey('00000000', '00000000', '0123456789abcdef'),
    valid: true, serverValidated: true,
    activated: Date.now() + 365 * 86400000,
  }));
  const pf = loadPanel({ storage: forged });
  try {
    await flush(30);
    assert.strictEqual(pf.els('runBtn').disabled, true, 'unsigned legacy state must NOT enable Generate');
    assert.ok(/Trial used/.test(pf.els('licenseStatus').textContent), 'shows trial-exhausted state: ' + pf.els('licenseStatus').textContent);
    assert.strictEqual(pf.els('licensedNote').style.display, 'none', 'no licensed note');
  } finally { pf.close(); }

  // (b) Present-but-forged token: verify FAILS → license invalidated, no fallback.
  const badTok = makeLocalStorage();
  badTok.setItem('amh.trial.used', '2');
  badTok.setItem('amh.license', JSON.stringify({
    valid: true, token: 'v1.a1b2c3d400000000.' + 'f'.repeat(128),
  }));
  const pb = loadPanel({ storage: badTok });
  try {
    await flush(30);
    assert.strictEqual(JSON.parse(pb.storage.getItem('amh.license') || 'null').valid, false, 'invalid token clears valid');
    assert.strictEqual(pb.els('runBtn').disabled, true, 'bad token must NOT enable Generate');
  } finally { pb.close(); }

  // (c) Valid server-signed token path: locally verified → Licensed.
  const good = makeLocalStorage();
  const pg = loadPanel({ storage: good });
  try {
    pg.evalVm('verifyLicenseToken = async (t, pk, m) => ({ ok: true, expiry: "00000000" });');
    pg.storage.setItem('amh.license', JSON.stringify({ valid: false, token: 'v1.' + 'b1b2b3b4' + '00000000' + '.' + '0'.repeat(128) }));
    await pg.evalVm('assessLicense()');
    pg.evalVm('updateLicenseUI()');
    assert.strictEqual(pg.els('runBtn').disabled, false, 'signed token enables Generate');
    assert.strictEqual(pg.els('licensedNote').style.display, 'block');
    assert.strictEqual(pg.els('licenseStatus').textContent, 'Licensed');
  } finally { pg.close(); }
});

await t('3.6 license: legacy state is not silently upgraded or trusted', async () => {
  // Unsigned client state cannot be migrated securely. The customer must
  // activate a key online once and receive a signed lease.
  const legacy = makeLocalStorage();
  legacy.setItem('amh.trial.used', '2');
  legacy.setItem('amh.license', JSON.stringify({
    key: mkKey('00000000', '00000000', '0123456789abcdef'),
    valid: true, serverValidated: true, activated: Date.now() - 5 * 86400000,
  }));
  const migFetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/validate')) return { ok:true, json:async()=>({valid:true, token:'v1.b1b2b3b400000000.' + '0'.repeat(128)}) };
    return { ok:true, json:async()=>({ok:true}) };
  };
  const p = loadPanel({ storage: legacy, fetch: migFetch, folderDialog: () => ({err:1}) });
  try {
    await flush(40);
    const stored = JSON.parse(p.storage.getItem('amh.license') || 'null');
    assert.ok(!stored.token, 'legacy state must not be upgraded without explicit activation');
    assert.strictEqual(p.els('runBtn').disabled, true, 'legacy state must not enable Generate');
    assert.strictEqual(p.els('licensedNote').style.display, 'none', 'no licensed note');
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


await t('5b. review: Premiere placement=false keeps review open and reports failure', async () => {
  const fixture = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  const key = cacheKeyFor(fixture, { cap:'words', group:3, chars:42, speakers:false });
  const snap = snapshotCache();
  try {
    const base = snap !== null ? JSON.parse(snap) : {};
    base[key] = { srt: CACHE_SEED_SRT, transcript: '', at: Date.now() };
    restoreCache(JSON.stringify(base));
    const p = loadPanel({
      csiReply: { ok:true, captionItemName:'Caption', placed:false,
        requestedStart:0, landedStart:null, landedEnd:null,
        note:'all Premiere placement methods failed' }
    });
    try {
      await flush(10);
      p.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
      p.els('fileInput').fire('change');
      await flush(40);
      assert.ok(p.els('review').classList.contains('show'), 'review opens before placement');
      p.els('reviewPlace').fire('click');
      await flush(30);
      assert.ok(p.els('review').classList.contains('show'), 'review stays open when placement fails');
      assert.ok(/ERROR|Premiere|placement/i.test(p.els('logBox').textContent), 'failure is visible');
      assert.ok(!/Captions added/.test(p.els('logBox').textContent), 'no false success message');
    } finally { p.close(); }
  } finally { restoreCache(snap); }
});

await t('5c. trial: authoritative charge denial blocks review and placement', async () => {
  const fixture = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  const key = cacheKeyFor(fixture, { cap:'words', group:3, chars:42, speakers:false });
  const snap = snapshotCache();
  try {
    const base = snap !== null ? JSON.parse(snap) : {};
    base[key] = { srt: CACHE_SEED_SRT, transcript: '', at: Date.now() };
    restoreCache(JSON.stringify(base));
    const p = loadPanel({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('/api/trial?')) return { ok:true, json:async()=>({used:0, max:2, remaining:2}) };
        if (u.includes('/api/trial/use')) return { ok:true, json:async()=>({used:2, max:2, remaining:0, charged:false}) };
        return { ok:false, json:async()=>null };
      }
    });
    try {
      await flush(10);
      p.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
      p.els('fileInput').fire('change');
      await flush(50);
      assert.ok(!p.els('review').classList.contains('show'), 'denied trial charge never opens placement review');
      assert.ok(/not placed|trial credit/i.test(p.els('logBox').textContent), 'denial is visible to the user');
      assert.ok(!/Captions added/.test(p.els('logBox').textContent), 'no placement can occur after denial');
    } finally { p.close(); }
  } finally { restoreCache(snap); }
});

await t('6. batch cache: per-clip keys, unchanged clips served from cache, edit re-transcribes only the changed clip', async () => {
  const fast = path.join(REPO, 'tools', 'test', 'fixtures', 'fast.wav');
  const ts   = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  assert.ok(fs.existsSync(fast) && fs.existsSync(ts), 'fixtures present');

  // Fake warm worker: records which clips were (re-)transcribed and emits
  // deterministic per-clip cues tagged with a generation counter.
  const sends = [];
  const snap = snapshotCache();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_dom_batch_'));
  const out = (n) => path.join(outDir, 'o' + n + '.srt');
  try {
    const p = loadPanel({
      hooks: {
        warmStart: () => true,
        warmSend: async (req) => {
          sends.push(req.batch.map((b) => b.name));
          const gen = sends.length;
          const cues = req.batch.map((b) => ({
            start: b.offset + 0.5, end: b.offset + 2.5,
            text: 'clip ' + path.basename(b.name || 'clip', path.extname(b.name || '')) + ' gen' + gen
          }));
          fs.writeFileSync(req.out_srt, p.evalVm('srtFromCues')(cues), 'utf8');
          return { text: cues.map((c) => c.text).join('\n') };
        }
      }
    });
    try {
      const clipCacheKey = p.evalVm('clipCacheKey');
      const cacheKeyRef  = p.evalVm('cacheKey');
      const srtFromCues  = p.evalVm('srtFromCues');
      const transcribeBatch = p.evalVm('transcribeBatch');

      const itA = (o, d) => ({ name: 'fast.wav', sourcePath: fast, sourceIn: 0, duration: d, offset: o, cached: null, wav: fast });
      const itB = (o, d) => ({ name: 'twospeaker.wav', sourcePath: ts, sourceIn: 0, duration: d, offset: o, cached: null, wav: ts });

      // Seed a SINGLE-clip cache entry for A (whole-file key). The batch path
      // must serve A from it — clipCacheKey shares the single-clip dimensions.
      // cacheLoad() is lazy, so writing before the first transcribeBatch works.
      const seeded = JSON.parse(snap || '{}');
      seeded[cacheKeyRef(fast, { sourceIn: 0, duration: 3 }, 0)] =
        { srt: srtFromCues([{ start: 0.5, end: 2.5, text: 'single-clip cueA' }]), transcript: '', at: 0 };
      restoreCache(JSON.stringify(seeded));

      // Run 1: A is cached from the single-clip path, B is new → only B transcribed.
      const r1 = await transcribeBatch([itA(0, 3), itB(3, 4)], out(1), () => {});
      assert.strictEqual(r1.cached, false, 'run1 not all-cached');
      assert.deepStrictEqual(sends, [['twospeaker.wav']], 'run1 transcribes only the new clip');
      const s1 = fs.readFileSync(out(1), 'utf8');
      has(s1, 'single-clip cueA', 'run1 SRT carries the single-clip cue from cache');
      has(s1, 'clip twospeaker gen1', 'run1 B transcribed fresh');

      // Run 2: identical items → all cached, worker untouched, byte-identical SRT.
      const r2 = await transcribeBatch([itA(0, 3), itB(3, 4)], out(2), () => {});
      assert.strictEqual(r2.cached, true, 'run2 all-cached');
      assert.strictEqual(sends.length, 1, 'run2 re-transcribes nothing');
      assert.strictEqual(fs.readFileSync(out(2), 'utf8'), s1, 'run2 output identical to run1');

      // Run 3: B edited (duration 4 -> 6) → its key changes → only B resubmits.
      const keyB1 = clipCacheKey(itB(3, 4));
      const keyB2 = clipCacheKey(itB(3, 6));
      assert.notStrictEqual(keyB2, keyB1, 'edit changes the clip key');
      const r3 = await transcribeBatch([itA(0, 3), itB(3, 6)], out(3), () => {});
      assert.strictEqual(r3.cached, false, 'run3 not all-cached');
      assert.deepStrictEqual(sends, [['twospeaker.wav'], ['twospeaker.wav']], 'run3 re-sends only B');
      const s3 = fs.readFileSync(out(3), 'utf8');
      has(s3, 'single-clip cueA', 'run3 A still served from cache');
      has(s3, 'clip twospeaker gen2', 'run3 B re-transcribed with fresh cues');
      assert.strictEqual(s3.indexOf('clip twospeaker gen1'), -1, 'run3 stale B cues gone');

      // Granularity, not a global overwrite: the old B entry survives.
      const cache = JSON.parse(snapshotCache() || '{}');
      assert.ok(cache[keyB1] && cache[keyB1].srt, 'old B entry retained');
      assert.ok(cache[keyB2] && cache[keyB2].srt, 'new B entry stored');
    } finally { p.close(); }
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
    restoreCache(snap);
  }
});

await t('7. batch cache unit: key determinism, attribution windows, srtFromCues mirrors core', async () => {
  const p = loadPanel({ hooks: { warmStart: () => true, warmSend: async () => ({ ok: true }) } });
  try {
    const fast = path.join(REPO, 'tools', 'test', 'fixtures', 'fast.wav');
    const ts   = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
    const clipCacheKey  = p.evalVm('clipCacheKey');
    const attributeCues = p.evalVm('attributeCues');
    const srtFromCues   = p.evalVm('srtFromCues');
    const srtTextFromCues = p.evalVm('srtTextFromCues');

    const base = (src, d, o, si) => ({ name: src, sourcePath: src, sourceIn: si || 0, duration: d, offset: o || 0, cached: null });
    const k = (it) => clipCacheKey(it);
    assert.strictEqual(k(base(fast, 3, 0)), k(base(fast, 3, 0)), 'same path/range/offset -> same key');
    assert.notStrictEqual(k(base(fast, 3, 0)), k(base(fast, 5, 0)),   'duration change busts key');
    assert.notStrictEqual(k(base(fast, 3, 0)), k(base(fast, 3, 2)),   'offset change busts key');
    assert.notStrictEqual(k(base(fast, 3, 0)), k(base(fast, 3, 0, 1)), 'sourceIn change busts key');
    assert.notStrictEqual(k(base(fast, 3, 0)), k(base(ts, 3, 0)),     'source path change busts key');

    const items = [{ offset: 0, duration: 3 }, { offset: 3, duration: 4 }];
    const byItem = attributeCues([
      { start: 2.9, end: 3.0, text: 'a' },   // inside A window
      { start: 3.0, end: 3.2, text: 'b' },   // exact A end; A wins the overlap (first match)
      { start: 0.0, end: 1.0, text: 'c' },   // A start
      { start: 3.6, end: 3.8, text: 'd' },   // past A's 0.5s right-slack -> B window
      { start: 9.5, end: 10.0, text: 'e' }   // nearest fallback -> B
    ], items);
    // Spread into host arrays: vm-realm Arrays carry a different Array.prototype,
    // so deepStrictEqual would reject them on prototype identity alone.
    const gotA = [...byItem.get(items[0]).map((c) => c.text)];
    const gotB = [...byItem.get(items[1]).map((c) => c.text)];
    assert.deepStrictEqual(gotA, ['a', 'b', 'c'], 'clip A attribution');
    assert.deepStrictEqual(gotB, ['d', 'e'], 'clip B attribution');

    const cues = [
      { start: 1.25, end: 3.0, text: '\u1200\u120e \u12e3\u120d\u121d' },
      { start: 5.0, end: 6.5, text: '\u12a5\u1295\u12f0\u120d\u1293' }
    ];
    const formatted = srtFromCues(cues);
    assert.strictEqual(formatted, srtTextFromCues(cues), 'srtFromCues mirrors the core disk writer');
    has(formatted, '1\n00:00:01,250 --> 00:00:03,000', 'SRT block one');
    has(formatted, '2\n00:00:05,000 --> 00:00:06,500', 'SRT block two');
  } finally { p.close(); }
});


// A work area normally contains clips that play AT THE SAME TIME: dialogue
// plus a music bed, a J-cut, B-roll audio over an interview, a duplicated
// safety track. attributeCues() can only guess which clip produced a cue from
// its start time, so for overlapping clips it hands every cue to the first one.
// That used to duplicate captions on the second run: the second clip cached
// nothing, an empty entry reads back as a MISS, so it was transcribed again
// while the first clip replayed the same cues from cache — 3 captions became 6.
await t('8. work area: overlapping clips must not duplicate captions on re-run', async () => {
  const p = loadPanel({ hooks: { warmStart: () => true, warmSend: async () => ({ ok: true }) } });
  try {
    const overlappingItems = p.evalVm('overlappingItems');
    const it = (name, o, d) => ({ name, sourcePath: '/tmp/' + name, sourceIn: 0, duration: d, offset: o, cached: null });

    // adjacent clips (A ends exactly where B starts) are NOT overlapping —
    // this is the ordinary cut, and it must keep caching as before (test 6).
    const adjacent = [it('a.mov', 0, 3), it('b.mov', 3, 4)];
    assert.strictEqual(overlappingItems(adjacent).size, 0, 'a clean cut is not an overlap');

    // dialogue + music bed over the same 30s
    const stacked = [it('dialogue.mov', 0, 30), it('music.mp3', 0, 30)];
    assert.strictEqual(overlappingItems(stacked).size, 2, 'stacked tracks flagged');

    // J-cut: audio pulled 2s ahead of the video it belongs to
    const jcut = [it('iv_audio.mov', 8, 12), it('iv_video.mov', 10, 10)];
    assert.strictEqual(overlappingItems(jcut).size, 2, 'J-cut flagged');

    // a clip fully inside another (B-roll audio under a long interview)
    const nested = [it('long.mov', 0, 60), it('broll.mov', 10, 5)];
    assert.strictEqual(overlappingItems(nested).size, 2, 'nested clip flagged');

    // only the overlapping pair is penalised; an unrelated clip still caches
    const mixed = [it('d.mov', 0, 30), it('m.mp3', 0, 30), it('tail.mov', 40, 5)];
    const bad = overlappingItems(mixed);
    assert.strictEqual(bad.size, 2, 'only the overlapping pair is flagged');
    assert.ok(!bad.has(mixed[2]), 'the disjoint clip is still cacheable');
  } finally { p.close(); }
});


// End-to-end proof of the same bug through transcribeBatch: two clips that
// share timeline time, transcribed twice. The second run must produce exactly
// the same captions as the first, not double them.
await t('9. work area: second run over stacked clips returns identical captions', async () => {
  const fmtTs = (s) => {
    const ms = Math.round(s * 1000);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const mm = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
    const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return hh + ':' + mm + ':' + ss + ',' + String(ms % 1000).padStart(3, '0');
  };
  const sends = [];
  const hooks = {
    warmStart: () => true,
    warmSend: async (req) => {
      sends.push(req.batch.map((b) => b.name));
      // Fake engine: emit one cue per submitted clip, at its own offset.
      const cues = req.batch.map((b) => ({ start: b.offset + 1, end: b.offset + 2, text: 'cue ' + b.name }));
      fs.writeFileSync(req.out_srt, cues.map((c, i) =>
        [i + 1, fmtTs(c.start) + ' --> ' + fmtTs(c.end), c.text, ''].join('\n')).join('\n'), 'utf8');
      return { ok: true, text: '' };
    },
  };
  const p = loadPanel({ hooks });
  try {
    const transcribeBatch = p.evalVm('transcribeBatch');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_overlap_'));
    const out = (n) => path.join(outDir, 'o' + n + '.srt');
    // dialogue and music both occupy 0..30s — the ordinary "music bed" edit
    const mk = () => ([
      { name: 'dialogue.mov', sourcePath: path.join(REPO, 'tools/test/fixtures/fast.wav'),
        sourceIn: 0, duration: 30, offset: 0, cached: null, wav: 'd.wav' },
      { name: 'music.mp3', sourcePath: path.join(REPO, 'tools/test/fixtures/twospeaker.wav'),
        sourceIn: 0, duration: 30, offset: 0, cached: null, wav: 'm.wav' },
    ]);

    const r1 = await transcribeBatch(mk(), out(1), () => {});
    const r2 = await transcribeBatch(mk(), out(2), () => {});

    assert.strictEqual(r1.cues.length, 2, 'run1 yields one cue per clip');
    assert.strictEqual(r2.cues.length, r1.cues.length,
      'run2 must NOT duplicate captions (was 4 instead of 2 before the overlap guard)');
    assert.strictEqual(fs.readFileSync(out(2), 'utf8'), fs.readFileSync(out(1), 'utf8'),
      'run2 SRT is byte-identical to run1');
    assert.strictEqual(r2.cached, false, 'overlapping clips are never served from cache');
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {}
  } finally { p.close(); }
});


await t('8. review: empty list renders (no ReferenceError) when filter matches nothing', async () => {
  // Regression guard: renderReview()'s empty-state branch referenced a local
  // `filter` variable that a later refactor removed, so under 'use strict'
  // it threw "ReferenceError: filter is not defined" any time the list
  // rendered zero rows — a filter with no matches, or every cue deleted.
  // No existing test hit the zero-row path, so it shipped unnoticed.
  const fixture = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  const key = cacheKeyFor(fixture, { cap:'words', group:3, chars:42, speakers:false });
  const snap = snapshotCache();
  try {
    const base = snap !== null ? JSON.parse(snap) : {};
    base[key] = { srt: CACHE_SEED_SRT, transcript: '', at: Date.now() };
    restoreCache(JSON.stringify(base));

    const p = loadPanel({});
    try {
      await flush(10);
      p.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
      p.els('fileInput').fire('change');
      await flush(40);
      assert.strictEqual(p.els('reviewList').children.length, 2, 'two captions to start');

      // 1) filter that matches nothing -> empty state, must not throw
      p.els('reviewSearch').value = 'zzzz-no-such-caption';
      p.els('reviewSearch').fire('input');
      const list = p.els('reviewList');
      assert.strictEqual(list.children.length, 1, 'only the empty-state row is rendered');
      has(list.children[0].textContent, 'zzzz-no-such-caption',
        'empty state names the active filter');

      // 2) clear the filter, then delete every cue -> the other empty branch
      p.els('reviewSearch').value = '';
      p.els('reviewSearch').fire('input');
      const del = () => p.els('reviewList').children[0].children[3];
      del().fire('click');
      del().fire('click');
      assert.strictEqual(p.els('reviewList').children.length, 1, 'empty-state row after deleting all');
      has(p.els('reviewList').children[0].textContent, 'No captions yet',
        'empty state prompts to add a cue');
    } finally { p.close(); }
  } finally { restoreCache(snap); }
});

await t('9. license survives a CEP localStorage wipe (Premiere upgrade)', async () => {
  // CEP keeps localStorage in a cache dir keyed by the HOST VERSION:
  //   ~/Library/Caches/CSXS/cep_cache/PPRO_<ver>_com.amharic.captions.panel/
  // so upgrading Premiere hands the panel an empty store. The license used to
  // live only there, which silently de-licensed paying customers with no way
  // back (the server has no mid-only lookup). It must now round-trip through
  // the home-dir file. Observed in the wild 2026-09-22.
  const machineHome = fs.mkdtempSync(path.join(os.tmpdir(),'amh_dom_lic_'));
  const licFile = path.join(machineHome, '.amharic_captions_license.json');
  try {
    const lic = { token: 'fake.lease.token', valid: true, serverValidated: true, activated: Date.now() };

    // 1) a license saved by the panel is written to the durable file
    let p = loadPanel({ machineHome });
    try {
      p.evalVm('setLicense(' + JSON.stringify(lic) + ')');
      assert.ok(fs.existsSync(licFile), 'setLicense writes the home-dir file');
      assert.strictEqual(JSON.parse(fs.readFileSync(licFile,'utf8')).token, lic.token,
        'durable file carries the lease token');
    } finally { p.close(); }

    // 2) reload with a COMPLETELY FRESH localStorage (the Premiere-upgrade
    //    case) -> the license is recovered from the file
    p = loadPanel({ machineHome, storage: makeLocalStorage() });
    try {
      const got = p.evalVm('JSON.stringify(getLicense())');
      assert.ok(got && got !== 'null', 'license recovered after a localStorage wipe');
      assert.strictEqual(JSON.parse(got).token, lic.token, 'recovered lease token matches');
      // and the cache is re-seeded so the rest of the session is normal
      assert.ok(p.storage.getItem('amh.license'), 'localStorage cache re-seeded from the file');
    } finally { p.close(); }

    // 3) no file and no localStorage -> genuinely unlicensed (fails closed)
    fs.rmSync(licFile, { force: true });
    p = loadPanel({ machineHome, storage: makeLocalStorage() });
    try {
      assert.strictEqual(p.evalVm('JSON.stringify(getLicense())'), 'null',
        'no durable copy and no cache means unlicensed');
    } finally { p.close(); }
  } finally { fs.rmSync(machineHome,{recursive:true,force:true}); }
});

await t('9b. license: failed online revalidation does not start the 24h retry interval', async () => {
  const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_dom_recheck_'));
  try {
    const p = loadPanel({
      machineHome,
      fetch: async () => ({ ok: false, json: async () => null }),
    });
    try {
      p.storage.setItem('amh.license', JSON.stringify({ key: mkKey(p.mid, '00000000', '0123456789abcdef'), token: 'v1.fake' }));
      p.storage.removeItem('amh.license.lastCheck');
      await p.evalVm('revalidateLicenseOnline(true)');
      await flush(5);
      assert.strictEqual(p.storage.getItem('amh.license.lastCheck'), null,
        'network failure leaves revocation retry due immediately');
    } finally { p.close(); }
  } finally { fs.rmSync(machineHome, { recursive: true, force: true }); }
});

await t('10. single-clip progress: engine window lines drive the bar', async () => {
  // A single clip is the DEFAULT source, and its bar used to be parked at a
  // fixed 40% for the whole transcription — a ten-minute interview looked
  // identical to a hang. The engine now streams `[progress] done/total` per
  // ~20s window; these assert the panel actually consumes it.
  const p = loadPanel({});
  try {
    // Arrays built inside the vm have that realm's prototype, so compare
    // primitives rather than deepStrictEqual across the boundary.
    p.evalVm('__seen = []; windowProgress = (d, t) => { __seen.push(d + "/" + t); };');

    // a well-formed line is consumed (returns true) and reported
    assert.strictEqual(p.evalVm('consumeProgressLine("[progress] 3/12")'), true,
      'progress line is recognised');
    assert.strictEqual(p.evalVm('__seen[__seen.length-1]'), '3/12',
      'done/total parsed and forwarded');

    // it must be CONSUMED, not logged — one line per window would bury real
    // messages in the log on a long clip
    assert.strictEqual(p.evalVm('consumeProgressLine("[progress] 12/12")'), true,
      'final progress line consumed');

    // ordinary engine chatter must pass through untouched
    assert.strictEqual(p.evalVm('consumeProgressLine("[info] loading audio: x.wav")'), false,
      'non-progress stderr is not swallowed');
    assert.strictEqual(p.evalVm('consumeProgressLine("Traceback (most recent call last):")'), false,
      'a crash line is never swallowed');

    // malformed variants must not throw or report
    const before = p.evalVm('__seen.length');
    assert.strictEqual(p.evalVm('consumeProgressLine("[progress] notanumber")'), false,
      'malformed progress line is not treated as progress');
    assert.strictEqual(p.evalVm('__seen.length'), before,
      'malformed line reported nothing');

    // with no active reporter it is still consumed (batch runs drive their own
    // bar and must not be disturbed by stray lines)
    p.evalVm('windowProgress = null;');
    assert.strictEqual(p.evalVm('consumeProgressLine("[progress] 1/5")'), true,
      'consumed even with no reporter attached');
  } finally { p.close(); }
});

await t('11. a failed run says so on screen, not only in the log', async () => {
  // A failure used to print one ERROR line into a collapsed Log and reset the
  // bar to zero — visually identical to "nothing happened". The user clicks
  // Generate again, it fails again, and support gets "it doesn't work".
  const p = loadPanel({});
  try {
    // raw engine text is translated into something an editor can act on
    const cases = [
      ['audio too short (35 ms)', 'too short'],
      ['Python failed: worker exited', 'engine stopped'],
      ['ffmpeg failed with code 1', 'Could not read'],
      ['ENOSPC: no space left on device', 'disk is full'],
      ['runtime incomplete', 'runtime is missing'],
      ['something nobody predicted', 'Transcription failed'],
    ];
    for (const [raw, expect] of cases) {
      const got = p.evalVm('humanError(' + JSON.stringify(raw) + ')');
      has(got, expect, 'humanError(' + JSON.stringify(raw) + ') mentions "' + expect + '"');
    }

    // failRun puts the message where the user is looking AND flips the pill
    p.evalVm('failRun("Python failed: worker exited")');
    assert.strictEqual(p.els('statusText').textContent, 'failed',
      'status pill reports the failure');
    has(p.els('progLabel').textContent, 'engine stopped',
      'the human message is shown next to the Generate button');
    has(p.els('progLabel').textContent, 'Details for support',
      'and points at the support details for more');
  } finally { p.close(); }
});

await t('17. polish: Amharic errors/progress, compact idle UI, simple license states', async () => {
  const storage = makeLocalStorage();
  storage.setItem('amh.lang', 'am');
  storage.setItem('amh.trial.used', '0');
  const p = loadPanel({ storage });
  try {
    await flush(10);
    // idle: no empty progress row
    assert.strictEqual(p.els('progWrap').style.display, 'none', 'progress row hidden when idle');
    // running: row shows, text in Amharic
    p.evalVm("setBusy(true); setProgress(0.4, 'Transcribing 3/7 · about 2 min left')");
    assert.strictEqual(p.els('progWrap').style.display, '', 'progress row visible while running');
    assert.strictEqual(p.els('progLabel').textContent, 'ወደ ጽሑፍ በመቀየር ላይ 3/7 · ወደ 2 ደቂቃ ቀርቷል');
    p.evalVm('setBusy(false)');
    // failure: Amharic message, row stays visible because there is something to say
    p.evalVm('failRun("ffmpeg failed with code 1")');
    has(p.els('progLabel').textContent, 'የሚዲያ ፋይሉን ማንበብ አልተቻለም', 'failure in Amharic');
    assert.strictEqual(p.els('progWrap').style.display, '', 'failure message visible');
    // language switch re-renders the failure line
    p.evalVm("i18nSetLang('en')");
    has(p.els('progLabel').textContent, 'Could not read that media file', 'switch -> English');
    p.evalVm("i18nSetLang('am')");

    // Karaoke hides the words-per-caption field; Grouped shows it
    p.els('capWords').fire('click');
    assert.strictEqual(p.els('groupSizeField').style.display, 'none', 'karaoke: no words-per-caption');
    p.els('capGroup').fire('click');
    assert.strictEqual(p.els('groupSizeField').style.display, '', 'grouped: words-per-caption shown');

    // trial used up: said once (banner), not twice
    p.evalVm("localStorage.setItem('amh.trial.used','2'); updateLicenseUI()");
    assert.strictEqual(p.els('trialBanner').style.display, 'block');
    assert.strictEqual(p.els('licenseStatus').style.display, 'none', 'no duplicate status line');
    // licensed: thank-you note, no price in the footer, no redundant status line
    p.evalVm("LICENSED = true; LICENSE_NOTE = 'Licensed'; updateLicenseUI()");
    assert.strictEqual(p.els('footPrice').style.display, 'none', 'no price shown to payers');
    assert.strictEqual(p.els('licenseStatus').style.display, 'none');
    p.evalVm("LICENSE_NOTE = 'Licensed (expires 20271231)'; updateLicenseUI()");
    assert.strictEqual(p.els('licenseStatus').style.display, '', 'dated keys still show their date');
  } finally { p.close(); }

  // After Effects: the review button says composition, not timeline
  const ae = loadPanel({ hostApp: 'AEFT' });
  try {
    await flush(10);
    assert.strictEqual(ae.els('reviewPlace').textContent, '✓ Add to composition');
  } finally { ae.close(); }
});

await t('12. the boot ping really is once per day', async () => {
  // The comment claimed once per day; the code pinged on every panel open. At
  // one customer that is free. At ten thousand it is the difference between
  // fitting in a request budget and not — for telemetry nobody reads twice.
  const store = makeLocalStorage();
  let calls = 0;
  const fetchCounting = async (url) => {
    if (String(url).includes('/api/ping')) calls++;
    return { ok: false, json: async () => null };
  };

  let p = loadPanel({ storage: store, fetch: fetchCounting });
  try { p.evalVm('pingPanel()'); } finally { p.close(); }
  assert.strictEqual(calls, 1, 'first open pings');

  // reopening with the SAME storage must not ping again
  p = loadPanel({ storage: store, fetch: fetchCounting });
  try { p.evalVm('pingPanel()'); p.evalVm('pingPanel()'); } finally { p.close(); }
  assert.strictEqual(calls, 1, 'subsequent opens inside 24h do not ping');

  // a day later it pings again
  store.setItem('amh.lastPing', String(Date.now() - 25 * 60 * 60 * 1000));
  p = loadPanel({ storage: store, fetch: fetchCounting });
  try { p.evalVm('pingPanel()'); } finally { p.close(); }
  assert.strictEqual(calls, 2, 'pings again after 24h');

  // a clock that jumped backwards must not silence it forever
  store.setItem('amh.lastPing', String(Date.now() + 90 * 24 * 60 * 60 * 1000));
  p = loadPanel({ storage: store, fetch: fetchCounting });
  try { p.evalVm('pingPanel()'); } finally { p.close(); }
  assert.strictEqual(calls, 3, 'a future timestamp does not disable pings forever');
});

await t('13. language: Amharic by default, live switch to English and back', async () => {
  const storage = makeLocalStorage();
  storage.setItem('amh.lang', 'am');      // what a fresh install resolves to
  storage.setItem('amh.trial.used', '1');
  const p = loadPanel({ storage });
  try {
    await flush(10);
    assert.strictEqual(p.evalVm('i18nGetLang()'), 'am');
    assert.strictEqual(p.els('statusText').textContent, 'ዝግጁ', 'status pill in Amharic');
    has(p.els('licenseStatus').textContent, 'ሙከራ፦ 1', 'trial count in Amharic');

    p.evalVm("i18nSetLang('en')");
    assert.strictEqual(storage.getItem('amh.lang'), 'en', 'choice persisted');
    assert.strictEqual(p.els('statusText').textContent, 'ready', 'status re-rendered in English');
    assert.strictEqual(p.els('licenseStatus').textContent, 'Trial: 1 free transcription left');

    p.evalVm("i18nSetLang('am')");
    assert.strictEqual(p.els('statusText').textContent, 'ዝግጁ', 'and back to Amharic');
  } finally { p.close(); }
});

await t('14. After Effects: loads host_ae.jsx, AE wording, font + long timeout on placement', async () => {
  const evalLog = [];
  const p = loadPanel({ hostApp: 'AEFT', evalLog });
  try {
    await flush(10);
    assert.strictEqual(p.evalVm('HOST_APP'), 'AEFT');
    const load = evalLog.find((j) => /\$\.evalFile/.test(j));
    assert.ok(load, 'host_ae.jsx evaluated');
    assert.match(load, /jsx\/host_ae\.jsx"\)\)$/, 'forward-slash path, properly quoted: ' + load);
    assert.ok(evalLog.indexOf(load) === 0 || !evalLog.slice(0, evalLog.indexOf(load)).some((j) => /amh/.test(j)),
      'loaded before any host call');
    assert.strictEqual(p.els('srcClip').textContent, 'Selected Layer');
    assert.strictEqual(p.els('srcWhole').textContent, 'Whole Comp');
    p.evalVm("importCaptions('C:/x.srt', 3, 'clip')");
    const imp = evalLog.find((j) => /^amh_importCaptions\(/.test(j));
    const args = JSON.parse(JSON.parse(imp.slice('amh_importCaptions('.length, -1)));
    assert.deepStrictEqual(Object.keys(args).sort(), ['baseName', 'font', 'srtPath', 'startSeconds']);
  } finally { p.close(); }

  // Premiere never loads the AE layer and keeps its own wording.
  const pLog = [];
  const pp = loadPanel({ evalLog: pLog });
  try {
    await flush(10);
    assert.ok(!pLog.some((j) => /host_ae/.test(j)), 'Premiere does not load host_ae.jsx');
    assert.strictEqual(pp.els('srcClip').textContent === 'Selected Layer', false);
  } finally { pp.close(); }
});

await t('15. lite package: model missing -> download card, Generate blocked, finish unblocks', async () => {
  // Reshape the placeholder runtime into a lite one for this test only.
  const rt = path.join(REPO, 'runtime');
  const bundled = path.join(rt, 'model');
  const hidden = path.join(rt, 'model.hidden-by-test');
  const manPath = path.join(rt, 'model_manifest.json');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_models_'));
  const prevHome = process.env.AMH_MODEL_HOME;
  const man = { id: 'abc123def456', sources: [],
    files: [{ name: 'model.bin', size: 5, sha256: 'x' }, { name: 'model_meta.json', size: 2, sha256: 'y' }] };
  assert.ok(fs.existsSync(rt), 'placeholder runtime present');
  fs.renameSync(bundled, hidden);
  fs.writeFileSync(manPath, JSON.stringify(man));
  if (!fs.existsSync(path.join(rt, 'amh_model.py'))) fs.copyFileSync(path.join(REPO, 'amh_model.py'), path.join(rt, 'amh_model.py'));
  process.env.AMH_MODEL_HOME = home;
  try {
    const storage = makeLocalStorage();
    storage.setItem('amh.trial.used', '0');
    let p = loadPanel({ storage });
    try {
      await flush(10);
      assert.strictEqual(p.evalVm('MODEL_MISSING'), true);
      assert.strictEqual(p.els('statusText').textContent, 'model needed');
      assert.strictEqual(p.els('runBtn').disabled, true, 'Generate blocked even with trial credit');
      assert.strictEqual(p.els('modelCard').style.display, 'block', 'download card shown');
      has(p.els('modelBtn').textContent, 'Download the Amharic model (0 MB)');
      assert.strictEqual(p.evalVm('MODEL_DIR'), path.join(home, man.id), 'download target is the shared folder');

      // Pressing the button starts the downloader; with no sources (and a
      // placeholder python) it ends in the resumable "failed" state.
      p.els('modelBtn').fire('click');
      for (let i = 0; i < 100 && p.els('modelCard').getAttribute('data-state') === 'running'; i++) await flush(50);
      assert.strictEqual(p.els('modelCard').getAttribute('data-state'), 'failed');
      has(p.els('modelBtn').textContent, 'Resume download');

      // A finished download unblocks Generate without reopening the panel.
      p.evalVm("modelDownloadFinished(" + JSON.stringify(path.join(home, man.id)) + ")");
      assert.strictEqual(p.evalVm('MODEL_MISSING'), false);
      assert.strictEqual(p.els('runBtn').disabled, false, 'Generate enabled after download');
      assert.strictEqual(p.els('statusText').textContent, 'ready');
      assert.strictEqual(p.evalVm('AMH_ENV.AMH_MODEL_DIR'), path.join(home, man.id));
    } finally { p.close(); }

    // A completed earlier download is found on the next start.
    const d = path.join(home, man.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'model.bin'), '12345');
    fs.writeFileSync(path.join(d, 'model_meta.json'), '{}');
    fs.writeFileSync(path.join(d, 'complete.json'), JSON.stringify({ id: man.id }));
    p = loadPanel({ storage });
    try {
      await flush(10);
      assert.strictEqual(p.evalVm('MODEL_MISSING'), false);
      assert.strictEqual(p.evalVm('MODEL_DIR'), d);
      assert.strictEqual(p.els('modelCard').style.display, 'none');
    } finally { p.close(); }

    // A carried-forward bundled model that does not match the manifest is stale.
    fs.rmSync(d, { recursive: true, force: true });
    fs.renameSync(hidden, bundled);
    p = loadPanel({ storage });
    try {
      await flush(10);
      assert.strictEqual(p.evalVm('MODEL_MISSING'), true, 'size mismatch -> download needed');
    } finally { p.close(); }
    fs.renameSync(bundled, hidden);
  } finally {
    if (fs.existsSync(hidden)) fs.renameSync(hidden, bundled);
    fs.rmSync(manPath, { force: true });
    if (prevHome === undefined) delete process.env.AMH_MODEL_HOME; else process.env.AMH_MODEL_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await t('13b. language: an unset preference defaults to Amharic; unknown text falls back to English', async () => {
  const storage = makeLocalStorage();
  storage.setItem('amh.lang', 'am');
  const p = loadPanel({ storage });
  try {
    storage.removeItem('amh.lang');
    assert.strictEqual(p.evalVm('i18nGetLang()'), 'am', 'no stored choice -> Amharic');
    assert.strictEqual(p.evalVm("T('some brand-new English message')"), 'some brand-new English message');
    assert.strictEqual(p.evalVm("T('License expired on 2027-01-01')"), 'ፈቃዱ 2027-01-01 ላይ አብቅቷል');
    assert.strictEqual(p.evalVm("T('2 captions')"), '2 ካፕሽን');
  } finally { p.close(); }
});

console.log('\n' + (fail===0 ? 'ALL PASS' : 'FAILURES: '+fail) + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail===0 ? 0 : 1);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
