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

// Never touch the real ~/.amharic_captions_* files. loadPanel() points each
// panel at a temp home and restores the variable on close(), but a panel's
// async license check can finish AFTER close() — it once overwrote the dev
// PC's real license with a test lease. So the whole run defaults to a
// throwaway home, and the end of the run checks the real files are untouched.
const REAL_IDENTITY = ['.amharic_captions_license.json', '.amharic_captions_machine.json']
  .map((f) => path.join(os.homedir(), f));
const realIdentityState = () => REAL_IDENTITY.map((f) => {
  try { const s = fs.statSync(f); return f + ':' + s.size + ':' + s.mtimeMs; } catch (e) { return f + ':-'; }
}).join('|');
const REAL_IDENTITY_BEFORE = realIdentityState();
process.env.AMH_MACHINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_panel_home_'));

const CACHE_FILE = path.join(os.tmpdir(), 'amh_transcript_cache.json');
const ENGINE_FILES = ['ethio_srt.py','ctc_beam.py','amh_correct.py','amh_decode.py','amh_vad.py','amh_lm.py','amh_lm.json.gz'];

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
// The license server, with this computer's free minutes already given in the
// Telegram bot (1.10.7): 20 free minutes, each job charged in seconds.
const minutesState = (left, extra) => Object.assign({ mode: 'minutes', status: 'active', minutes: 20, seconds_total: 1200, seconds_left: left }, extra || {});
const trialServer = (opts) => {
  opts = opts || {};
  let left = opts.left === undefined ? 1200 : opts.left;
  const st = opts.status || 'active';
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/api/trial?v=2')) return { ok: true, json: async () => minutesState(left, { status: st }) };
    if (u.includes('/api/trial/use')) {
      const b = JSON.parse((init && init.body) || '{}');
      const give = st === 'active' && !opts.deny ? Math.min(b.seconds || 1, left) : 0;
      left -= give;
      if (opts.onUse) opts.onUse(b, give);
      return { ok: true, json: async () => minutesState(left, { status: st, charged: give > 0, seconds: give, ticket: give > 0 ? 't2.' + b.mid + '.' + b.run_id + '.9999999999.' + give + '.' + '0'.repeat(128) : undefined }) };
    }
    if (opts.more) { const r = opts.more(u, init); if (r) return r; }
    return { ok: false, json: async () => null };
  };
};
const defaultFetch = trialServer();
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
      if (opts.csiRaw) { cb(opts.csiRaw(jsx)); return; }
      cb(JSON.stringify(opts.csiReply || defaultCsiReply));
    } },
    cep: { fs:{ showOpenDialog(){ return opts.folderDialog ? opts.folderDialog() : {err:1}; } },
            util:{ openURLInDefaultBrowser(){} } },
    __adobe_cep__:{
      getHostEnvironment(){ return JSON.stringify({appName: opts.hostApp || 'PPRO', appSkinInfo:{appBackgroundColor:{red:30,green:30,blue:30}}}); },
      addEventListener(){},
      registerKeyEventsInterest(json){ if (opts.keyLog) opts.keyLog.push(json); },
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
    // The fake engine needs no permission (1.10.3 engineAuth is tested in 10e).
    vm.runInContext('engineAuth = async () => ({ lease: "test" });', ctx);
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
    assert.strictEqual(p.els('panelVersion').textContent, '1.10.9');
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
    assert.ok(p.els('fmtH').classList.contains('active'), 'horizontal by default');
    p.els('fmtV').fire('click');
    assert.ok(p.els('fmtV').classList.contains('active') && !p.els('fmtH').classList.contains('active'), 'vertical selected');
    const s = JSON.parse(storage.getItem('amh.settings')||'{}');
    assert.strictEqual(s.speakers, true);
    assert.strictEqual(s.source, 'work');
    assert.strictEqual(s.group, 5);
    assert.strictEqual(s.format, 'v', 'video shape saved');
    assert.strictEqual(s.chars, 22, 'vertical = short captions');
    // reset group so cache key stays deterministic
    p.els('groupSize').value = '3'; p.els('groupSize').fire('input');

    // reload: shared storage + same machine home
    const p2 = loadPanel({ storage, machineHome: homeDir, folderDialog: () => ({err:1}) });
    try {
      assert.strictEqual(p2.els('capGroup').classList.contains('active'), true, 'cap grouped remembered');
      assert.strictEqual(p2.els('speakersToggle').checked, true, 'speakers remembered');
      assert.strictEqual(p2.els('groupSize').disabled, false, 'syncStyleControls on reload');
      assert.strictEqual(p2.els('srcWork').classList.contains('active'), true, 'source remembered');
      assert.strictEqual(p2.els('fmtV').classList.contains('active'), true, 'video shape remembered');
    } finally { p2.close(); }
  } finally { p.close(); }
});

await t('3. license: initial trial, bad keys, activation', async () => {
  const p = loadPanel();
  try {
    await flush(5);
    assert.strictEqual(p.els('runBtn').disabled, false);
    assert.strictEqual(p.els('licenseStatus').textContent, 'Free trial: 20:00 minutes left', 'free minutes shown');

    // empty key
    p.els('licenseInput').value = '   ';
    p.els('licenseActivate').fire('click');
    assert.strictEqual(p.els('licenseStatus').textContent, 'Paste your activation code or license key first');

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
    let validateBody = null;
    const licFetch = async (url, o) => {
      const u = String(url);
      if (u.includes('/api/validate')) {
        validateBody = JSON.parse((o && o.body) || '{}');
        return { ok:true, json:async()=>({valid:true, token:'v1.b1b2c3d400000000.' + '0'.repeat(128)}) };
      }
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
      // which computer (not which internet address) — the server counts
      // computers per key to spot a license copied to friends
      assert.ok(validateBody && /^[0-9a-f]{8}$/.test(validateBody.hf || ''), 'activation sends the computer fingerprint: ' + JSON.stringify(validateBody && validateBody.hf));
      assert.strictEqual(validateBody.hf, p2.evalVm('hostFingerprint()'), 'the same one the machine record keeps');
    } finally { p2.close(); }
  } finally { p.close(); }
});

await t('3.5 license: unsigned legacy state is always refused', async () => {
  // Legacy-shaped state is not a license. It is rejected even when its
  // timestamp is current or in the future.
  const forged = makeLocalStorage();
  forged.setItem('amh.license', JSON.stringify({
    key: mkKey('00000000', '00000000', '0123456789abcdef'),
    valid: true, serverValidated: true,
    activated: Date.now() + 365 * 86400000,
  }));
  const pf = loadPanel({ storage: forged, fetch: trialServer({ left: 0 }) });
  try {
    await flush(30);
    assert.strictEqual(pf.els('runBtn').disabled, true, 'unsigned legacy state must NOT enable Generate');
    assert.ok(/Trial used/.test(pf.els('licenseStatus').textContent), 'shows trial-exhausted state: ' + pf.els('licenseStatus').textContent);
    assert.strictEqual(pf.els('licensedNote').style.display, 'none', 'no licensed note');
  } finally { pf.close(); }

  // (b) Present-but-forged token: verify FAILS → license invalidated, no fallback.
  const badTok = makeLocalStorage();
  badTok.setItem('amh.license', JSON.stringify({
    valid: true, token: 'v1.a1b2c3d400000000.' + 'f'.repeat(128),
  }));
  const pb = loadPanel({ storage: badTok, fetch: trialServer({ left: 0 }) });
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
  legacy.setItem('amh.license', JSON.stringify({
    key: mkKey('00000000', '00000000', '0123456789abcdef'),
    valid: true, serverValidated: true, activated: Date.now() - 5 * 86400000,
  }));
  const migFetch = trialServer({ left: 0, more: (u) => (u.includes('/api/validate')
    ? { ok:true, json:async()=>({valid:true, token:'v1.b1b2b3b400000000.' + '0'.repeat(128)}) }
    : { ok:true, json:async()=>({ok:true}) }) });
  const p = loadPanel({ storage: legacy, fetch: migFetch, folderDialog: () => ({err:1}) });
  try {
    await flush(40);
    const stored = JSON.parse(p.storage.getItem('amh.license') || 'null');
    assert.ok(!stored.token, 'legacy state must not be upgraded without explicit activation');
    assert.strictEqual(p.els('runBtn').disabled, true, 'legacy state must not enable Generate');
    assert.strictEqual(p.els('licensedNote').style.display, 'none', 'no licensed note');
  } finally { p.close(); }
});

await t('3.7 simple buying: Buy link carries a secret, the panel activates itself, activation codes redeem', async () => {
  let licState = 'pending';
  let KEY = null;
  let KEY2 = null;
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ u, body });
    if (u.includes('/api/license')) return { ok: true, json: async () => (licState === 'approved' ? { status: 'approved', key: KEY } : { status: licState }) };
    if (u.includes('/api/redeem')) return { ok: true, json: async () => (body.code === 'K7QD-3MXP' ? { ok: true, key: KEY2 } : { ok: false, reason: 'not_found' }) };
    if (u.includes('/api/validate')) return { ok: true, json: async () => ({ valid: true, token: 'v1.x.' + '0'.repeat(128) }) };
    if (u.includes('/api/trial')) return { ok: true, json: async () => ({ used: 0 }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };

  // Buy → Telegram /start link with this computer + a secret → waits → activates itself.
  const p = loadPanel({ fetch: f });
  try {
    p.evalVm('verifyLicenseToken = async () => ({ ok: true, expiry: "00000000" });');
    p.evalVm('var __opened = null; cep.util.openURLInDefaultBrowser = (u) => { __opened = u; };');
    KEY = mkKey(p.mid, '00000000', '0123456789abcdef');
    await flush(5);
    p.els('buyBtn').fire('click', { preventDefault() {} });
    await flush(20);
    const opened = p.evalVm('__opened');
    assert.match(opened, new RegExp('^https://t\\.me/AmharicCaptionsBot\\?start=m_' + p.mid + '_[A-Za-z0-9]{16}$'), 'deep link: ' + opened);
    assert.ok(opened.length - 'https://t.me/AmharicCaptionsBot?start='.length <= 64, 'fits Telegram’s 64-char /start limit');
    const nonce = opened.split('_').pop();
    assert.strictEqual(JSON.parse(p.storage.getItem('amh.pendingBuy')).nonce, nonce, 'secret kept by the panel');
    has(p.els('buyPending').textContent, 'activates itself', 'waiting note');
    // The Machine ID lives in "Details for support" (buying never needs it).
    assert.strictEqual(p.els('machineIdDisplay').textContent, p.mid, 'Machine ID still shown for support');
    assert.deepStrictEqual(calls.filter((c) => c.u.includes('/api/license')).at(-1).body, { mid: p.mid, nonce }, 'asks with its own secret');
    p.els('buyBtn').fire('click', { preventDefault() {} });
    await flush(5);
    assert.strictEqual(p.evalVm('__opened'), opened, 'a second tap reuses the same secret (no orphaned order)');
    licState = 'approved';
    await p.evalVm('checkPendingBuy()');
    await flush(40);
    assert.strictEqual(p.els('licenseStatus').textContent, 'Licensed', 'activated with nothing pasted');
    assert.strictEqual(p.els('licensedNote').style.display, 'block');
    assert.strictEqual(p.storage.getItem('amh.pendingBuy'), null, 'pending purchase cleared');
  } finally { p.close(); }

  // Paid from the phone: a short activation code typed into the key box.
  const q = loadPanel({ fetch: f });
  try {
    q.evalVm('verifyLicenseToken = async () => ({ ok: true, expiry: "00000000" });');
    KEY2 = mkKey(q.mid, '00000000', 'fedcba9876543210');
    await flush(5);
    q.els('licenseInput').value = 'ABCD-EFGH';
    q.els('licenseActivate').fire('click');
    await flush(20);
    assert.strictEqual(q.els('licenseStatus').textContent, 'Activation code not found — check the letters in the bot message.');
    q.els('licenseInput').value = ' k7qd 3mxp ';
    q.els('licenseActivate').fire('click');
    await flush(40);
    assert.deepStrictEqual(calls.filter((c) => c.u.includes('/api/redeem')).at(-1).body, { mid: q.mid, code: 'K7QD-3MXP' }, 'code normalised, sent with this computer');
    assert.strictEqual(q.els('licenseStatus').textContent, 'Licensed', 'code → key → activated');
  } finally { q.close(); }
});

await t('3.8 review: speaker marks show per caption and a tap switches the speaker', async () => {
  const p = loadPanel();
  try {
    p.evalVm('reviewTrialCharged = true; SPEAKERS = true; lastCues = [' +
      '{start:0,end:1,text:"a",speaker:"S1"},{start:1,end:2,text:"b",speaker:"S2"},{start:2,end:3,text:"c",speaker:"S1"}];');
    await p.evalVm('openReview("x.srt", "t", 0, {})');
    const rows = p.els('reviewList').children;
    const chip = (i) => rows[i].children[0].children[2];
    assert.ok(chip(0) && /1/.test(chip(0).textContent) && /2/.test(chip(1).textContent), 'chips show 1 / 2');
    chip(2).fire('click', { preventDefault() {} });
    assert.deepStrictEqual(JSON.parse(p.evalVm('JSON.stringify(reviewCues.map((c) => c.speaker))')), ['S1', 'S2', 'S2'], 'tap switched caption 3 to speaker 2');
    has(p.els('reviewCount').textContent, '2 speakers found', 'speaker note');
    // Without speakers there are no marks at all.
    p.evalVm('lastCues = [{start:0,end:1,text:"a"}];');
    await p.evalVm('openReview("y.srt", "t", 0, {})');
    assert.strictEqual(p.els('reviewList').children[0].children[0].children.length, 2, 'no mark without speakers');
  } finally { p.close(); }
});

await t('3.9 review: doubtful words from the engine are marked; fixing one clears it', async () => {
  const p = loadPanel();
  try {
    // The engine writes <srt>.doubt.json next to the SRT, keyed by cue number.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_doubt_'));
    const srt = path.join(dir, 'x.srt');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nሰላም ወንድሜ\n\n2\n00:00:01,000 --> 00:00:02,000\nደህና ነኝ\n\n');
    fs.writeFileSync(srt + '.doubt.json', JSON.stringify({ 1: ['ወንድሜ'] }));
    p.evalVm('reviewTrialCharged = true; lastCues = withDoubts(normalizeCues(parseSrt(fs.readFileSync(' +
      JSON.stringify(srt) + ', "utf8"))), ' + JSON.stringify(srt) + ');');
    await p.evalVm('openReview("x.srt", "t", 0, {})');
    const rows = p.els('reviewList').children;
    assert.ok(rows[0].classList.contains('doubt'), 'row with a doubtful word is marked');
    assert.ok(!rows[1].classList.contains('doubt'), 'clean row is not');
    const textBox = rows[0].children[1];
    const marks = () => textBox.children[1].children.filter((c) => c.tagName === 'MARK').map((c) => c.textContent);
    assert.deepStrictEqual(marks(), ['ወንድሜ'], 'the unsure word itself is marked orange, in place');
    assert.strictEqual(textBox.children[1].children.map((c) => c.textContent).join(''), 'ሰላም ወንድሜ\u200b', 'the copy behind the box is the same text');
    assert.ok(!rows[0].querySelector('.doubt-line'), 'no "check:" label line any more');
    has(p.els('reviewCount').textContent, '1 to check', 'header count');
    const ta = textBox.children[0];
    // Clicking inside the orange word selects the whole word (type to replace it).
    ta.selectionStart = ta.selectionEnd = 6;
    ta.fire('click', {});
    assert.deepStrictEqual([ta.selectionStart, ta.selectionEnd], [4, 8], 'the whole word is selected');
    ta.selectionStart = ta.selectionEnd = 1;
    ta.fire('click', {});
    assert.deepStrictEqual([ta.selectionStart, ta.selectionEnd], [1, 1], 'a click on a normal word just places the cursor');
    // The editor fixes the word: the mark and the count go away.
    ta.value = 'ሰላም ወንድሜ፣';
    ta.value = 'ሰላም ወንድሞቼ';
    ta.fire('input', {});
    assert.ok(!rows[0].classList.contains('doubt'), 'fixed word clears the mark');
    assert.deepStrictEqual(marks(), [], 'no orange left');
    assert.ok(p.els('reviewCount').textContent.indexOf('to check') < 0, 'count cleared');
    // No sidecar → no marks, nothing breaks.
    fs.unlinkSync(srt + '.doubt.json');
    const n = p.evalVm('withDoubts(normalizeCues(parseSrt(fs.readFileSync(' + JSON.stringify(srt) + ', "utf8"))), ' +
      JSON.stringify(srt) + ').filter((c) => c.doubt).length');
    assert.strictEqual(n, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { p.close(); }
});

await t('3.10 review: fix a word -> a line UNDER that caption (Change all / 🧠 Always fix); never learns silently; nothing at the top', async () => {
  const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_fix_'));
  const p = loadPanel({ machineHome });
  const store = path.join(machineHome, '.amharic_captions_fixes.json');
  const open = async (cues) => {
    p.evalVm('reviewTrialCharged = true; lastCues = ' + JSON.stringify(cues) + ';');
    await p.evalVm('openReview("x.srt", "t", 0, {})');
  };
  const texts = () => JSON.parse(p.evalVm('JSON.stringify(reviewCues.map((c) => c.text))'));
  const row = (i) => p.els('reviewList').children[i];
  const editRow = (i, text) => {
    const ta = row(i).children[1].children[0];
    ta.value = text;
    ta.fire('input', {});
    ta.fire('change', {});
  };
  const hint = (i) => row(i).children.find((c) => c.className === 'row-hint');
  const hintBtn = (i, text) => hint(i).children.find((c) => c.tagName === 'BUTTON' && c.textContent.includes(text));
  try {
    // Nothing above the list any more: no search, no Next, no bar, no second 🧠 button.
    const html = fs.readFileSync(path.join(REPO, 'panel', 'index.html'), 'utf8');
    for (const gone of ['revNext', 'revReplace', 'replaceBar', 'rfFind', 'fixAllBar', 'revUndoFix']) {
      assert.ok(!html.includes('id="' + gone + '"'), gone + ' removed');
    }
    // Fix a word once -> the line appears under THAT caption only.
    await open([{ start: 0, end: 1, text: 'ሰላም ፈታን' }, { start: 1, end: 2, text: 'ፈታን መጣ ፈታንታ' },
      { start: 2, end: 3, text: 'ሌላ ቃል' }, { start: 3, end: 4, text: 'እሱ ፈታን ነው' }]);
    editRow(0, 'ሰላም ፈጣን');
    assert.ok(hint(0), 'the line is under the edited caption');
    assert.ok(!hint(1) && !hint(3), 'and nowhere else');
    has(hint(0).children[0].textContent, 'ፈታን → ፈጣን', 'says what changes');
    has(hintBtn(0, 'Change all').textContent, '(2)', 'Change all says how many captions');
    hintBtn(0, 'Change all').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ፈጣን', 'ፈጣን መጣ ፈታንታ', 'ሌላ ቃል', 'እሱ ፈጣን ነው']);
    assert.ok(!hint(0), 'the line goes away after the tap');
    assert.ok(!fs.existsSync(store) || !JSON.parse(fs.readFileSync(store, 'utf8')).fixes['ፈታን'], 'Change all alone does not remember');
    // ✕ closes it; editing another caption also closes it.
    await open([{ start: 0, end: 1, text: 'ገላት ነው' }, { start: 1, end: 2, text: 'ገላት' }]);
    editRow(0, 'ገነት ነው');
    hintBtn(0, '✕').fire('click', {});
    assert.ok(!hint(0));
    assert.deepStrictEqual(texts(), ['ገነት ነው', 'ገላት']);
    editRow(0, 'ገነት ናት');   // not a single-word fix of the original any more
    const ta1 = row(1).children[1].children[0];
    await open([{ start: 0, end: 1, text: 'ማበታ ነው' }, { start: 1, end: 2, text: 'ሌላ' }]);
    editRow(0, 'ማታ ነው');
    assert.ok(hint(0) && !hintBtn(0, 'Change all'), 'nothing else to change: only 🧠 Always fix is offered');
    row(1).children[1].children[0].value = 'ሌላ ነገር';
    row(1).children[1].children[0].fire('input', {});
    assert.ok(!hint(0), 'typing in another caption hides the line');

    // The panel never learns silently: the same hand fix in several videos
    // (placed and exported) creates no rule — only "🧠 Always fix" does.
    assert.strictEqual(p.els('revMemory').style.display, 'none', 'no memory yet -> no 🧠 button');
    for (let round = 1; round <= 3; round++) {
      await open([{ start: 0, end: 1, text: 'ትናንት መጣ' }]);
      assert.deepStrictEqual(texts(), ['ትናንት መጣ'], 'never applied (round ' + round + ')');
      editRow(0, 'ትላንት መጣ');
    }
    assert.ok(!fs.existsSync(store) || !JSON.parse(fs.readFileSync(store, 'utf8')).fixes['ትናንት'], 'no rule learned by itself');
    assert.strictEqual(typeof p.evalVm('typeof learnFromReview'), 'string');
    assert.strictEqual(p.evalVm('typeof learnFromReview'), 'undefined', 'the silent learner is gone');
    // A rule an OLDER version learned silently (not chosen) is ignored.
    p.evalVm('saveFixStore({ v: 1, fixes: { "ትናንት": { to: "ትላንት", n: 2, strong: false, at: 1 } } })');
    await open([{ start: 0, end: 1, text: 'ትናንት ሄደ' }]);
    assert.deepStrictEqual(texts(), ['ትናንት ሄደ'], 'old silent rule not applied');
    assert.strictEqual(p.els('revMemory').style.display, 'none', 'and not shown');
  } finally { p.close(); fs.rmSync(machineHome, { recursive: true, force: true }); }
});

await t('3.11 review: split / join / delete one click; Enter & Backspace; undo; 🧠 always fix, green words, put back / forget, memory dropdown', async () => {
  const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_act_'));
  const p = loadPanel({ machineHome });
  const store = path.join(machineHome, '.amharic_captions_fixes.json');
  const open = async (cues) => {
    p.evalVm('reviewTrialCharged = true; lastCues = ' + JSON.stringify(cues) + ';');
    await p.evalVm('openReview("x.srt", "t", 0, {})');
  };
  const texts = () => JSON.parse(p.evalVm('JSON.stringify(reviewCues.map((c) => c.text))'));
  const row = (i) => p.els('reviewList').children[i];
  const acts = (i) => row(i).children[2];
  const btn = (i, cls) => acts(i).children.find((b) => (b.className || '').includes(cls));
  const ta = (i) => row(i).children[1].children[0];
  const key = (i, k, pos) => { const t = ta(i); t.selectionStart = t.selectionEnd = pos; t.fire('keydown', { key: k, preventDefault() {} }); };
  try {
    await open([{ start: 0, end: 4, text: 'ሰላም ውድ ተመልካቾቼ እንኳን ደህና', doubt: ['ደህና'] },
      { start: 4, end: 6, text: 'መጣችሁ ዛሬ' }, { start: 6, end: 8, text: 'ቻው' }]);
    // Always visible, one click each: ✂ split, ⤓ join, 🗑 delete (+ ⋯ for the rest).
    for (const c of ['act-split', 'act-join', 'row-more', 'act-del']) assert.ok(btn(0, c), c + ' is on the row');
    assert.ok(btn(2, 'act-join').disabled, 'the last caption cannot join a next one');
    assert.ok(btn(2, 'act-split').disabled, 'a one-word caption cannot be split');

    // Enter splits AT THE CURSOR (snapped to the space), time shared by length.
    key(0, 'Enter', 'ሰላም ውድ ተመልካቾቼ እ'.length);
    assert.deepStrictEqual(texts(), ['ሰላም ውድ ተመልካቾቼ', 'እንኳን ደህና', 'መጣችሁ ዛሬ', 'ቻው']);
    const times = JSON.parse(p.evalVm('JSON.stringify(reviewCues.map((c) => [c.start, c.end]))'));
    assert.ok(times[0][1] > 0 && times[0][1] < 4 && times[1][0] === times[0][1] && times[1][1] === 4, 'time shared: ' + JSON.stringify(times));
    assert.deepStrictEqual(JSON.parse(p.evalVm('JSON.stringify(reviewCues[1].doubt)')), ['ደህና'], 'the orange word moves with its half');
    has(p.els('revUndo').textContent, 'Undo split', 'undo offered');

    // Backspace at the very start joins with the caption above.
    key(1, 'Backspace', 0);
    assert.deepStrictEqual(texts(), ['ሰላም ውድ ተመልካቾቼ እንኳን ደህና', 'መጣችሁ ዛሬ', 'ቻው']);
    key(1, 'Backspace', 3);
    assert.strictEqual(texts().length, 3, 'Backspace inside the text is just typing');
    // Shift+Enter is a line break, not a split.
    ta(0).selectionStart = ta(0).selectionEnd = 3;
    ta(0).fire('keydown', { key: 'Enter', shiftKey: true, preventDefault() { throw new Error('must not block Shift+Enter'); } });
    assert.strictEqual(texts().length, 3);

    // The buttons: join (with the next), split (at the remembered cursor), delete.
    btn(0, 'act-join').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ውድ ተመልካቾቼ እንኳን ደህና መጣችሁ ዛሬ', 'ቻው']);
    ta(0).selectionStart = ta(0).selectionEnd = 'ሰላም ውድ'.length;
    ta(0).fire('keyup', {});
    btn(0, 'act-split').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ውድ', 'ተመልካቾቼ እንኳን ደህና መጣችሁ ዛሬ', 'ቻው'], 'split at the cursor, not the middle');
    btn(1, 'act-del').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ውድ', 'ቻው']);
    has(p.els('revUndo').textContent, 'Undo delete');
    // Undo, step by step: delete, split, join.
    p.els('revUndo').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ውድ', 'ተመልካቾቼ እንኳን ደህና መጣችሁ ዛሬ', 'ቻው'], 'undo delete');
    p.els('revUndo').fire('click', {});
    p.els('revUndo').fire('click', {});
    assert.deepStrictEqual(texts(), ['ሰላም ውድ ተመልካቾቼ እንኳን ደህና', 'መጣችሁ ዛሬ', 'ቻው'], 'undo split, then join');
    // ⋯ keeps the rarer edits: shift ±0.1s and add a caption below.
    const more = acts(1).children[2];
    more.children[1].children[2].fire('click');
    assert.strictEqual(texts().length, 4, '⋯ → add a caption below');
    assert.strictEqual(texts()[2], '', 'the new caption sits right below');

    // 🧠 Always fix: changes it everywhere NOW (green) and in every new video.
    await open([{ start: 0, end: 1, text: 'ፈታን ነው' }, { start: 1, end: 2, text: 'እሱም ፈታን' }, { start: 2, end: 3, text: 'ሌላ ቃል' }]);
    ta(0).value = 'ፈጣን ነው'; ta(0).fire('input', {}); ta(0).fire('change', {});
    const hint0 = () => row(0).children.find((c) => c.className === 'row-hint');
    hint0().children.find((c) => c.tagName === 'BUTTON' && c.textContent.includes('Always fix')).fire('click', {});
    assert.deepStrictEqual(texts(), ['ፈጣን ነው', 'እሱም ፈጣን', 'ሌላ ቃል'], 'changed in this video right away');
    const greens = (i) => row(i).children[1].children[1].children.filter((c) => c.tagName === 'MARK' && c.className === 'fix').map((c) => c.textContent);
    assert.deepStrictEqual([greens(0), greens(1)], [['ፈጣን'], ['ፈጣን']], 'and shown green');
    has(hint0().children[0].textContent, 'fixed automatically from now on', 'a short ✓ in the same place');
    assert.strictEqual(JSON.parse(fs.readFileSync(store, 'utf8')).fixes['ፈታን'].strong, true, 'saved as a rule');
    has(p.els('revMemory').textContent, '(1)', 'memory count in the header');
    assert.strictEqual(p.els('revMemory').style.display, '', 'the 🧠 button appears once something is remembered');
    await new Promise((r) => setTimeout(r, 2700));
    assert.ok(!hint0(), 'the ✓ goes away by itself');
    await open([{ start: 0, end: 1, text: 'እሱ ፈታን ነው' }, { start: 1, end: 2, text: 'ፈታን' }]);
    assert.deepStrictEqual(texts(), ['እሱ ፈጣን ነው', 'ፈጣን'], 'applied to the next transcription straight away');
    assert.deepStrictEqual(greens(0), ['ፈጣን'], 'the memory fix is green');
    // Clicking a green word explains it: put back HERE keeps the memory.
    ta(0).selectionStart = ta(0).selectionEnd = 'እሱ ፈ'.length;
    ta(0).fire('click', {});
    has(hint0().children[0].textContent, 'ፈታን → ፈጣን', 'says what the memory changed');
    hint0().children.find((c) => c.tagName === 'BUTTON' && c.textContent.includes('Put back')).fire('click', {});
    assert.deepStrictEqual(texts(), ['እሱ ፈታን ነው', 'ፈጣን'], 'put back in this caption only');
    assert.ok(JSON.parse(fs.readFileSync(store, 'utf8')).fixes['ፈታን'], 'the memory is kept');
    // Forget this fix: back everywhere, rule gone.
    const ta1 = row(1).children[1].children[0];
    ta1.selectionStart = ta1.selectionEnd = 1;
    ta1.fire('click', {});
    row(1).children.find((c) => c.className === 'row-hint').children
      .find((c) => c.tagName === 'BUTTON' && c.textContent.includes('Forget this fix')).fire('click', {});
    assert.deepStrictEqual(texts(), ['እሱ ፈታን ነው', 'ፈታን'], 'original back everywhere');
    assert.ok(!JSON.parse(fs.readFileSync(store, 'utf8')).fixes['ፈታን'], 'forgotten');
    // The memory list: a dropdown that closes on a click elsewhere; ✕ forgets one.
    p.evalVm('saveFixStore({ v: 1, fixes: { "ሀለ": { to: "ሀሎ", n: 1, strong: true, at: 1 } } }); syncMemoryButton();');
    p.els('revMemory').fire('click', {});
    const panel = p.els('memoryPanel');
    assert.strictEqual(panel.style.display, '', 'opens');
    const rows = () => panel.children.find((c) => c.className === 'mem-list').children;
    has(rows()[0].children[0].textContent, 'ሀለ → ሀሎ');
    rows()[0].children[2].fire('click', {});
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(store, 'utf8')).fixes, {}, 'forgotten from the list');
    assert.ok(!p.els('revMemory').textContent.includes('('), 'count gone');
    assert.strictEqual(p.els('revMemory').style.display, 'none', 'nothing left -> the 🧠 button hides again');
    assert.strictEqual(panel.style.display, 'none', 'and its list closes');
  } finally { p.close(); fs.rmSync(machineHome, { recursive: true, force: true }); }
});

await t('4. license: free minutes used up block Generate', async () => {
  const p = loadPanel({ fetch: trialServer({ left: 0 }) });
  try {
    await flush(10);
    assert.strictEqual(p.els('runBtn').disabled, true, 'Generate disabled');
    assert.ok(/Trial used/.test(p.els('licenseStatus').textContent), 'trial-used banner');
    assert.strictEqual(p.els('trialBanner').style.display, 'block');
    assert.strictEqual(p.els('freeMinBox').style.display, 'none', 'no free-minutes offer once used');
    p.evalVm('assertCanRun()');
    assert.ok(/free minutes are used up/.test(p.els('logBox').textContent), 'gate logged');
    assert.strictEqual(p.els('runBtn').disabled, true, 'still disabled');
  } finally { p.close(); }
});

await t('4b. free minutes from Telegram: offer, one-time bot link, the panel notices by itself', async () => {
  let status = 'none';
  let opened = null;
  const reqs = [];
  const f = trialServer({ left: 0, more: (u, init) => {
    if (u.includes('/api/trial/request')) {
      reqs.push(JSON.parse(init.body));
      return { ok: true, json: async () => minutesState(0, { status: 'none', seconds_total: 0, nonce: 'abcdefghijklmnop', link: 'https://t.me/AmharicCaptionsBot?start=t_abcdefghijklmnop' }) };
    }
    return null;
  } });
  const g = async (url, init) => {
    if (String(url).includes('/api/trial?v=2')) {
      return { ok: true, json: async () => (status === 'none'
        ? minutesState(0, { status: 'none', seconds_total: 0 }) : minutesState(1200)) };
    }
    return f(url, init);
  };
  const p = loadPanel({ fetch: g });
  try {
    await flush(10);
    p.evalVm('cep.util.openURLInDefaultBrowser = (u) => { globalThis.__opened = u; };');
    assert.strictEqual(p.els('freeMinBox').style.display, '', 'the free-minutes box shows');
    assert.strictEqual(p.els('freeMinTitle').textContent, 'Try 20 minutes free');
    assert.strictEqual(p.els('runBtn').disabled, false, 'Generate stays clickable and explains');
    assert.strictEqual(p.evalVm('assertCanRun()'), false, 'no free caption before Telegram');
    assert.ok(/Get your 20 free minutes in Telegram first/.test(p.els('logBox').textContent));
    p.els('freeMinBtn').fire('click');
    await flush(10);
    opened = p.evalVm('globalThis.__opened');
    assert.strictEqual(opened, 'https://t.me/AmharicCaptionsBot?start=t_abcdefghijklmnop', 'opens the one-time bot link');
    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].mid, p.mid);
    assert.ok(/^[0-9a-f]{8}$/.test(reqs[0].hf || ''), 'with the computer fingerprint');
    assert.ok(/Waiting for Telegram/.test(p.els('freeMinWait').textContent), 'says it is waiting');
    status = 'active';                         // the person pressed START
    await p.evalVm('refreshTrialFromServer()');
    p.evalVm('updateLicenseUI()');
    assert.strictEqual(p.els('freeMinBox').style.display, 'none', 'box gone once the minutes are there');
    assert.strictEqual(p.els('licenseStatus').textContent, 'Free trial: 20:00 minutes left');
    assert.strictEqual(p.evalVm('assertCanRun()'), true, 'Generate works');
  } finally { p.evalVm('if (TRIAL_POLL) clearInterval(TRIAL_POLL); TRIAL_POLL = null;'); p.close(); }
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
      const ta0  = row0.children[1].children[0];   // text box: textarea + the marked copy behind it
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
      // Viewers see a "– " dash where the speaker changes, never "[S1]".
      has(srt, EDITED, 'SRT edited cue');
      has(srt, '– ' + CUE2, 'SRT marks the speaker change with a dash');
      assert.ok(srt.indexOf('[S1]') < 0 && srt.indexOf('[S2]') < 0, 'no [S1]/[S2] in the saved SRT');
      assert.ok(srt.indexOf('00:00:01,000 --> 00:00:03,000') >= 0, 'SRT times present');
      has(vtt, '<v S1>' + EDITED + '</v>', 'VTT voice tag');
      has(txt, 'Speaker 1: ' + EDITED, 'TXT speaker line');

      // nudge first cue back 0.1s
      // ⋯ menu → first item (−0.1s)
      const more0 = p.els('reviewList').children[0].children[2].children[2];
      more0.children[0].fire('click');
      assert.ok(more0.classList.contains('open'), '⋯ opens the menu');
      more0.children[1].children[0].fire('click');
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

await t('5c. trial: a charge the server denies stops the engine (no ticket, nothing made)', async () => {
  const p = loadPanel({ fetch: trialServer({ deny: true }) });
  try {
    await flush(10);
    p.evalVm('LICENSED = false; activeRunId = "run-deny"; ENGINE_AUTH = null; reviewTrialCharged = false;');
    let err = '';
    try { await p.evalVm('engineAuth(60)'); } catch (e) { err = String(e && e.message); }
    assert.strictEqual(err, 'trial used up', 'denied -> the engine never starts');
    assert.strictEqual(p.evalVm('reviewTrialCharged'), false);
    assert.strictEqual(p.evalVm('TRIAL_CHARGED_RUN'), null, 'nothing to give back');
    assert.ok(/free minutes are used up/i.test(p.evalVm('humanError("trial used up")')), 'said in plain words');
  } finally { p.close(); }
  const off = loadPanel({});
  try {
    off.evalVm('LICENSED = false; activeRunId = "run-off"; ENGINE_AUTH = null; apiPost = async () => null;');
    let err = '';
    try { await off.evalVm('engineAuth(60)'); } catch (e) { err = String(e && e.message); }
    assert.strictEqual(err, 'free caption needs internet', 'offline -> needs internet');
  } finally { off.close(); }
});

await t('5d. after a free caption: next-step card (group while one is left, Buy after the last); never on a denied charge', async () => {
  const fixture = path.join(REPO, 'tools', 'test', 'fixtures', 'twospeaker.wav');
  const key = cacheKeyFor(fixture, { cap:'words', group:3, chars:42, speakers:false });
  const snap = snapshotCache();
  try {
    const base = snap !== null ? JSON.parse(snap) : {};
    base[key] = { srt: CACHE_SEED_SRT, transcript: '', at: Date.now() };
    restoreCache(JSON.stringify(base));
    const p = loadPanel({ fetch: trialServer() });
    try {
      await flush(10);
      p.evalVm('var __opened = null; cep.util.openURLInDefaultBrowser = (u) => { __opened = u; };');
      const card = p.els('trialCard');
      // A free job is charged when the engine starts (here: 300 s of 1200);
      // the last one is set as its charge would leave it (0 left).
      const charge = [300];
      const run = async () => {
        if (charge.length) {
          p.evalVm('ENGINE_AUTH = null; activeRunId = "run-" + Math.random();');
          await p.evalVm('engineAuth(' + charge.shift() + ')');
        } else {
          p.evalVm('TRIAL_CARD_DUE = { remaining: 0, cut: null };');
        }
        p.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
        p.els('fileInput').fire('change');
        await flush(40);
        assert.ok(p.els('review').classList.contains('show'), 'review open');
        assert.ok(!card.classList.contains('show'), 'the card never covers the review');
      };

      // 1st free caption, placed: the group is the main action.
      await run();
      p.els('reviewPlace').fire('click');
      await flush(30);
      assert.ok(card.classList.contains('show'), 'card after the first free caption');
      assert.ok(card.classList.contains('tc-left') && !card.classList.contains('tc-last'));
      assert.strictEqual(p.els('tcLeftText').textContent, 'You have 15:00 free minutes left.');
      assert.ok(/btn-primary/.test(p.els('tcGroup').className) && !/btn-primary/.test(p.els('tcBuy').className));
      p.els('tcGroup').fire('click');
      assert.strictEqual(p.evalVm('__opened'), 'https://t.me/+L-bMfmIRyEo3MDg0', 'opens the Telegram group');
      assert.ok(!card.classList.contains('show'), 'and closes');

      // 2nd (last) free caption, discarded: Buy is the main action and starts the normal purchase.
      await run();
      p.els('reviewDiscard').fire('click');
      await flush(10);
      assert.ok(card.classList.contains('show') && card.classList.contains('tc-last'), 'last-caption card, even after discard');
      assert.ok(/btn-primary/.test(p.els('tcBuy').className));
      p.els('tcBuy').fire('click');
      assert.match(String(p.evalVm('__opened')), /^https:\/\/t\.me\/AmharicCaptionsBot\?start=m_/, 'Buy opens the bot with this Machine ID');
      assert.ok(!card.classList.contains('show'));
    } finally { p.close(); }

    // A longer video than the minutes left: the card says what was covered.
    const c = loadPanel({ fetch: trialServer({ left: 600 }) });
    try {
      await flush(10);
      c.evalVm('ENGINE_AUTH = null; activeRunId = "run-cut";');
      await c.evalVm('engineAuth(1500)');
      assert.strictEqual(c.evalVm('TRIAL_CUT'), 600, 'the free minutes cover 10:00 of a 25-minute video');
      c.evalVm('showTrialCardIfDue()');
      const cc = c.els('trialCard');
      assert.ok(cc.classList.contains('show') && cc.classList.contains('tc-cut'), 'the "rest needs a license" card');
      assert.strictEqual(c.els('tcCutText').textContent, 'Your free minutes covered the first 10:00 of this video.');
      assert.ok(/btn-primary/.test(c.els('tcBuy').className), 'Buy first');
    } finally { c.close(); }

    // A cached run (no engine) charges nothing and shows no card.
    const q = loadPanel({ fetch: trialServer({ onUse: () => { throw new Error('charged'); } }) });
    try {
      await flush(10);
      q.els('fileInput').files = [{ path: fixture, name: 'twospeaker.wav' }];
      q.els('fileInput').fire('change');
      await flush(50);
      assert.ok(q.els('review').classList.contains('show'), 'cached result opens');
      assert.ok(!q.els('trialCard').classList.contains('show'), 'no card when no free minutes were used');
    } finally { q.close(); }
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


await t('8. review: empty list renders (no ReferenceError) after deleting every caption', async () => {
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

      // Delete every cue (⋯ → Delete) -> the empty state renders, no throw.
      const del = () => p.els('reviewList').children[0].children[2].children[3];
      assert.ok(del().className.includes('act-del'), 'Delete is one click on the row');
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

await t('10b. long videos: battery tip, honest time after a resume, watchdog, resume file', async () => {
  // "It can't handle a 10-minute video": laptops on battery are 2-3x slower,
  // a resumed job must not show a fake "seconds left", a slow-but-working
  // engine must never be cut off, and an interrupted run continues.
  const p = loadPanel({});
  try {
    p.evalVm('setWindowProgress(Date.now()); consumeProgressLine("[power] battery"); windowProgress(3, 10);');
    const label = p.evalVm('$("progLabel").textContent');
    assert.ok(label.includes('plug in the charger'), 'battery tip shown: ' + label);
    const am = p.evalVm('(() => { const keep = AMH_LANG; AMH_LANG = "am"; const r = T(PROGRESS_EN); AMH_LANG = keep; return r; })()');
    assert.ok(am.includes('ቻርጀር ይሰኩ') && am.startsWith('ወደ ጽሑፍ በመቀየር ላይ 3/10'), 'and in Amharic: ' + am);
    assert.strictEqual(p.evalVm('consumeProgressLine("[power] battery")'), true, 'power line is consumed, not logged as an error');
    p.evalVm('setWindowProgress(Date.now()); windowProgress(5, 10);');
    assert.ok(!p.evalVm('$("progLabel").textContent').includes('ቻርጀር'), 'a new run starts without the tip');

    // resumed at 20/39: the first line must not produce an estimate
    p.evalVm('setWindowProgress(Date.now() - 100000); windowProgress(20, 39);');
    const resumed = p.evalVm('$("progLabel").textContent');
    assert.ok(!/ደቂቃ|ሰከንድ/.test(resumed), 'no instant estimate on a resumed job: ' + resumed);

    // watchdog: any worker output restarts it (slow but working is fine)
    const rearmed = p.evalVm(`(() => {
      let fired = 0;
      const fake = { onTimeout: () => { fired++; }, timer: null };
      warmPending.set(9999, fake);
      warmBeat();
      const armed = !!fake.timer;
      clearTimeout(fake.timer);
      warmPending.delete(9999);
      return armed && fired === 0;
    })()`);
    assert.strictEqual(rearmed, true, 'worker output re-arms the watchdog');
    assert.strictEqual(p.evalVm('WARM_SEND_TIMEOUT_MS'), 20 * 60 * 1000, 'watchdog = 20 min of silence, not a total limit');

    // resume: same video + settings -> same work file; it is moved to the
    // run's output with its doubt marks when done
    assert.strictEqual(p.evalVm('resumeWorkPath("abc")'), p.evalVm('resumeWorkPath("abc")'));
    assert.notStrictEqual(p.evalVm('resumeWorkPath("abc")'), p.evalVm('resumeWorkPath("abd")'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_resume_'));
    try {
      const work = path.join(dir, 'w.srt');
      const out = path.join(dir, 'o.srt');
      fs.writeFileSync(work, '1\n00:00:00,000 --> 00:00:01,000\nሰላም\n');
      fs.writeFileSync(work + '.doubt.json', '{}');
      p.evalVm('finishWork(' + JSON.stringify(work) + ', ' + JSON.stringify(out) + ')');
      assert.ok(fs.readFileSync(out, 'utf8').includes('ሰላም'), 'output written');
      assert.ok(fs.existsSync(out + '.doubt.json'), 'doubt marks moved too');
      assert.ok(!fs.existsSync(work) && !fs.existsSync(work + '.doubt.json'), 'work files removed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { p.close(); }
});

await t('10c. review while it is still working: opens early, waits while typing, locks Place, finishes', async () => {
  const p = loadPanel({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_live_'));
  const srt = (n) => Array.from({ length: n }, (_, i) =>
    (i + 1) + '\n00:00:' + String(i * 2).padStart(2, '0') + ',000 --> 00:00:' + String(i * 2 + 1).padStart(2, '0') + ',500\nካፕሽን ' + (i + 1) + '\n').join('\n');
  try {
    const work = path.join(dir, 'work.srt');
    const out = path.join(dir, 'out.srt');
    p.evalVm('LICENSED = true; SPEAKERS = false; cancelRequested = false; reviewTrialCharged = false;' +
      'setInterval = (fn) => { __tick = fn; return 77; };' +
      'LIVE_WANTED = { outSrt: ' + JSON.stringify(out) + ', label: "clip" };' +
      '__poll = startLivePoll(' + JSON.stringify(work) + ');');
    assert.strictEqual(p.evalVm('__poll'), 77, 'polling starts for a licensed run');

    await p.evalVm('__tick()');
    assert.strictEqual(p.evalVm('reviewOpen'), false, 'nothing written yet -> no review');

    fs.writeFileSync(work, srt(3));
    await p.evalVm('__tick()');
    assert.strictEqual(p.evalVm('reviewOpen && !!REVIEW_LIVE'), true, 'the review opens with the first captions');
    assert.strictEqual(p.els('reviewList').children.length, 3);
    assert.strictEqual(p.evalVm('$("reviewPlace").disabled'), true, 'Place is locked while it works');
    assert.ok(p.evalVm('$("reviewPlace").textContent').startsWith('⏳'), 'and says it is still working');
    assert.strictEqual(p.evalVm('$("reviewExport").disabled'), true, 'export too');
    p.evalVm('placeReview()');
    assert.strictEqual(p.evalVm('reviewOpen'), true, 'Place does nothing while it works');

    // the editor is typing: new captions wait, nothing is redrawn under them
    p.evalVm('reviewCues[0].text = "የተስተካከለ"; editingReview = () => true;');
    fs.writeFileSync(work, srt(5));
    await p.evalVm('__tick()');
    assert.strictEqual(p.evalVm('reviewCues.length'), 5, 'new captions are kept');
    assert.strictEqual(p.els('reviewList').children.length, 3, 'but not drawn while typing');
    p.evalVm('editingReview = () => false;');
    await p.evalVm('__tick()');
    assert.strictEqual(p.els('reviewList').children.length, 5, 'drawn once the editor stops typing');
    assert.strictEqual(p.evalVm('reviewCues[0].text'), 'የተስተካከለ', 'the edit is kept');

    // the run ends: the last captions come in, Place unlocks with its own label
    const label0 = p.evalVm('$("reviewPlace").dataset.liveLabel');
    fs.writeFileSync(out, srt(6));
    await p.evalVm('showRunResult(' + JSON.stringify(out) + ', "clip", { cues: normalizeCues(parseSrt(' + JSON.stringify(srt(6)) + ')) })');
    assert.strictEqual(p.evalVm('REVIEW_LIVE'), null);
    assert.strictEqual(p.evalVm('reviewCues.length'), 6, 'the final captions are all there, once');
    assert.strictEqual(p.evalVm('$("reviewPlace").disabled'), false, 'Place unlocked');
    assert.strictEqual(p.evalVm('$("reviewPlace").textContent'), label0, 'with its normal label');
    assert.strictEqual(p.evalVm('reviewCues[0].text'), 'የተስተካከለ', 'edit still kept');

    // Discard while it works also stops the run
    p.evalVm('closeReview(true); cancelRequested = false; LIVE_WANTED = { outSrt: ' + JSON.stringify(out) + ', label: "clip" };' +
      'startLivePoll(' + JSON.stringify(work) + ');');
    await p.evalVm('__tick()');
    assert.strictEqual(p.evalVm('reviewOpen && !!REVIEW_LIVE'), true);
    p.evalVm('discardReview()');
    assert.strictEqual(p.evalVm('cancelRequested'), true, 'Discard stops the run');
    assert.strictEqual(p.evalVm('reviewOpen'), false);
    p.evalVm('finishLiveReview(null, false)');

    // not for trial users (a free caption must not be charged for a run that
    // may still fail) and not with speaker marks (rewritten at the end)
    p.evalVm('LICENSED = false; cancelRequested = false;');
    assert.strictEqual(p.evalVm('startLivePoll("x")'), null, 'trial: the review opens at the end as before');
    p.evalVm('LICENSED = true; SPEAKERS = true;');
    assert.strictEqual(p.evalVm('startLivePoll("x")'), null, 'speaker marks: at the end as before');
    p.evalVm('SPEAKERS = false; LIVE_WANTED = null;');
    assert.strictEqual(p.evalVm('startLivePoll("x")'), null, 'only the runs that ask for it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); p.close(); }
});

await t('10c2. Work Area / Whole edit while it works: long runs go live into a resumable work file (1.10.9)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_blive_'));
  const sent = [];
  const cue3 = '1\n00:00:01,000 --> 00:00:02,000\nአንድ\n\n2\n00:03:21,000 --> 00:03:22,000\nሁለት\n';
  const p = loadPanel({ hooks: {
    warmStart: () => true,
    warmSend: async (req) => { sent.push(req); fs.writeFileSync(req.out_srt, cue3); return { text: '' }; },
  } });
  // 16 kHz mono 16-bit WAVs of a given length (only their size matters here)
  const wav = (name, secs) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.alloc(44 + secs * 32000)); return f; };
  try {
    p.evalVm('LICENSED = true; SPEAKERS = false; cancelRequested = false; setInterval = () => 77; clearInterval = () => {};');
    const out = path.join(dir, 'seq.srt');
    p.evalVm('LIVE_WANTED = { outSrt: ' + JSON.stringify(out) + ', label: "sequence" };');
    const items = JSON.stringify([{ wav: wav('a.wav', 200), offset: 0, name: 'a' }, { wav: wav('b.wav', 200), offset: 200, name: 'b' }]);
    const r = await p.evalVm('transcribeBatch(' + items + ', ' + JSON.stringify(out) + ')');
    const req = sent[0];
    assert.strictEqual(req.live, true, '6:40 of audio, licensed -> the engine writes as it goes');
    assert.ok(/amh_work_b[0-9a-f]{23}\.srt$/.test(req.out_srt), 'into a work file named after the clips: ' + req.out_srt);
    assert.notStrictEqual(req.out_srt, out);
    assert.ok(fs.existsSync(out) && !fs.existsSync(req.out_srt), 'the work file becomes the result');
    assert.strictEqual(r.cues.length, 2);
    // same clips again -> the same work file (its journal resumes a stopped run)
    await p.evalVm('transcribeBatch(' + items + ', ' + JSON.stringify(out) + ')');
    assert.strictEqual(sent[1].out_srt, req.out_srt, 'same edit -> same work file');

    // short runs, trial users and speaker marks: as before
    const short = JSON.stringify([{ wav: wav('c.wav', 100), offset: 0, name: 'c' }]);
    await p.evalVm('transcribeBatch(' + short + ', ' + JSON.stringify(out) + ')');
    assert.ok(!sent[2].live && sent[2].out_srt === out, 'under 5 minutes: straight to the result');
    p.evalVm('SPEAKERS = true;');
    await p.evalVm('transcribeBatch(' + items + ', ' + JSON.stringify(out) + ')');
    assert.ok(!sent[3].live, 'speaker marks: at the end as before');
    p.evalVm('SPEAKERS = false; LICENSED = false;');
    await p.evalVm('transcribeBatch(' + items + ', ' + JSON.stringify(out) + ')');
    assert.ok(!sent[4].live, 'free trial: at the end as before');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); p.close(); }
});

await t('10d. anonymous step counts: once a day per step, nothing personal, error types', async () => {
  const sent = [];
  const p = loadPanel({ fetch: async (url, o) => {
    if (String(url).includes('/api/event')) sent.push(JSON.parse((o && o.body) || '{}'));
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  try {
    await flush(1500);                        // the 'open' step fires after load
    p.evalVm('track("run_click"); track("run_click"); track("buy_click");');
    await flush(5);
    const steps = sent.map((x) => x.e);
    assert.ok(steps.includes('open'), 'opened is reported: ' + steps);
    assert.strictEqual(steps.filter((x) => x === 'run_click').length, 1, 'each step once a day');
    const body = sent.find((x) => x.e === 'run_click');
    assert.deepStrictEqual(Object.keys(body).sort(), ['e', 'h', 'os', 'v'], 'only step, app, OS, version — no Machine ID');
    assert.strictEqual(body.v, p.evalVm('APP_VERSION'));
    const cases = [
      ['No selected clip.', 'err_no_clip'], ['ffmpeg failed: x', 'err_media_unreadable'],
      ['Python failed: worker exited', 'err_engine'], ['ENOSPC: no space left', 'err_disk_full'],
      ['Cancelled', ''], ['something odd', 'err_other'],
    ];
    for (const [raw, want] of cases) assert.strictEqual(p.evalVm('errorStep(' + JSON.stringify(raw) + ')'), want, raw);
  } finally { p.close(); }
});

await t('10e. engine permission: license lease, or a trial ticket charged when the engine starts', async () => {
  // 1.10.3: the engine refuses a job without permission, so the panel gets it
  // first — the licensed user's lease, or one free caption's signed ticket.
  let charges = 0;
  let asked = null;
  const trialFetch = (withTicket) => async (url, o) => {
    if (String(url).includes('/api/trial/use')) {
      charges++;
      asked = JSON.parse(o.body);
      return { ok: true, json: async () => minutesState(1200 - asked.seconds, Object.assign({ charged: true, seconds: asked.seconds },
        withTicket ? { ticket: 't2.x.run.1.' + asked.seconds + '.' + '0'.repeat(128) } : {})) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const p = loadPanel({ fetch: trialFetch(true) });
  try {
    p.evalVm('LICENSED = false; activeRunId = "run-1"; reviewTrialCharged = false; ENGINE_AUTH = null;');
    const a = await p.evalVm('engineAuth(83.4)');
    assert.ok(a.ticket && a.ticket.startsWith('t2.'), 'a free job brings the free-minutes ticket');
    assert.strictEqual(asked.seconds, 84, 'charged in whole seconds of this job');
    assert.strictEqual(asked.run_id, 'run-1');
    assert.strictEqual(p.evalVm('reviewTrialCharged'), true, 'and is charged now, not again when the review opens');
    assert.strictEqual(p.evalVm('TRIAL_CHARGED_RUN'), 'run-1', 'remembered for a refund if the job fails');
    await p.evalVm('engineAuth(83.4)');
    assert.strictEqual(charges, 1, 'the same run never charges twice');
    assert.deepStrictEqual(Array.from(p.evalVm('authArgs({ ticket: "T" })')), ['--ticket', 'T']);
    assert.deepStrictEqual(Array.from(p.evalVm('authArgs({ lease: "L" })')), ['--lease', 'L']);
  } finally { p.close(); }

  const off = loadPanel({ fetch: trialFetch(false) });
  try {
    off.evalVm('LICENSED = false; activeRunId = "run-2"; ENGINE_AUTH = null;');
    let err = '';
    try { await off.evalVm('engineAuth(10)'); } catch (e) { err = String(e && e.message); }
    assert.strictEqual(err, 'free caption needs internet', 'no ticket -> no free caption');
    assert.ok(off.evalVm('humanError("free caption needs internet")').includes('internet'), 'said in plain words');
    assert.strictEqual(off.evalVm('errorStep("license required: no license")'), 'err_license');
  } finally { off.close(); }

  const lic = loadPanel({});
  try {
    lic.evalVm('LICENSED = true; getLicense = () => ({ token: "v1.lease" }); activeRunId = "run-3"; ENGINE_AUTH = null;');
    const a = await lic.evalVm('engineAuth()');
    assert.strictEqual(a.lease, 'v1.lease', 'a licensed computer sends its lease (no trial charge)');
  } finally { lic.close(); }
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
    assert.strictEqual(p.els('fmtField').style.display, 'none', 'karaoke: no video shape');
    p.els('capGroup').fire('click');
    assert.strictEqual(p.els('groupSizeField').style.display, '', 'grouped: words-per-caption shown');
    assert.strictEqual(p.els('fmtField').style.display, '', 'grouped: video shape shown');

    // trial used up: said once (banner), not twice
    p.evalVm("TRIAL_MIN = { status: 'active', seconds_left: 0, seconds_total: 1200, minutes: 20 }; updateLicenseUI()");
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
  const p = loadPanel({ storage, fetch: trialServer({ left: 754 }) });
  try {
    await flush(10);
    assert.strictEqual(p.evalVm('i18nGetLang()'), 'am');
    assert.strictEqual(p.els('statusText').textContent, 'ዝግጁ', 'status pill in Amharic');
    assert.strictEqual(p.els('licenseStatus').textContent, 'ነጻ ሙከራ፦ 12:34 ደቂቃ ቀርቷል', 'free minutes in Amharic');

    p.evalVm("i18nSetLang('en')");
    assert.strictEqual(storage.getItem('amh.lang'), 'en', 'choice persisted');
    assert.strictEqual(p.els('statusText').textContent, 'ready', 'status re-rendered in English');
    assert.strictEqual(p.els('licenseStatus').textContent, 'Free trial: 12:34 minutes left');

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
    // In After Effects every host call is wrapped (aeHostCall) so the AE
    // implementations are active at call time, whatever order host.jsx and
    // host_ae.jsx were evaluated in.
    const imp = evalLog.find((j) => /return amh_importCaptions\(/.test(j));
    assert.ok(imp && /amharic_getSelectedClip\.amhAE===true/.test(imp) && /host_ae\.jsx/.test(imp), 'AE call is guarded');
    assert.ok(/did not load/.test(imp), 'and refuses to run the Premiere code when the AE code is not active');
    const inner = /return (amh_importCaptions\(.*\));\}\)\(\)$/.exec(imp)[1];
    const args = JSON.parse(JSON.parse(inner.slice('amh_importCaptions('.length, -1)));
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

await t('14c. an empty or "EvalScript error." answer is explained by a host probe (AE version, helpers, project)', async () => {
  // Seen: After Effects on a Mac, Work Area, v1.9.1 — "No result from After
  // Effects" and nothing else to go on.
  const probeLog = [];
  const p = loadPanel({ hostApp: 'AEFT', csiRaw: (jsx) => {
    if (/s\.push\("app "/.test(jsx)) { probeLog.push(jsx); return 'app 25.2, json object, helpers function, ae-code false, project open, active Composition'; }
    return /getSequenceInfo/.test(jsx) ? '' : /getSelectedClip/.test(jsx) ? 'EvalScript error.' : '{"ok":true}';
  } });
  try {
    await flush(5);
    const r = await p.evalVm("evalScript('amharic_getSequenceInfo(false)')");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'No result from After Effects (app 25.2, json object, helpers function, ae-code false, project open, active Composition)');
    const r2 = await p.evalVm("evalScript('amharic_getSelectedClip()')");
    assert.match(r2.error, /^script error in After Effects \(app 25\.2/);
    assert.ok(probeLog.length === 2 && !/aeHostCall|evalFile/.test(probeLog[0]), 'the probe is plain (not wrapped, no file loads)');
    assert.ok(new Function('app', 'amhGuard', 'amharic_getSelectedClip', 'return ' + probeLog[0])({ version: '1', project: null }, undefined, undefined).indexOf('project none') >= 0,
      'the probe itself runs and never throws, even with nothing loaded');
  } finally { p.close(); }
  // When the probe gets no answer either, say that.
  const q = loadPanel({ hostApp: 'AEFT', csiRaw: () => '' });
  try {
    await flush(5);
    const r = await q.evalVm("evalScript('amharic_getSequenceInfo(false)')");
    assert.strictEqual(r.error, 'No result from After Effects (the host did not answer a test either)');
  } finally { q.close(); }
});

await t('14b. editing shortcuts (Ctrl/Cmd + C V X A Z Y, + Shift) stay in the panel, in AE and Premiere', async () => {
  // Without this, Ctrl+C on a caption word ran After Effects' own Copy:
  // "After Effects must have keyframes selected in order to export them as text".
  for (const hostApp of ['AEFT', 'PPRO']) {
    const keyLog = [];
    const p = loadPanel({ hostApp, keyLog });
    try {
      await flush(5);
      assert.strictEqual(keyLog.length, 1, hostApp + ': registered once at load');
      const keys = JSON.parse(keyLog[0]);
      const mac = process.platform === 'darwin';
      const mod = mac ? 'metaKey' : 'ctrlKey';
      const want = mac ? [0, 6, 7, 8, 9, 16] : [65, 67, 86, 88, 89, 90];   // A Z X C V Y / A C V X Y Z
      for (const code of want) {
        assert.ok(keys.some((k) => k.keyCode === code && k[mod] === true && !k.shiftKey), hostApp + ': key ' + code);
        assert.ok(keys.some((k) => k.keyCode === code && k[mod] === true && k.shiftKey === true), hostApp + ': Shift+key ' + code);
      }
      assert.strictEqual(keys.length, want.length * 2, 'nothing else is taken from the host');
    } finally { p.close(); }
  }
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

await t('16. update notice: newer shows, same/older/offline hide, ✕ snoozes per version, once a day', async () => {
  let calls = 0;
  let answer = { version: '9.9.9', url: 'https://amharic-caption-pro.vercel.app/install/' };
  let online = true;
  const fetchLatest = async (url) => {
    if (String(url).indexOf('/api/latest') < 0) return { ok: false, json: async () => null };
    calls++;
    if (!online) throw new Error('offline');
    return { ok: true, json: async () => answer };
  };
  const storage = makeLocalStorage();
  let p = loadPanel({ storage, fetch: fetchLatest });
  try {
    await flush(10);
    assert.strictEqual(p.els('updateBanner').style.display, 'none', 'nothing known yet');
    await p.evalVm('checkForUpdate()');
    assert.strictEqual(calls, 1);
    assert.strictEqual(p.els('updateBanner').style.display, 'flex', 'newer version -> banner');
    assert.strictEqual(p.els('updateText').textContent, 'Version 9.9.9 is available.');
    await p.evalVm('checkForUpdate()');
    assert.strictEqual(calls, 1, 'at most one lookup a day');

    // ✕ snoozes this version...
    p.els('updateLater').fire('click');
    assert.strictEqual(p.els('updateBanner').style.display, 'none', 'snoozed');
  } finally { p.close(); }

  // ...across restarts (no network needed to remember)...
  online = false;
  p = loadPanel({ storage, fetch: fetchLatest });
  try {
    await flush(10);
    assert.strictEqual(p.els('updateBanner').style.display, 'none', 'still snoozed after restart');
    // ...but a NEWER release shows again at once.
    storage.setItem('amh.update.checked', '0');
    online = true;
    answer = { version: '10.0.0', url: 'https://amharic-caption-pro.vercel.app/install/' };
    await p.evalVm('checkForUpdate()');
    assert.strictEqual(p.els('updateBanner').style.display, 'flex', 'newer than the snoozed one');
    has(p.els('updateText').textContent, '10.0.0');
  } finally { p.close(); }

  // Same or older version: no banner. Offline: nothing stored, retried next open.
  for (const [v, why] of [['1.0.0', 'older'], [p.evalVm('APP_VERSION'), 'same']]) {
    const s2 = makeLocalStorage();
    answer = { version: v, url: 'https://amharic-caption-pro.vercel.app/install/' };
    const q = loadPanel({ storage: s2, fetch: fetchLatest });
    try { await q.evalVm('checkForUpdate()'); assert.strictEqual(q.els('updateBanner').style.display, 'none', why); }
    finally { q.close(); }
  }
  const s3 = makeLocalStorage();
  online = false;
  const o = loadPanel({ storage: s3, fetch: fetchLatest });
  try {
    await o.evalVm('checkForUpdate()');
    assert.strictEqual(o.els('updateBanner').style.display, 'none', 'offline: no banner, no error');
    assert.strictEqual(s3.getItem('amh.update.checked'), null, 'offline: will retry next open');
  } finally { o.close(); }

  // A download link that is not our own site is never used.
  const s4 = makeLocalStorage();
  online = true;
  answer = { version: '9.9.9', url: 'https://evil.example/malware.zip' };
  const q4 = loadPanel({ storage: s4, fetch: fetchLatest });
  try {
    await q4.evalVm('checkForUpdate()');
    assert.strictEqual(JSON.parse(s4.getItem('amh.update.latest')).url,
      'https://amharic-caption-pro.vercel.app/install/', 'foreign URL replaced by our install page');
  } finally { q4.close(); }

  // Amharic wording
  const s5 = makeLocalStorage();
  s5.setItem('amh.lang', 'am');
  answer = { version: '9.9.9', url: 'https://amharic-caption-pro.vercel.app/install/' };
  const a5 = loadPanel({ storage: s5, fetch: fetchLatest });
  try {
    await a5.evalVm('checkForUpdate()');
    assert.strictEqual(a5.els('updateText').textContent, 'አዲስ ስሪት 9.9.9 ወጥቷል።');
  } finally { a5.close(); }
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

await t('the real license / machine-ID files in the home folder were never touched', async () => {
  await flush(50);   // let any late async license work finish first
  assert.strictEqual(realIdentityState(), REAL_IDENTITY_BEFORE);
});

console.log('\n' + (fail===0 ? 'ALL PASS' : 'FAILURES: '+fail) + '  (' + pass + ' passed, ' + fail + ' failed)');
process.exit(fail===0 ? 0 : 1);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
