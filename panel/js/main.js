/*
 * Amharic Captions panel controller.
 * Runs inside CEP Chromium with Node integration, so it can spawn ffmpeg and
 * the Ethio-ASR Python transcription, then hand the SRT to Premiere via
 * ExtendScript.
 */
'use strict';

const csi = new CSInterface();

// ─────────────────────────────────────────────────────────────────────────────
// License system (runs FIRST, independently of CEP Node, so it also works in a
// plain browser for testing). Machine ID = random 8-char hex, stored locally.
// License key = AMH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX, HMAC-SHA256 signed.
// ─────────────────────────────────────────────────────────────────────────────
const LICENSE_SECRET = '7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g=';

// ── Cloudflare Worker API URL (server-side trial + key validation) ──────────
// Deployed Worker URL — see tools/telegram-worker/DEPLOY.md.
const API_URL = 'https://amharic-captions-bot.amhcaps.workers.dev';

async function apiGet(path) {
  try {
    const res = await fetch(API_URL + path, { method: 'GET' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

async function apiPost(path, body) {
  try {
    const res = await fetch(API_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function getOrCreateMachineId() {
  const key = 'amh.machineId';
  let id = localStorage.getItem(key);
  if (id && /^[0-9a-f]{8}$/.test(id)) return id;
  id = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(key, id);
  return id;
}

const MACHINE_ID = getOrCreateMachineId();

// ── Host theme detection (Premiere dark/light) ──────────────────────────────
function hostTheme() {
  try {
    const env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    const bg = env.appSkinInfo && env.appSkinInfo.appBackgroundColor;
    if (bg && typeof bg.red === 'number') {
      // 0..255; bright background => light theme, dark => dark theme.
      const lum = (bg.red + bg.green + bg.blue) / 3;
      return lum > 140 ? 'light' : 'dark';
    }
  } catch (e) {}
  return null;
}

function applyTheme() {
  const t = hostTheme();
  if (t) document.documentElement.setAttribute('data-theme', t);
}
// Inline-applied ASAP so there's no dark->light flash when CEP starts up.
applyTheme();

// Stay in sync when the user toggles Premiere's brightness.
try {
  if (window.__adobe_cep__ && window.__adobe_cep__.addEventListener) {
    window.__adobe_cep__.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme);
  }
} catch (e) {}

// ── Amharic font detection: which installed font renders አማርኛ well? ───────
// The caption track in Premiere uses the operating system's default for the
// Ethiopic script; we surface the best available font so users know what they
// will see (and can install Abyssinica SIL for the nicest result).
const AMH_CANDIDATE_FONTS = [
  'Abyssinica SIL',        // best glyphs, most popular Ethiopic-capable font
  'Noto Sans Ethiopic',
  'Noto Serif Ethiopic',
  'Kefa',
  'Ebrima',
  'Nyala',
  'Visual Geez Unicode',
];

function detectAmharicFont() {
  // document.fonts.check('16px "NAME"') returns true only when that named font
  // is actually installed and layout can use it for the given glyph/script.
  if (typeof document === 'undefined' || !document.fonts || typeof document.fonts.check !== 'function') {
    return { ok: true, font: null, support: false }; // can't tell => don't block
  }
  const probe = '\u1200\u1228'; // "ሀረ" — Ethiopic-required codepoints
  for (const name of AMH_CANDIDATE_FONTS) {
    try {
      if (document.fonts.check('16px "' + name + '"', probe)) {
        return { ok: true, font: name, support: true };
      }
    } catch (e) {}
  }
  return { ok: false, font: null, support: true };
}

let AMH_FONT = detectAmharicFont();

function renderFontPill(info) {
  const pill = document.getElementById('fontPill');
  const txt = document.getElementById('fontText');
  if (!pill || !txt) return;
  if (!info.support) {
    pill.className = 'warn';
    txt.textContent = 'font: unknown';
    pill.title = 'Could not detect installed fonts on this system.';
    return;
  }
  if (info.ok && info.font) {
    pill.className = 'ok';
    txt.textContent = info.font;
    pill.title = 'Captions will render in ' + info.font + '.' +
      ' For the clearest Amharic, install "Abyssinica SIL" for free.';
  } else {
    pill.className = 'warn';
    txt.textContent = 'font: install';
    pill.title = 'No Ethiopic-capable font detected. Install "Abyssinica SIL" ' +
      '(free) so captions render correctly in Premiere.';
  }
}
renderFontPill(AMH_FONT);

// ── First-run onboarding ────────────────────────────────────────────────────
const ONBOARD_KEY = 'amh.onboarded';
function needsOnboarding() {
  try { return !localStorage.getItem(ONBOARD_KEY); } catch (e) { return false; }
}
function showOnboarding() {
  const ob = document.getElementById('onboard');
  if (!ob) return;
  ob.classList.add('show');
}
function hideOnboarding() {
  const ob = document.getElementById('onboard');
  if (ob) ob.classList.remove('show');
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
}

// Health checks (also reused by diagnostics later).
function healthChecks() {
  let runtime = false, python = false, ffmpeg = false, model = false;
  try {
    runtime = !!RUNTIME && fs.existsSync(PYTHON) && fs.existsSync(FFMPEG) && fs.existsSync(MODEL_DIR);
    python = !!RUNTIME && fs.existsSync(PYTHON);
    ffmpeg = !!RUNTIME && fs.existsSync(FFMPEG);
    model = !!RUNTIME && fs.existsSync(MODEL_DIR);
  } catch (e) {}
  return { runtime, python, ffmpeg, model, font: AMH_FONT.ok };
}

function renderHealthList() {
  const h = healthChecks();
  const map = {
    runtime: ['Transcription engine', h.runtime],
    model:   ['Amharic model',        h.model],
    ffmpeg:  ['Audio extractor',      h.ffmpeg],
    python:  ['Python runtime',       h.python],
    font:    ['Amharic font',         AMH_FONT.ok],
  };
  document.querySelectorAll('#healthList .row-check').forEach((row) => {
    const key = row.getAttribute('data-check');
    const state = row.querySelector('.state');
    const [label, good] = map[key] || [key, false];
    row.querySelector('span:first-child').textContent = label;
    row.classList.toggle('ok', good);
    row.classList.toggle('bad', !good);
    state.textContent = good ? 'OK' : 'Check';
  });
}

function initOnboarding() {
  const btn = document.getElementById('onboardStart');
  if (btn) btn.addEventListener('click', hideOnboarding);

  // Health checks depend on RUNTIME etc. which are resolved later in the file;
  // so render when the environment is ready (after setup()) via a resechedule.
  // We simply re-render on every open and after setup is wired.
  renderHealthList();

  if (needsOnboarding() && typeof RUNTIME !== 'undefined') {
    // Small delay so RUNTIME/PYTHON/FFMPEG (declared further down) are defined.
    setTimeout(() => { showOnboarding(); renderHealthList(); }, 60);
  }
}

// Support link: open Telegram DM to the seller, pre-filling the machine ID.
function initSupport() {
  const a = document.getElementById('supportLink');
  if (a) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const msg = encodeURIComponent('Hello! I need help with Amharic Captions.\nMachine ID: ' + MACHINE_ID);
      const url = 'https://t.me/sumpak6?text=' + msg;
      try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
      catch (err) { window.open(url, '_blank'); }
    });
  }
}

// ── Version badge in footer (keep in sync with CSXS manifest.xml) ──────────
function initVersion() {
  const el = document.getElementById('panelVersion');
  if (el) el.textContent = '1.1.0';
}

function getLicense() {
  try { return JSON.parse(localStorage.getItem('amh.license') || 'null'); }
  catch (e) { return null; }
}

function setLicense(licenseObj) {
  try { localStorage.setItem('amh.license', JSON.stringify(licenseObj)); }
  catch (e) {}
}

function validateLicense(key, machineId) {
  const clean = key.replace(/AMH-/g, '').replace(/-/g, '').toLowerCase();
  if (clean.length !== 32) return { ok: false, error: 'Invalid key length' };

  const mid  = clean.substring(0, 8);
  const exp  = clean.substring(8, 16);
  const sig  = clean.substring(16, 32);

  if (mid !== machineId.toLowerCase()) return { ok: false, error: 'Key is for a different machine' };

  // Check expiry
  if (exp !== '00000000') {
    const expDate = new Date(exp.substring(0,4) + '-' + exp.substring(4,6) + '-' + exp.substring(6,8));
    if (isNaN(expDate.getTime()) || Date.now() > expDate.getTime()) {
      return { ok: false, error: 'License expired on ' + exp.substring(0,4) + '-' + exp.substring(4,6) + '-' + exp.substring(6,8) };
    }
  }

  // HMAC verification (via SubtleCrypto)
  const msg = mid + '|' + exp;
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', encoder.encode(LICENSE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  ).then((keyObj) => {
    return crypto.subtle.sign('HMAC', keyObj, encoder.encode(msg));
  }).then((buf) => {
    const computed = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    if (computed === sig) return { ok: true, expiry: exp };
    return { ok: false, error: 'Invalid license key' };
  });
}

let LICENSED = false;
let LICENSED_REFRESH = false;

// Free-trial credits: an unlicensed user may run this many transcriptions
// before being asked to enter a license key. Count is stored per-machine.
const TRIAL_ALLOWED = 2;
function getTrialUsed() {
  try { return parseInt(localStorage.getItem('amh.trial.used') || '0', 10) || 0; }
  catch (e) { return 0; }
}
function setTrialUsed(n) {
  try { localStorage.setItem('amh.trial.used', String(Math.max(0, n))); } catch (e) {}
}
function trialRemaining() {
  return Math.max(0, TRIAL_ALLOWED - getTrialUsed());
}
// Called once when an unlicensed user successfully places a transcription.
// Counts toward the free-trial limit; licensed users are unaffected.
// Uses server-side tracking (D1) with localStorage fallback for offline.
async function consumeTrialCredit() {
  if (LICENSED) return;

  // Try server-side increment first
  const serverResult = await apiPost('/api/trial/use', { mid: MACHINE_ID });
  if (serverResult && typeof serverResult.used === 'number') {
    // Sync local state from server
    setTrialUsed(serverResult.used);
    const left = serverResult.remaining;
    if (left > 0) {
      log('Free trial: ' + serverResult.used + '/' + TRIAL_ALLOWED + ' used, ' + left + ' left.');
    } else {
      log('Free trial used up (' + TRIAL_ALLOWED + '/' + TRIAL_ALLOWED + '). Enter a license key to continue.');
    }
    return;
  }

  // Fallback: local-only (offline or API unreachable)
  setTrialUsed(getTrialUsed() + 1);
  const used = getTrialUsed();
  const left = trialRemaining();
  if (left > 0) {
    log('Free trial: ' + used + '/' + TRIAL_ALLOWED + ' used, ' + left + ' left.');
  } else {
    log('Free trial used up (' + TRIAL_ALLOWED + '/' + TRIAL_ALLOWED + '). Enter a license key to continue.');
  }
}

function updateLicenseUI() {
  const lic = getLicense();
  const midEl = document.getElementById('machineIdDisplay');
  const licInput = document.getElementById('licenseInput');
  const licBtn = document.getElementById('licenseActivate');
  const licStatus = document.getElementById('licenseStatus');
  const runBtn = document.getElementById('runBtn');
  const banner = document.getElementById('trialBanner');

  if (midEl) midEl.textContent = MACHINE_ID;

  if (lic && lic.valid) {
    LICENSED = true;
    if (banner) banner.style.display = 'none';
    if (licStatus) {
      licStatus.textContent = 'Licensed' + (lic.expiry && lic.expiry !== '00000000' ? ' (expires ' + lic.expiry + ')' : '');
      licStatus.style.color = 'var(--ok)';
    }
    if (runBtn) runBtn.disabled = false;
    if (licInput) licInput.style.display = 'none';
    if (licBtn) licBtn.style.display = 'none';
    // Licensed: lock the Machine ID so it can't be copied or changed anymore.
    const midSection = document.getElementById('machineIdSection');
    if (midSection) {
      midSection.style.display = 'none';
    }
    const licNote = document.getElementById('licensedNote');
    if (licNote) licNote.style.display = 'block';
  } else {
    LICENSED = false;
    // Ensure the license entry fields are always visible while unlicensed,
    // including right after the trial runs out.
    if (licInput) licInput.style.display = '';
    if (licBtn) licBtn.style.display = '';
    // Unlicensed: show the Machine ID again and hide the licensed note.
    const midSectionU = document.getElementById('machineIdSection');
    if (midSectionU) midSectionU.style.display = '';
    const licNoteU = document.getElementById('licensedNote');
    if (licNoteU) licNoteU.style.display = 'none';
    const rem = trialRemaining();
    if (rem > 0) {
      // Free trial: allow running, but the Generate button is enabled.
      if (banner) banner.style.display = 'none';
      if (licStatus) {
        licStatus.textContent = 'Trial: ' + rem + ' free transcription' + (rem === 1 ? '' : 's') + ' left';
        licStatus.style.color = 'var(--warn)';
      }
      if (runBtn) runBtn.disabled = false;
    } else {
      // Trial used up: make the path to purchase unmistakable.
      if (banner) banner.style.display = 'block';
      if (banner && typeof banner.scrollIntoView === 'function' && !LICENSED_REFRESH) {
        try { banner.scrollIntoView({ block: 'center' }); } catch (e) {}
      }
      if (licStatus) {
        licStatus.textContent = 'Trial used. Enter your license key above to continue.';
        licStatus.style.color = 'var(--warn)';
      }
      if (runBtn) runBtn.disabled = true;
    }
  }
  LICENSED_REFRESH = false;
}

async function activateLicense() {
  const licInput = document.getElementById('licenseInput');
  const licStatus = document.getElementById('licenseStatus');
  if (!licInput) return;

  const key = licInput.value.trim();
  if (!key) {
    if (licStatus) { licStatus.textContent = 'Paste a license key first'; licStatus.style.color = 'var(--err)'; }
    return;
  }

  if (licStatus) { licStatus.textContent = 'Validating…'; licStatus.style.color = 'var(--text-secondary)'; }

  try {
    // 1) Local HMAC check (fast shape check)
    const result = await validateLicense(key, MACHINE_ID);
    if (!result.ok) {
      if (licStatus) { licStatus.textContent = result.error || 'Invalid key'; licStatus.style.color = 'var(--err)'; }
      return;
    }

    // 2) Server-side check: key must exist in D1 for this machine.
    //    fail-closed: a first activation REQUIRES the server to confirm the key.
    //    After a key is once confirmed, offline re-activation is allowed via cache.
    const cached = getLicense();
    const serverResult = await apiPost('/api/validate', { mid: MACHINE_ID, key: key });
    if (serverResult && serverResult.valid === false) {
      const reason = serverResult.reason === 'expired'
        ? 'License expired'
        : 'Key not recognized — contact @sumpak6 on Telegram';
      if (licStatus) { licStatus.textContent = reason; licStatus.style.color = 'var(--err)'; }
      return;
    }
    if (serverResult && serverResult.valid === true) {
      // confirmed by server today — cache the fact
      setLicense({ key: key, valid: true, expiry: result.expiry, activated: Date.now(), serverValidated: true });
      updateLicenseUI();
      const logBox = document.getElementById('logBox');
      if (logBox && logBox.textContent) logBox.textContent += '\nLicense activated successfully.';
      return;
    }
    // Server unreachable:
    if (cached && cached.valid && cached.serverValidated && cached.key === key) {
      // previously validated server-side — allow offline
      setLicense({ key: key, valid: true, expiry: result.expiry, activated: Date.now(), serverValidated: true });
      updateLicenseUI();
      const logBox = document.getElementById('logBox');
      if (logBox && logBox.textContent) logBox.textContent += '\nLicense activated (offline, previously verified).';
      return;
    }
    // Not previously verified and server unreachable → refuse (fail-closed)
    if (licStatus) {
      licStatus.textContent = 'Cannot verify license — no connection to the license server. Try again online.';
      licStatus.style.color = 'var(--err)';
    }
  } catch (e) {
    if (licStatus) { licStatus.textContent = 'Validation error'; licStatus.style.color = 'var(--err)'; }
  }
}

// Initialize license UI immediately (works in plain browser AND CEP).
(function initLicense() {
  const licBtn = document.getElementById('licenseActivate');
  if (licBtn) licBtn.addEventListener('click', activateLicense);
  const copyBtn = document.getElementById('machineIdCopy');
  const midEl = document.getElementById('machineIdDisplay');
  if (copyBtn && midEl) {
    copyBtn.addEventListener('click', (e) => {
      try {
        const mid = midEl.textContent.trim();
        if (mid && mid !== 'loading…') {
          const ta = document.createElement('textarea');
          ta.value = mid;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          const old = copyBtn.textContent;
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { copyBtn.textContent = old; }, 1600);
        }
      } catch (err) { /* ignore */ }
      e.stopPropagation();
    });
  }
  updateLicenseUI();

  // Sync server-side trial count on load (best effort — silently ignore if offline)
  if (!getLicense()) {
    apiGet('/api/trial?mid=' + MACHINE_ID).then((data) => {
      if (data && typeof data.used === 'number') setTrialUsed(data.used);
    });
  }
})();
// ─────────────────────────────────────────────────────────────────────────────
// End license system
// ─────────────────────────────────────────────────────────────────────────────

const nodeRequire = window.require || (window.cep_node && window.cep_node.require);
if (!nodeRequire) {
  const logBox = document.getElementById('logBox');
  if (logBox && logBox.textContent) {
    logBox.textContent = 'Node.js integration is not enabled. Reinstall the extension so the ' +
      'CEFCommandLine flags take effect, then restart Premiere Pro.';
  }
  throw new Error('CEP Node integration unavailable');
}

const { execFile } = nodeRequire('child_process');
const fs = nodeRequire('fs');
const os = nodeRequire('os');
const path = nodeRequire('path');

// --------------------------------------------------------------------------
// Cross-platform runtime resolution.
//
// The panel is self-contained: everything it needs lives in a "runtime"
// folder. On a shipped machine this is bundled INSIDE the extension directory
// as ./runtime (so the whole extension is one folder the user copies).
//
//   <extension>/runtime/
//     bin/ffmpeg[.exe]
//     python/                       <- relocatable python 3.11 + site-packages
//     ethio_srt.py
//     amh_mel.py                    <- standalone numpy mel extractor
//     model/                        <- CTranslate2 int8 (model_meta.json) or ethio-asr
//
// mac/win only differ in the binary names and the python/ffmpeg executables;
// the panel code is identical. In development (no bundled runtime) we fall
// back to the original ~/Documents/amharic-captions location, which keeps
// this repo working on the author's machine.
// --------------------------------------------------------------------------

const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_64BIT = process.arch === 'x64' || process.arch === 'arm64';

// The extension's own folder (folder containing js/ -> the extension root).
const EXT_DIR = (() => {
  const here = __dirname; // .../com.amharic.captions/js
  return path.dirname(here);
})();

const DEV_RUNTIME = path.join(os.homedir(), 'Documents', 'amharic-captions');

function runtimeComplete(base) {
  if (!base || !fs.existsSync(base)) return false;
  if (!fs.existsSync(path.join(base, 'ethio_srt.py'))) return false;
  // A shipped, self-contained runtime must include the model, ffmpeg and a
  // python interpreter. (The dev fallback is handled separately below.)
  let modelOk = fs.existsSync(path.join(base, 'model'))
             || fs.existsSync(path.join(base, 'ethio-asr'));
  let binOk = fs.existsSync(path.join(base, 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'))
           || fs.existsSync(path.join(base, 'bin', 'ffmpeg'));
  let pyOk = IS_WIN
    ? fs.existsSync(path.join(base, 'python', 'python.exe'))
    : fs.existsSync(path.join(base, 'python', 'bin', 'python3'));
  return modelOk && binOk && pyOk;
}

function pickRuntime() {
  // CEP's __dirname is not reliably the same across OSes/builds: it may be the
  // extension root OR the js/ folder. So we probe several candidate "extension
  // root" locations and, for each, look for a complete runtime/ among them.
  const here = (typeof __dirname !== 'undefined' && __dirname) ? __dirname : EXT_DIR;
  const roots = [];
  // If here is .../extensions/com.amharic.captions (root) and also if it is js/
  const dirs = [here, path.dirname(here), path.join(path.dirname(here), 'js'),
                path.join(path.dirname(here), '..')];
  for (const d of dirs) {
    if (!d || roots.indexOf(d) >= 0) continue;
    roots.push(d);
  }
  const seen = {};
  for (const base of roots) {
    if (seen[base]) continue;
    seen[base] = true;
    const cand = path.join(base, 'runtime');
    if (runtimeComplete(cand)) return cand;
  }
  const devRt = path.join(DEV_RUNTIME, 'runtime');
  if (runtimeComplete(devRt)) return devRt;
  // Dev fallback uses the .venv, so it doesn't need bin/ffmpeg.
  if (fs.existsSync(path.join(DEV_RUNTIME, 'ethio_srt.py'))) {
    return DEV_RUNTIME;
  }
  return null;
}

const RUNTIME = pickRuntime();

function runtimePath(...parts) {
  if (!RUNTIME) return path.join.apply(path, parts);
  return path.join.apply(path, [RUNTIME].concat(parts));
}

// FFMPEG: prefer the staged static binary in bin/, else dev Homebrew path.
function resolveFFMPEG() {
  if (RUNTIME) {
    const cand = path.join(RUNTIME, 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(cand)) return cand;
  }
  if (RUNTIME === DEV_RUNTIME && !IS_WIN) return '/opt/homebrew/bin/ffmpeg';
  return IS_WIN ? 'ffmpeg' : 'ffmpeg';
}
const FFMPEG = resolveFFMPEG();

// PYTHON: bundled runtime has python/; the dev layout has .venv/.
function resolvePython() {
  if (RUNTIME && RUNTIME !== DEV_RUNTIME) {
    if (IS_WIN) {
      const c1 = path.join(RUNTIME, 'python', 'python.exe');
      if (fs.existsSync(c1)) return c1;
    } else {
      const c1 = path.join(RUNTIME, 'python', 'bin', 'python3');
      if (fs.existsSync(c1)) return c1;
    }
  }
  const devPy = path.join(DEV_RUNTIME, '.venv', 'bin', 'python');
  if (fs.existsSync(devPy)) return devPy;
  return path.join(DEV_RUNTIME, '.venv', 'bin', 'python');
}
const PYTHON = resolvePython();

const SCRIPT   = RUNTIME     ? runtimePath('ethio_srt.py')     : runtimePath('ethio_srt.py');
const MODEL_DIR= (RUNTIME && RUNTIME !== DEV_RUNTIME)
                    ? runtimePath('model')                       // shipped layout
                    : runtimePath('ethio-asr');                  // dev layout


// Where the runtime folder actually is (for the status pill / diagnostics).
const RUNTIME_LABEL = RUNTIME ? RUNTIME : '(not found)';

// Environment passed to the transcription process so it finds the model.
// Child Python must emit UTF-8. On Windows the console code page is often
// cp1252, which cannot encode Amharic and would crash when the transcript is
// printed to stdout. Force UTF-8 for stdout/stderr and locale.
const AMH_ENV = Object.assign({}, process.env, {
  AMH_MODEL_DIR: MODEL_DIR,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  PYTHONUNBUFFERED: '1'
});

const $ = (id) => document.getElementById(id);

const logEl = $('logBox');
function log(msg) {
  const line = typeof msg === 'string' ? msg : String(msg);
  logEl.textContent += (logEl.textContent ? '\n' : '') + line;
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() { logEl.textContent = ''; }

function setStatus(state, text) {
  const pill = $('statusPill');
  const txt = $('statusText');
  if (!pill || !txt) return;
  pill.classList.remove('ready', 'busy', 'err');
  if (state) pill.classList.add(state);
  txt.textContent = text || '';
}
function setBusy(busy) {
  setStatus(busy ? 'busy' : 'ready', busy ? 'working…' : (IS_WIN ? 'ready · win' : 'ready · mac'));
  $('runBtn').disabled = busy;
  const cancel = $('cancelBtn');
  if (cancel) cancel.style.display = busy ? 'inline-block' : 'none';
}

// ------------------------------------------------------------ evalScript
function evalScript(jsx) {
  return new Promise((resolve, reject) => {
    csi.evalScript(jsx, (result) => {
      if (typeof result === 'string' && result.length > 0) {
        try {
          const parsed = JSON.parse(result);
          resolve(parsed);
        } catch (e) {
          resolve({ ok: true, _raw: result });
        }
      } else {
        resolve({ ok: false, error: result || 'No result from Premiere' });
      }
    });
  });
}

function findFootage()      { return evalScript('amharic_findFootage()'); }
function importCaptions(srtPath, startSeconds, baseName) {
  const args = JSON.stringify({ srtPath, startSeconds: startSeconds || 0, baseName: baseName || '' });
  return evalScript(`amh_importCaptions(${JSON.stringify(args)})`);
}
function getSelectedClip()  { return evalScript('amharic_getSelectedClip()'); }
function getSequenceInfo(all) {
  return evalScript('amharic_getSequenceInfo(' + (all ? 'true' : 'false') + ')');
}

function runDiagnostics() {
  clearLog();
  log('Dumping project media tree…');
  return evalScript('amharic_diag()');
}

// ------------------------------------------------------------- settings
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('amh.settings') || '{}');
    return s;
  } catch (e) { return {}; }
}
function saveSettings(over) {
  const s = loadSettings();
  for (const k in over) s[k] = over[k];
  try { localStorage.setItem('amh.settings', JSON.stringify(s)); } catch (e) {}
  return s;
}

let SOURCE = 'clip';
let CAP = 'grouped';
let GROUP_SIZE = 3;
let MAX_CHARS = 42;
let cancelRequested = false;
let lastSrtPath = null;
let lastCues = [];
let activeChild = null;

function applySettings() {
  const s = loadSettings();
  SOURCE = s.source || 'clip';
  CAP = s.cap || 'words';
  GROUP_SIZE = s.group || 3;
  MAX_CHARS = s.chars || 42;
  document.querySelectorAll('#srcSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.src === SOURCE);
  });
  document.querySelectorAll('#capSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.cap === CAP);
  });
  $('groupSize').value = GROUP_SIZE;
  $('maxChars').value = MAX_CHARS;
  $('expFmt').value = s.fmt || 'srt';
}

// ----------------------------------------------------------------- SRT
function parseSrt(text) {
  const cues = [];
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length);
    if (lines.length < 3) continue;
    const timeMatch = lines[1].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!timeMatch) continue;
    const toSec = (s) => {
      const p = s.trim().replace(',', '.').split(':');
      let sec = 0;
      for (const part of p) sec = sec * 60 + parseFloat(part);
      return sec;
    };
    const start = toSec(timeMatch[1]);
    const end = toSec(timeMatch[2]);
    const text = lines.slice(2).join('\n');
    if (text && start >= 0) cues.push({ start, end, text });
  }
  return cues;
}

function formatSrtTs(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}

function writeSrt(outPath) {
  const sortable = lastCues.slice().sort((a, b) => a.start - b.start);
  let out = '';
  let idx = 0;
  for (const cue of sortable) {
    idx += 1;
    out += idx + '\n';
    out += formatSrtTs(cue.start) + ' --> ' + formatSrtTs(cue.end) + '\n';
    out += cue.text + '\n\n';
  }
  fs.writeFileSync(outPath, out, 'utf8');
  lastSrtPath = outPath;
  return outPath;
}

function writeVtt(outPath) {
  const sortable = lastCues.slice().sort((a, b) => a.start - b.start);
  const ts = (sec) => {
    sec = Math.max(0, sec);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.floor((sec - Math.floor(sec)) * 1000)).padStart(3, '0');
    return h + ':' + m + ':' + s + '.' + ms;
  };
  let out = 'WEBVTT\n\n';
  for (const cue of sortable) {
    out += ts(cue.start) + ' --> ' + ts(cue.end) + '\n';
    out += cue.text + '\n\n';
  }
  fs.writeFileSync(outPath, out, 'utf8');
  lastSrtPath = outPath;
  return outPath;
}

// ----------------------------------------------------------- extraction
// Extract a timeline clip's trimmed source audio to a 16k mono wav via ffmpeg.
function extractAudio(clip, wav) {
  return new Promise((resolve, reject) => {
    const ffArgs = ['-v', 'error', '-y', '-i', clip.sourcePath];
    if (clip.duration > 0) ffArgs.push('-ss', String(clip.sourceIn), '-t', String(clip.duration));
    ffArgs.push('-ac', '1', '-ar', '16000', wav);
    execFile(FFMPEG, ffArgs, (err) => {
      if (err) reject(new Error('ffmpeg failed for ' + clip.name + ': ' + (err.message || err)));
      else resolve();
    });
  });
}

// --------------------------------------------------------- transcription
// Extract the full-transcript blocks from a python stdout stream.
function extractTranscripts(stdout) {
  const transcripts = [];
  const lines = String(stdout || '').split('\n');
  let inBlock = false;
  let buf = [];
  for (const ln of lines) {
    if (ln.indexOf('--- full transcription ---') === 0) { inBlock = true; buf = []; continue; }
    if (ln.indexOf('[info]') === 0 || ln.indexOf('[batch]') === 0) {
      if (inBlock) { transcripts.push(buf.join('\n').trim()); inBlock = false; }
      continue;
    }
    if (inBlock) buf.push(ln);
  }
  if (inBlock) transcripts.push(buf.join('\n').trim());
  return transcripts;
}

function pyFlags() {
  const f = [];
  if (CAP === 'words') f.push('--words');
  else f.push('--group', String(GROUP_SIZE));
  f.push('--max-chars', String(MAX_CHARS));
  return f;
}

// Transcribe a single source (already a file path). range = {sourceIn, duration};
// offset shifts cue times to the timeline.
function transcribe(sourcePath, outSrt, range, offset) {
  const wav = path.join(os.tmpdir(), 'amharic_' + Date.now() + '.wav');
  return new Promise((resolve, reject) => {
    const ffArgs = ['-v', 'error', '-y', '-i', sourcePath];
    // For a trimmed clip we must start from sourceIn AND stop after duration.
    // Put -ss after -i (accurate seek) so the extracted segment matches the
    // timeline trim exactly, not a keyframe-aligned approximation.
    if (range && range.duration > 0) {
      ffArgs.push('-ss', String(range.sourceIn || 0), '-t', String(range.duration));
    }
    ffArgs.push('-ac', '1', '-ar', '16000', wav);
    activeChild = execFile(FFMPEG, ffArgs, (err) => {
      if (err) {
        try { fs.unlinkSync(wav); } catch (e) {}
        reject(new Error('ffmpeg failed: ' + (err.message || err))); return;
      }
      const pyArgs = [SCRIPT, wav, outSrt].concat(pyFlags());
      if (offset && offset !== 0) pyArgs.push('--offset', String(offset));
      activeChild = execFile(PYTHON, pyArgs, { maxBuffer: 32 * 1024 * 1024, env: AMH_ENV }, (perr, stdout) => {
        try { fs.unlinkSync(wav); } catch (e) {}
        if (cancelRequested) { reject(new Error('Cancelled')); return; }
        if (perr) { reject(new Error('Python failed: ' + (perr.message || perr))); return; }
        const transcript = extractTranscripts(stdout).join('\n');
        let cues = [];
        try { cues = parseSrt(fs.readFileSync(outSrt, 'utf8')); } catch (e) {}
        lastCues = cues;
        lastSrtPath = outSrt;
        resolve({ outSrt, cues, transcript });
      });
    });
  }).finally(() => { activeChild = null; });
}

// Transcribe several extracted wavs in ONE Python process (one model load).
function transcribeBatch(items, outSrt, onProgress) {
  const reqPath = path.join(os.tmpdir(), 'amharic_batch_' + Date.now() + '.json');
  fs.writeFileSync(reqPath, JSON.stringify(items.map((it) => ({
    wav: it.wav, offset: it.offset
  }))), 'utf8');
  const pyArgs = [SCRIPT, '--batch', reqPath, outSrt].concat(pyFlags());
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON, pyArgs, { maxBuffer: 64 * 1024 * 1024, env: AMH_ENV }, (perr, stdout) => {
      if (perr) { reject(new Error('Python failed: ' + (perr.message || perr))); return; }
      if (cancelRequested) { reject(new Error('Cancelled')); return; }
      let transcript = '';
      const lines = String(stdout || '').split('\n');
      let inBlock = false, buf = [];
      for (const ln of lines) {
        const prog = ln.match(/^\[batch\] %% (\d+)\/(\d+) (.+)$/);
        if (prog) {
          if (onProgress) onProgress(parseInt(prog[1], 10), parseInt(prog[2], 10), prog[3]);
          continue;
        }
        if (ln.indexOf('--- full transcription ---') === 0) { inBlock = true; buf = []; continue; }
        if (ln.indexOf('[info]') === 0) { if (inBlock) { transcript += (transcript ? '\n' : '') + buf.join('\n').trim(); inBlock = false; } continue; }
        if (inBlock) buf.push(ln);
      }
      if (inBlock) transcript += (transcript ? '\n' : '') + buf.join('\n').trim();
      let cues = [];
      try { cues = parseSrt(fs.readFileSync(outSrt, 'utf8')); } catch (e) {}
      try { fs.unlinkSync(reqPath); } catch (e) {}
      lastCues = cues;
      lastSrtPath = outSrt;
      resolve({ outSrt, cues, transcript: transcript.trim() });
    });
    $('cancelBtn').addEventListener('click', () => { try { child.kill(); } catch (e) {} }, { once: true });
  });
}

function showTranscript(text) {
  const box = $('transcriptBox');
  if (!box) return;
  box.value = text || '';
}

async function finishImport(outSrt, label, startSeconds) {
  log('Placing captions on your timeline…');
  const imp = await importCaptions(outSrt, startSeconds || 0, label);
  if (imp.ok) {
    // A transcript was produced and placed: for an unlicensed trial user this
    // counts as one free use.
    consumeTrialCredit();
    log('✓ Captions added: ' + imp.captionItemName);
    if (imp.requestedStart !== undefined && imp.landedStart !== undefined &&
        imp.landedStart !== null) {
      log('Timeline position ' + imp.landedStart.toFixed(2) + 's → ' +
          (imp.landedEnd !== null ? imp.landedEnd.toFixed(2) + 's' : '?') +
          '  (requested ' + imp.requestedStart.toFixed(2) + 's)');
    }
    if (!imp.placed && imp.note) log('Note: ' + imp.note);
    log('Can\'t see them? Expand the caption track (bottom of the timeline) and');
    log('  turn on the CC toggle in the Program Monitor.');
    log('To restyle, open Essential Graphics and set the caption font.');
  } else {
    log('Import warning: ' + (imp.error || 'unknown'));
  }
}

// ---------------------------------------------------------------- runners
function setProgress(pct, text) {
  const bar = $('progBar');
  if (bar) bar.style.width = (Math.round(pct * 100)) + '%';
  const label = $('progLabel');
  if (label) label.textContent = text || '';
}

async function run() {
  clearLog();
  cancelRequested = false;
  setProgress(0, '');
  if (!RUNTIME) {
    log('ERROR: Transcription runtime not found.');
    log('Reinstall the extension and restart Premiere.');
    return;
  }
  if (!fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    log('ERROR: Runtime is incomplete — missing python or ffmpeg.');
    log('Reinstall the correct platform build and restart Premiere.');
    return;
  }
  if (!LICENSED && trialRemaining() <= 0) {
    log('Your free trial (2 transcriptions) is used up.');
    log('Enter your license key in the License section and click Activate to continue.');
    return;
  }
  setBusy(true);
  try {
    if (SOURCE === 'clip') { await runSelectedClip(); return; }
    await runWorkArea();
  } catch (e) {
    if (!cancelRequested) log('ERROR: ' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
    setProgress(0, '');
    updateLicenseUI();
  }
}

async function runSelectedClip() {
  log('Checking your selected clip…');
  const c = await getSelectedClip();
  if (!c.ok || !c.sourcePath) throw new Error(c.error || 'No selected clip.');
  log('✓ Clip: ' + c.name + (c.via ? ('  [' + c.via + ']') : ''));
  log('Listening to ' + c.duration.toFixed(1) + 's of audio…');

  if (c.duration <= 0) { log('ERROR: Selected clip has zero duration.'); return; }

  // Clean base name WITHOUT any media extension ("mehari", not "mehari.mp3").
  // Embedding ".mp3" in the temp SRT filename confuses Premiere's media-type
  // detection so it stops importing the file as a caption track.
  const cleanName = (c.name.replace(/\.[^.]+$/, '') || 'captions');

  const outSrt = path.join(os.tmpdir(), 'amh_captions_' + Date.now() + '.srt');
  setProgress(0.4, 'Transcribing…');
  // Bake the clip's absolute timeline position into the SRT timestamps (so the
  // cues carry their real timeline times), then place the caption band at 0.
  const r = await transcribe(c.sourcePath, outSrt,
    { sourceIn: c.sourceIn, duration: c.duration }, c.timelineStart);
  setProgress(0.9, 'Transcription complete');

  log('Done writing captions.');
  showTranscript(r.transcript);

  // Import via a UNIQUELY named temp file so Premiere is forced to create a fresh
  // caption item on every run instead of reusing a stale/cached one.
  await finishImport(outSrt, cleanName, 0);
  try { fs.unlinkSync(outSrt); } catch (e) {}
}

async function runWorkArea() {
  log('Reading your edit area…');
  const info = await getSequenceInfo(SOURCE === 'whole');
  if (!info.ok || !info.clips) throw new Error(info.error || 'No sequence info.');
  const clips = info.clips;
  if (clips.length === 0) {
    log('No audio-bearing clips with a resolvable source in this sequence/work area.');
    return;
  }
  // Whole-edit mode: ignore the work-area bounds (transcribe every clip).
  const rangeLabel = (SOURCE === 'whole')
    ? 'whole edit (all clips)'
    : 'work area ' + info.inPoint.toFixed(2) + 's → ' +
      (info.outPoint >= 1e10 ? 'end' : info.outPoint.toFixed(2)) + 's';
  log('Found ' + clips.length + ' clip(s) to transcribe (' + rangeLabel + ').');
  log('Extracting audio per clip, then writing captions in one pass…');

  const outSrt = path.join(os.tmpdir(), 'amh_sequence_' + Date.now() + '.srt');
  const stamp = Date.now();

  const items = [];
  for (let n = 0; n < clips.length; n++) {
    if (cancelRequested) { log('Cancelled by user.'); return; }
    const clip = clips[n];
    setProgress((n + 1) / clips.length / 2, 'Extracting audio ' + (n + 1) + '/' + clips.length);
    const wav = path.join(os.tmpdir(), 'amh_extract_' + stamp + '_' + n + '.wav');
    await extractAudio(clip, wav);
    items.push({ wav, offset: clip.timelineStart, name: clip.name, duration: clip.duration });
  }

  if (cancelRequested) { log('Cancelled by user.'); return; }

  log('Transcribing ' + items.length + ' clip(s) in one pass…');
  const r = await transcribeBatch(items, outSrt, (n, total, name) => {
    setProgress(0.5 + (n / total) * 0.5, 'Transcribing ' + n + '/' + total +
      (name && name.trim() ? ' (' + path.basename(name) + ')' : ''));
  });

  for (const it of items) { try { fs.unlinkSync(it.wav); } catch (e) {} }

  log('Done — ' + r.cues.length + ' captions written.');
  showTranscript(r.transcript);

  await finishImport(outSrt, 'sequence');
  try { fs.unlinkSync(outSrt); } catch (e) {}
}

// ------------------------------------------------------------ choose file
async function runFromFile(input) {
  if (!input.files || input.files.length === 0) return;
  const f = input.files[0];
  const picked = $('picked');
  if (picked) {
    picked.style.display = 'block';
    picked.textContent = 'Selected: ' + f.name + (f.path ? ('\n' + f.path) : '');
  }
  clearLog();
  if (!f.path) {
    log('ERROR: CEP did not expose a filesystem path for "' + f.name + '".');
    log('On this Premiere build the file picker returns no path. Try the ' +
        '"Selected Clip" or "Work Area" source instead.');
    return;
  }
  try {
    localStorage.setItem('amh.lastFile', JSON.stringify({ path: f.path, name: f.name }));
  } catch (e) {}
  log('Using chosen file: ' + f.name);
  log('Path: ' + f.path);
  return runFile(f.path, f.name);
}

async function runFile(filePath, fileName) {
  clearLog();
  cancelRequested = false;
  setBusy(true);
  setProgress(0, '');
  try {
    const base = filePath.replace(/\.[^.]+$/, '');
    const outSrt = path.join(os.tmpdir(), 'amh_file_' + Date.now() + '.srt');
    const cleanName = (fileName || path.basename(base) || 'captions').replace(/\.[^.]+$/, '');
    log('Writing captions… this can take a minute.');
    setProgress(0.4, 'Transcribing…');
    const r = await transcribe(filePath, outSrt);
    setProgress(0.9, 'Transcription complete');
    log('Done writing captions.');
    showTranscript(r.transcript);
    await finishImport(outSrt, cleanName);
    try { fs.unlinkSync(outSrt); } catch (e) {}
  } catch (e) {
    if (!cancelRequested) log('ERROR: ' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
    setProgress(0, '');
  }
}

// ----------------------------------------------------------------- export
function exportCaptions() {
  if (!lastCues || lastCues.length === 0) {
    log('Nothing to export yet. Generate captions first.');
    return;
  }
  const cwd = os.homedir() + '/Desktop/AmharicCaptions';
  try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) {}
  const fmt = $('expFmt').value;
  const base = (lastSrtPath ? path.basename(lastSrtPath).replace(/\.srt$/i, '') : 'captions');
  const dest = path.join(cwd, base + '.' + fmt);
  if (fmt === 'vtt') writeVtt(dest);
  else writeSrt(dest);
  log('Exported ' + fmt.toUpperCase() + ': ' + dest);
}

// ------------------------------------------------------------------ wiring
function setup() {
  applySettings();

  // Words-per-caption only applies in Grouped mode (karaoke = 1 word/caption).
  const syncStyleControls = () => {
    $('groupSize').disabled = (CAP !== 'grouped');
  };
  syncStyleControls();

  // Source segmented control
  document.querySelectorAll('#srcSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#srcSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      SOURCE = b.dataset.src;
      saveSettings({ source: SOURCE });
    });
  });

  // Caption style segmented control
  document.querySelectorAll('#capSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#capSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      CAP = b.dataset.cap;
      saveSettings({ cap: CAP });
      syncStyleControls();
    });
  });

  $('groupSize').addEventListener('input', (e) => {
    GROUP_SIZE = Math.max(1, Math.min(12, Number(e.target.value) || 3));
    saveSettings({ group: GROUP_SIZE });
  });
  $('maxChars').addEventListener('input', (e) => {
    MAX_CHARS = Math.max(10, Math.min(200, Number(e.target.value) || 42));
    saveSettings({ chars: MAX_CHARS });
  });
  $('expFmt').addEventListener('change', (e) => saveSettings({ fmt: e.target.value }));

  $('runBtn').addEventListener('click', run);
  $('exportBtn').addEventListener('click', exportCaptions);
  $('cancelBtn').addEventListener('click', () => {
    cancelRequested = true;
    try { if (activeChild) activeChild.kill(); } catch (e) {}
  });

  $('choose').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => runFromFile($('fileInput')));

  $('diag').addEventListener('click', async (e) => {
    e.preventDefault();
    $('logDisc').classList.add('open');
    clearLog();
    log('Dumping project media tree…');
    const r = await runDiagnostics();
    if (r.ok && r.lines) {
      r.lines.forEach((l) => log(l));
      log('---');
      log('If every clip shows "path=(none)", Premiere is not exposing on-disk paths.');
    } else {
      log('ERROR: ' + (r.error || 'unknown'));
    }
  });

  // Disclosures
  $('logDisc').addEventListener('click', () => {
    $('logDisc').classList.toggle('open');
  });
  $('transcriptDisc').addEventListener('click', () => {
    $('transcriptDisc').classList.toggle('open');
  });

  // Runtime availability.
  if (!RUNTIME) {
    setStatus('err', 'runtime missing');
    log('ERROR: could not find the transcription runtime.');
    log('Expected it at:');
    log('  ' + path.join(EXT_DIR, 'runtime'));
    log('  or ' + DEV_RUNTIME);
    log('');
    log('This extension folder is: ' + EXT_DIR);
    log('If this path is NOT the ...\\extensions\\com.amharic.captions folder,');
    log('or if runtime/ is missing/nested inside another folder, re-extract the');
    log('zip so that js/, runtime/, jsx/ and CSXS/ sit directly inside the');
    log('com.amharic.captions folder. Then restart Premiere.');
  } else if (!fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG) || !fs.existsSync(MODEL_DIR)) {
    setStatus('err', 'runtime incomplete');
    log('ERROR: runtime found at ' + RUNTIME + ' but is incomplete.');
    log('  python: ' + (fs.existsSync(PYTHON) ? 'ok' : 'MISSING (' + PYTHON + ')'));
    log('  ffmpeg: ' + (fs.existsSync(FFMPEG) ? 'ok' : 'MISSING (' + FFMPEG + ')'));
    log('  model:  ' + (fs.existsSync(MODEL_DIR) ? 'ok' : 'MISSING (' + MODEL_DIR + ')'));
    log('Reinstall the correct runtime for your platform and restart Premiere.');
  } else {
    setStatus('ready', IS_WIN ? 'ready · win' : 'ready · mac');
  }

  // P0 polish: token theme applied already; keep health + onboarding in sync.
  renderHealthList();
  initOnboarding();
  initSupport();
  initVersion();
}

setup();
