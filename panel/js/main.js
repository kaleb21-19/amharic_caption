/*
 * Amharic Captions panel controller.
 * Runs inside CEP Chromium with Node integration, so it can spawn ffmpeg and
 * the Ethio-ASR Python transcription, then hand the SRT to Premiere via
 * ExtendScript.
 */
'use strict';

const APP_VERSION = '1.7.2';

// Panel language (js/i18n.js). L() returns the Amharic for a known English UI
// string when the panel is in Amharic, else the English; it degrades to a
// no-op if i18n.js is not loaded.
function L(s) { return (typeof T === 'function') ? T(s) : s; }

// Language switch (header / onboarding toggle): re-render every piece of
// dynamic text that was built in the old language. Static HTML is handled by
// i18n.js itself; the engine Log intentionally stays English. Registered this
// early (callbacks run later, on click) and each step is guarded, so a panel
// that failed part-way through loading still switches what it did render.
if (typeof i18nOnChange === 'function') {
  i18nOnChange(() => {
    const steps = [
      () => { LICENSED_REFRESH = true; updateLicenseUI(); }, // re-render only; no scroll
      () => renderFontPill(AMH_FONT),
      () => renderHealthList(),
      () => {
        const txt = document.getElementById('statusText');
        if (txt && STATUS_EN) txt.textContent = L(STATUS_EN);
      },
      () => {
        const rv = document.getElementById('review');
        if (rv && rv.classList.contains('show')) renderReview();
      },
      () => {
        const pl = document.getElementById('progLabel');
        if (pl && PROGRESS_EN) pl.textContent = L(PROGRESS_EN);
      },
    ];
    steps.forEach((step) => { try { step(); } catch (e) {} });
  });
}

const csi = new CSInterface();

// Host application: 'PPRO' (Premiere Pro) or 'AEFT' (After Effects). The panel
// is shared; only the ExtendScript layer differs (jsx/host_ae.jsx overrides
// host.jsx's entry points inside After Effects, see loadHostLayer()).
const HOST_APP = (() => {
  try {
    const env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
    if (env && env.appName === 'AEFT') return 'AEFT';
  } catch (e) {}
  return 'PPRO';
})();
const IS_AE = HOST_APP === 'AEFT';
const HOST_NAME = IS_AE ? 'After Effects' : 'Premiere';

// True in a lite package until the one-time model download has finished
// (see resolveModelDir / initModelDownload). Generate stays disabled.
let MODEL_MISSING = false;

// After Effects words for the source picker (a comp has layers, not clips).
// Re-keyed so the language toggle keeps the AE wording in both languages.
if (IS_AE) {
  [['srcClip', 'src.clip.ae', 'Selected Layer'],
   ['srcWhole', 'src.whole.ae', 'Whole Comp'],
   ['reviewPlace', 'rev.place.ae', '✓ Add to composition'],
   ['reviewSub', 'rev.sub.ae', 'edit text & times, then add them to the composition']].forEach(([id, key, en]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('data-i18n', key);
    el.__i18nEn = en;
    el.textContent = en;
  });
  if (typeof i18nApplyStatic === 'function') i18nApplyStatic();
}

// ─────────────────────────────────────────────────────────────────────────────
// License system (runs FIRST, independently of CEP Node, so it also works in a
// plain browser for testing). New Machine IDs are random 16-hex installation
// identifiers, stored locally. Legacy 8-hex IDs remain readable for recovery.
// License keys are HMAC-SHA256 signed and displayed in AMH- groups.
// ─────────────────────────────────────────────────────────────────────────────
// No HMAC secret is embedded here (ever). Key authenticity is decided by the
// server /api/validate; this file only does a quick structural check so a
// wrong key is rejected locally before a network round-trip.

// ── Cloudflare Worker API URL (server-side trial + key validation) ──────────
// Deployed Worker URL — see tools/telegram-worker/DEPLOY.md.
const API_URL = 'https://amharic-captions-bot.amhcaps.workers.dev';

// The extension API is public by design: a desktop panel cannot keep a
// meaningful shared secret. License authenticity is enforced by the Worker's
// HMAC + D1 lookup; do not treat a client-embedded API key as authentication.
// Deployments may set AMH_REQUIRE_API_KEY=1 as an optional infrastructure gate,
// but that gate cannot protect a public desktop client.
const API_KEY_HINT = '';

function apiHeaders() {
  const headers = {};
  if (API_KEY_HINT) headers['X-Api-Key'] = API_KEY_HINT;
  return headers;
}

const API_TIMEOUT_MS = 15000;
const TRIAL_SYNC_TIMEOUT_MS = 3000;
async function apiGet(path, timeoutMs) {
  timeoutMs = timeoutMs || API_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (controller) controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(API_URL + path, { method: 'GET', headers: apiHeaders(), signal: controller && controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

async function apiPost(path, body) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (controller) controller.abort(); }, API_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json', ...apiHeaders() };
    const res = await fetch(API_URL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller && controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
  finally { clearTimeout(timer); }
}

// ── Machine identity — Node-persisted, outside CEP's removable storage ───────
// The panel runs inside CEP Chromium with Node integration (manifest has
// --enable-nodejs, so `require` exists here — but NOT in a plain-browser test
// page). The license anchor mid stays a random 16-hex value (legacy 8-hex
// records remain readable), but its source file
// now lives in the user's HOME directory: clearing CEP cookies, uninstalling
// the extension, or reinstalling CEP does NOT reset it, so deleting
// localStorage no longer regenerates a fresh trial/license machine. A host
// fingerprint (username + home-directory + platform) is stored alongside so
// support can spot a record that was copied onto another PC. New records use a
// random 16-hex installation ID; legacy 8-hex IDs remain readable. Degrades to
// localStorage-only when Node's fs/os are unavailable (plain browser test page).
const NODE = (typeof require === 'function') ? require : null;
const nodeFs = (() => { try { return NODE && NODE('fs'); } catch (e) { return null; } })();
const nodeOs = (() => { try { return NODE && NODE('os'); } catch (e) { return null; } })();
const nodePath = (() => { try { return NODE && NODE('path'); } catch (e) { return null; } })();

function identityHome() {
  if (!nodeOs) return null;
  // AMH_MACHINE_HOME optionally relocates the identity store (support /
  // portable installs / tests). Defaults to the user's home directory.
  return (process && process.env && process.env.AMH_MACHINE_HOME)
    || (nodeOs.homedir && nodeOs.homedir()) || null;
}

function identityFile(name) {
  const home = identityHome();
  if (!home) return null;
  if (nodePath && nodePath.join) return nodePath.join(home, name);
  return home + '/' + name;
}

function machineFilePath() {
  return identityFile('.amharic_captions_machine.json');
}

// The license lives in the HOME DIRECTORY, not just localStorage. CEP's
// localStorage is per-extension AND per-host-version — the real cache path is
//   ~/Library/Caches/CSXS/cep_cache/PPRO_<ver>_com.amharic.captions.panel/
// so a Premiere upgrade hands the panel a brand-new empty store and the
// customer silently loses a license they paid for, with no way back (the
// server has no mid-only lookup; /api/validate needs the key itself).
// Observed in the wild 2026-09-22. Keep this file separate from the machine
// record so a license write can never endanger the machine ID.
function licenseFilePath() {
  return identityFile('.amharic_captions_license.json');
}

// Bump when the fingerprint inputs change, so records stamped by an older
// algorithm are never compared against a newer one (that would flag every
// existing install as "moved to another computer" exactly once).
const HOST_FP_VERSION = 2;

function hostFingerprint() {
  try {
    if (!nodeOs || !NODE) return null;
    const u = nodeOs.userInfo && nodeOs.userInfo();
    // Deliberately NOT os.hostname(). On macOS it follows the network —
    // "Name.local" on Wi-Fi, "Name.lan" on some routers, bare "Name"
    // otherwise — so a paying customer changing networks saw "This machine
    // record was created on another computer. ... contact support", for a
    // machine that had not changed at all. username+homedir+platform still
    // catches a record copied to a different PC or a different account, which
    // is the only thing this flag is for.
    const raw = [
      String((u && u.username) || ''),
      String((u && u.homedir) || ''),
      String((nodeOs.platform && nodeOs.platform()) || '')
    ].join('|');
    return NODE('crypto').createHash('sha256').update(raw).digest('hex').slice(0, 8);
  } catch (e) { return null; }
}

const MACHINE_ID_LENGTH = 16; // 64 bits for new installation identities

function randomMachineId() {
  if (NODE) {
    try {
      return Array.from(NODE('crypto').randomBytes(MACHINE_ID_LENGTH / 2))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {}
  }
  return Array.from((window.crypto || globalThis.crypto).getRandomValues(new Uint8Array(MACHINE_ID_LENGTH / 2)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseMachineRecord(raw) {
  try {
    const rec = JSON.parse(raw);
    if (rec && (/^[0-9a-f]{8}$/.test(rec.id) || new RegExp('^[0-9a-f]{' + MACHINE_ID_LENGTH + '}$').test(rec.id))) {
      return {
        id: rec.id,
        host: typeof rec.host === 'string' ? rec.host : null,
        hv: Number(rec.hv) || 1
      };
    }
  } catch (e) {}
  return null;
}

function loadMachineRecord() {
  const p = machineFilePath();
  if (!p || !nodeFs) return null;
  try {
    const primary = parseMachineRecord(nodeFs.readFileSync(p, 'utf8'));
    if (primary) return primary;
  } catch (e) {}
  // A crash during a direct write must not mint a new paid license identity.
  // Recover the last complete record before considering a fresh machine.
  try {
    const backup = parseMachineRecord(nodeFs.readFileSync(p + '.bak', 'utf8'));
    if (backup) {
      saveMachineRecord(backup.id, backup.host);
      return backup;
    }
  } catch (e) {}
  return null;
}

function saveMachineRecord(id, host) {
  const p = machineFilePath();
  if (!p || !nodeFs) return false;
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  try {
    nodeFs.mkdirSync(require('path').dirname(p), { recursive: true });
    nodeFs.writeFileSync(tmp, JSON.stringify({ id: id, host: host || null, hv: HOST_FP_VERSION }), { encoding: 'utf8', mode: 0o600 });
    try { nodeFs.chmodSync(tmp, 0o600); } catch (e) {}
    // Keep one known-good copy before replacing the primary. Never overwrite a
    // valid backup with a truncated primary while recovering from corruption.
    try {
      if (nodeFs.existsSync(p)) {
        const current = parseMachineRecord(nodeFs.readFileSync(p, 'utf8'));
        if (current) nodeFs.copyFileSync(p, p + '.bak');
      }
    } catch (e) {}
    try {
      nodeFs.renameSync(tmp, p);
    } catch (e) {
      // Windows can refuse rename-over-existing; the backup still protects the
      // next boot if this fallback is interrupted.
      nodeFs.copyFileSync(tmp, p);
      nodeFs.unlinkSync(tmp);
    }
    try { nodeFs.chmodSync(p, 0o600); } catch (e) {}
    return true;
  } catch (e) {
    try { nodeFs.unlinkSync(tmp); } catch (cleanupError) {}
    return false;
  }
}

function getOrCreateMachineId() {
  // 1) Node-persisted record is the source of truth.
  const rec = loadMachineRecord();
  if (rec) {
    try { localStorage.setItem('amh.machineId', rec.id); } catch (e) {}
    return rec.id;
  }
  // 2) A legacy localStorage id migrates into the Node file so existing
  //    license holders keep the same machine (no re-key after this update).
  const legacy = localStorage.getItem('amh.machineId');
  if (legacy && (/^[0-9a-f]{8}$/.test(legacy) || new RegExp('^[0-9a-f]{' + MACHINE_ID_LENGTH + '}$').test(legacy))) {
    saveMachineRecord(legacy, hostFingerprint());
    return legacy;
  }
  // 3) Brand-new machine.
  const id = randomMachineId();
  saveMachineRecord(id, hostFingerprint());
  try { localStorage.setItem('amh.machineId', id); } catch (e) {}
  return id;
}

// True when the home-dir record was created on a different host than the one
// it is now running on (record copied onto another PC / user reinstalled under
// a different account). We flag it for the UI instead of silently cycling the
// identity, which would make a legitimately-reinstalled license invalid.
const MACHINE_HOST_MISMATCH = (() => {
  const rec = loadMachineRecord();
  const cur = hostFingerprint();
  if (!rec || !cur) return false;
  if (rec.hv !== HOST_FP_VERSION) {
    // Stamped by the old hostname-based algorithm, so its value is not
    // comparable to `cur`. Re-stamp with the stable fingerprint and stay
    // quiet: warning here would show "created on another computer" to every
    // existing install exactly once, which is the false alarm this removes.
    // The machine ID is passed through untouched, so the license stays valid.
    saveMachineRecord(rec.id, cur);
    return false;
  }
  return !!rec.host && cur !== rec.host;
})();

const MACHINE_ID = getOrCreateMachineId();

// Boot ping: announce {version, mid} so support can tell which build a machine
// is running. Fire-and-forget, and genuinely once per day.
//
// The comment here used to claim "once per day" while the code pinged on EVERY
// panel open — an editor who opens Premiere four times a day sent four. That
// is free at one customer and is the difference between fitting in a request
// budget and not at ten thousand, for telemetry nobody reads more than once.
const PING_KEY = 'amh.lastPing';
const PING_EVERY_MS = 24 * 60 * 60 * 1000;
function pingPanel() {
  try {
    let last = 0;
    try { last = Number(localStorage.getItem(PING_KEY)) || 0; } catch (e) {}
    const now = Date.now();
    // A clock that jumped backwards must not silence the ping forever.
    if (last && now - last < PING_EVERY_MS && now >= last) return;
    try { localStorage.setItem(PING_KEY, String(now)); } catch (e) {}
    apiPost('/api/ping?v=1', { v: APP_VERSION, mid: MACHINE_ID });
  } catch (e) {}
}
setTimeout(pingPanel, 800);

// ── Update-available notice ──────────────────────────────────────────────────
// Asks our Worker (GET /api/latest, one cached GitHub lookup for everyone) at
// most once a day and remembers the answer, so the banner survives restarts
// and offline days. ✕ snoozes it for 3 days for that version only; a newer
// release shows again at once. The button only ever opens our own website.
const UPDATE_LATEST_KEY = 'amh.update.latest';     // {version, url}
const UPDATE_CHECKED_KEY = 'amh.update.checked';   // epoch ms of last lookup
const UPDATE_SNOOZE_KEY = 'amh.update.snooze';     // {version, until}
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const UPDATE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const UPDATE_SITE = 'https://amharic-caption-pro.vercel.app/';

function versionNewer(a, b) {           // true when version a > version b
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }

function renderUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  const latest = readJson(UPDATE_LATEST_KEY);
  const snooze = readJson(UPDATE_SNOOZE_KEY);
  const show = !!(latest && /^\d+\.\d+\.\d+$/.test(latest.version) &&
    versionNewer(latest.version, APP_VERSION) &&
    !(snooze && snooze.version === latest.version && Date.now() < snooze.until));
  banner.style.display = show ? 'flex' : 'none';
  if (show) {
    const txt = document.getElementById('updateText');
    if (txt) txt.textContent = L('Version ' + latest.version + ' is available.');
  }
}

async function checkForUpdate() {
  let last = 0;
  try { last = Number(localStorage.getItem(UPDATE_CHECKED_KEY)) || 0; } catch (e) {}
  const now = Date.now();
  if (!(last && now - last < UPDATE_EVERY_MS && now >= last)) {
    const data = await apiGet('/api/latest', 5000);
    if (data && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(data.version || ''))) {
      const url = (typeof data.url === 'string' && data.url.indexOf(UPDATE_SITE) === 0)
        ? data.url : UPDATE_SITE + 'install/';
      try {
        localStorage.setItem(UPDATE_LATEST_KEY, JSON.stringify({ version: data.version, url }));
        localStorage.setItem(UPDATE_CHECKED_KEY, String(now));
      } catch (e) {}
    }
    // Offline / server error: nothing stored, so the next panel open retries.
  }
  renderUpdateBanner();
}

function initUpdateBanner() {
  const go = document.getElementById('updateGo');
  const later = document.getElementById('updateLater');
  if (go) go.addEventListener('click', (e) => {
    e.preventDefault();
    const latest = readJson(UPDATE_LATEST_KEY);
    const url = (latest && typeof latest.url === 'string' && latest.url.indexOf(UPDATE_SITE) === 0)
      ? latest.url : UPDATE_SITE + 'install/';
    try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
    catch (err) { window.open(url, '_blank'); }
  });
  if (later) later.addEventListener('click', () => {
    const latest = readJson(UPDATE_LATEST_KEY);
    if (latest) {
      try {
        localStorage.setItem(UPDATE_SNOOZE_KEY,
          JSON.stringify({ version: latest.version, until: Date.now() + UPDATE_SNOOZE_MS }));
      } catch (e) {}
    }
    renderUpdateBanner();
  });
  if (typeof i18nOnChange === 'function') i18nOnChange(renderUpdateBanner);
  renderUpdateBanner();                 // last known answer, even offline
  setTimeout(checkForUpdate, 1500);
}

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

// Authoritative detection: force each candidate font through FontFaceSet.load()
// and accept the first one that actually produced a matching face. Falls back
// to a canvas width probe when the FontFaceSet API is missing or lies.
function detectAmharicFont() {
  return new Promise((resolve) => {
    const probe = '\u1200\u1228';
    // The filesystem scan is authoritative. When it has already answered, the
    // weaker browser probe must not clobber it (the probe cannot be trusted in
    // the embedded Chromium). When fs is unavailable it stays null and the
    // browser result stands as the best available answer.
    const finish = (info) => {
      if (AMH_FONT_FS) { resolve(info); return; }
      applyFontInfo(info);
      resolve(info);
    };

    const tryCanvas = () => {
      try {
        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        ctx.font = '24px "monospace"';
        const narrow = ctx.measureText(probe).width;
        for (const name of AMH_CANDIDATE_FONTS) {
          ctx.font = '24px "' + name + '", "monospace"';
          // If the named font exists it wins the CSS font stack; if it is
          // missing, monospace renders the probe (typically tofu, and wider).
          if (Math.abs(ctx.measureText(probe).width - narrow) > 0.5) {
            return finish({ ok: true, font: name, support: true });
          }
        }
        return finish({ ok: false, font: null, support: true });
      } catch (e) {
        return finish({ ok: true, font: null, support: false });
      }
    };

    if (typeof document === 'undefined' || !document.fonts ||
        typeof document.fonts.load !== 'function') {
      return tryCanvas();
    }

    const fontToLoad = AMH_CANDIDATE_FONTS.slice();
    const tryNext = () => {
      const name = fontToLoad.shift();
      if (!name) return tryCanvas(); // none loaded → canvas probe
      let faces;
      try {
        faces = document.fonts.load('16px "' + name + '"', probe);
      } catch (e) { return tryNext(); }
      if (!faces || typeof faces.then !== 'function') return tryNext();
      faces.then((list) => {
        const ok = Array.isArray(list) && list.some((f) => f && f.family === name);
        if (ok) return finish({ ok: true, font: name, support: true });
        return tryNext();
      }).catch(() => tryNext());
    };
    tryNext();
  });
}

let AMH_FONT = { ok: true, font: null, support: false };
let AMH_FONT_FS = null; // set once the filesystem-backed scan (below) has run
function applyFontInfo(info) {
  AMH_FONT = info;
  renderFontPill(info);
  renderHealthList();
}
// Kick off the browser-based detection (fast, but not authoritative inside the
// embedded Chromium). It is overridden by the filesystem scan once fs is live.
detectAmharicFont();

function renderFontPill(info) {
  const pill = document.getElementById('fontPill');
  const txt = document.getElementById('fontText');
  if (!pill || !txt) return;
  // Nothing to say when the Amharic font is fine: the pill only appears when
  // the customer has something to fix (keeps the header uncluttered).
  pill.style.display = (info.support && info.ok && info.font) ? 'none' : '';
  if (!info.support) {
    pill.className = 'warn';
    txt.textContent = L('font: unknown');
    pill.title = L('Could not detect installed fonts on this system.');
    return;
  }
  if (info.ok && info.font) {
    pill.className = 'ok';
    txt.textContent = info.font;
    pill.title = L('Captions will render in ' + info.font + '.' +
      ' For the clearest Amharic, install "Abyssinica SIL" for free.');
  } else {
    pill.className = 'warn';
    txt.textContent = L('font: install');
    pill.title = L('No Ethiopic-capable font detected. Install "Abyssinica SIL" ' +
      '(free) so captions render correctly in Premiere.');
  }
}
// Drop-in guard: renders 'font: …' placeholder until async detection resolves.
if (document.getElementById('fontPill')) renderFontPill(AMH_FONT);

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
    const features = !!RUNTIME && (isDegradedRuntime(RUNTIME) || ['amh_lm.py', 'amh_lm.json.gz', 'amh_vad.py', 'silero_vad.onnx', 'amh_diarize.py', 'speaker_embed.onnx']
      .every((f) => fs.existsSync(path.join(RUNTIME, f))));
    runtime = !!RUNTIME && fs.existsSync(PYTHON) && fs.existsSync(FFMPEG) && fs.existsSync(MODEL_DIR) && features;
    python = !!RUNTIME && fs.existsSync(PYTHON);
    ffmpeg = !!RUNTIME && fs.existsSync(FFMPEG);
    model = !!RUNTIME && !MODEL_MISSING && (
      fs.existsSync(path.join(MODEL_DIR, 'model_meta.json')) ||
      fs.existsSync(path.join(MODEL_DIR, 'config.json'))
    );
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
    row.querySelector('span:first-child').textContent = L(label);
    row.classList.toggle('ok', good);
    row.classList.toggle('bad', !good);
    state.textContent = L(good ? 'OK' : 'Missing');
    row.style.display = good ? 'none' : '';
  });
  // All fine: say nothing. Something missing: show only those rows.
  const allGood = Object.keys(map).every((k) => map[k][1]);
  const list = document.getElementById('healthList');
  const title = document.getElementById('healthTitle');
  if (list) list.style.display = allGood ? 'none' : '';
  if (title) title.style.display = allGood ? 'none' : '';
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

// Buy: open the sales bot with the Machine ID already in the message. The
// three-step "copy / open / paste" instruction it replaces put the single
// most error-prone action in the purchase — transcribing a 16-character id
// into a chat by hand — on the customer.
function initBuy() {
  const b = document.getElementById('buyBtn');
  if (b) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const msg = encodeURIComponent(
        'Hello! I want to buy Amharic Captions.\nMachine ID: ' + MACHINE_ID);
      const url = 'https://t.me/AmharicCaptionsBot?text=' + msg;
      try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
      catch (err) { window.open(url, '_blank'); }
    });
  }
  // Bank details stay one tap away rather than occupying the panel by
  // default — they matter at payment time, not while reading.
  const t = document.getElementById('bankDetails');
  const box = document.getElementById('bankBox');
  if (t && box) {
    t.addEventListener('click', (e) => {
      e.preventDefault();
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
  }
}

// Terms link: open the license, privacy & refund page in the default browser.
function initLegal() {
  const a = document.getElementById('legalLink');
  if (a) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = 'https://amharic-caption-pro.vercel.app/legal/';
      try {
        if (window.__adobe_cep__) { window.cep.util.openURLInDefaultBrowser(url); }
        else { window.open(url, '_blank'); }
      } catch (err) { window.open(url, '_blank'); }
    });
  }
}

// ── Version badge in footer (keep in sync with CSXS manifest.xml) ──────────
function initVersion() {
  const el = document.getElementById('panelVersion');
  if (el) el.textContent = APP_VERSION;
}

function readLicenseFile() {
  const p = licenseFilePath();
  if (!p || !nodeFs) return null;
  try {
    const o = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}

function writeLicenseFile(obj) {
  const p = licenseFilePath();
  if (!p || !nodeFs) return false;
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const dir = nodePath && nodePath.dirname ? nodePath.dirname(p) : path.dirname(p);
    nodeFs.mkdirSync(dir, { recursive: true });
    // Write beside the destination, restrict permissions, then rename. A
    // partially written license file must never become the durable copy.
    nodeFs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
    try { nodeFs.chmodSync(tmp, 0o600); } catch (e) {}
    try {
      nodeFs.renameSync(tmp, p);
    } catch (e) {
      // Windows may refuse rename-over-existing; retain atomic behavior on
      // POSIX and use a guarded copy fallback only on that platform.
      nodeFs.copyFileSync(tmp, p);
      nodeFs.unlinkSync(tmp);
    }
    try { nodeFs.chmodSync(p, 0o600); } catch (e) {}
    return true;
  } catch (e) {
    try { nodeFs.unlinkSync(tmp); } catch (cleanupError) {}
    return false;
  }
}

// localStorage is a CACHE, the home-dir file is the durable copy. CEP wipes
// localStorage on a Premiere upgrade (the cache dir is keyed by host version),
// which silently de-licensed a paying customer with no way to recover — the
// server has no mid-only lookup, so they had to find their key again.
// Copying the file to another machine gains nothing: the lease is an ECDSA
// signature bound to THIS Machine ID and verifyLicenseToken() checks that.
function getLicense() {
  // The home-dir file is the durable source of truth. CEP may wipe or retain a
  // stale localStorage value independently, so never let that mask a valid file.
  const fromFile = readLicenseFile();
  if (fromFile) {
    try { localStorage.setItem('amh.license', JSON.stringify(fromFile)); }
    catch (e) {}
    return fromFile;
  }
  // If the durable file is genuinely absent (for example a pre-file install),
  // allow the cache as a recovery path; once a file exists it is authoritative.
  let ls = null;
  try { ls = JSON.parse(localStorage.getItem('amh.license') || 'null'); }
  catch (e) { ls = null; }
  return ls;
}

function setLicense(licenseObj) {
  let localOk = true;
  try { localStorage.setItem('amh.license', JSON.stringify(licenseObj)); }
  catch (e) { localOk = false; }
  const fileOk = writeLicenseFile(licenseObj);
  // A normal CEP build has Node fs and must persist the lease. Development
  // browser shims without Node can still use localStorage; a packaged build
  // never silently downgrades a paid activation to that cache.
  return nodeFs ? fileOk : localOk;
}

function canonicalPanelKey(value) {
  return String(value || '').trim().replace(/^amh/i, '').replace(/[\s-]+/g, '').toLowerCase();
}

// validateLicense() (structural-only key check) lives in js/core.js so it can
// be unit-tested in Node. It intentionally does NOT recompute the key's HMAC:
// the minting secret must never ship in the public panel bundle (anyone could
// then forge keys that pass the server too). The cryptographic authority is
// the server (/api/validate), which re-derives the HMAC and requires a real D1
// customer row; core.js only rejects obviously-wrong keys fast, locally.

let LICENSED = false;
let LICENSED_REFRESH = false;
let LICENSE_NOTE = '';

// Signed leases are mandatory. Legacy `{valid, serverValidated, activated}`
// objects are intentionally rejected because every field is user-controlled.

// Recompute LICENSED / LICENSE_NOTE from cryptographic evidence only.
// Runs on boot and after every activation attempt.
async function assessLicense() {
  const stored = getLicense();
  LICENSED = false;
  LICENSE_NOTE = '';
  if (!stored || !stored.token) return;

  const v = await verifyLicenseToken(stored.token, LICENSE_TOKEN_PUBKEY_PEM, MACHINE_ID);
  if (v.ok) {
    LICENSED = true;
    LICENSE_NOTE = 'Licensed' + (v.expiry && v.expiry !== '00000000' ? ' (expires ' + v.expiry + ')' : '');
    return;
  }
  // Definitive signature/shape failures clear the lease. A transient WebCrypto
  // or runtime failure must not destroy a valid offline license; it is simply
  // not unlocked for this session and can be retried on the next boot/focus.
  const transient = /No WebCrypto|verification failed/i.test(String(v.error || ''));
  if (!transient) setLicense(Object.assign({}, stored, { valid: false, token: null }));
}

// Online revocation check. Local signature verification remains the offline
// gate; this best-effort check makes a revoked key fail on the next boot (or
// focus) when the panel can reach the server. A network failure never destroys
// a valid offline lease.
const LICENSE_RECHECK_INTERVAL = 24 * 60 * 60 * 1000;
async function revalidateLicenseOnline(force) {
  const stored = getLicense();
  if (!stored || !stored.token || !stored.key) return;
  let last = 0;
  try { last = parseInt(localStorage.getItem('amh.license.lastCheck') || '0', 10) || 0; } catch (e) {}
  if (!force && last && Date.now() - last < LICENSE_RECHECK_INTERVAL) return;
  const result = await apiPost('/api/validate', { mid: MACHINE_ID, key: stored.key });
  // Only a real semantic response starts the retry interval. Network errors,
  // 5xx responses, and malformed payloads must be retried on the next focus.
  if (!result || (result.valid !== true && result.valid !== false)) return;
  try { localStorage.setItem('amh.license.lastCheck', String(Date.now())); } catch (e) {}
  if (result.valid === false) {
    log('License revoked or rejected by server' + (result.reason ? ' (' + result.reason + ')' : '') + '.');
    setLicense(Object.assign({}, stored, { valid: false, token: null }));
    await assessLicense();
    updateLicenseUI();
    return;
  }
  if (result.valid === true && result.token) {
    const durable = setLicense(Object.assign({}, stored, {
      valid: true,
      token: result.token,
      expiry: result.expiry || stored.expiry || '00000000',
      serverValidated: true,
    }));
    if (!durable) log('WARNING: refreshed lease could not be written to the durable license file.');
    await assessLicense();
    updateLicenseUI();
  }
}

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

let trialSyncPromise = null;
async function refreshTrialFromServer() {
  if (LICENSED) return trialRemaining();
  if (trialSyncPromise) return trialSyncPromise;
  trialSyncPromise = (async () => {
    try {
      const data = await apiGet('/api/trial?mid=' + encodeURIComponent(MACHINE_ID), TRIAL_SYNC_TIMEOUT_MS);
      if (data && typeof data.used === 'number') {
        setTrialUsed(data.used);
        updateLicenseUI();
      }
    } catch (e) {
      // Offline/localStorage fallback remains available; the post-transcription
      // charge is still required before an unlicensed result can be placed.
    }
    return trialRemaining();
  })();
  try {
    return await trialSyncPromise;
  } finally {
    trialSyncPromise = null;
  }
}
// Shared license/trial gate for EVERY transcription entry point (run() and
// runFile()). Fail-closed: unlicensed users may only transcribe while free
// trial credits remain; licensed users always pass.
function assertCanRun() {
  if (!LICENSED && trialRemaining() <= 0) {
    log('Your free trial (2 transcriptions) is used up.');
    log('Enter your license key in the License section and click Activate to continue.');
    return false;
  }
  return true;
}
function newRunId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {}
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

// Called once when an unlicensed user produces a transcription result. Counts
// toward the free-trial limit even if the user later discards the review;
// licensed users are unaffected.
// Uses server-side tracking (D1) with localStorage fallback for offline.
async function consumeTrialCredit(runId) {
  if (LICENSED) return { allowed: true, licensed: true };

  // Try server-side increment first. The run ID makes retries idempotent.
  const chargeRunId = runId || activeRunId || newRunId();
  const serverResult = await apiPost('/api/trial/use', { mid: MACHINE_ID, run_id: chargeRunId });
  // A duplicate request can arrive while the original Worker invocation still
  // holds its D1 lease. Do not mistake that pending response for a completed
  // zero-credit charge (or fall through to the local counter). Give the owner a
  // short reconciliation window; if it is still pending, the server lease will
  // finish or be reclaimed safely on a later retry.
  if (serverResult && serverResult.pending) {
    log('Trial charge is still being finalized; reconciling with the server…');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const retry = await apiPost('/api/trial/use', { mid: MACHINE_ID, run_id: chargeRunId });
    if (retry && !retry.pending && typeof retry.used === 'number') {
      const charged = retry.charged === undefined
        ? retry.used < TRIAL_ALLOWED
        : retry.charged === true;
      setTrialUsed(retry.used);
      const retryLeft = retry.remaining;
      log('Free trial: ' + retry.used + '/' + TRIAL_ALLOWED + ' used, ' + retryLeft + ' left.');
      return { allowed: charged, charged, used: retry.used, remaining: retryLeft, pending: false };
    }
    log('The server will reconcile this trial charge; local state was not advanced.');
    return { allowed: false, charged: false, pending: true };
  }
  if (serverResult && typeof serverResult.used === 'number') {
    // New Workers return an explicit `charged` bit. The fallback inference keeps
    // older local Worker deployments usable for a first credit, but an explicit
    // false (cap reached, flood-blocked, or conflicting run ID) never places.
    const charged = serverResult.charged === undefined
      ? serverResult.used < TRIAL_ALLOWED
      : serverResult.charged === true;
    setTrialUsed(serverResult.used);
    const left = serverResult.remaining;
    if (left > 0) {
      log('Free trial: ' + serverResult.used + '/' + TRIAL_ALLOWED + ' used, ' + left + ' left.');
    } else {
      log('Free trial used up (' + TRIAL_ALLOWED + '/' + TRIAL_ALLOWED + '). Enter a license key to continue.');
    }
    return { allowed: charged, charged, used: serverResult.used, remaining: left, pending: false };
  }

  // Fallback: local-only (offline or API unreachable).
  // KNOWN LIMITATION: this counter lives in localStorage, so a user who is
  // offline (or who clears the panel's localStorage) can reset the trial and
  // keep transcribing without a key. We accept this deliberately: the product
  // is fully offline by design, so we cannot hard-require the server. If trial
  // abuse becomes a problem, gate the 2nd+ use on a successful /api/trial/use
  // round-trip instead of falling through here. See README "Known limitations".
  const before = getTrialUsed();
  if (before >= TRIAL_ALLOWED) {
    log('Free trial is already exhausted; no caption placement was allowed.');
    return { allowed: false, charged: false, used: before, remaining: 0, offline: true };
  }
  setTrialUsed(before + 1);
  const used = getTrialUsed();
  const left = trialRemaining();
  if (left > 0) {
    log('Free trial: ' + used + '/' + TRIAL_ALLOWED + ' used, ' + left + ' left.');
  } else {
    log('Free trial used up (' + TRIAL_ALLOWED + '/' + TRIAL_ALLOWED + '). Enter a license key to continue.');
  }
  return { allowed: true, charged: true, used, remaining: left, offline: true };
}

function updateLicenseUI() {
  const midEl = document.getElementById('machineIdDisplay');
  const licInput = document.getElementById('licenseInput');
  const licBtn = document.getElementById('licenseActivate');
  const licStatus = document.getElementById('licenseStatus');
  const runBtn = document.getElementById('runBtn');
  const banner = document.getElementById('trialBanner');

  if (midEl) midEl.textContent = MACHINE_ID;

  if (LICENSED) {
    if (banner) banner.style.display = 'none';
    if (licStatus) {
      licStatus.textContent = L(LICENSE_NOTE || 'Licensed');
      licStatus.style.color = 'var(--ok)';
      // The thank-you note already says it; only a dated key needs this line.
      licStatus.style.display = /expires/.test(LICENSE_NOTE || '') ? '' : 'none';
    }
    if (runBtn) runBtn.disabled = MODEL_MISSING;
    if (licInput) licInput.style.display = 'none';
    if (licBtn) licBtn.style.display = 'none';
    const keyField = document.getElementById('licenseKeyField');
    if (keyField) keyField.style.display = 'none';
    // Licensed: lock the Machine ID so it can't be copied or changed anymore.
    const midSection = document.getElementById('machineIdSection');
    if (midSection) {
      midSection.style.display = 'none';
    }
    const mmHide = document.getElementById('machineMismatch');
    if (mmHide) mmHide.style.display = 'none';
    const licNote = document.getElementById('licensedNote');
    if (licNote) licNote.style.display = 'block';
  } else {
    LICENSED = false;
    // Ensure the license entry fields are always visible while unlicensed,
    // including right after the trial runs out.
    if (licInput) licInput.style.display = '';
    if (licBtn) licBtn.style.display = '';
    const keyFieldU = document.getElementById('licenseKeyField');
    if (keyFieldU) keyFieldU.style.display = '';
    // Unlicensed: show the Machine ID again and hide the licensed note.
    const midSectionU = document.getElementById('machineIdSection');
    if (midSectionU) midSectionU.style.display = '';
    const mmEl = document.getElementById('machineMismatch');
    if (mmEl) mmEl.style.display = MACHINE_HOST_MISMATCH ? '' : 'none';
    const licNoteU = document.getElementById('licensedNote');
    if (licNoteU) licNoteU.style.display = 'none';
    const rem = trialRemaining();
    if (rem > 0) {
      // Free trial: allow running, but the Generate button is enabled.
      if (banner) banner.style.display = 'none';
      if (licStatus) {
        licStatus.textContent = L('Trial: ' + rem + ' free transcription' + (rem === 1 ? '' : 's') + ' left');
        licStatus.style.color = 'var(--warn)';
        licStatus.style.display = '';
      }
      if (runBtn) runBtn.disabled = MODEL_MISSING;
    } else {
      // Trial used up: make the path to purchase unmistakable.
      if (banner) banner.style.display = 'block';
      if (banner && typeof banner.scrollIntoView === 'function' && !LICENSED_REFRESH) {
        try { banner.scrollIntoView({ block: 'center' }); } catch (e) {}
      }
      if (licStatus) {
        licStatus.textContent = L('Trial used. Enter your license key above to continue.');
        licStatus.style.color = 'var(--warn)';
        licStatus.style.display = 'none';   // the trial banner says it once
      }
      if (runBtn) runBtn.disabled = true;
    }
  }
  const footPrice = document.getElementById('footPrice');
  if (footPrice) footPrice.style.display = LICENSED ? 'none' : '';
  LICENSED_REFRESH = false;
}

async function activateLicense() {
  const licInput = document.getElementById('licenseInput');
  const licStatus = document.getElementById('licenseStatus');
  if (!licInput) return;

  const key = licInput.value.trim();
  if (!key) {
    if (licStatus) { licStatus.textContent = L('Paste a license key first'); licStatus.style.color = 'var(--err)'; }
    return;
  }

  if (licStatus) { licStatus.textContent = L('Validating…'); licStatus.style.color = 'var(--text-secondary)'; }

  try {
    // 1) Local structural check (fast shape check — not a keyed HMAC; see the
    //    comment near validateLicense()).
    const result = validateLicense(key, MACHINE_ID);
    if (!result.ok) {
      if (licStatus) { licStatus.textContent = L(result.error || 'Invalid key'); licStatus.style.color = 'var(--err)'; }
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
        : serverResult.reason === 'revoked'
        ? 'License revoked — contact @sumpak6 on Telegram'
        : 'Key not recognized — contact @sumpak6 on Telegram';
      if (licStatus) { licStatus.textContent = L(reason); licStatus.style.color = 'var(--err)'; }
      return;
    }
    if (serverResult && serverResult.valid === true && serverResult.token) {
      // A successful first activation is not complete until the server has
      // issued a signed lease. Never cache a boolean-only "valid" response.
      const serverExpiry = (serverResult.expiry && /^\d{8}$/.test(String(serverResult.expiry))) ? serverResult.expiry : result.expiry;
      const store = {
        key: key,
        valid: true,
        expiry: serverExpiry,
        activated: Date.now(),
        serverValidated: true,
        token: serverResult.token
      };
      const durable = setLicense(store);
      await assessLicense();
      updateLicenseUI();
      if (!durable) {
        setLicense(Object.assign({}, store, { valid: false, token: null }));
        await assessLicense();
        updateLicenseUI();
        if (licStatus) { licStatus.textContent = L('Could not save the signed lease to this installation. Check folder permissions and try again.'); licStatus.style.color = 'var(--err)'; }
        return;
      }
      if (!LICENSED) {
        if (licStatus) licStatus.textContent = L('Server returned no valid lease token. Contact support.');
        return;
      }
      const logBox = document.getElementById('logBox');
      if (logBox) logBox.textContent += (logBox.textContent ? '\n' : '') + 'License activated successfully.';
      return;
    }
    if (serverResult && serverResult.valid === true && !serverResult.token) {
      if (licStatus) licStatus.textContent = L('License server is not signing leases. Contact support.');
      return;
    }
    // Server unreachable: only a previously verified signed lease may be reused.
    if (cached && canonicalPanelKey(cached.key) === canonicalPanelKey(key) && cached.token) {
      const store = {
        key: key,
        valid: true,
        expiry: result.expiry,
        serverValidated: true,
        activated: cached.activated || Date.now(),
        token: cached.token
      };
      const durable = setLicense(store);
      await assessLicense();
      updateLicenseUI();
      if (!durable) {
        setLicense(Object.assign({}, store, { valid: false, token: null }));
        await assessLicense();
        updateLicenseUI();
        if (licStatus) { licStatus.textContent = L('Could not save the cached lease to this installation. Check folder permissions and try again.'); licStatus.style.color = 'var(--err)'; }
        return;
      }
      if (!LICENSED) {
        if (licStatus) licStatus.textContent = L('Cached lease could not be verified.');
        return;
      }
      const logBox = document.getElementById('logBox');
      if (logBox) logBox.textContent += (logBox.textContent ? '\n' : '') + 'License activated (offline, previously verified).';
      return;
    }
    // Not previously verified and server unreachable → refuse (fail-closed)
    if (licStatus) {
      licStatus.textContent = L('Cannot verify license — no connection to the license server. Try again online.');
      licStatus.style.color = 'var(--err)';
    }
  } catch (e) {
    if (licStatus) { licStatus.textContent = L('Validation error'); licStatus.style.color = 'var(--err)'; }
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
          copyBtn.textContent = L('✓ Copied');
          setTimeout(() => { copyBtn.textContent = old; }, 1600);
        }
      } catch (err) { /* ignore */ }
      e.stopPropagation();
    });
  }
  updateLicenseUI();

  // Recompute LICENSED only from a signed lease. Unsigned legacy state is
  // deliberately ignored and must be activated again online. After the local
  // check, make a best-effort online revocation check.
  assessLicense().then(() => {
    updateLicenseUI();
    revalidateLicenseOnline();
  });

  // Sync server-side trial count on load (best effort — silently ignore if offline)
  const storedLicense = getLicense();
  if (!storedLicense || !storedLicense.token) {
    apiGet('/api/trial?mid=' + MACHINE_ID).then((data) => {
      if (data && typeof data.used === 'number') setTrialUsed(data.used);
    });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => revalidateLicenseOnline());
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

const { execFile, spawn } = nodeRequire('child_process');
const crypto = nodeRequire('crypto');
const fs = nodeRequire('fs');
const os = nodeRequire('os');
const path = nodeRequire('path');

// --------------------------------------------------------------------------
// Amharic font detection (authoritative, filesystem-backed).
//
// The browser FontFaceSet/canvas probes cannot be trusted inside the embedded
// Chromium used by CEP. Node has real filesystem access, so we scan the OS
// font directories for the candidates instead — deterministic on every rig.
// --------------------------------------------------------------------------

const AMH_FONT_DIRS = (() => {
  if (process.platform === 'win32') {
    return [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
  }
  return [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts'),
  ];
})();

// candidate name -> filename substrings that identify it (case-insensitive)
const AMH_FONT_FILES = [
  ['Abyssinica SIL',       ['abyssinica']],
  ['Noto Sans Ethiopic',   ['notosansethiopic', 'noto sans ethiopic']],
  ['Noto Serif Ethiopic',  ['notoserifethiopic', 'noto serif ethiopic']],
  ['Kefa',                 ['kefa']],
  ['Ebrima',               ['ebrima']],
  ['Nyala',                ['nyala']],
  ['Visual Geez Unicode',  ['visualgeez', 'visual geez']],
];

function scanAmharicFontFs() {
  try {
    const found = {}; // name -> { file, dir }
    for (const dir of AMH_FONT_DIRS) {
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        const low = n.toLowerCase();
        for (const [name, needles] of AMH_FONT_FILES) {
          if (!found[name] && needles.some((nd) => low.includes(nd))) {
            found[name] = { file: n, dir };
          }
        }
      }
    }
    for (const [name] of AMH_FONT_FILES) {
      if (found[name]) {
        const f = found[name];
        return Object.assign({ ok: true, font: name, support: true },
                             { path: path.join(f.dir, f.file), dir: f.dir, file: f.file });
      }
    }
    // No candidate present, but we did scan at least one real dir => trusted.
    return { ok: false, font: null, support: true };
  } catch (e) {
    return { ok: true, font: null, support: false };
  }
}

// Locate the on-disk font file for a specific candidate. Used by the review
// to point libass at the font directory and tell it the family name.
function findAmhFontFile(name) {
  try {
    const rec = AMH_FONT_FILES.find(([n]) => n === name);
    if (!rec) return null;
    const [, needles] = rec;
    for (const dir of AMH_FONT_DIRS) {
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        const low = n.toLowerCase();
        if (needles.some((nd) => low.includes(nd))) {
          return { file: n, dir, path: path.join(dir, n), family: name };
        }
      }
    }
  } catch (e) {}
  return null;
}

AMH_FONT_FS = scanAmharicFontFs();
// Applied below, after RUNTIME/etc. are declared (renderHealthList reads them).

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

// Inside After Effects, load the AE implementations of the host entry points
// on top of host.jsx (the manifest's ScriptPath). evalScript calls run in
// order in the host engine, so this completes before any panel call.
function loadHostLayer() {
  if (!IS_AE) return;
  const f = path.join(EXT_DIR, 'jsx', 'host_ae.jsx').replace(/\\/g, '/');
  try { csi.evalScript('$.evalFile(new File(' + JSON.stringify(f) + '))', () => {}); } catch (e) {}
}
loadHostLayer();

function isDegradedRuntime(base) {
  try {
    return fs.existsSync(path.join(base, '..', 'DEGRADED_BUILD.txt')) ||
      fs.existsSync(path.join(base, 'DEGRADED_BUILD.txt'));
  } catch (e) { return false; }
}

function runtimeComplete(base) {
  if (!base || !fs.existsSync(base)) return false;
  if (!fs.existsSync(path.join(base, 'ethio_srt.py'))) return false;
  // A shipped, self-contained runtime must include the model, ffmpeg and a
  // python interpreter. (The dev fallback is handled separately below.)
  const degraded = isDegradedRuntime(base);
  const modelOk = fs.existsSync(path.join(base, 'model', 'model_meta.json'))
             || (degraded && fs.existsSync(path.join(base, 'model', 'config.json')))
             || fs.existsSync(path.join(base, 'ethio-asr', 'config.json'))
             || fs.existsSync(path.join(base, 'model_manifest.json'));   // lite: downloaded later
  let binOk = fs.existsSync(path.join(base, 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'))
           || fs.existsSync(path.join(base, 'bin', 'ffmpeg'));
  let pyOk = IS_WIN
    ? fs.existsSync(path.join(base, 'python', 'python.exe'))
    : fs.existsSync(path.join(base, 'python', 'bin', 'python3'));
  const featureOk = isDegradedRuntime(base) || (
    fs.existsSync(path.join(base, 'amh_lm.py')) &&
    fs.existsSync(path.join(base, 'amh_lm.json.gz')) &&
    fs.existsSync(path.join(base, 'amh_vad.py')) &&
    fs.existsSync(path.join(base, 'silero_vad.onnx')) &&
    fs.existsSync(path.join(base, 'amh_diarize.py')) &&
    fs.existsSync(path.join(base, 'speaker_embed.onnx'))
  );
  return modelOk && binOk && pyOk && featureOk;
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
  if (RUNTIME === DEV_RUNTIME && !IS_WIN) {
    const devFfmpeg = '/opt/homebrew/bin/ffmpeg';
    return fs.existsSync(devFfmpeg) ? devFfmpeg : null;
  }
  return null;
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

const SCRIPT = runtimePath('ethio_srt.py');
// ── Where the model lives ─────────────────────────────────────────────────
// Full packages bundle it in runtime/model. Lite packages ship only
// runtime/model_manifest.json and download the model ONCE into a per-user
// folder outside the extension, so installing an update never deletes it.
// Mirrors amh_model.py resolve(): keep the two in sync.
function modelSharedRoot() {
  if (process.env.AMH_MODEL_HOME) return process.env.AMH_MODEL_HOME;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AmharicCaptions', 'models');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', 'AmharicCaptions', 'models');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'AmharicCaptions', 'models');
}
function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return -1; } }
const MODEL_MANIFEST = (() => {
  if (!RUNTIME || RUNTIME === DEV_RUNTIME) return null;
  try {
    const m = JSON.parse(fs.readFileSync(runtimePath('model_manifest.json'), 'utf8'));
    return (m && m.id && Array.isArray(m.files)) ? m : null;
  } catch (e) { return null; }
})();
const MODEL_TOTAL_BYTES = MODEL_MANIFEST ? MODEL_MANIFEST.files.reduce((a, f) => a + f.size, 0) : 0;
function sharedModelDir() { return path.join(modelSharedRoot(), MODEL_MANIFEST.id); }
function resolveModelDir() {
  if (!RUNTIME || RUNTIME === DEV_RUNTIME) return runtimePath('ethio-asr');   // dev layout
  const bundled = runtimePath('model');
  if (!MODEL_MANIFEST) return bundled;                                     // full, pre-manifest
  const bin = MODEL_MANIFEST.files.find((f) => f.name === 'model.bin');
  if (fs.existsSync(path.join(bundled, 'model_meta.json')) &&
      (!bin || fileSize(path.join(bundled, 'model.bin')) === bin.size)) return bundled;
  const d = sharedModelDir();
  try {
    const done = JSON.parse(fs.readFileSync(path.join(d, 'complete.json'), 'utf8'));
    if (done.id === MODEL_MANIFEST.id &&
        MODEL_MANIFEST.files.every((f) => fileSize(path.join(d, f.name)) === f.size)) return d;
  } catch (e) {}
  return null;
}
let MODEL_DIR = resolveModelDir();
MODEL_MISSING = MODEL_DIR === null;
if (MODEL_MISSING) MODEL_DIR = sharedModelDir();   // where it will be downloaded


// Where the runtime folder actually is (for the status pill / diagnostics).
const RUNTIME_LABEL = RUNTIME ? RUNTIME : '(not found)';

// Apply the authoritative filesystem font result now that RUNTIME etc. exist.
if (AMH_FONT_FS) applyFontInfo(AMH_FONT_FS);

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
  // Errors/warnings are the reason the Log box exists — surface them instead of
  // hiding them behind the collapsed disclosure. Success stays quiet.
  if (/^ERROR/i.test(line) || /warning/i.test(line) || /no speech detected/i.test(line)) {
    const disc = document.getElementById('logDisc');
    if (disc && !disc.classList.contains('open')) disc.classList.add('open');
  }
}
function clearLog() { logEl.textContent = ''; }

let STATUS_EN = '';
function setStatus(state, text) {
  const pill = $('statusPill');
  const txt = $('statusText');
  if (!pill || !txt) return;
  pill.classList.remove('ready', 'busy', 'err');
  if (state) pill.classList.add(state);
  STATUS_EN = text || '';
  txt.textContent = L(STATUS_EN);
}
function setSuccess(text) {
  // Green "ready" pill, but with a concrete outcome so the user sees success
  // without having to open the collapsed Log box.
  setStatus('ready', text || '✓ Done');
}
function setBusy(busy) {
  if (busy) {
    setStatus('busy', 'working…');
  } else {
    // Keep a freshly-confirmed success pill ("✓ Captions on timeline") instead
    // of immediately overwriting it with the generic "ready" state.
    const pill = $('statusPill');
    const txt = $('statusText');
    const keep = pill && ((pill.classList.contains('ready') && txt && /^✓/.test(txt.textContent)) || pill.classList.contains('err'));
    if (!keep) setStatus('ready', 'ready');
  }
  $('runBtn').disabled = busy;
  const cancel = $('cancelBtn');
  if (cancel) cancel.style.display = busy ? 'inline-block' : 'none';
  UI_BUSY = !!busy;
  syncProgressRow();
}

// ------------------------------------------------------------ evalScript
// Escape U+2028 (LINE SEPARATOR) / U+2029 (PARAGRAPH SEPARATOR) before JSON
// crosses the bridge. ExtendScript parses inbound JSON with `eval(...)` (see
// panel/jsx/json2.jsx), and ES3/ES5 treats those two code points as string
// terminators — a payload containing either would splice/terminate the string
// literal (classic injection; also breaks any filename/path that contains one).
// escJ() is safe in BOTH JS string literals and JSON.parse, so it is applied
// to every outbound payload serialized into the JSX envelope.
function escJson(s) {
  const j = JSON.stringify(s);
  return j === undefined ? 'null'
    : String(j).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function evalScript(jsx, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: HOST_NAME + ' script timed out' }), timeoutMs || 20000);
    try {
      csi.evalScript(jsx, (result) => {
        if (typeof result === 'string' && result.length > 0) {
          try { finish(JSON.parse(result)); }
          catch (e) { finish({ ok: true, _raw: result }); }
        } else {
          finish({ ok: false, error: result || ('No result from ' + HOST_NAME) });
        }
      });
    } catch (e) {
      finish({ ok: false, error: String(e && e.message || e) });
    }
  });
}

function findFootage()      { return evalScript('amharic_findFootage()'); }
function importCaptions(srtPath, startSeconds, baseName) {
  const font = (AMH_FONT && AMH_FONT.font) || '';
  const args = escJson({ srtPath, startSeconds: startSeconds || 0, baseName: baseName || '', font });
  // After Effects writes one Source Text keyframe per cue; a long karaoke
  // run can take well over the default 20 s.
  return evalScript('amh_importCaptions(' + escJson(args) + ')', IS_AE ? 180000 : 20000);
}
function getSelectedClip()  { return evalScript('amharic_getSelectedClip()'); }
function getSequenceInfo(all) {
  return evalScript('amharic_getSequenceInfo(' + (all ? 'true' : 'false') + ')');
}
function seekPlayhead(seconds) {
  return evalScript('amharic_seekPlayhead(' + escJson(String(seconds)) + ')');
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
let CAP = 'words';   // same default as the HTML and applySettings()
let GROUP_SIZE = 3;
let MAX_CHARS = 42;
let SPEAKERS = false;
let cancelRequested = false;
let lastSrtPath = null;
let lastCues = [];
let activeChild = null;

// Stable folder for placed caption SRTs, the same for every customer and
// chosen automatically (never prompted). Premiere keeps a file link to the
// imported caption SRT — deleting it makes Premiere ask to "Locate file"
// (both right after adding the captions and every time the project reopens).
// So placed SRTs live here permanently instead of a temp dir that gets wiped.
// Documents (not Desktop) so customer desktops stay clean.
const USER_CAPTIONS_DIR = path.join(os.homedir(), 'Documents', 'AmharicCaptions');
function ensureCaptionsDir() {
  try {
    fs.mkdirSync(USER_CAPTIONS_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(USER_CAPTIONS_DIR, 0o700);
  } catch (e) {}
  return USER_CAPTIONS_DIR;
}

function applySettings() {
  const s = loadSettings();
  SOURCE = s.source || 'clip';
  CAP = s.cap || 'words';
  GROUP_SIZE = s.group || 3;
  MAX_CHARS = s.chars || 42;
  SPEAKERS = !!s.speakers;
  document.querySelectorAll('#srcSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.src === SOURCE);
  });
  document.querySelectorAll('#capSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.cap === CAP);
  });
  $('groupSize').value = GROUP_SIZE;
  $('maxChars').value = MAX_CHARS;
  $('speakersToggle').checked = SPEAKERS;
}

// ----------------------------------------------------------------- SRT
// parseSrt / formatSrtTs / cleanCueLines / *TextFromCues live in js/core.js
// (pure, unit-tested). writeSrt / writeVtt below only add disk I/O + state.
function writeSrt(outPath) {
  fs.writeFileSync(outPath, srtTextFromCues(lastCues), { encoding: 'utf8', mode: 0o600 });
  lastSrtPath = outPath;
  return outPath;
}

function writeVtt(outPath) {
  fs.writeFileSync(outPath, vttTextFromCues(lastCues), { encoding: 'utf8', mode: 0o600 });
  lastSrtPath = outPath;
  return outPath;
}

// ----------------------------------------------------------- extraction
// Light audio cleanup for noisy/music backgrounds: high-pass removes rumble,
// low-pass kills hiss above speech range, afftdn reduces stationary noise.
// Keeps speech intact but stops background content confusing the ASR.
const AUDIO_CLEAN_FILTER = 'highpass=f=80,lowpass=f=7500,afftdn=nf=-25';

// Extract a timeline clip's trimmed source audio to a 16k mono wav via ffmpeg.
function protectTempFile(filePath) {
  try { if (filePath) fs.chmodSync(filePath, 0o600); } catch (e) {}
}

function extractAudio(clip, wav) {
  return new Promise((resolve, reject) => {
    // -ss BEFORE -i = fast input seek (jumps to the keyframe, then we use
    //  -ss 0 -t for frame-accurate position) — decodes far less for clips
    //  deep in long files. -vn -sn skips decoding video/subtitle streams we
    //  discard anyway (~15-30% faster on video files).
    const pre = ['-v', 'error', '-y', '-ss', String(clip.sourceIn || 0)];
    const post = ['-ss', '0'];
    if (clip.duration > 0) post.push('-t', String(clip.duration));
    post.push('-vn', '-sn', '-af', AUDIO_CLEAN_FILTER, '-ac', '1', '-ar', '16000', wav);
    // Track as the active child so Cancel kills the ffmpeg mid-extraction.
    activeChild = execFile(FFMPEG, pre.concat(['-i', clip.sourcePath], post), { timeout: 30 * 60 * 1000 }, (err) => {
      activeChild = null;
      if (err) {
        try { fs.unlinkSync(wav); } catch (e) {}
        reject(new Error('ffmpeg failed for ' + clip.name + ': ' + (err.message || err)));
      } else {
        protectTempFile(wav);
        resolve();
      }
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
  if (SPEAKERS) f.push('--speakers');
  return f;
}

const WARM_TRANSPORT_ERRS = new Set(['worker error', 'worker exited', 'worker write failed']);

// --------------------------------------------------------------------------
// Warm ASR worker: ONE long-lived Python process keeps the model loaded.
// Requests are JSON lines on stdin; replies (and per-clip progress) are JSON
// lines on stdout tagged with the same id. Falls back to one-shot mode below
// if the server cannot start.
// --------------------------------------------------------------------------
const WARM_IDLE_MS = 20 * 60 * 1000; // kill the worker after 20 min idle
const WARM_SEND_TIMEOUT_MS = 60 * 60 * 1000; // per-request watchdog (worker hung)
let warmChild = null;
let warmReady = false;
let warmIdleTimer = null;
let warmSeq = 0;
const warmPending = new Map(); // id -> {resolve, reject, onProgress}

function warmStart() {
  if (warmChild && !warmChild.killed) return true;
  let child;
  try {
    child = spawn(PYTHON, [SCRIPT, '--server'], {
      env: AMH_ENV,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (e) { return false; }
  // Assign BEFORE attaching handlers so the exit/error guards can compare
  // identity: a stale 'exit' from a previous child must never null a newer one.
  warmChild = child;
  warmReady = false;
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) warmOnLine(line);
      nl = buf.indexOf('\n');
    }
  });
  // ALWAYS drain stderr. An unread pipe fills in seconds (64KB) and then the
  // worker BLOCKS on its next write — a silent deadlock that looks like the
  // worker "hung" on a transcription. Log every line so crashes surface in the
  // panel log instead of vanishing.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    // Split: a single chunk can carry several lines, and progress lines must
    // be consumed individually rather than logged as one blob.
    String(d).split('\n').forEach((raw) => {
      const t = raw.trim();
      if (!t) return;
      if (consumeProgressLine(t)) return;
      log('[worker] ' + t);
    });
  });
  child.on('error', () => { if (warmChild === child) warmDiscard('worker error'); });
  child.on('exit', () => { if (warmChild === child) warmDiscard('worker exited'); });
  return true;
}

function warmDiscard(reason) {
  try { if (warmChild) warmChild.kill(); } catch (e) {}
  warmChild = null;
  warmReady = false;
  const rejectReason = cancelRequested ? new Error('Cancelled') : new Error(reason);
  for (const [, p] of warmPending) {
    if (p.timer) clearTimeout(p.timer);
    try { p.reject(rejectReason); } catch (e) {}
  }
  warmPending.clear();
}

function warmOnLine(line) {
  let msg = null;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type === 'ready') { warmReady = true; return; }
  if (typeof msg.id !== 'number') return;
  const p = warmPending.get(msg.id);
  if (!p) return;
  if (msg.type === 'prog' && p.onProgress) { p.onProgress(msg); return; }
  if ('ok' in msg) {
    warmPending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (cancelRequested) { p.reject(new Error('Cancelled')); return; }
    if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'Worker error'));
  }
}

function warmSend(req) {
  req.id = ++warmSeq;
  return new Promise((resolve, reject) => {
    const p = { resolve, reject, onProgress: req.onProgress, timer: null };
    warmPending.set(req.id, p);
    if (warmIdleTimer) { clearTimeout(warmIdleTimer); warmIdleTimer = null; }
    // Hardware watchdog for a silently-stuck worker. A legit transcription of
    // the longest clips is far under this; if it fires the worker is hung (a
    // deadlock we no longer let happen, but a hard clamp beats an eternal
    // spinner). The worker is discarded afterward — a stuck process can't be
    // trusted to answer the next request.
    p.timer = setTimeout(() => {
      warmPending.delete(req.id);
      const err = new Error('worker timeout');
      warmDiscard('worker timeout');
      reject(err);
    }, WARM_SEND_TIMEOUT_MS);
    try {
      const ok = warmChild.stdin.write(JSON.stringify(req) + '\n');
      if (!ok) setImmediate(warmDiscard, 'worker write failed');
    } catch (e) { warmPending.delete(req.id); if (p.timer) clearTimeout(p.timer); reject(e); }
  });
}

function warmIdleKill() {
  // Idle GC: no requests can be pending (it only fires 20 min after the LAST
  // activity), but be defensive and settle them rather than leaving promises
  // hanging on a dead worker.
  if (warmPending.size > 0) { warmDiscard('idle shutdown'); return; }
  if (warmChild && !warmChild.killed) { try { warmChild.kill(); } catch (e) {} }
  warmChild = null;
  warmReady = false;
}
// Idle GC so a warm python doesn't linger forever after the user stops using
// the panel. Killed only after 20 min of NO transcription activity.
function warmTouch() {
  if (warmIdleTimer) clearTimeout(warmIdleTimer);
  warmIdleTimer = setTimeout(warmIdleKill, WARM_IDLE_MS);
}

// Always reap the warm worker AND any in-flight child when the panel closes.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeunload', () => {
    try { if (warmChild && !warmChild.killed) warmChild.kill(); } catch (e) {}
    try { if (activeChild && !activeChild.killed) activeChild.kill(); } catch (e) {}
    warmChild = null;
    activeChild = null;
  });
}

// --------------------------------------------------------------------------
// Transcript cache: skip re-transcribing the exact same (source, range, style).
// Keyed on media path + trim + caption style + model dir + file size + mtime,
// so edited files and caption-style changes invalidate naturally.
// --------------------------------------------------------------------------
const CACHE_FILE = process.env.AMH_CACHE_FILE || path.join(os.tmpdir(), 'amh_transcript_cache.json');
let transcriptCache = null;

function cacheLoad() {
  if (transcriptCache) return transcriptCache;
  try {
    transcriptCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch (e) { transcriptCache = {}; }
  return transcriptCache;
}
function cacheSave() {
  const tmp = CACHE_FILE + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(tmp, JSON.stringify(transcriptCache), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) {}
    try { fs.renameSync(tmp, CACHE_FILE); }
    catch (e) { fs.copyFileSync(tmp, CACHE_FILE); fs.unlinkSync(tmp); }
    try { fs.chmodSync(CACHE_FILE, 0o600); } catch (e) {}
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (cleanupError) {}
  }
}

// Lazy engine-version hash — includes mtimes of the shipped Python scripts
// + the bundled word-LM data, so any code/data change to the decode path
// (ethio_srt / ctc_beam / amh_correct / amh_vad / amh_lm) busts cached results.
let _engineHash = null;
function engineHash() {
  if (_engineHash) return _engineHash;
  const h = crypto.createHash('sha1');
  for (const f of ['ethio_srt.py', 'ctc_beam.py', 'amh_correct.py', 'amh_vad.py', 'amh_lm.py', 'amh_lm.json.gz']) {
    try {
      const p = RUNTIME ? path.join(RUNTIME, f) : path.join(DEV_RUNTIME, f);
      h.update(f + ':' + Math.floor(fs.statSync(p).mtimeMs));
    } catch (e) { h.update(f + ':x'); }
  }
  _engineHash = h.digest('hex').slice(0, 8);
  return _engineHash;
}

function cacheKey(sourcePath, range, offset) {
  const h = crypto.createHash('sha1');
  h.update(sourcePath);
  if (range) {
    h.update(':' + String(range.sourceIn || 0));
    h.update(':' + String(range.duration || 0));
  }
  h.update(':' + CAP + ':' + GROUP_SIZE + ':' + MAX_CHARS + ':' + (SPEAKERS ? 1 : 0));
  h.update(':' + engineHash() + ':' + MODEL_DIR);
  h.update(':' + String(offset || 0));
  try {
    const st = fs.statSync(sourcePath);
    h.update(':' + st.size + ':' + Math.floor(st.mtimeMs));
  } catch (e) {}
  return h.digest('hex').slice(0, 24);
}

// Per-clip cache key for one batch item. Same dimensions as cacheKey() so a
// clip transcribed alone shares the entry with the batch path — an edit then
// re-transcribes ONLY the clips whose key actually changed.
function clipCacheKey(it) {
  return cacheKey(it.sourcePath, { sourceIn: it.sourceIn, duration: it.duration }, it.offset);
}

// Canonical SRT serializer. Keep every output path on core.js so speaker
// labels cannot diverge between cache files, exports, and Premiere placement.
function srtFromCues(cues) {
  return srtTextFromCues(cues);
}

// Items whose timeline window overlaps another item's. Per-clip caching is
// UNSOUND for these: when two clips play at once (dialogue + music bed, a
// J-cut, B-roll audio over an interview, a duplicated safety track) a cue's
// start time cannot identify which clip produced it.
//
// Left unhandled this duplicates captions, which a customer sees directly:
// attributeCues() gives every overlapping cue to the FIRST item, so the second
// item caches nothing; an empty entry reads back as a cache MISS, so next run
// it is transcribed again while the first item replays the same cues from
// cache. Run 1 yields 3 captions, run 2 yields 6 — see tools/test/test_panel_dom.js
// "work area: overlapping clips must not duplicate captions on re-run".
//
// Overlapping items therefore neither READ nor WRITE the cache: they are
// re-transcribed every run. That costs time on sequences with a music bed,
// but it is always correct, and non-overlapping clips still cache normally.
function overlappingItems(items) {
  const bad = new Set();
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const aStart = a.offset || 0;
    const aEnd = aStart + (a.duration || 0);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const bStart = b.offset || 0;
      const bEnd = bStart + (b.duration || 0);
      // Touching end-to-start is not an overlap; a shared instant is fine.
      if (aStart < bEnd && bStart < aEnd) { bad.add(a); bad.add(b); }
    }
  }
  return bad;
}

// Map freshly-transcribed cues back to their source item. For items with
// disjoint timeline ranges a cue belongs to the item whose [offset,
// offset+duration] window holds its start (nearest item if none does).
// Overlapping items are excluded from caching by overlappingItems() above, so
// their attribution here is best-effort and only affects the current run,
// where every cue is written out exactly once regardless of attribution.
function attributeCues(cues, items) {
  const byItem = new Map();
  for (const it of items) byItem.set(it, []);
  for (const cue of cues) {
    let pick = items[0] || null;
    let best = Infinity;
    for (const it of items) {
      const o = it.offset || 0;
      const d = it.duration || 0;
      if (cue.start >= o - 0.05 && cue.start <= o + d + 0.5) { pick = it; best = 0; break; }
      const dist = Math.min(Math.abs(cue.start - o), Math.abs(cue.start - (o + d)));
      if (dist < best) { best = dist; pick = it; }
    }
    if (pick) byItem.get(pick).push(cue);
  }
  return byItem;
}

function cacheLookup(key) {
  const c = cacheLoad()[key];
  if (!c || !c.srt) return null;
  let cues = [];
  try { cues = normalizeCues(parseSrt(c.srt)); } catch (e) { cues = []; }
  if (!cues.length) return null;
  return { srt: c.srt, cues, transcript: c.transcript || '' };
}

async function cacheStore(key, srt, transcript) {
  cacheLoad()[key] = { srt, transcript, at: Date.now() };
  // Per-clip caching means one entry per clip (plus whole-file entries), so
  // keep a generous bound and drop the oldest beyond it.
  const CAP_N = 200;
  const keys = Object.keys(cacheLoad());
  if (keys.length > CAP_N) {
    const olds = keys.map((k) => ({ k, at: cacheLoad()[k].at || 0 }))
      .sort((a, b) => a.at - b.at);
    for (const o of olds.slice(0, keys.length - CAP_N)) delete cacheLoad()[o.k];
  }
  cacheSave();
}

// --------------------------------------------------------------------------
// Transcription entry points. Both check the transcript cache first, then go
// through the WARM worker (one model load), falling back to one-shot Python.
// --------------------------------------------------------------------------

// Warm-worker style options.
function warmStyle() {
  return { mode: CAP === 'words' ? 'words' : 'grouped',
           group: CAP === 'grouped' ? GROUP_SIZE : 0,
           max_chars: MAX_CHARS,
           speakers: SPEAKERS };
}

// Extract a trimmed source segment to 16k mono wav.
function extractToWav(sourcePath, range) {
  const wav = path.join(os.tmpdir(), 'amharic_warm_' + Date.now() + '_' + Math.floor(Math.random() * 1e5) + '.wav');
  return new Promise((resolve, reject) => {
    const ffArgs = ['-v', 'error', '-y'];
    if (range && range.sourceIn) ffArgs.push('-ss', String(range.sourceIn));
    ffArgs.push('-i', sourcePath, '-ss', '0');
    if (range && range.duration > 0) ffArgs.push('-t', String(range.duration));
    ffArgs.push('-vn', '-sn', '-af', AUDIO_CLEAN_FILTER);
    ffArgs.push('-ac', '1', '-ar', '16000', wav);
    activeChild = execFile(FFMPEG, ffArgs, { timeout: 30 * 60 * 1000 }, (err) => {
      activeChild = null;
      if (err) {
        try { fs.unlinkSync(wav); } catch (e) {}
        reject(new Error('ffmpeg failed: ' + (err.message || err)));
      } else {
        protectTempFile(wav);
        resolve(wav);
      }
    });
  });
}

// Transcribe a single source (already a file path). range = {sourceIn, duration};
// offset shifts cue times to the timeline. Result: { outSrt, cues, transcript }.
async function transcribe(sourcePath, outSrt, range, offset) {
  const key = cacheKey(sourcePath, range, offset);
  const hit = cacheLookup(key);
  if (hit) {
    fs.writeFileSync(outSrt, hit.srt, 'utf8');
    protectTempFile(outSrt);
    lastCues = hit.cues;
    lastSrtPath = outSrt;
    return { outSrt, cues: hit.cues, transcript: hit.transcript, cached: true };
  }

  const wav = await extractToWav(sourcePath, range);
  try {
    if (!warmStart()) {
      // Server unavailable → one-shot process.
      return transcribeOneShot(sourcePath, outSrt, range, offset, wav);
    }
    const r = await warmSend(Object.assign({
      wav, out_srt: outSrt, offset: offset || 0
    }, warmStyle()));
    warmTouch();
    protectTempFile(outSrt);
    let cues = [];
    try { cues = normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))); } catch (e) {}
    lastCues = cues;
    lastSrtPath = outSrt;
    await cacheStore(key, fs.readFileSync(outSrt, 'utf8'), r.text || '');
    return { outSrt, cues, transcript: r.text || '', cached: false };
  } catch (e) {
    // Cancel kills the warm worker, which surfaces here as a transport error
    // ("worker exited"). Treat any failure while a cancel is pending as a
    // clean cancellation — never fall back into a new one-shot process.
    if (cancelRequested) throw new Error('Cancelled');
    if (e && e.message === 'Cancelled') throw e;
    if (!e || !WARM_TRANSPORT_ERRS.has(e.message)) throw e;
    // One-shot fallback (worker missing or failed this request).
    return transcribeOneShot(sourcePath, outSrt, range, offset, wav);
  } finally {
    try { fs.unlinkSync(wav); } catch (e) {}
  }
}

// Original per-run python process (fallback when the warm worker is absent).
// `onProgress` used to be a parameter here that every caller passed as an empty
// function and nothing ever invoked. Progress now flows the same way as on the
// warm path — parsed off the child's stderr — so the dead parameter is gone.
function transcribeOneShot(sourcePath, outSrt, range, offset, wav) {
  return new Promise((resolve, reject) => {
    const pyArgs = [SCRIPT, wav, outSrt].concat(pyFlags());
    if (offset && offset !== 0) pyArgs.push('--offset', String(offset));
    activeChild = execFile(PYTHON, pyArgs, { maxBuffer: 32 * 1024 * 1024, env: AMH_ENV, timeout: 4 * 60 * 60 * 1000 }, (perr, stdout) => {
      activeChild = null;
      if (cancelRequested) { reject(new Error('Cancelled')); return; }
      if (perr) { reject(new Error('Python failed: ' + (perr.message || perr))); return; }
      const transcript = extractTranscripts(stdout).join('\n');
      protectTempFile(outSrt);
      let cues = [];
      try { cues = normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))); } catch (e) {}
      lastCues = cues;
      lastSrtPath = outSrt;
      resolve({ outSrt, cues, transcript });
    });
    // execFile buffers stderr for the callback, but we also want it live so
    // the bar moves while the run is happening rather than all at once at the
    // end. Attaching a listener does not disturb the buffered copy.
    try {
      if (activeChild && activeChild.stderr) {
        activeChild.stderr.setEncoding('utf8');
        activeChild.stderr.on('data', (d) => {
          String(d).split('\n').forEach((raw) => {
            const t = raw.trim();
            if (t) consumeProgressLine(t);
          });
        });
      }
    } catch (e) {}
  });
}

// Transcribe the given clips, using the per-clip cache so only CHANGED clips
// are actually run through the model. Cached and freshly-produced cues are
// merged (sorted) into one SRT in item order.
// items: [{ sourcePath?, sourceIn?, duration?, wav?, offset, name?, cached? }].
async function transcribeBatch(items, outSrt, onProgress) {
  // Clips that share timeline time can't be cached per-clip without risking
  // duplicated or misattributed captions — see overlappingItems().
  const ambiguous = overlappingItems(items);
  const hits = items.map((it) => (ambiguous.has(it) ? null : (it.cached ||
    (it.sourcePath ? cacheLookup(clipCacheKey(it)) : null))));
  const misses = items.filter((it, i) => !hits[i]);

  const finish = (byItem, transcript) => {
    const all = [];
    items.forEach((it, i) => {
      const cs = hits[i] ? hits[i].cues : (byItem.get(it) || []);
      for (const c of cs) all.push(c);
    });
    all.sort((a, b) => a.start - b.start);
    fs.writeFileSync(outSrt, srtFromCues(all), 'utf8');
    protectTempFile(outSrt);
    lastCues = all;
    lastSrtPath = outSrt;
    return { outSrt, cues: all, transcript: transcript || '', cached: misses.length === 0 };
  };

  if (misses.length === 0) {
    if (onProgress) onProgress(items.length, items.length, 'cached');
    return finish(new Map(), '');
  }

  let byItem = new Map();
  let transcript = '';
  try {
    if (warmStart()) {
      const req = {
        batch: misses.map((it) => ({ wav: it.wav, offset: it.offset, name: it.name || '' })),
        out_srt: outSrt
      };
      if (onProgress) req.onProgress = onProgress;
      const r = await warmSend(Object.assign(req, warmStyle()));
      warmTouch();
      if (r && r.skipped) {
        log('Note: skipped ' + r.skipped + ' clip(s) that could not be transcribed.');
      }
      let parsed = [];
      try { parsed = normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))); } catch (e) {}
      byItem = attributeCues(parsed, misses);
      transcript = r.text || '';
    } else {
      // Server unavailable → one-shot process (one model load, misses only).
      const one = await transcribeBatchOneShot(misses, outSrt, onProgress);
      byItem = one.byItem;
      transcript = one.transcript;
    }
  } catch (e) {
    // Same as the single-clip path: a pending cancel must not respawn work.
    if (cancelRequested) throw new Error('Cancelled');
    if (e && e.message === 'Cancelled') throw e;
    if (!e || !WARM_TRANSPORT_ERRS.has(e.message)) throw e;
    const one = await transcribeBatchOneShot(misses, outSrt, onProgress);
    byItem = one.byItem;
    transcript = one.transcript;
  }

  for (const it of misses) {
    if (!it.sourcePath) continue;
    if (ambiguous.has(it)) continue;   // overlapping clip: attribution unreliable
    const cs = byItem.get(it) || [];
    if (!cs.length) continue;
    await cacheStore(clipCacheKey(it), srtFromCues(cs), '');
  }
  return finish(byItem, transcript);
}

// Original multi-clip one-shot fallback (one process, one model load).
function transcribeBatchOneShot(items, outSrt, onProgress) {
  const reqPath = path.join(os.tmpdir(), 'amharic_batch_' + Date.now() + '.json');
  try {
    fs.writeFileSync(reqPath, JSON.stringify(items.map((it) => ({
      wav: it.wav, offset: it.offset
    }))), { encoding: 'utf8', mode: 0o600 });
    protectTempFile(reqPath);
  } catch (e) {
    try { fs.unlinkSync(reqPath); } catch (cleanupError) {}
    throw e;
  }
  const pyArgs = [SCRIPT, '--batch', reqPath, outSrt].concat(pyFlags());
  return new Promise((resolve, reject) => {
    const cleanupReq = () => { try { fs.unlinkSync(reqPath); } catch (e) {} };
    let child;
    try {
      child = execFile(PYTHON, pyArgs, { maxBuffer: 64 * 1024 * 1024, env: AMH_ENV, timeout: 4 * 60 * 60 * 1000 }, (perr, stdout) => {
        activeChild = null;
        if (cancelRequested) { cleanupReq(); reject(new Error('Cancelled')); return; }
        if (perr) { cleanupReq(); reject(new Error('Python failed: ' + (perr.message || perr))); return; }
        let transcript = '';
        const lines = String(stdout || '').split('\n');
        let inBlock = false, buf = [];
        for (const ln of lines) {
          const prog = ln.match(/^\[batch\] %+ (\d+)\/(\d+) (.+)$/);
          if (prog) {
            const name = String(prog[3]).replace(/\\/g, '/').split('/').pop() || prog[3];
            if (onProgress) onProgress(parseInt(prog[1], 10), parseInt(prog[2], 10), name);
            continue;
          }
          if (ln.indexOf('--- full transcription ---') === 0) { inBlock = true; buf = []; continue; }
          if (ln.indexOf('[info]') === 0) { if (inBlock) { transcript += (transcript ? '\n' : '') + buf.join('\n').trim(); inBlock = false; } continue; }
          if (inBlock) buf.push(ln);
        }
        if (inBlock) transcript += (transcript ? '\n' : '') + buf.join('\n').trim();
        protectTempFile(outSrt);
        let cues = [];
        try { cues = normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))); } catch (e) {}
        cleanupReq();
        let byItem;
        try { byItem = attributeCues(cues, items); }
        catch (e) { reject(new Error('Could not attribute batch captions: ' + (e && e.message ? e.message : String(e)))); return; }
        lastCues = cues;
        lastSrtPath = outSrt;
        resolve({ outSrt, cues, transcript: transcript.trim(), byItem });
      });
    } catch (e) {
      cleanupReq();
      reject(e);
      return;
    }
    // Track the child so the Cancel button can kill it immediately (the setup
    // cancel handler clears activeChild via child.kill()). The once-listener
    // is dropped — it stacked one listener per run and never detached.
    activeChild = child;
  });
}

// --------------------------------------------------------------------------
// Placement & import
// --------------------------------------------------------------------------

async function finishImport(outSrt, label, startSeconds) {
  log(IS_AE ? 'Adding the caption text layer to your composition…' : 'Placing captions on your timeline…');
  const imp = await importCaptions(outSrt, startSeconds || 0, label);
  if (imp && imp.ok && imp.placed === true) {
    log('✓ Captions added: ' + imp.captionItemName);
    setSuccess('✓ Captions on timeline');
    if (imp.requestedStart !== undefined && imp.landedStart !== undefined &&
        imp.landedStart !== null) {
      log('Timeline position ' + imp.landedStart.toFixed(2) + 's → ' +
          (imp.landedEnd !== null ? imp.landedEnd.toFixed(2) + 's' : '?') +
          '  (requested ' + imp.requestedStart.toFixed(2) + 's)');
    }
    if (imp.note) log('Placement method: ' + imp.note);
    if (IS_AE) {
      log('Captions are one text layer at the top of the comp. Restyle it in the');
      log('  Character panel; Ctrl+Z (Cmd+Z) removes it in one step.');
    } else {
      log('Can\'t see them? Expand the caption track (bottom of the timeline) and');
      log('  turn on the CC toggle in the Program Monitor.');
      log('To restyle, open Essential Graphics and set the caption font.');
    }
    return true;
  }

  const reason = (imp && imp.error) ||
    (imp && imp._raw ? (HOST_NAME + ' returned an unexpected response: ' + imp._raw) : null) ||
    (imp && imp.note) ||
    (HOST_NAME + ' did not confirm that the captions were placed.');
  log('ERROR: ' + reason);
  log('Your existing captions were kept. Review the log and try again.');
  setStatus('err', 'placement failed');
  return false;
}

// ---------------------------------------------------------------------------
// Review & edit step: shown after transcription, before anything hits the
// timeline. The user edits cue text/times, adds/deletes cues, picks a preview
// font, then places (writes the edited SRT to the timeline) or discards.
// ---------------------------------------------------------------------------

let REVIEW = null; // { outSrt, label, startSeconds }
let reviewOpen = false;
let reviewPlacing = false;
let reviewTrialCharged = false;
let activeRunId = '';

function fmtReviewTs(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
function parseReviewTs(str) {
  const t = String(str || '').trim();
  if (!/^\d{1,3}:\d{1,2}([.,]\d{1,3})?$/.test(t)) return NaN;
  const [m, rest] = t.split(':');
  return Number(m) * 60 + Number(rest.replace(',', '.'));
}

// editable working copy of the cues (the real lastCues is only overwritten on
// place, so cache/transcript stay pristine if the user discards)
let reviewCues = [];
let REVIEW_FILTER = '';
function cueMatchesFilter(cue) {
  const filter = (REVIEW_FILTER || '').toLowerCase();
  if (!filter) return true;
  return (cue.text || '').toLowerCase().indexOf(filter) >= 0 ||
    fmtReviewTs(cue.start).indexOf(filter) >= 0 || fmtReviewTs(cue.end).indexOf(filter) >= 0;
}


async function openReview(outSrt, label, startSeconds, opts) {
  opts = opts || {};
  // A transcription consumes a trial credit when it is produced, not only
  // when the user chooses to place it. This prevents unlimited discard/retry
  // loops. Licensed users are unaffected.
  if (!reviewTrialCharged) {
    const trial = await consumeTrialCredit(activeRunId || newRunId());
    if (!trial || !trial.allowed) {
      removeTempCaptionArtifact(outSrt);
      if (lastSrtPath === outSrt) lastSrtPath = null;
      log('Trial credit was not confirmed. The transcription was not placed; activate a license or retry when the server is available.');
      setStatus('err', 'trial credit required');
      updateLicenseUI();
      return false;
    }
    reviewTrialCharged = true;
  }
  if (!LICENSED && !reviewTrialCharged) {
    log('Placement blocked because no trial credit was charged.');
    return false;
  }
  REVIEW = {
    outSrt, label: label || 'captions', startSeconds: startSeconds || 0,
  };
  // Transcript cleanup pass: normalize spacing/punctuation in every cue as it
  // enters the review so the user edits (and we write) tidy Amharic.
  reviewCues = JSON.parse(JSON.stringify(lastCues)).map((c) =>
    Object.assign({}, c, { text: cleanCueLines(c.text) }));
  reviewOpen = true;
  REVIEW_FILTER = '';
  const search = $('reviewSearch');
  if (search) search.value = '';
  renderReview();
  $('review').classList.add('show');
  log('Review your captions below — edit, then click "Place on timeline".');
  return true;
}

function removeTempCaptionArtifact(filePath) {
  try {
    if (!filePath) return;
    const resolved = path.resolve(String(filePath));
    const tempRoot = path.resolve(os.tmpdir());
    const inTemp = resolved.indexOf(tempRoot + path.sep) === 0;
    const generatedReview = path.basename(resolved).startsWith('amh_review_');
    if (!inTemp && !generatedReview) return;
    if (!path.basename(resolved).startsWith('amh_')) return;
    fs.unlinkSync(resolved);
  } catch (e) {}
}

function closeReview(keepArtifact) {
  if (!keepArtifact && REVIEW && REVIEW.outSrt) removeTempCaptionArtifact(REVIEW.outSrt);
  if (!keepArtifact) lastSrtPath = null;
  reviewOpen = false;
  reviewPlacing = false;
  REVIEW = null;
  reviewCues = [];
  REVIEW_FILTER = '';
  $('review').classList.remove('show');
}

function renderReview() {
  // Sort by start time so playback order matches what gets written.
  reviewCues.sort((a, b) => a.start - b.start);
  const list = $('reviewList');
  list.textContent = '';
  const ts = (sec) => fmtReviewTs(sec);

  let shown = 0;
  for (let i = 0; i < reviewCues.length; i++) {
    const cue = reviewCues[i];
    if (!cueMatchesFilter(cue)) continue;
    shown++;
    const row = document.createElement('div');
    row.className = 'review-row';

    const timeBox = document.createElement('div');
    timeBox.className = 'time-box';
    const tIn = document.createElement('input');
    tIn.className = 't'; tIn.value = ts(cue.start); tIn.title = L('Start (m:ss.cc)');
    const tOut = document.createElement('input');
    tOut.className = 't'; tOut.value = ts(cue.end); tOut.title = L('End (m:ss.cc)');
    timeBox.appendChild(tIn);
    timeBox.appendChild(tOut);

    const tools = document.createElement('div');
    tools.className = 'review-tools';
    const mk = (label, title, cls) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tool'; b.textContent = label; b.title = L(title);
      if (cls) b.classList.add(cls);
      tools.appendChild(b);
      return b;
    };
    const nudgeBack = mk('−0.1s', 'Shift this caption −0.1s');
    const nudgeFwd = mk('+0.1s', 'Shift this caption +0.1s');
    const splitBtn = mk('\u2702', 'Split this caption into two');
    const mergeBtn = mk('\u2295', 'Merge this caption into the next');
    const nextCue = reviewCues[i + 1];
    mergeBtn.disabled = !nextCue ||
      (cue.speaker && nextCue.speaker && cue.speaker !== nextCue.speaker);
    splitBtn.disabled = ((cue.text || '').trim().split(/\s+/).filter(Boolean).length <= 1);
    nudgeBack.addEventListener('click', () => nudgeReview(i, -0.1));
    nudgeFwd.addEventListener('click', () => nudgeReview(i, 0.1));
    splitBtn.addEventListener('click', () => splitReview(i));
    mergeBtn.addEventListener('click', () => mergeReview(i));

    const ta = document.createElement('textarea');
    ta.value = cue.text || ''; ta.placeholder = L('caption text');
    // The captions are Amharic. Without this the whole review list is read as
    // English, and a screen reader pronounces Ge'ez with the wrong voice.
    ta.setAttribute('lang', 'am');
    ta.setAttribute('aria-label', 'Caption ' + (i + 1) + ' text');

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = L('Delete this caption');

    // Time edits re-sort and re-render; text edits update the live cue only.
    tIn.addEventListener('change', () => {
      const v = parseReviewTs(tIn.value);
      if (isNaN(v)) { log('Time format: m:ss.cc (e.g. 1:23.45)'); return; }
      cue.start = v;
      if (cue.end < cue.start + 0.3) cue.end = cue.start + 0.3;
      renderReview();
    });
    tOut.addEventListener('change', () => {
      const v = parseReviewTs(tOut.value);
      if (isNaN(v)) { log('Time format: m:ss.cc (e.g. 1:23.45)'); return; }
      cue.end = Math.max(cue.start + 0.3, v);
      renderReview();
    });
    ta.addEventListener('input', () => { cue.text = ta.value; });
    del.addEventListener('click', () => { reviewCues.splice(i, 1); renderReview(); });

    row.appendChild(timeBox);
    row.appendChild(tools);
    row.appendChild(ta);
    row.appendChild(del);
    // Click a caption row to jump the Premiere playhead to that caption's start.
    row.addEventListener('click', (e) => {
      const el = e.target;
      if (el === tIn || el === tOut) return; // time inputs handle their own edits
      if (el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA') return;
      seekPlayhead(cue.start);
    });
    list.appendChild(row);
  }

  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'review-empty';
    empty.textContent = L(REVIEW_FILTER
      ? 'No captions match "' + REVIEW_FILTER + '".'
      : 'No captions yet — click "+ Add cue".');
    list.appendChild(empty);
  }
  updateReviewCount();
}

// Review editor ops: nudge a caption's timing, split its text, merge with the
// next caption. All operate on the working copy; nothing reaches the timeline
// until the user places.
function nudgeReview(i, delta) {
  const cue = reviewCues[i];
  if (!cue) return;
  cue.start = Math.max(0, cue.start + delta);
  cue.end = Math.max(cue.start + 0.3, cue.end + delta);
  renderReview();
}

function splitReview(i) {
  const cue = reviewCues[i];
  if (!cue) return;
  const words = (cue.text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return;
  const mid = Math.ceil(words.length / 2);
  const first = words.slice(0, mid).join(' ');
  const second = words.slice(mid).join(' ');
  if (!first || !second) return;
  const frac = (first.length + 1) / ((cue.text || '').trim().length + 2);
  const cut = cue.start + (cue.end - cue.start) * Math.max(0.1, Math.min(0.9, frac));
  const original = cue.end;
  cue.text = first;
  cue.end = Math.max(cue.start + 0.3, cut);
  const secondCue = { start: cue.end, end: original, text: second };
  if (cue.speaker) secondCue.speaker = cue.speaker;
  reviewCues.splice(i + 1, 0, secondCue);
  renderReview();
}

function mergeReview(i) {
  const cue = reviewCues[i];
  const next = reviewCues[i + 1];
  if (!cue || !next) return;
  if (cue.speaker && next.speaker && cue.speaker !== next.speaker) return;
  cue.text = (cleanCueLines(cue.text) + ' ' + cleanCueLines(next.text)).trim();
  cue.end = next.end;
  reviewCues.splice(i + 1, 1);
  renderReview();
}

function updateReviewCount() {
  $('reviewCount').textContent = L(reviewCues.length + ' caption' + (reviewCues.length === 1 ? '' : 's'));
}

function writeReviewSrt(outDir) {
  const out = srtTextFromCues(reviewCues);
  const dest = path.join(outDir || os.tmpdir(), 'amh_review_' + Date.now() + '.srt');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dest), 0o700); } catch (e) {}
  fs.writeFileSync(dest, out, { encoding: 'utf8', mode: 0o600 });
  protectTempFile(dest);
  return dest;
}

async function placeReview() {
  if (!reviewOpen || !REVIEW || reviewPlacing) return;
  if (!LICENSED && !reviewTrialCharged) {
    log('Placement blocked: the trial credit was not confirmed.');
    setStatus('err', 'trial credit required');
    return;
  }
  reviewCues = reviewCues.filter((c) => (c.text || '').trim().length > 0);
  if (reviewCues.length === 0) { log('All captions are empty — nothing to place.'); return; }

  reviewPlacing = true;
  const placeBtn = $('reviewPlace');
  const discardBtn = $('reviewDiscard');
  if (placeBtn) placeBtn.disabled = true;
  if (discardBtn) discardBtn.disabled = true;
  try {
    // Commit the edited cues only after we have a concrete placement target.
    lastCues = JSON.parse(JSON.stringify(reviewCues));
    const originalReviewSrt = REVIEW.outSrt;
    const dest = writeReviewSrt(ensureCaptionsDir());
    removeTempCaptionArtifact(originalReviewSrt);
    REVIEW.outSrt = dest;
    lastSrtPath = dest;
    log('Placing your edited captions (' + reviewCues.length + ')…');
    const placed = await finishImport(dest, REVIEW.label || 'captions', REVIEW.startSeconds);
    if (!placed) return; // keep the review and edits open for recovery
    // Premiere's caption item links to this file. Deleting it triggers a
    // "Locate file" prompt on every project open.
    log('Captions saved to ' + dest + '  (Premiere keeps a file link to this).');
    closeReview(true);
  } catch (e) {
    log('ERROR: placement failed: ' + (e && e.message ? e.message : String(e)));
  } finally {
    reviewPlacing = false;
    if (placeBtn) placeBtn.disabled = false;
    if (discardBtn) discardBtn.disabled = false;
  }
}

function discardReview() {
  if (!reviewOpen || reviewPlacing) return;
  log('Discarded — nothing was placed on the timeline.');
  closeReview();
}

// Export the (edited) captions as a set of files into a user-chosen folder.
// Writes <name>.srt + <name>.vtt + <name>.txt together (overwriting).
function exportReviewFiles() {
  if (!reviewOpen) return;
  const cues = (reviewCues && reviewCues.length ? reviewCues : lastCues)
    .filter((c) => (c.text || '').trim().length > 0);
  if (!cues.length) { log('Nothing to export yet.'); return; }
  const label = (REVIEW && REVIEW.label) || 'captions';

  let dir = null;
  try {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
      const r = window.cep.fs.showOpenDialog(false, true,
        'Choose a folder for the SRT / VTT / TXT export', '');
      if (!r || r.err !== 0 || !r.data || !r.data.length) { log('Export cancelled.'); return; }
      dir = r.data[0];
    }
  } catch (e) { dir = null; }
  if (!dir) dir = ensureCaptionsDir();

  const base = safeFileName(label);
  const srt = path.join(dir, base + '.srt');
  const vtt = path.join(dir, base + '.vtt');
  const txt = path.join(dir, base + '.txt');
  try {
    fs.writeFileSync(srt, srtTextFromCues(cues), { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(vtt, vttTextFromCues(cues), { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(txt, txtTextFromCues(cues), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    log('Export failed: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  log('Exported ' + cues.length + ' captions to ' + dir +
    '  (' + base + '.srt / ' + base + '.vtt / ' + base + '.txt)');
}

// Sanitize a clip/label name into a safe cross-platform file stem.
function safeFileName(name) {
  const s = String(name || 'captions')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || 'captions';
}

function initReview() {
  // Font is fixed for the review preview: uses the detected Amharic
  // font (or Abyssinica SIL). Premiere's timeline caption style cannot be
  // scripted, so no font/size pickers are exposed in the panel anymore.
  const font = (AMH_FONT && AMH_FONT.font) || 'Abyssinica SIL';
  $('reviewList').style.setProperty('--review-font',
    '"' + font + '"');

  $('reviewPlace').addEventListener('click', placeReview);
  $('reviewDiscard').addEventListener('click', discardReview);
  const expBtn = $('reviewExport');
  if (expBtn) expBtn.addEventListener('click', exportReviewFiles);
  $('reviewAdd').addEventListener('click', () => {
    const last = reviewCues.length ? reviewCues[reviewCues.length - 1] : null;
    const start = last ? last.end : 0;
    const end = last ? last.end + 2 : 2;
    reviewCues.push({ start, end, text: '' });
    renderReview();
  });

  const search = $('reviewSearch');
  if (search) {
    search.addEventListener('input', (e) => { REVIEW_FILTER = e.target.value; renderReview(); });
  }


  // Keyboard shortcuts while the overlay is open:
  //   Cmd/Ctrl+Enter → place; Esc → discard.
  document.addEventListener('keydown', (e) => {
    if (!reviewOpen) return;
    if (e.key === 'Escape') {
      // While typing in a caption/time field, Esc just cancels that edit
      // (moves focus away) instead of wiping the whole review.
      const el = e.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && document.activeElement === el) {
        el.blur();
        return;
      }
      discardReview();
    }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { placeReview(); }
  });
}

// ---------------------------------------------------------------- runners
let PROGRESS_EN = '';
let UI_BUSY = false;
// The progress row (bar, label, Cancel) takes space only while a run is going
// or there is something to say (a failure message); idle, it is hidden.
function syncProgressRow() {
  const wrap = $('progWrap');
  if (!wrap) return;
  const bar = $('progBar');
  const moving = bar && parseFloat(bar.style.width) > 0;
  wrap.style.display = (UI_BUSY || moving || PROGRESS_EN) ? '' : 'none';
  // A message on its own (e.g. after a failure) shows without an empty bar.
  const track = $('progTrack');
  if (track) track.style.display = (UI_BUSY || moving) ? '' : 'none';
}
function setProgress(pct, text) {
  const value = Math.round(pct * 100);
  const bar = $('progBar');
  if (bar) bar.style.width = value + '%';
  const label = $('progLabel');
  PROGRESS_EN = text || '';
  if (label) label.textContent = L(PROGRESS_EN);
  syncProgressRow();
  // Keep the exposed value in step with the painted width, otherwise a screen
  // reader announces a bar that never moves while the sighted one fills.
  const track = $('progTrack');
  if (track) track.setAttribute('aria-valuenow', String(value));
}

// Set while a single clip is transcribing. The engine streams
// `[progress] done/total` on stderr once per window; the warm worker's stderr
// drain routes matching lines here. Null at every other time, so batch runs
// (which drive the bar from their own clip counter) are unaffected.
let windowProgress = null;

// Parse one engine stderr line. Returns true when it was a progress line and
// has been consumed, so the caller can keep it out of the log — one line per
// 20s window would otherwise bury real messages on a long clip.
function consumeProgressLine(line) {
  const m = /^\[progress\]\s+(\d+)\/(\d+)\s*$/.exec(String(line).trim());
  if (!m) return false;
  if (!windowProgress) return true;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!total) return true;
  windowProgress(done, total);
  return true;
}

async function run() {
  if (reviewPlacing) {
    log('Wait for the current placement to finish.');
    return;
  }
  if (runInProgress || runStartInProgress) {
    log('A transcription is already running. Wait for it to finish or cancel it first.');
    return;
  }
  // A fresh run replaces whatever review/overlay was showing.
  if (reviewOpen) closeReview();
  clearLog();
  cancelRequested = false;
  runFailed = false;
  reviewTrialCharged = false;
  activeRunId = newRunId();
  setProgress(0, '');
  if (!RUNTIME) {
    log('ERROR: Transcription runtime not found.');
    log('The extension folder is missing the bundled "runtime" directory.');
    log('Reinstall the correct platform build, then restart Premiere.');
    if (typeof EXT_DIR !== 'undefined') log('Looking in: ' + EXT_DIR);
    return;
  }
  if (!PYTHON || !FFMPEG || !fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    log('ERROR: Runtime is incomplete — missing python or ffmpeg.');
    log('python: ' + PYTHON + ' -> ' + (fs.existsSync(PYTHON) ? 'OK' : 'MISSING'));
    log('ffmpeg: ' + FFMPEG + ' -> ' + (fs.existsSync(FFMPEG) ? 'OK' : 'MISSING'));
    log('Reinstall the correct platform build and restart Premiere.');
    return;
  }
  if (!modelReadyForRun()) return;
  runStartInProgress = true;
  try { await refreshTrialFromServer(); }
  finally { runStartInProgress = false; }
  if (cancelRequested) return;
  if (!assertCanRun()) return;
  runInProgress = true;
  setBusy(true);
  try {
    if (SOURCE === 'clip') { await runSelectedClip(); return; }
    await runWorkArea();
  } catch (e) {
    if (!cancelRequested) {
      const raw = (e && e.message) ? e.message : String(e);
      log('ERROR: ' + raw);
      // Say it where the user is actually looking. Previously a failed run
      // only printed into the Log and silently reset the bar to zero, which
      // is indistinguishable from "nothing happened" — the user re-clicks
      // Generate, it fails again, and they message support with "it doesn't
      // work" and no detail.
      failRun(raw);
    }
  } finally {
    if (cancelRequested) {
      removeTempCaptionArtifact(lastSrtPath);
      lastSrtPath = null;
    }
    runInProgress = false;
    setBusy(false);
    if (!cancelRequested && !runFailed) setProgress(0, '');
    updateLicenseUI();
  }
}

// Set for the duration of one failed run so the finally block does not wipe
// the message it just put on screen.
let runFailed = false;
let runInProgress = false;
// Held only while the asynchronous trial preflight is in flight. This closes
// the click race where two Generate presses could both pass the preflight
// before either one sets runInProgress.
let runStartInProgress = false;

// Turn an engine/transport error into something an editor can act on. The raw
// text is still written to the Log for support; this is the one line they see.
function humanError(raw) {
  const t = String(raw || '').toLowerCase();
  if (t.includes('audio too short')) return 'That clip is too short to transcribe.';
  if (t.includes('no speech')) return 'No speech found in that audio.';
  if (t.includes('audio-bearing')) return 'No transcribable clips in that range.';
  if (t.includes('no clip found') || t.includes('no selected clip') || t.includes('select a clip')) {
    return 'Select a clip on the timeline (or put the playhead on it), then try again.';
  }
  if (t.includes('source path') || t.includes('no media file')) {
    return 'That item has no media file — try a regular video or audio clip.';
  }
  if (t.includes('ffmpeg')) return 'Could not read that media file.';
  if (t.includes('enospc') || t.includes('no space')) return 'Your disk is full.';
  if (t.includes('python failed') || t.includes('worker')) return 'The transcription engine stopped unexpectedly.';
  if (t.includes('runtime')) return 'The transcription runtime is missing or incomplete.';
  if (t.includes('cancel')) return 'Cancelled.';
  return 'Transcription failed.';
}

function failRun(raw) {
  runFailed = true;
  removeTempCaptionArtifact(lastSrtPath);
  const msg = humanError(raw);
  setStatus('err', 'failed');
  // progLabel is an aria-live region, so this is announced as well as shown.
  setProgress(0, msg + ' See “Details for support” below.');
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
  lastSrtPath = outSrt;
  setProgress(0.15, 'Transcribing…');

  // Drive the bar from the engine's real per-window progress instead of
  // parking it at a fixed percentage. Before this, a single clip — the
  // DEFAULT source — sat at 40% with "Transcribing…" from start to finish,
  // so a ten-minute interview looked exactly like a hang and invited the user
  // to kill Premiere mid-run. Batch mode already had per-clip progress; this
  // gives the single-clip path the same honesty.
  // Window work spans 0.15 -> 0.9, leaving room for extraction before and
  // placement after.
  const startedAt = Date.now();
  windowProgress = (done, total) => {
    const frac = Math.max(0, Math.min(1, done / total));
    let eta = '';
    // Only estimate once a window has actually completed, otherwise the first
    // guess is wild and the number visibly lurches.
    if (done > 0 && done < total) {
      const perWindow = (Date.now() - startedAt) / done;
      const left = Math.round((perWindow * (total - done)) / 1000);
      if (left > 0) {
        eta = left >= 60
          ? ' · about ' + Math.ceil(left / 60) + ' min left'
          : ' · about ' + left + 's left';
      }
    }
    setProgress(0.15 + frac * 0.75, 'Transcribing ' + done + '/' + total + eta);
  };

  // Bake the clip's absolute timeline position into the SRT timestamps (so the
  // cues carry their real timeline times), then place the caption band at 0.
  let r;
  try {
    r = await transcribe(c.sourcePath, outSrt,
      { sourceIn: c.sourceIn, duration: c.duration }, c.timelineStart);
  } finally {
    // Always clear, including on cancel or error — a stale reporter would
    // otherwise keep moving the bar during the next run.
    windowProgress = null;
  }
  setProgress(0.9, 'Transcription complete');

  if (!r.cues.length) log('No speech detected in this audio — nothing to place.');
  log('Done writing captions.');

  // Review flow: let the user edit before anything hits the timeline.
  await openReview(outSrt, cleanName, 0);
}

async function runWorkArea() {
  log('Reading your edit area…');
  const info = await getSequenceInfo(SOURCE === 'whole');
  if (!info.ok || !info.clips) throw new Error(info.error || 'No sequence info.');
  const unsupported = Array.isArray(info.unsupported) ? info.unsupported : [];
  if (unsupported.length) {
    log('Skipping ' + unsupported.length + ' clip(s) with unsupported speed/retime/reverse mapping.');
    unsupported.slice(0, 8).forEach((u) => log('  - ' + (u.name || 'unnamed clip') + ': ' + (u.reason || 'unsupported')));
  }
  const clips = (info.clips || []).filter((c) => !c.unsupported);
  if (clips.length === 0) {
    throw new Error('No audio-bearing clips with a resolvable source in this range.');
  }
  // Whole-edit mode: ignore the work-area bounds (transcribe every clip).
  const rangeLabel = (SOURCE === 'whole')
    ? 'whole edit (all clips)'
    : 'work area ' + info.inPoint.toFixed(2) + 's → ' +
      (info.outPoint >= 1e10 ? 'end' : info.outPoint.toFixed(2)) + 's';
  log('Found ' + clips.length + ' clip(s) to transcribe (' + rangeLabel + ').');
  log('Extracting audio per clip, then writing captions in one pass…');

  const outSrt = path.join(os.tmpdir(), 'amh_sequence_' + Date.now() + '.srt');
  lastSrtPath = outSrt;
  const stamp = Date.now();

  // Fast path: if every clip (by path+offset+mtime) is in the transcript cache,
  // skip audio extraction AND transcription entirely.
  // Per-clip cache: build an item per clip and look each one up. Only clips
  // whose key changed are extracted + transcribed below.
  const items = clips.map((clip) => ({
    offset: clip.timelineStart, name: clip.name, duration: clip.duration,
    sourcePath: clip.sourcePath, sourceIn: clip.sourceIn, cached: null
  }));
  // Clips sharing timeline time are never served from cache — their cues
  // cannot be attributed to one clip, and doing so duplicates captions on the
  // next run. Entries written by an older build may still exist, so this also
  // guards against a stale one.
  const ambiguous = overlappingItems(items);
  for (const it of items) {
    if (it.sourcePath && !ambiguous.has(it)) it.cached = cacheLookup(clipCacheKey(it));
  }

  // Fast path: every clip already cached → skip extraction AND transcription.
  if (items.length && items.every((it) => it.cached)) {
    setProgress(0.95, 'Reading cached captions');
    const all = [];
    for (const it of items) for (const c of it.cached.cues) all.push(c);
    all.sort((a, b) => a.start - b.start);
    fs.writeFileSync(outSrt, srtFromCues(all), 'utf8');
    protectTempFile(outSrt);
    lastCues = all;
    lastSrtPath = outSrt;
    if (all.length === 0) log('No speech detected in these clips — nothing to place.');
    log('Done — ' + all.length + ' captions written (' +
        items.length + ' clip(s) cached).');
    await openReview(outSrt, 'sequence', 0, {});
    return;
  }

  const misses = items.filter((it) => !it.cached);
  if (misses.length < items.length) {
    log('Using cached captions for ' + (items.length - misses.length) +
        ' unchanged clip(s); transcribing ' + misses.length + ' changed clip(s).');
  }
  let extractionFailures = 0;
  try {
    for (let n = 0; n < misses.length; n++) {
      if (cancelRequested) {
        log('Cancelled by user.');
        removeTempCaptionArtifact(outSrt);
        lastSrtPath = null;
        return;
      }
      const it = misses[n];
      setProgress((n + 1) / misses.length / 2, 'Extracting audio ' + (n + 1) + '/' + misses.length);
      const wav = path.join(os.tmpdir(), 'amh_extract_' + stamp + '_' + n + '.wav');
      try {
        await extractAudio(it, wav);
        it.wav = wav;
      } catch (e) {
        extractionFailures += 1;
        it.extractionError = String((e && e.message) || e);
        log('WARNING: skipped "' + (it.name || path.basename(it.sourcePath || 'clip')) +
            '" — ' + it.extractionError);
        try { fs.unlinkSync(wav); } catch (cleanupError) {}
      }
    }

    if (cancelRequested) { log('Cancelled by user.'); return; }
    if (extractionFailures) {
      log('Skipped ' + extractionFailures + ' clip(s) whose audio could not be extracted.');
    }

    // Cached clips plus successfully extracted clips are transcribed together;
    // failed clips are excluded rather than poisoning the whole batch.
    const batchItems = items.filter((it) => !it.extractionError);
    if (!batchItems.length) {
      throw new Error('No clip audio could be prepared for transcription.');
    }

    log('Transcribing ' + batchItems.length + ' clip(s) in one pass…');
    const batchStart = Date.now();
    const r = await transcribeBatch(batchItems, outSrt, (msgOrN, total, name) => {
      // Warm-worker callback passes {at, of, name}; one-shot passes (n, total, name).
      const done = typeof msgOrN === 'object' ? msgOrN.at : msgOrN;
      const ofTotal = typeof msgOrN === 'object' ? msgOrN.of : total;
      const label = typeof msgOrN === 'object' ? msgOrN.name : name;
      // Live ETA from measured throughput.
      const elapsedSec = (Date.now() - batchStart) / 1000;
      const secPerClip = done > 0 ? elapsedSec / done : 0;
      const etaSec = secPerClip * (ofTotal - done);
      const etaText = etaSec > 0 ? (' · ~' + Math.ceil(etaSec) + 's left') : '';
      setProgress(0.5 + (done / Math.max(1, ofTotal)) * 0.5,
        'Transcribing ' + done + '/' + ofTotal + etaText +
        (label && label.trim() ? ' (' + path.basename(label) + ')' : ''));
    });

    if (!r.cues.length) log('No speech detected in these clips — nothing to place.');
    log('Done — ' + r.cues.length + ' captions written.');
    await openReview(outSrt, 'sequence', 0, {});
  } finally {
    // Always remove every temporary WAV, including failures and cancellation.
    for (const it of items) {
      if (it.wav) { try { fs.unlinkSync(it.wav); } catch (e) {} }
    }
    // Temporary WAVs are gone; do not retain audio paths after this block.
  }
}

// ------------------------------------------------------------ choose file
async function runFromFile(input) {
  if (reviewPlacing) {
    log('Wait for the current placement to finish.');
    return;
  }
  if (runInProgress || runStartInProgress) {
    log('A transcription is already running. Wait for it to finish or cancel it first.');
    return;
  }
  if (!input.files || input.files.length === 0) return;
  const f = input.files[0];
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
  if (reviewOpen) closeReview();
  clearLog();
  cancelRequested = false;
  reviewTrialCharged = false;
  runFailed = false;
  activeRunId = newRunId();
  if (!RUNTIME || !PYTHON || !FFMPEG || !fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    log('ERROR: Transcription runtime is missing or incomplete.');
    log('Reinstall the correct platform build and restart Premiere.');
    return;
  }
  if (!modelReadyForRun()) return;
  runStartInProgress = true;
  try { await refreshTrialFromServer(); }
  finally { runStartInProgress = false; }
  if (cancelRequested) return;
  if (!assertCanRun()) return;
  runInProgress = true;
  setBusy(true);
  setProgress(0, '');
  try {
    const base = filePath.replace(/\.[^.]+$/, '');
    const outSrt = path.join(os.tmpdir(), 'amh_file_' + Date.now() + '.srt');
    lastSrtPath = outSrt;
    const cleanName = (fileName || path.basename(base) || 'captions').replace(/\.[^.]+$/, '');
    log('Writing captions… this can take a minute.');
    setProgress(0.4, 'Transcribing…');
    const r = await transcribe(filePath, outSrt);
    setProgress(0.9, 'Transcription complete');
    if (!r.cues.length) log('No speech detected in this audio — nothing to place.');
    log('Done writing captions.');
    await openReview(outSrt, cleanName, 0);
  } catch (e) {
    if (!cancelRequested) {
      const raw = (e && e.message) ? e.message : String(e);
      log('ERROR: ' + raw);
      failRun(raw);
    }
  } finally {
    if (cancelRequested) {
      removeTempCaptionArtifact(lastSrtPath);
      lastSrtPath = null;
    }
    runInProgress = false;
    setBusy(false);
    if (!cancelRequested && !runFailed) setProgress(0, '');
    updateLicenseUI();
  }
}

// ------------------------------------------------------------------ wiring
// ── One-time model download (lite packages) ────────────────────────────────
// Runs runtime/amh_model.py download, which resumes a partial file, verifies
// every file's SHA-256 and only then marks the model complete. Pause kills the
// child; the partial file stays, so Resume continues from the same byte.
let modelChild = null;
function modelReadyForRun() {
  if (!MODEL_MISSING) return true;
  log('The Amharic model has not been downloaded yet.');
  log('Use "Download the Amharic model" at the top of the panel first.');
  setStatus('err', 'model needed');
  const card = $('modelCard');
  if (card && typeof card.scrollIntoView === 'function') { try { card.scrollIntoView({ block: 'center' }); } catch (e) {} }
  return false;
}
function mb(n) { return Math.round(n / 1e6); }
function setModelUi(state, done) {
  const btn = $('modelBtn'), bar = $('modelBar'), label = $('modelLabel'), card = $('modelCard');
  if (!card) return;
  card.style.display = MODEL_MISSING || state === 'done' ? 'block' : 'none';
  const total = MODEL_TOTAL_BYTES || 1;
  if (bar && typeof done === 'number') bar.style.width = Math.min(100, (100 * done) / total).toFixed(1) + '%';
  if (state === 'idle') {
    btn.textContent = L('⬇ Download the Amharic model (' + mb(MODEL_TOTAL_BYTES) + ' MB)');
    btn.disabled = false;
    if (label) label.textContent = '';
  } else if (state === 'running') {
    btn.textContent = L('Pause');
    btn.disabled = false;
    if (label) label.textContent = L('Downloading… ' + mb(done || 0) + ' / ' + mb(MODEL_TOTAL_BYTES) + ' MB');
  } else if (state === 'paused') {
    btn.textContent = L('Resume download');
    btn.disabled = false;
    if (label) label.textContent = L('Paused at ' + mb(done || 0) + ' / ' + mb(MODEL_TOTAL_BYTES) + ' MB');
  } else if (state === 'failed') {
    btn.textContent = L('Resume download');
    btn.disabled = false;
    if (label) label.textContent = L('Download stopped. Check your internet and press Resume; it continues where it stopped.');
  } else if (state === 'done') {
    btn.textContent = L('✓ Model ready');
    btn.disabled = true;
    if (label) label.textContent = '';
    setTimeout(() => { const c = $('modelCard'); if (c && !MODEL_MISSING) c.style.display = 'none'; }, 2500);
  }
  card.setAttribute('data-state', state);
}
let MODEL_UI = { state: 'idle', done: 0 };
function modelUi(state, done) {
  MODEL_UI = { state, done: typeof done === 'number' ? done : MODEL_UI.done };
  setModelUi(MODEL_UI.state, MODEL_UI.done);
}
function modelDownloadFinished(dir) {
  MODEL_DIR = dir;
  MODEL_MISSING = false;
  AMH_ENV.AMH_MODEL_DIR = dir;
  modelUi('done', MODEL_TOTAL_BYTES);
  log('✓ Amharic model downloaded and verified: ' + dir);
  setStatus('ready', 'ready');
  renderHealthList();
  updateLicenseUI();
}
function startModelDownload() {
  if (modelChild) return;
  const script = runtimePath('amh_model.py');
  if (!fs.existsSync(script)) { log('ERROR: amh_model.py is missing from the runtime. Reinstall.'); return; }
  modelUi('running');
  log('Downloading the Amharic model…');
  let out = '';
  let child;
  try {
    child = spawn(PYTHON, ['-E', '-s', script, 'download'], { env: AMH_ENV, windowsHide: true });
  } catch (e) {
    log('ERROR: could not start the model download: ' + (e.message || e));
    modelUi('failed');
    return;
  }
  modelChild = child;
  child.stdout.on('data', (buf) => {
    out += buf.toString('utf8');
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      const m = /^\[dl\] (\d+) (\d+)$/.exec(line);
      if (m) { if (MODEL_UI.state === 'running') modelUi('running', Number(m[1])); continue; }
      if (line.charAt(0) === '{') {
        try {
          const r = JSON.parse(line);
          if (r.ok && r.dir) child.__result = r;
          else if (r.error) log('Model download: ' + r.error);
        } catch (e) {}
      }
    }
  });
  child.stderr.on('data', () => {});
  child.on('close', () => {
    modelChild = null;
    if (child.__result) { modelDownloadFinished(child.__result.dir); return; }
    if (child.__paused) { modelUi('paused'); return; }
    modelUi('failed');
  });
  child.on('error', () => { modelChild = null; modelUi('failed'); });
}
function initModelDownload() {
  const btn = $('modelBtn');
  if (!btn) return;
  if (!MODEL_MISSING) { const c = $('modelCard'); if (c) c.style.display = 'none'; return; }
  btn.addEventListener('click', () => {
    if (modelChild) {
      modelChild.__paused = true;
      try { modelChild.kill(); } catch (e) {}
      return;
    }
    startModelDownload();
  });
  modelUi('idle', 0);
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setModelUi(MODEL_UI.state, MODEL_UI.done));
}

function setup() {
  applySettings();

  // Words-per-caption only applies in Grouped mode (karaoke = 1 word/caption).
  const syncStyleControls = () => {
    $('groupSize').disabled = (CAP !== 'grouped');
    const field = $('groupSizeField');
    if (field) field.style.display = (CAP === 'grouped') ? '' : 'none';
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
  $('speakersToggle').addEventListener('change', (e) => {
    SPEAKERS = !!e.target.checked;
    saveSettings({ speakers: SPEAKERS });
  });

  $('runBtn').addEventListener('click', run);
  $('cancelBtn').addEventListener('click', () => {
    cancelRequested = true;
    try { if (activeChild) activeChild.kill(); } catch (e) {}
    try { if (warmChild && !warmChild.killed) warmChild.kill(); } catch (e) {}
  });

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

  // Advanced options (Max chars). Same disclosure mechanic as the Log.
  const adv = $('advDisc');
  if (adv) {
    adv.addEventListener('click', (e) => {
      e.preventDefault();
      adv.classList.toggle('open');
      adv.setAttribute('aria-expanded', adv.classList.contains('open') ? 'true' : 'false');
    });
  }

  // About: version + the attribution required by the CC-BY-4.0 licensed
  // acoustic model this product redistributes (snapwre/hohe-asr-amharic, a
  // fine-tune of badrex/Ethio-ASR-multilingual-600M).
  $('credits').addEventListener('click', (e) => {
    e.preventDefault();
    $('logDisc').classList.add('open');
    clearLog();
    log('Amharic Captions v' + APP_VERSION);
    log('---');
    log('Acoustic model: "hohe-asr-amharic" by snapwre (Hugging Face), fine-tuned');
    log('from "Ethio-ASR-multilingual-600M" by badrex.');
    log('License: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).');
    log('Model page: https://huggingface.co/snapwre/hohe-asr-amharic');
    log('Converted to CTranslate2 int8 for offline CPU inference; no other changes.');
    log('');
    log('Speaker-embedding model: TitaNet-Small by NVIDIA (NeMo), distributed via');
    log('the sherpa-onnx project. License: CC BY 4.0.');
    log('');
    log('Voice activity detection: Silero VAD (https://github.com/snakers4/silero-vad).');
    log('License: MIT.');
    log('');
    log('Audio/video processing: FFmpeg (https://ffmpeg.org), bundled unmodified as a');
    log('separate executable and run as a child process. FFmpeg is licensed to you');
    log('under the GNU GPL. The full license text and a written offer for the');
    log('corresponding source code ship in the "licenses" folder of your download.');
    log('');
    log('Runtime: CPython (PSF-2.0) with CTranslate2 (MIT), NumPy (BSD-3-Clause),');
    log('onnxruntime (MIT), sherpa-onnx (Apache-2.0) and soundfile (BSD-3-Clause).');
    log('Panel: Adobe CSInterface.js (BSD-3-Clause), json2 (Public Domain).');
    log('');
    log('Full per-component attribution: licenses/THIRD-PARTY-NOTICES.md');
  });

  // Runtime availability.
  if (!RUNTIME) {
    setStatus('err', 'runtime missing');
    $('runBtn').disabled = true;
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
  } else if (MODEL_MISSING && fs.existsSync(PYTHON) && fs.existsSync(FFMPEG)) {
    setStatus('err', 'model needed');
    $('runBtn').disabled = true;
    log('The Amharic model is not on this computer yet (' + Math.round(MODEL_TOTAL_BYTES / 1e6) + ' MB).');
    log('Use "Download the Amharic model" at the top of the panel. It is a');
    log('one-time download; if the connection drops it continues where it stopped.');
  } else if (!fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG) || !fs.existsSync(MODEL_DIR)) {
    setStatus('err', 'runtime incomplete');
    $('runBtn').disabled = true;
    log('ERROR: runtime found at ' + RUNTIME + ' but is incomplete.');
    log('  python: ' + (fs.existsSync(PYTHON) ? 'ok' : 'MISSING (' + PYTHON + ')'));
    log('  ffmpeg: ' + (fs.existsSync(FFMPEG) ? 'ok' : 'MISSING (' + FFMPEG + ')'));
    log('  model:  ' + (fs.existsSync(MODEL_DIR) ? 'ok' : 'MISSING (' + MODEL_DIR + ')'));
    log('Reinstall the correct runtime for your platform and restart Premiere.');
  } else {
    setStatus('ready', 'ready');
    // silero_vad.onnx is OPTIONAL to run (tools/build.sh will cut a zip without
    // it and amh_vad.py just returns no segments) — but its absence silently
    // changes transcription: speech-gap detection collapses to one segment, so
    // captions are cut and timed differently and accuracy moves measurably.
    // Losing that quietly is the worst outcome, so say so. Status stays 'ready'
    // because the panel really does still work. See TESTING.md 1.2j.
    if (!fs.existsSync(path.join(RUNTIME, 'silero_vad.onnx'))) {
      log('WARNING: silero_vad.onnx is missing from the runtime.');
      log('Transcription still works, but speech-gap detection is disabled,');
      log('which changes caption timing and accuracy. Re-extract the zip or');
      log('reinstall to restore it.');
    }
  }

  // P0 polish: token theme applied already; keep health + onboarding in sync.
  renderHealthList();
  initOnboarding();
  initSupport();
  initBuy();
  initLegal();
  initVersion();
  initReview();
  initModelDownload();
  initUpdateBanner();
  syncProgressRow();   // idle: no empty progress row
}

setup();
