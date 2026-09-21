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
    const modelOk = fs.existsSync(path.join(base,'model')) || fs.existsSync(path.join(base,'ethio-asr'));
    const binOk   = fs.existsSync(path.join(base,'bin','ffmpeg'))   || fs.existsSync(path.join(base,'bin','ffmpeg.exe'));
    const pyOk    = fs.existsSync(path.join(base,'python','bin','python3')) || fs.existsSync(path.join(base,'python','python.exe'));
    return modelOk && binOk && pyOk;
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
    if (rec && /^[0-9a-f]{8}$/.test(rec.id)) mid = rec.id;
  } catch (e) {}

  return {
    document, storage, machineHome, mid,
    els: (id) => document.getElementById(id),
    // Evaluate an expression inside the main.js vm context (e.g. fetch a
    // function declaration by name: evalVm('clipCacheKey')).
    evalVm: (code) => vm.runInContext(code, ctx),
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
    assert.strictEqual(p.els('panelVersion').textContent, '1.4.26');
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

await t('3.5 license: forged license refused — signed-lease migration window', async () => {
  // (a) Legacy-shaped forgery (the audit #4 bypass) aged beyond the 30-day
  // migration grace → refused, trial path enforced. Regression test.
  const forged = makeLocalStorage();
  forged.setItem('amh.trial.used', '2'); // exhaust trial so Generate must stay locked
  forged.setItem('amh.license', JSON.stringify({
    key: mkKey('00000000', '00000000', '0123456789abcdef'),
    valid: true, serverValidated: true,
    activated: Date.now() - 31 * 86400000, // too old even if it WERE server-legit
  }));
  const pf = loadPanel({ storage: forged });
  try {
    await flush(30); // let boot assessLicense() run (WebCrypto verify)
    assert.strictEqual(pf.els('runBtn').disabled, true, 'forged beyond-grace license must NOT enable Generate');
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

await t('3.6 license: legacy install upgraded to a signed token on boot', async () => {
  // A pre-token buyer within grace, online: the panel must silently re-validate
  // and STORE the server-minted token (migration completes on its own). Token
  // verification itself is covered by the real-keypair unit tests in
  // test_panel.js; here we mirror field logic (3.5c) for the success path.
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
    assert.ok(stored && stored.token, 'legacy license upgraded to a token');
    assert.ok(stored.activated > 0 && String(stored.activated).length > 10, 'original activated date preserved');
    p.evalVm('verifyLicenseToken = async (t, pk, m) => ({ ok: true, expiry: "00000000" });');
    await p.evalVm('assessLicense()');
    p.evalVm('updateLicenseUI()');
    assert.strictEqual(p.els('runBtn').disabled, false, 'still licensed after upgrade');
    assert.strictEqual(p.els('licensedNote').style.display, 'block');
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

console.log('\n' + (fail===0 ? 'ALL PASS' : 'FAILURES: '+fail) + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail===0 ? 0 : 1);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
