/*
 * Amharic Captions panel controller.
 * Runs inside CEP Chromium with Node integration, so it can spawn ffmpeg and
 * the Ethio-ASR Python transcription, then hand the SRT to Premiere via
 * ExtendScript.
 */
'use strict';

const APP_VERSION = '1.60.0';

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
      () => { syncClientButton(); renderClientPanel(); },
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

// ── Anonymous step counts (what happens before people buy) ──────────────
// Half of the computers in Ethiopia that opened the panel never made a
// caption, and nothing said why. track('step') reports one fixed step name
// (opened, model download failed, pressed Make captions, error type, …) at
// most once per computer per day. Only the step, the app (Premiere / After
// Effects / desktop app), the OS and the version are sent — no Machine ID,
// no text, nothing from the video. The server keeps daily totals only
// (/api/event, migration 0025).
const TRACK_HOST = (typeof window !== 'undefined' && window.__amhApp) ? 'APP' : HOST_APP;
const TRACK_OS = (typeof process !== 'undefined' && process.platform === 'darwin') ? 'mac' : 'win';
function track(step) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = 'amh.ev.' + step;
    if (localStorage.getItem(key) === day) return;
    localStorage.setItem(key, day);
    const p = apiPost('/api/event', { e: step, h: TRACK_HOST, os: TRACK_OS, v: APP_VERSION });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}
// The error TYPE behind a failed run (the same buckets as humanError()).
// What the engine said last (stderr), for the error type and the problem
// report: a crash's reason is often only there, not in the error itself.
let WORKER_TAIL = [];
function noteEngineLine(line) {
  WORKER_TAIL.push(String(line).slice(0, 300));
  if (WORKER_TAIL.length > 40) WORKER_TAIL.shift();
}
const MEMORY_RE = /memoryerror|bad_alloc|out of memory|not enough memory|cannot allocate|insufficient memory|paging file is too small/i;
// ffmpeg found no sound in the file (a stock video without audio)
const NO_AUDIO_RE = /does not contain any stream|matches no streams|no audio stream|contains no audio/i;
const BLOCKED_RE = /access is denied|permissionerror|\[winerror 5\]|operation not permitted|winerror 225|virus/i;
function errorStep(raw) {
  const t = String(raw || '').toLowerCase();
  const tail = WORKER_TAIL.join('\n');
  if (workerDllError || t.includes('dll load failed')) return 'err_av_blocked';
  if (MEMORY_RE.test(t) || MEMORY_RE.test(tail)) return 'err_memory';
  if (BLOCKED_RE.test(t) || BLOCKED_RE.test(tail)) return 'err_av_blocked';
  if (t.includes('worker timeout')) return 'err_engine_hang';
  if (t.includes('audio too short')) return 'err_too_short';
  if (t.includes('no speech')) return 'err_no_speech';
  if (t.includes('audio-bearing')) return 'err_no_clips';
  if (t.includes('caption layer made by amharic captions')) return 'err_no_clip';
  if (t.includes('nested sequence has no clip with sound')) return 'err_no_media';
  if (t.includes('precomp has no layer with sound')) return 'err_no_media';
  if (t.includes('no clip found') || t.includes('no selected clip') || t.includes('select a clip')) return 'err_no_clip';
  if (t.includes('source path') || t.includes('no media file')) return 'err_no_media';
  if (NO_AUDIO_RE.test(t)) return 'err_no_audio';
  if (t.includes('ffmpeg')) return 'err_media_unreadable';
  if (t.includes('enospc') || t.includes('no space')) return 'err_disk_full';
  if (t.includes('license required') || t.includes('trial used up') || t.includes('needs internet')) return 'err_license';
  if (t.includes('python failed') || t.includes('worker')) return 'err_engine';
  if (t.includes('runtime')) return 'err_runtime';
  if (t.includes('cancel')) return '';
  return 'err_other';
}
setTimeout(() => track('open'), 1200);

// ── What's new (once per release) ───────────────────────────────────────────
// One entry per release: what an editor who updates actually gets. This list is
// the ONLY place to edit for a new version — the first open after a version
// change shows the card once (never again, never on a first install), and the
// update banner takes its one short line from the newest entry here. A panel
// cannot know what a release newer than itself contains, so `banner` must also
// stay true of any later update. Amharic first, then English.
const WHATS_NEW = {
  '1.42.0': {
    banner: {
      am: '⬇ የአማርኛ ሞዴሉ ማውረድ አሁን ሁልጊዜ ይጨርሳል — ኢንተርኔት ቢቋረጥም — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '⬇ The Amharic model download now always finishes — even when the internet drops — your license stays the same.',
    },
    items: [
      { am: 'ኢንተርኔት ቢቋረጥ ተስፋ አይቆርጥም — ፕሮግራሙ እስኪዘጋ ድረስ በየ5 ደቂቃው እንደገና ይሞክራል', en: 'It never gives up when the internet drops — it tries again every 5 minutes while the program is open' },
      { am: 'ፕሮግራሙን ዘግተው ሲከፍቱ ወይም ኮምፒውተሩ ከተነሳ በኋላ በራሱ ይቀጥላል', en: 'It continues by itself when you open the program again, even after a restart' },
      { am: 'ቢያቆሙት ያቆሙበት ይቆያል — "ቀጥል" ሲጫኑ ይቀጥላል', en: 'If you pause it, it stays paused until you press Resume' },
      { am: 'የመጀመሪያው ማውረድ ያለ እርስዎ ፈቃድ አይጀምርም — የሞባይል ዳታዎን አይጨርስም', en: 'The first download never starts without you — it will not use your mobile data on its own' },
    ],
  },
  '1.41.0': {
    banner: {
      am: '📱 ፈቃድ በስልክዎ ይግዙ — QR ያንሱ፣ በባንክ መተግበሪያዎ ይክፈሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '📱 Buy a license with your phone — scan the QR, pay in your bank app — your license stays the same.',
    },
    items: [
      { am: '"ፈቃድ ይግዙ" አሁን QR ያሳያል — በስልክዎ ካሜራ ያንሱት', en: '"Buy a license" now shows a QR code — scan it with your phone camera' },
      { am: 'ቦቱ፣ የባንክ መተግበሪያውና ስክሪንሾቱ ሁሉም በስልክዎ ላይ — በጥቂት ንክኪ', en: 'The bot, your bank app and the screenshot are all on your phone — a few taps' },
      { am: 'ክፍያው ሲረጋገጥ ይህ ኮምፒውተር በራሱ ይነቃል — ምንም መለጠፍ የለም', en: 'Once the payment is confirmed this computer unlocks itself — nothing to paste' },
      { am: 'ከፈለጉ "ቴሌግራምን በዚህ ኮምፒውተር ክፈት" አሁንም አለ', en: '"Open Telegram on this computer" is still there if you prefer' },
    ],
  },
  '1.40.0': {
    banner: {
      am: '✨ 6 አዳዲስ የካፕሽን እንቅስቃሴዎች — መተየብ፣ ሞገድ፣ ብርሃን እና ሌሎች — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✨ 6 new caption animations — typing, wave, glow and more — your license stays the same.',
    },
    items: [
      { am: '⌨ መተየብ እና 〰 ሞገድ፦ ፊደሎቹ አንድ በአንድ ይታያሉ', en: '⌨ Typing and 〰 Wave: the letters appear one by one' },
      { am: '✨ ብርሃን፣ ደብዝዞ ማጉላት፣ መንቀጥቀጥ፣ ተንሸራቶ + ቀለም', en: '✨ Glow, Blur zoom, Shake, Slide + colour' },
      { am: 'በPremiere፣ After Effects እና Studio ውስጥ ይሰራሉ — ከሁሉም ስታይሎችና ፊደሎች ጋር', en: 'In Premiere, After Effects and the Studio — with every style and font' },
      { am: 'ⓘ አስተካክል → እንቅስቃሴ', en: 'ⓘ Customize → Animation' },
    ],
  },
  '1.39.0': {
    banner: {
      am: '✍ በCapCut ውስጥ ያረሙት ካፕሽን አይጠፋም — "አዘምን" ይጠብቀዋል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✍ Captions you fix inside CapCut are never lost — "Update" keeps them — your license stays the same.',
    },
    items: [
      { am: 'በCapCut ውስጥ ካፕሽን ቢያርሙ፣ "↻ አዘምን" ማስተካከያዎን (ቀለሙንም) ይጠብቃል', en: 'Fix a caption inside CapCut: "↻ Update" keeps your fix (its colour too)' },
      { am: 'ቃል በቃል ያረሙት (ለምሳሌ ተዎድሮስ → ቴዎድሮስ) ወደ 🧠 ማስታወሻ ይገባል — በሁሉም ቪዲዮዎች ይስተካከላል', en: 'A word you replace (e.g. ተዎድሮስ → ቴዎድሮስ) goes into 🧠 memory — fixed in every video' },
      { am: 'ቦታው የተቆረጠ ማስተካከያ ካለ ይነገርዎታል', en: 'You are told if a fix was in a part you cut away' },
      { am: 'ከዚህ በፊት የላኳቸው ፕሮጀክቶችም ይጠበቃሉ', en: 'Projects you sent before are protected too' },
    ],
  },
  '1.38.0': {
    banner: {
      am: '🎬 Studio በሚጠቀሙት ኤዲተር (CapCut፣ DaVinci፣ Premiere) መንገድ ይመራዎታል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎬 The Studio follows your editor (CapCut, DaVinci, Premiere) — your license stays the same.',
    },
    items: [
      { am: 'Studio መነሻ፦ "በየትኛው ኤዲተር ይሰራሉ?" — አንድ ጊዜ ይምረጡ', en: 'Studio home: "Which editor do you use?" — pick once' },
      { am: 'CapCut፦ የCapCut ፕሮጀክቶችዎ ከላይ፣ በ⬆ ይላኩ ውስጥም CapCut መጀመሪያ', en: 'CapCut: your CapCut projects on top, and CapCut first in ⬆ Export' },
      { am: 'Premiere እና DaVinci፦ የሚቀጥለውን ደረጃ የሚያሳይ አጭር መመሪያ', en: 'Premiere and DaVinci: a short hint for the next step' },
      { am: 'በማንኛውም ጊዜ "ቀይር" ይጫኑ', en: 'Press "change" any time' },
    ],
  },
  '1.37.0': {
    banner: {
      am: '✨ በCapCut ውስጥ ለአንድ ካፕሽን የሰጡትን እንቅስቃሴ ለሁሉም ይስጡ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✨ Give all your captions the animation you chose for one in CapCut — your license stays the same.',
    },
    items: [
      { am: 'በCapCut ውስጥ ለአንድ ካፕሽን እንቅስቃሴ (Animation) ይስጡ — በStudio መነሻ "ለሁሉም ካፕሽኖች" ይጫኑ', en: 'Give one caption an animation in CapCut — press "Use for all captions" on the Studio home' },
      { am: 'እያንዳንዱ ካፕሽን በርዝመቱ ልክ ይንቀሳቀሳል፤ በCapCut ያረሙት ጽሑፍ ይቆያል', en: 'Each caption gets it at its own length; text you fixed in CapCut stays' },
      { am: '"↻ አዘምን" የመረጡትን እንቅስቃሴ ይጠብቃል', en: '"↻ Update" keeps the animation you chose' },
      { am: 'ማንኛውንም የCapCut እንቅስቃሴ መጠቀም ይችላሉ (In፣ Out፣ Loop)', en: 'Any CapCut animation works (In, Out, Loop)' },
    ],
  },
  '1.36.0': {
    banner: {
      am: '✏️ የCapCut ፕሮጀክትዎን በአንድ ጠቅታ ካፕሽን ያድርጉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✏️ Caption your CapCut project in one click — your license stays the same.',
    },
    items: [
      { am: 'Studio መነሻ፦ የCapCut ፕሮጀክቶችዎ ይታያሉ — "ካፕሽን ጨምር" ይጫኑ', en: 'Studio home: your CapCut projects are listed — press "Add captions"' },
      { am: 'በፕሮጀክቱ ውስጥ ያሉ ሁሉም ቪዲዮዎች ካፕሽን ያገኛሉ', en: 'Every video in the project gets captions' },
      { am: 'በCapCut ውስጥ እንደገና ቢቆርጡ፣ "↻ አዘምን" በሰከንዶች ያስተካክላል — እንደገና መጻፍ የለም', en: 'Re-cut in CapCut? "↻ Update" fixes it in seconds — nothing is transcribed again' },
      { am: 'በMac ላይ ያለው CapCutም ይሰራል', en: 'CapCut on Mac works too' },
    ],
  },
  '1.35.0': {
    banner: {
      am: '✏️ ካፕሽኖችዎን በስታይሉ ወደ CapCut ይላኩ — እያንዳንዱ ካፕሽን እንደሚታረም ጽሑፍ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✏️ Send your styled captions to CapCut — every caption an editable text — your license stays the same.',
    },
    items: [
      { am: 'Studio ⬆ ይላኩ → CapCut፦ ካፕሽኖቹ በፊደሉ፣ በቀለሙ፣ በመጠኑና በቦታው ወደ CapCut ፕሮጀክትዎ ይገባሉ', en: 'Studio ⬆ Export → CapCut: the captions go into your CapCut project with their font, colours, size and position' },
      { am: 'ቪዲዮውን በCapCut ውስጥ ቢቆርጡ ወይም ቢያንቀሳቅሱም ካፕሽኖቹ በትክክለኛው ጊዜ ይቀመጣሉ', en: 'Even if you trimmed or moved the video in CapCut, the captions land at the right time' },
      { am: 'ከመቀየሩ በፊት ፕሮጀክቱ ይቀመጣል — ↶ እንደነበረው ይመልሰዋል፤ እንደገና ሲልኩ አይደገምም', en: 'The project is backed up first — ↶ puts it back; sending again never doubles the captions' },
      { am: '★ ቃላትና ቁጥሮች በጎላ ቀለማቸው ይሄዳሉ', en: '★ words and numbers keep their highlight colour' },
    ],
  },
  '1.34.0': {
    banner: {
      am: '✂ ቪዲዮዎን ጽሑፉን በማረም ያርትዑ — ቃላትን ይሰርዙ፣ ክፍሎችን ያንቀሳቅሱ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ Edit your video by editing the text — delete words, move parts — your license stays the same.',
    },
    items: [
      { am: 'Studio ¶ ጽሑፍ፦ ቃላትን መርጠው Delete ይጫኑ — ያ የቪዲዮው ክፍል ከካፕሽኑ ጋር ይቆረጣል', en: 'Studio ¶ Script: select words and press Delete — that part of the video goes, captions too' },
      { am: 'አንድን ክፍል በ⋮⋮ ይዘው ወደ ሌላ ቦታ ይጎትቱት — ቪዲዮውም አብሮ ይንቀሳቀሳል', en: 'Drag a paragraph by its ⋮⋮ to another place — the video moves with it' },
      { am: 'ሁሉም ለውጥ በአንድ ↶ (Ctrl+Z) ይመለሳል', en: 'One ↶ (Ctrl+Z) brings any change back' },
      { am: 'ቁርጡ በቃላቱ መካከል ይሆናል፤ ግማሽ ቃል ወይም ትንፋሽ አይቀርም', en: 'Cuts fall between words: no half words or breaths are left' },
    ],
  },
  '1.33.0': {
    banner: {
      am: '🛠 ጥገናዎች፦ ፕሮጀክቶች የራሳቸውን የካፕሽን ገጽታ ያስታውሳሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🛠 Fixes: projects remember their own caption look — your license stays the same.',
    },
    items: [
      { am: 'Studio፦ ፕሮጀክት ሲከፍቱ የራሱ መጠን፣ ቦታና ቀለም ይመለሳል (ሌላ ፕሮጀክት ቢቀይረውም)', en: 'Studio: opening a project brings back its own size, position and colours (even if another project changed the style)' },
      { am: 'Studio፦ "ቃላት በአንድ ካፕሽን" ከፕሮጀክቱ ጋር ይቀመጣል', en: 'Studio: "Words per caption" is saved with the project' },
      { am: 'After Effects፦ "ሙሉ ኮምፕ" እና "Work Area" በፕሪኮምፖች ውስጥ ያለውን ድምፅም ይወስዳሉ', en: 'After Effects: "Whole comp" and "Work Area" also take the sound inside precomps' },
      { am: 'ጠባብ ፓነል ላይ "1 · ካራኦኬ" ሙሉ ይታያል', en: '"1 · Karaoke" shows in full on a narrow panel' },
    ],
  },
  '1.32.0': {
    banner: {
      am: '🎨 ካፕሽንዎን በቪዲዮው ውስጥ ያስተካክሉ — ይጎትቱት፣ መጠኑን ይቀይሩ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎨 Style your captions right in the video — drag them, size them — your license stays the same.',
    },
    items: [
      { am: 'Studio፦ "⚙ አስተካክል" ከስታይሎቹ ፈንታ ይከፈታል — እያንዳንዱ ለውጥ በቪዲዮው ውስጥ ወዲያው ይታያል', en: 'Studio: "⚙ Customize" opens in place of the styles — every change shows in the video at once' },
      { am: 'Studio፦ ካፕሽኑን በቪዲዮው ውስጥ ወደ ላይ ወይም ወደ ታች ይጎትቱት (9:16 ላይ የTikTok መስመር ይታያል)', en: 'Studio: drag the caption up or down in the video (9:16 shows the TikTok line)' },
      { am: 'መጠን አሁን ተንሸራታች ነው (60–180%)፣ ቦታም በትክክል (↕) — Premiere ላይም', en: 'Size is now a slider (60–180%) and the height is exact (↕) — in Premiere too' },
      { am: 'Studio፦ የእንግሊዝኛ ቃላት በቅድመ እይታው ውስጥ በትክክል ይታያሉ', en: 'Studio: English words now show properly in the preview' },
    ],
  },
  '1.31.0': {
    banner: {
      am: '✨ ይበልጥ ንጹህ Studio — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✨ A cleaner Studio — your license stays the same.',
    },
    items: [
      { am: 'Studio፦ በዝርዝሩ ውስጥ ረጅም ካፕሽኖች ሙሉ በሙሉ ይታያሉ', en: 'Studio: long captions show in full in the List' },
      { am: 'Studio፦ ቀጭን፣ ጸጥ ያሉ የማሸብለያ አሞሌዎች', en: 'Studio: thin, quiet scroll bars' },
      { am: 'Studio፦ ከላይ አጭር "🔑 ፈቃድ" — ሙሉ መረጃው ሲጠቁሙበት ይታያል', en: 'Studio: a short "🔑 License" at the top — point at it for the details' },
      { am: 'Studio፦ የስታይል ማስታወሻው በራሱ መስመር፣ የ"ዝርዝር" ቁልፍ ሙሉ ስሙ ይታያል', en: 'Studio: the style note has its own line, and "List" shows its whole name' },
    ],
  },
  '1.30.0': {
    banner: {
      am: '✨ ይበልጥ ንጹህ ፓነል — ትንሽ ቁልፎች፣ ብዙ ቦታ ለካፕሽኖችዎ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✨ A cleaner panel — fewer buttons, more room for your captions — your license stays the same.',
    },
    items: [
      { am: 'ከታች፦ ተወው እና ✓ በታይምላይን ላይ አስቀምጥ ብቻ', en: 'At the bottom: just Discard and ✓ Place on timeline' },
      { am: '"+ ካፕሽን ጨምር" ከካፕሽኖቹ ዝርዝር በታች፣ "⬇ ፋይሎች" (SRT፣ VTT፣ TXT) ከደረጃዎቹ ጋር', en: '"+ Add caption" under the caption list, "⬇ Files" (SRT, VTT, TXT) next to the steps' },
      { am: 'ዝመና ይፈትሹ፣ ስለ ምርቱ እና ውሎች በግርጌው "⋯" ውስጥ', en: 'Check for updates, About and Terms are in the "⋯" at the bottom' },
      { am: 'ፈቃድ ያላቸው፦ ትልቁ ሳጥን ቀርቶ በግርጌው ትንሽ "✓ ፈቃድ አለዎት"', en: 'Licensed: a small "✓ Licensed" at the bottom instead of the big box' },
    ],
  },
  '1.29.0': {
    banner: {
      am: '🎬 Studio፦ የመረጡት የካፕሽን ስታይል በማጫወቻው ውስጥ ይታያል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎬 Studio: the caption style you choose now plays in the player — your license stays the same.',
    },
    items: [
      { am: 'የመረጡት ስታይል (Glide፣ Bounce…) በማጫወቻው ውስጥ በእንቅስቃሴው ልክ እንደሚላከው ይታያል', en: 'The style you choose (Glide, Bounce…) plays in the player exactly as it is exported, animations too' },
      { am: 'ካፕሽን ሲያርሙ ወይም ስታይል ሲቀይሩ ወዲያው ይታደሳል', en: 'It updates as soon as you fix a caption or change the style' },
      { am: '📁 ሚዲያ፦ ለሌሎቹ ቪዲዮዎችም "💬 ካፕሽን ይስሩ"', en: '📁 Media: "💬 Make captions" for your other videos too' },
      { am: 'ጽሑፍ፣ ተደራቢ ወይም ሙዚቃ ሲያስተካክሉ ከእንግዲህ አይጠፋም (አይለቀቅም)', en: 'A text, overlay or music no longer gets unselected while you change its settings' },
    ],
  },
  '1.28.0': {
    banner: {
      am: '🔤 8 አዳዲስ የአማርኛ ፊደሎች — አሁን 12 ፊደሎች ለካፕሽንና ለርዕስ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🔤 8 new Amharic fonts — now 12 fonts for captions and titles — your license stays the same.',
    },
    items: [
      { am: 'አዲስ፦ Yebse (ወፍራም)፣ WashRa (ደማቅ)፣ Agbalumo (ተጫዋች)፣ Tint (ብሩሽ)፣ Fantuwua (የእጅ ጽሑፍ)፣ Jiret (መጽሐፍ)፣ Hibur Mono (ታይፕራይተር)፣ Gothic (ያጌጠ)',
        en: 'New: Yebse (heavy), WashRa (bold), Agbalumo (playful), Tint (brush), Fantuwua (handwritten), Jiret (book), Hibur Mono (typewriter), Gothic (ornate)' },
      { am: 'ሁሉም ፊደሎች በአንድ መጠን ይታያሉ — ለTikTok እና Reels የተዘጋጁ', en: 'Every font looks the same size — made for TikTok and Reels' },
      { am: '⬇ "እነዚህን ፊደሎች በዚህ ኮምፒውተር ላይ ይጫኑ"፦ በPremiere ርዕሶች፣ CapCut እና DaVinci ውስጥም ይጠቀሙባቸው', en: '⬇ "Install these fonts on this PC": use them in Premiere titles, CapCut and DaVinci too' },
      { am: 'Studio፦ የርዕሶች መጠን በማጫወቻው ልክ እንደሚላከው ይታያል', en: 'Studio: titles now show in the player at exactly the size they are exported' },
    ],
  },
  '1.27.0': {
    banner: {
      am: '✎ የስታይል ካፕሽኖች አሁን ይታረማሉ፦ እያንዳንዱ ካፕሽን የራሱ ክሊፕ ነው — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✎ Styled captions can now be edited: every caption is its own clip — your license stays the same.',
    },
    items: [
      { am: 'በPremiere እያንዳንዱ ካፕሽን የራሱ ክሊፕ ነው፦ ለብቻው ያንቀሳቅሱት፣ ያሳጥሩት ወይም ይሰርዙት', en: 'In Premiere every caption is its own clip: move, trim or delete it on its own' },
      { am: 'ካፕሽኑን በጊዜ መስመሩ ላይ ይምረጡ → በፓነሉ "✎ የተመረጠውን ካፕሽን ያስተካክሉ" → ያርሙ → ያስቀምጡ', en: 'Select a caption on the timeline → "✎ Edit the selected caption" in the panel → fix it → Place' },
      { am: 'የተቀየሩት ካፕሽኖች ብቻ እንደገና ይሰራሉ — በሰከንዶች', en: 'Only the captions you changed are drawn again — in seconds' },
      { am: 'ከ🕘 የቅርብ ጊዜ ሲከፍቱም እንዲሁ፦ የቀየሩት ብቻ ይታደሳል', en: 'The same from 🕘 Recent: only what you changed is updated' },
    ],
  },
  '1.26.0': {
    banner: {
      am: '⌨ ያለ አማርኛ ኪቦርድ አማርኛ ይጻፉ፦ selam → ሰላም — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '⌨ Type Amharic without an Amharic keyboard: selam → ሰላም — your license stays the same.',
    },
    items: [
      { am: 'በካፕሽን፣ በማረሚያ እና በStudio ጽሑፍ ውስጥ በላቲን ፊደል ሲጽፉ አማርኛ ይወጣል', en: 'In captions, fixes and Studio titles, Latin letters write Amharic as you type' },
      { am: 'biet → ቤት · gwada → ጓዳ · TEna → ጤና · :: → ።', en: 'biet → ቤት · gwada → ጓዳ · TEna → ጤና · :: → ።' },
      { am: 'ሳጥኑ ላይ ያለውን አ ይጫኑ ወይም Ctrl+Space (Mac ⌘⇧Space) — ለእንግሊዝኛ', en: 'Click the አ on the box or press Ctrl+Space (Mac ⌘⇧Space) — for English' },
      { am: 'የአማርኛ ኪቦርድ ያላቸውም እንደቀድሞው ይጽፋሉ', en: 'An Amharic keyboard keeps working as before' },
    ],
  },
  '1.25.0': {
    banner: {
      am: '⬆ Studio፦ ለYouTube፣ TikTok፣ Instagram፣ ቴሌግራም በአንድ ጊዜ ይላኩ — በግራፊክስ ካርድ በጣም ፈጣን — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '⬆ Studio: export for YouTube, TikTok, Instagram and Telegram at once — much faster with the graphics card — your license stays the same.',
    },
    items: [
      { am: 'ለብዙ መድረኮች በአንድ ጊዜ፦ YouTube · TikTok/Reels/Shorts · Instagram · ካሬ · ቴሌግራም (ቀላል ፋይል) · ማስተር', en: 'Several platforms at once: YouTube · TikTok/Reels/Shorts · Instagram · Square · Telegram (light file) · Master' },
      { am: '⚡ የግራፊክስ ካርድ (NVIDIA፣ Intel፣ AMD፣ Apple) ካለ በራሱ ይጠቀማል', en: '⚡ Uses your graphics card (NVIDIA, Intel, AMD, Apple) when there is one' },
      { am: 'ካፕሽኑ ከቪዲዮው ጋር በአንድ ዙር ይጻፋል — ፈጣንና ጥራቱ አይቀንስም', en: 'Captions are drawn in the same pass as the video — faster, no quality lost' },
      { am: 'ተራ፦ ቪዲዮው ሲሰራ ማረምዎን ይቀጥሉ፤ የቀረው ጊዜ ይታያል፣ ማቆም ይቻላል', en: 'Queue: keep editing while it works; time left shown; stop any time' },
    ],
  },
  '1.24.0': {
    banner: {
      am: '⧓ Studio፦ ሽግግሮች፣ ፍጥነት (0.25×–4×) እና ቀለም — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '⧓ Studio: transitions, speed (0.25×–4×) and colour — your license stays the same.',
    },
    items: [
      { am: '⧓ ሽግግር፦ መቀላቀል፣ በጥቁር፣ በነጭ፣ መንሸራተት፣ መጥረግ፣ ክብ፣ ማጉላት', en: '⧓ Transitions: dissolve, dip to black / white, slide, wipe, circle, zoom' },
      { am: 'ሽግግሩ የቪዲዮውን ርዝመትና ካፕሽኖቹን አይቀይርም', en: 'A transition never changes the video length or moves the captions' },
      { am: '⏩ ፍጥነት፦ ቀርፋፋ ወይም ፈጣን — ድምፁ ቅላጼውን ይይዛል፣ ካፕሽኖቹ ከቃላቱ ጋር ይሄዳሉ', en: '⏩ Speed: slow motion or fast — the voice keeps its pitch, captions stay on their words' },
      { am: '🎨 ቀለም፦ ሞቅ ያለ፣ ቀዝቃዛ፣ ጥቁርና ነጭ፣ ደማቅ፣ ሲኒማ፣ የደበዘዘ + ብርሃን፣ ንፅፅር፣ ሙሌት፣ ሙቀት', en: '🎨 Colour: Warm, Cool, B&W, Vivid, Cinematic, Faded + brightness, contrast, saturation, temperature' },
      { am: 'በቅድመ-እይታ የሚያዩት ልክ የሚላከው ነው', en: 'What you see in the preview is what you export' },
    ],
  },
  '1.23.0': {
    banner: {
      am: '♪ Studio፦ ሙዚቃ፣ ሰው ሲናገር ራሱ የሚቀንስ ሙዚቃ፣ የድምፅ ማጽጃ እና የYouTube/TikTok የድምፅ መጠን — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '♪ Studio: music, music that gets quieter by itself while people speak, voice cleaning and YouTube/TikTok loudness — your license stays the same.',
    },
    items: [
      { am: '♪ የሙዚቃ መስመር፦ mp3፣ wav፣ m4a ይጎትቱ — ከዋናው መስመር በታች ይገባል', en: '♪ Music track: drop an mp3, wav or m4a — it goes under the main track' },
      { am: 'ሰው ሲናገር ሙዚቃው ራሱ ይቀንሳል፣ ዝም ሲል ይመለሳል', en: 'The music gets quieter by itself while someone speaks, and comes back in the pauses' },
      { am: 'የሙዚቃ መግቢያና መውጫ (fade)፣ ድምፅ', en: 'Music fade in / fade out, volume' },
      { am: '🔊 ድምፅ፦ የንግግር ድምፅ ማጽጃ (ጫጫታና ጉምጉምታ)', en: '🔊 Sound: clean the voice (hiss and rumble)' },
      { am: 'የድምፅ መጠን፦ YouTube · TikTok (−14 LUFS) ወይም ቲቪ (−23)', en: 'Loudness: YouTube · TikTok (−14 LUFS) or TV (−23)' },
    ],
  },
  '1.22.0': {
    banner: {
      am: 'T Studio፦ ርዕስ፣ የስም ጽሑፍ (lower third) እና በሳጥን ላይ ጽሑፍ በአማርኛ ፊደሎች — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'T Studio: titles, lower thirds and text on a box in Amharic fonts — your license stays the same.',
    },
    items: [
      { am: 'T ጽሑፍ መስመር፦ ርዕስ፣ የስምና ማዕረግ ጽሑፍ፣ በሳጥን ላይ፣ ቀላል', en: 'T Text track: title, name and title (lower third), on a box, plain' },
      { am: 'አራት የአማርኛ ፊደሎች፣ መጠን፣ ቀለም', en: 'Four Amharic fonts, size, colour' },
      { am: 'እንቅስቃሴ፦ Fade · Slide · Pop', en: 'Animation: Fade · Slide · Pop' },
      { am: 'በምስሉ ላይ ጎትተው ቦታውን ያስተካክሉ፤ በጊዜ መስመሩ ላይ ያንቀሳቅሱና ያሳጥሩ', en: 'Drag it on the picture; move and trim it on the timeline' },
      { am: 'የሚያዩት ፊደል ልክ የሚላከው ነው', en: 'The font you see is exactly the font you export' },
    ],
  },
  '1.21.0': {
    banner: {
      am: '🎞 Studio፦ B-roll፣ ፎቶና ሎጎ ከዋናው ቪዲዮ በላይ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎞 Studio: B-roll, photos and a logo above the main video — your license stays the same.',
    },
    items: [
      { am: '🎞 ተደራቢ መስመር፦ B-roll ቪዲዮ፣ ፎቶ ወይም ሎጎ በማንኛውም ሰዓት', en: '🎞 Overlay track: B-roll, a photo or a logo at any time' },
      { am: 'በምስሉ ላይ ጎትተው ቦታውን ያስተካክሉ፤ መጠን፣ ግልጽነት፣ ሙላ/ሙሉውን አሳይ', en: 'Drag it on the picture; size, opacity, fill / whole' },
      { am: 'በጊዜ መስመሩ ላይ ጎትተው ያንቀሳቅሱ፣ ጠርዙን ጎትተው ያሳጥሩ — ወደ ማጫወቻውና ወደ ክሊፕ ጠርዝ ይጣበቃል', en: 'Drag it on the timeline, trim its edges — it snaps to the playhead and clip edges' },
      { am: 'B-roll በነባሪ ድምፅ የለውም፤ ከፈለጉ ድምፁን ከፍ ያድርጉ', en: 'B-roll is silent by default; raise its volume if you want' },
      { am: 'ሲልኩ ሁሉም በአንድ ቪዲዮ ውስጥ በትክክል እንዳዩት', en: 'Export shows them exactly as you placed them' },
    ],
  },
  '1.20.0': {
    banner: {
      am: '🎬 Amharic Captions Studio አሁን እውነተኛ ኤዲተር ነው፦ ክሊፖች፣ ቁረጥ፣ አንቀሳቅስ፣ 9:16 — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎬 Amharic Captions Studio is now a real editor: clips, split, move, 9:16 — your license stays the same.',
    },
    items: [
      { am: '🎬 የጊዜ መስመር፦ ብዙ ክሊፖች፤ ✂ ቁረጥ (S)፣ 🗑 ሰርዝ፣ ጠርዙን ጎትተው ያሳጥሩ፣ ክሊፑን ጎትተው ያንቀሳቅሱ', en: '🎬 Timeline: many clips; ✂ Split (S), 🗑 Delete, drag an edge to trim, drag a clip to move it' },
      { am: '📁 ሚዲያ፦ ተጨማሪ ቪዲዮዎችን ያስገቡ ወይም ይጎትቱ', en: '📁 Media: import or drop more videos' },
      { am: 'መጠን፦ 16:9 · 9:16 (TikTok) · 1:1 · 4:5 — ምስሉን ጎትተው ቦታውን ይቀይሩ', en: 'Format: 16:9 · 9:16 (TikTok) · 1:1 · 4:5 — drag the picture to place it' },
      { am: '⚙ ክሊፕ፦ መጠን፣ ቦታና ድምፅ ለእያንዳንዱ ክሊፕ', en: '⚙ Clip: size, position and volume for each clip' },
      { am: 'ካፕሽኖቹ ኤዲቱን ይከተላሉ — ያረሙት ቃል መቼም አይጠፋም፤ ↶ ↷ ለሁሉም', en: 'Captions follow the edit — a fixed word is never lost; ↶ ↷ for everything' },
      { am: '⬆ ይላኩ፦ ሙሉው ኤዲት በአንድ ቪዲዮ፣ ካፕሽኑ በስታይልዎ ተጽፎበት', en: '⬆ Export: the whole edit as one video, captions in your style' },
    ],
  },
  '1.19.0': {
    banner: {
      am: '✂ Studio፦ ዝምታ፣ የተደገመ አባባልና እ… ድምፆችን ቆርጠው የጸዳ ቪዲዮ ይላኩ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ Studio: cut pauses, repeated takes and እ… sounds, and export a clean video — your license stays the same.',
    },
    items: [
      { am: '✂ ማጽዳት፦ ዝምታ፣ የተደገመ አባባልና እ… ድምፆች ይገኛሉ፤ የሚቆረጠውን ይመርጣሉ', en: '✂ Clean up: pauses, repeated takes and እ… sounds are found; you choose what goes' },
      { am: 'በጽሑፉ ውስጥ ቃላትን ይምረጡ → ✂ ቁረጥ', en: 'Select words in the Script → ✂ Cut' },
      { am: 'ሲጫወት የሚቆረጠውን ይዘላል — የጸዳውን ወዲያው ይሰማሉ፤ በጊዜ መስመሩ ላይ በቀይ ይታያል', en: 'Playback skips the cuts — you hear the clean edit at once; red on the timeline' },
      { am: 'ይላኩ፦ ካፕሽን ያለው የጸዳ ቪዲዮ፣ ያለ ካፕሽን የጸዳ ቪዲዮ፣ ከእሱ ጋር የሚሄድ .srt', en: 'Export: the clean video with captions, without captions, and the .srt that matches' },
      { am: 'ዋናው ቪዲዮዎ ፈጽሞ አይነካም', en: 'Your original video is never changed' },
    ],
  },
  '1.18.1': {
    banner: {
      am: '¶ Studio፦ ጽሑፉን እንደ ሰነድ ያንብቡና ያርሙ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '¶ Studio: read and fix the words like a document — your license stays the same.',
    },
    items: [
      { am: '¶ ጽሑፍ፦ ካፕሽኖቹ እንደ አንቀጽ ይነበባሉ፤ የሚነገረው ቃል በአረንጓዴ ይታያል', en: '¶ Script: the captions read as paragraphs; the word being spoken is green' },
      { am: 'ቃላትን ይምረጡ — ★ ጎልቶ · ✎ አርም · ▶ አጫውት እዚያው ይታያሉ', en: 'Select words — ★ Pop · ✎ Fix · ▶ Play appear right there' },
      { am: 'ቃሉን ሁለቴ ይጫኑ፦ ወዲያውኑ ያርሙት', en: 'Double-click a word to fix it at once' },
      { am: '⚠ ቁጥሩን ሲጫኑ ወደ መጀመሪያው የሚፈተሽ ቃል ይሄዳል', en: 'Click ⚠ to go to the first word to check' },
      { am: '☰ ዝርዝር፦ ለትክክለኛ ጊዜ የካፕሽን ሳጥኖቹ አንድ ጠቅታ ርቀው ናቸው', en: '☰ List: the caption boxes for exact timing are one click away' },
    ],
  },
  '1.18.0': {
    banner: {
      am: '🎬 Amharic Captions Studio በአዲስ መልክ፦ ቪዲዮ ይጣሉ፣ ወዲያውኑ ይጀምራል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎬 Amharic Captions Studio, redesigned: drop a video and it starts at once — your license stays the same.',
    },
    items: [
      { am: 'ቪዲዮ ሲጥሉ ስራው ወዲያውኑ ይጀምራል — ደረጃዎች የሉም', en: 'Drop a video and the work starts at once — no steps' },
      { am: 'አንድ ስክሪን፦ ጽሑፍ በግራ፣ ቪዲዮ በመሃል፣ ስታይል በቀኝ፣ የጊዜ መስመር ከታች', en: 'One screen: text left, video middle, style right, timeline below' },
      { am: 'ቃላት በአንድ ካፕሽን ከተጻፈ በኋላ ወዲያውኑ ይቀየራል — እንደገና መጻፍ የለም', en: 'Words per caption change instantly after transcription — nothing is redone' },
      { am: '⬆ ይላኩ፦ .srt፣ ካፕሽን ያለው ቪዲዮ፣ ሌሎች ፋይሎች — በአንድ ቦታ', en: '⬆ Export: .srt, video with captions, more files — in one place' },
      { am: 'ፕሮጀክቶች በራሳቸው ይቀመጣሉ፤ ያለ ቪዲዮ ፕሮጀክት ሲከፍቱ እንደገና አይጻፍም', en: 'Projects save themselves; an opened video with a project is never transcribed again' },
    ],
  },
  '1.17.0': {
    banner: {
      am: '🎬 አዲስ፦ Amharic Captions Studio — ለCapCut እና DaVinci ተጠቃሚዎች ሙሉ የስራ ቦታ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🎬 New: Amharic Captions Studio — a full workspace for CapCut and DaVinci users — your license stays the same.',
    },
    items: [
      { am: '🎬 የዴስክቶፕ መተግበሪያው አሁን «Amharic Captions Studio» ነው', en: '🎬 The desktop app is now "Amharic Captions Studio"' },
      { am: 'ትልቅ ቪዲዮ ማጫወቻ፣ ካፕሽኖቹ በላዩ ላይ፤ በቀኝ የካፕሽን ዝርዝሩ', en: 'A big video player with the captions on it; the caption list on the right' },
      { am: 'የጊዜ መስመር፦ የሙሉ ቪዲዮው የድምፅ ሞገድ፣ ካፕሽኖቹን ጎትተው ጊዜያቸውን ያስተካክሉ', en: 'A timeline: the whole video\u2019s sound wave; drag captions to retime them' },
      { am: '📁 ፕሮጀክቶች በራሳቸው ይቀመጣሉ — «የቅርብ ጊዜ ፕሮጀክቶች» እንደገና ሳይጻፉ ይከፈታሉ', en: '📁 Projects save themselves — "Recent projects" reopen without transcribing again' },
      { am: 'ቁልፎች፦ Space ያጫውቱ/ያቁሙ · J/L ±1 ሰከንድ · ←/→ አንድ ፍሬም', en: 'Keys: Space play/pause · J/L ±1 s · ←/→ one frame' },
    ],
  },
  '1.16.26': {
    banner: {
      am: '✂ እና 🔍 አሁን በትክክል በቃሉ ላይ ይሠራሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ and 🔍 now land exactly on the word — your license stays the same.',
    },
    items: [
      { am: '✂ አንድ ቃል ሲቆርጡ በትክክል ያ ቃል ብቻ ይቆረጣል', en: '✂ Cutting one word cuts exactly that word' },
      { am: '🔍 ዙም በትክክል ቃሉ በሚነገርበት ቅጽበት ይጀምራል', en: '🔍 The zoom starts exactly when the word is said' },
      { am: 'እ… ድምፆችም በትክክለኛ ቦታቸው ይቆረጣሉ', en: 'እ… sounds are cut at their exact place too' },
      { am: 'ቅጂ መስራት አይዘገይም — ልክ እንደበፊቱ ፈጣን ነው', en: 'Transcription is just as fast as before' },
    ],
  },
  '1.16.25': {
    banner: {
      am: 'ፓነሉ ይበልጥ ቀላልና ፈጣን ሆኗል፦ ደረጃዎች፣ አቋራጭ ቁልፎችና ሌሎችም — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'A clearer, faster panel: steps, keyboard shortcuts and more — your license stays the same.',
    },
    items: [
      { am: '▶ ከGenerate በፊት የሚጻፍለትን ክሊፕና ርዝመቱን ያያሉ', en: '▶ Before Generate you see which clip will be captioned, and how long it is' },
      { am: 'ቃላት በአንድ ካፕሽን፦ 1 · 2 · 3 · 4 · 5 — በአንድ መስመር', en: 'Words per caption: 1 · 2 · 3 · 4 · 5 — in one row' },
      { am: 'በግምገማው ላይ ደረጃዎች፦ ① ጽሑፍ ② ✂ ③ 🔍 ④ 🎨 ⑤ ያስቀምጡ', en: 'Steps in the review: ① Text ② ✂ ③ 🔍 ④ 🎨 ⑤ Place' },
      { am: '① ሲጫኑ ወደ መጀመሪያው አጠራጣሪ ቃል ይወስድዎታል', en: '① takes you to the first doubtful word' },
      { am: 'አቋራጮች፦ Ctrl+B = ★ · Ctrl+D = ✂ · Ctrl+↓/↑ = ቀጣይ/ቀዳሚ ካፕሽን', en: 'Shortcuts: Ctrl+B = ★ · Ctrl+D = ✂ · Ctrl+↓/↑ = next/previous caption' },
    ],
  },
  '1.16.24': {
    banner: {
      am: '✂ ቪዲዮውን በጽሑፍ ያርትዑ፦ ቃላትን ይሰርዙ፣ ከቪዲዮው ይቆረጣሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ Edit the video by its text: strike words and they are cut from the video — your license stays the same.',
    },
    items: [
      { am: '✂ በካፕሽኑ አጠገብ፦ ቃል ወይም ሙሉ ካፕሽን ይምረጡና ✂ ይጫኑ', en: '✂ next to each caption: pick a word or a whole caption and press ✂' },
      { am: 'የተሰረዙት ቃላት በቀይ መስመር ይታያሉ፤ ✂ እንደገና = ይቆያል', en: 'Struck words show red with a line through; ✂ again keeps them' },
      { am: 'በ«✂ ያጽዱ» ዝርዝር ውስጥ «የእርስዎ ቁርጥ» ሆነው ይመጣሉ', en: 'They come up in the ✂ Clean up list as "Your cut"' },
      { am: 'ሲቆረጡ ከካፕሽኑም ይወጣሉ፤ ዋናው ሴኩዌንስ አይነካም', en: 'Once cut they leave the captions too; your sequence is never touched' },
    ],
  },
  '1.16.23': {
    banner: {
      am: '🔍 ራስ-ሰር ዙም፦ ቪዲዮዎ በ★ ቃላት፣ በቁጥሮችና በብር ላይ ይቀርባል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '🔍 Auto zoom: your video zooms in on ★ words, numbers and money — your license stays the same.',
    },
    items: [
      { am: '🔍 ዙም፦ ★ ባደረጉባቸው ቃላት፣ በቁጥሮችና በብር ላይ ቪዲዮው ይቀርባል', en: '🔍 Zoom: the video moves in on your ★ words, numbers and money' },
      { am: 'ቀስ ብሎ ወይም በድንገት፤ 110%፣ 115% ወይም 125%', en: 'Smooth or punch; 110%, 115% or 125%' },
      { am: 'ዝርዝሩን ያዩታል፣ ማንኛውንም ያስቀራሉ', en: 'You see the list and untick any moment' },
      { am: 'በቅጂ ላይ ይሠራል፤ የራስዎ የScale እንቅስቃሴ አይነካም', en: 'Works on a copy; your own Scale animation is never touched' },
    ],
  },
  '1.16.22': {
    banner: {
      am: '✂ ማጽዳት በረጅም ቪዲዮዎች ላይ በጣም ፈጣን ሆኗል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ Clean up is much faster on long videos — your license stays the same.',
    },
    items: [
      { am: '✂ ማጽዳት በረጅም ቪዲዮዎች ላይ በጣም ፈጣን ሆኗል', en: '✂ Clean up is much faster on long videos' },
      { am: 'ሲቆርጥ ሂደቱን ያያሉ፦ «እየቆረጠ ነው 10 ከ 40…»', en: 'You see the progress while it cuts: "Cutting 10 of 40…"' },
      { am: '✕ ያቁሙ፦ በማንኛውም ጊዜ ማቆም ይችላሉ፤ የተቆረጠው ይቀራል', en: '✕ Stop at any time; what is already cut stays' },
      { am: 'ቪዲዮዎ በNested sequence ውስጥ ቢሆንም ይሠራል', en: 'Works when your video is inside a nested sequence' },
    ],
  },
  '1.16.20': {
    banner: {
      am: '✂ በአንድ ቁልፍ ያጽዱ፦ ዝምታ፣ የተደገመ አባባልና እ… ድምፆች ይቆረጣሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: '✂ Clean up in one click: pauses, repeated takes and እ… sounds are cut — your license stays the same.',
    },
    items: [
      { am: '✂ ያጽዱ፦ ረጅም ዝምታዎች ከቪዲዮዎ ድምፅ ይገኛሉ', en: '✂ Clean up: long pauses are found in your video\u2019s own sound' },
      { am: 'የተደገመ አባባል — የመጀመሪያው ሙከራ ይቆረጣል፣ የመጨረሻው ይቀራል', en: 'Repeated takes — the first try is cut, the last one stays' },
      { am: 'እ…፣ ኧ…፣ እም… ድምፆች ይቆረጣሉ፤ እንግዲህ/ያው እርስዎ ከመረጡ ብቻ', en: 'እ…, ኧ…, እም… sounds are cut; እንግዲህ/ያው only if you tick them' },
      { am: 'ዝርዝሩን ያዩታል፣ ማንኛውንም ያስቀራሉ፣ መስመሩን ሲነኩ Premiere እዚያ ይሄዳል', en: 'You see the list, untick anything, click a line and Premiere goes there' },
      { am: 'ዋናው ሴኩዌንስ አይነካም — የሚቆረጠው ቅጂው ነው፤ ካፕሽኖቹ አብረው ይስተካከላሉ', en: 'Your sequence is never touched — a copy is cut; the captions move with it' },
    ],
  },
  '1.16.19': {
    banner: {
      am: 'የካፕሽን ጊዜን በድምፅ ሞገድ ላይ በመጎተት ያስተካክሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'Fix caption timing by dragging on the sound wave — your license stays the same.',
    },
    items: [
      { am: '〰 ካፕሽን ሲያስተካክሉ የቪዲዮዎ ድምፅ ሞገድ ከስሩ ይታያል', en: "〰 Editing a caption shows your video's sound wave right under it" },
      { am: 'አረንጓዴውን ክፍል ጫፎች ይጎትቱ፦ ካፕሽኑ የሚጀምርበትና የሚያልቅበት', en: "Drag the green part's edges: when the caption starts and ends" },
      { am: 'ከጎረቤት ካፕሽኖች ጋር አይደራረብም፤ ↶ ይመልሳል', en: 'It never overlaps the next caption; ↶ undoes it' },
      { am: 'ሞገዱን ይንኩ — Premiere ያንን ቦታ ያሳያል', en: 'Click the wave — Premiere jumps there' },
    ],
  },
  '1.16.16': {
    banner: {
      am: 'ቃላትን ጎልተው እንዲታዩ ያድርጉ (★) — ቁጥሮችና ብር ራሳቸው ይጎላሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'Make words pop (★) — numbers and money pop by themselves — your license stays the same.',
    },
    items: [
      { am: '★ ቃልን ጎልቶ ማሳያ፦ በካፕሽኑ ⋯ ምናሌ ውስጥ', en: '★ Make a word pop: in the ⋯ menu of each caption' },
      { am: 'ቁጥሮች፣ ብርና መቶኛ ራሳቸው ይጎላሉ (በCustomize ማጥፋት ይቻላል)', en: 'Numbers, money and percent pop by themselves (can be turned off in Customize)' },
      { am: 'ጎልቶ የሚታየው ቃል በአጽንኦት ቀለምና ትልቅ ሆኖ ይታያል', en: 'A popped word is bigger, in the accent colour' },
      { am: '🕘 የቅርብ ጊዜ፦ ያስቀመጧቸውን ካፕሽኖች ከፍተው ያስተካክሉ', en: '🕘 Recent: reopen and edit captions you placed' },
    ],
  },
  '1.16.15': {
    banner: {
      am: 'ያስቀመጧቸውን ካፕሽኖች እንደገና ከፍተው ማስተካከል ይችላሉ — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'Reopen and edit captions you placed — your license stays the same.',
    },
    items: [
      { am: '🕘 የቅርብ ጊዜ፦ ያስቀመጧቸውን ካፕሽኖች ከፍተው ያስተካክሉ፣ እንደገና ያስቀምጡ', en: '🕘 Recent: reopen captions you placed, edit them, place them again' },
      { am: 'እንደገና ሲያስቀምጡ የቀድሞውን ይተካል — ሁለት ጊዜ አይደገምም', en: 'Placing again replaces the old captions — no doubles' },
      { am: 'ስታይሉና ቅንብሮቹ አብረው ይመለሳሉ', en: 'The style and its settings come back too' },
      { am: 'የስታይል ቅድመ እይታው በራስዎ ቪዲዮ ላይ ይታያል', en: 'The style preview plays on your own video' },
    ],
  },
  '1.16.14': {
    banner: {
      am: 'የስታይል ቅድመ እይታው በራስዎ ቪዲዮ ላይ ይታያል፤ በMac እና በተቆረጡ ክሊፖች ላይ ያሉ ችግሮች ተስተካክለዋል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'The style preview now plays on your own video; fixes for Mac and cut clips — your license stays the same.',
    },
    items: [
      { am: 'የስታይል ቅድመ እይታው አሁን በራስዎ ቪዲዮ ላይ ይታያል', en: 'The style preview now plays on your own video' },
      { am: 'በMac ላይ ስታይሎቹ በትክክል ይታያሉ', en: 'Caption styles show correctly on Mac' },
      { am: 'የተቆረጡ ክሊፖች፣ nested sequence እና precomp ይሰራሉ', en: 'Cut clips, nested sequences and precomps work' },
      { am: 'አንዱ ክፍል ሌላውን የስታይል ንብርብር አያጠፋም', en: 'Styling one part no longer removes another part' },
    ],
  },
  '1.16.5': {
    banner: {
      am: 'አዲስ ስታይሎች፣ ፎንቶችና አገባቦች ይዞ ይመጣል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'Comes with new styles, fonts and animations — your license stays the same.',
    },
    items: [
      { am: 'አዲስ ስታይሎች፦ Glide · Spotlight · Bounce', en: 'New styles: Glide · Spotlight · Bounce' },
      { am: '4 የካፕሽን ፊደሎች፦ ዘመናዊ · ክብ · ክላሲክ · ባህላዊ', en: '4 caption fonts: Modern · Rounded · Classic · Traditional' },
      { am: '8 አገባቦች፦ Fade · Slide · Pop · Zoom · Blur …', en: '8 animations: Fade · Slide · Pop · Zoom · Blur …' },
      { am: '«የኔ ስታይል» — የራስዎን ገጽታ አስቀምጠው በአንድ ንክኪ ይጠቀሙ', en: 'My styles — save your own look and reuse it in one tap' },
      { am: 'ትንሽና ፈጣን ቅድመ እይታ — የካፕሽን ስላይስ ብቻ', en: 'A smaller, faster preview — just the caption strip' },
    ],
  },
  '1.16.6': {
    banner: {
      am: 'የደንበኛ ቃላት መዝገብ ተጨምሯል — ፈቃድዎ እንደቀድሞው ይቀጥላል።',
      en: 'Adds a per-client word list — your license stays the same.',
    },
    items: [
      { am: '👤 የደንበኛ ቃላት፦ የአንድ ደንበኛ ስሞችና ቃላት አስተምረው፣ በዚያ ደንበኛ ቪዲዮዎች ውስጥ ብቻ በራሳቸው ይታረማሉ (የማሽኑ ማስታወሻ አይቀየርም)', en: '👤 Client words: teach one client’s names and terms — fixed only in that client’s videos (your 🧠 memory stays as it is)' },
      { am: 'በዚህ ኮምፒውተር ላይ ብቻ ይቀመጣል — ወደ ኢንተርኔት አይላክም', en: 'Kept on this computer only — nothing is uploaded' },
      { am: 'የደንበኛውን ዝርዝር አውጥተው (.txt / .json) ለተባባሪዎ ማስተላለፍ ይችላሉ', en: 'Export a client’s list (.txt / .json) to share it with a colleague' },
      { am: 'ወደ ሌላ ደንበኛ ሲቀይሩ የቀድሞው ቃላት በራሳቸው ይወጣሉ — አንድ ↩ Undo ብቻ', en: 'Changing client takes the old client’s words back out — one ↩ Undo' },
    ],
  },
};
const WHATSNEW_KEY = 'amh.whatsnew.seen';          // version whose news was shown
// "Try it" before the review exists: said inside the card for a few seconds
// (and in the log, which keeps it). Amharic first, then English.
const WN_TRY_HINT = {
  am: 'Generate ይጫኑ፣ ከዚያ ስታይል ይምረጡ',
  en: 'Press Generate, then choose a style',
};
const WN_HINT_MS = 6000;                           // read it, then the card goes

// ── Update-available notice ──────────────────────────────────────────────────
// Asks our Worker (GET /api/latest, one cached GitHub lookup for everyone) at
// most once a day and remembers the answer, so the banner survives restarts
// and offline days. ✕ snoozes it for 3 days for that version only; a newer
// release shows again at once. The button only ever opens our own website —
// an owner who updates lands on its download section, not on the new-user
// install steps (the footer's "Check for updates" forces a lookup).
const UPDATE_LATEST_KEY = 'amh.update.latest';     // {version, url}
const UPDATE_CHECKED_KEY = 'amh.update.checked';   // epoch ms of last lookup
const UPDATE_SNOOZE_KEY = 'amh.update.snooze';     // {version, until}
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const UPDATE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const UPDATE_SITE = 'https://amharic-caption-pro.vercel.app/';
const UPDATE_PAGE = UPDATE_SITE + 'install/#download';

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

// The one short line the banner shows: what an update brings. It comes from the
// newest entry in WHATS_NEW (see the note above the list); null when the list is
// empty, and then the banner says the version only.
function newestWhatsNewBanner() {
  let best = null;
  Object.keys(WHATS_NEW).forEach((v) => { if (!best || versionNewer(v, best)) best = v; });
  return best ? WHATS_NEW[best].banner : null;
}
function wnText(pair) {          // the panel language (Amharic by default)
  return (typeof i18nGetLang === 'function' && i18nGetLang() === 'am') ? pair.am : pair.en;
}

function renderUpdateBanner() {
  const banner = document.getElementById('updateBanner');
  if (!banner) return;
  const latest = readJson(UPDATE_LATEST_KEY);
  const snooze = readJson(UPDATE_SNOOZE_KEY);
  const newer = !!(latest && /^\d+\.\d+\.\d+$/.test(latest.version) &&
    versionNewer(latest.version, APP_VERSION) &&
    !(snooze && snooze.version === latest.version && Date.now() < snooze.until));
  banner.style.display = newer ? 'flex' : 'none';
  const txt = document.getElementById('updateText');
  if (txt && newer) {
    const news = newestWhatsNewBanner();
    txt.textContent = L('Version ' + latest.version + ' is available.') +
      (news ? ' ' + wnText(news) : '');
  }
  const go = document.getElementById('updateGo');
  if (go) go.style.display = newer ? '' : 'none';   // nothing to open when up to date
}

// `force` = the footer's "Check for updates": ignore the once-a-day memory.
// Returns true when the server answered during this call.
async function checkForUpdate(force) {
  let last = 0;
  try { last = Number(localStorage.getItem(UPDATE_CHECKED_KEY)) || 0; } catch (e) {}
  const now = Date.now();
  let fresh = false;
  if (force || !(last && now - last < UPDATE_EVERY_MS && now >= last)) {
    const data = await apiGet('/api/latest', 5000);
    if (data && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(data.version || ''))) {
      fresh = true;
      const url = (typeof data.url === 'string' && data.url.indexOf(UPDATE_SITE) === 0)
        ? data.url : UPDATE_PAGE;
      try {
        localStorage.setItem(UPDATE_LATEST_KEY, JSON.stringify({ version: data.version, url }));
        localStorage.setItem(UPDATE_CHECKED_KEY, String(now));
      } catch (e) {}
    }
    // Offline / server error: nothing stored, so the next panel open retries.
  }
  renderUpdateBanner();
  return fresh;
}

// "Check for updates" in the footer (it is otherwise at most once a day by
// itself): answer straight away, in the place the user pressed. The label goes
// back to normal after a few seconds.
async function onUpdateCheck() {
  const el = document.getElementById('updateCheck');
  const label = L('↻ Check for updates');
  const say = (msg) => { if (el) el.textContent = L(msg); };
  say('Checking…');
  const fresh = await checkForUpdate(true);
  const latest = readJson(UPDATE_LATEST_KEY);
  if (!fresh) say('Could not check — no internet.');
  else if (latest && versionNewer(latest.version, APP_VERSION)) say('Version ' + latest.version + ' is available.');
  else say('You are up to date (v' + APP_VERSION + ').');
  setTimeout(() => { if (el) el.textContent = label; }, 8000);
}

// Where "Download" goes: the website's download section (#download on the
// install page), never the new-user install steps. A url from the Worker wins
// when it is ours; an answer stored by an older panel ("…/install/") goes to
// the downloads as well.
function updateUrl() {
  const latest = readJson(UPDATE_LATEST_KEY);
  const raw = (latest && typeof latest.url === 'string' && latest.url.indexOf(UPDATE_SITE) === 0)
    ? latest.url : UPDATE_PAGE;
  if (raw.indexOf('#') >= 0) return raw;
  const base = raw.replace(/\/+$/, '');
  if (base === UPDATE_SITE.replace(/\/+$/, '')) return UPDATE_PAGE;   // the site root
  return /\/install$/.test(base) ? base + '/#download' : raw;
}
function openDownloadPage() {
  const url = updateUrl();
  try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
  catch (err) { window.open(url, '_blank'); }
}

// Footer "⋯" (1.30): Check for updates · About · Terms, shown only while
// used. About / Terms close it; Check for updates keeps it open so its answer
// is seen. A click anywhere else closes it.
function initFootMenu() {
  const box = document.getElementById('footMore');
  const btn = document.getElementById('footMoreBtn');
  if (!box || !btn) return;
  const setOpen = (on) => {
    box.classList.toggle('open', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => { e.preventDefault(); setOpen(!box.classList.contains('open')); });
  ['credits', 'legalLink'].forEach((id) => {
    const a = document.getElementById(id);
    if (a) a.addEventListener('click', () => setOpen(false));
  });
  document.addEventListener('click', (e) => {
    if (box.classList.contains('open') && !(box.contains && box.contains(e.target))) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
}

function initUpdateBanner() {
  const go = document.getElementById('updateGo');
  const later = document.getElementById('updateLater');
  const check = document.getElementById('updateCheck');
  if (go) go.addEventListener('click', (e) => { e.preventDefault(); openDownloadPage(); });
  if (check) check.addEventListener('click', (e) => { e.preventDefault(); onUpdateCheck(); });
  initFootMenu();
  const recent = document.getElementById('recentLink');
  if (recent) {
    if (IS_APP_MODE()) recent.style.display = 'none';    // Premiere / After Effects only
    else recent.addEventListener('click', (e) => { e.preventDefault(); toggleRecent(); });
  }
  const recentClose = document.getElementById('recentClose');
  if (recentClose) recentClose.addEventListener('click', (e) => { e.preventDefault(); hideRecent(); });
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

// ── What's new card ─────────────────────────────────────────────────────────
// Shown once, on the first open after a version change (see WHATS_NEW above).
// A first install never sees it: onboarding is the first-run story, so that
// path just remembers the version silently. ✕ and "Try it" both hide it for
// this version — "the card hides after use".
function seenWhatsNew() {
  try { return localStorage.getItem(WHATSNEW_KEY) || ''; } catch (e) { return ''; }
}
function markWhatsNewSeen(version) {
  try { localStorage.setItem(WHATSNEW_KEY, String(version)); } catch (e) {}
}
function renderWhatsNew() {
  const card = document.getElementById('whatsNew');
  if (!card) return;
  const nv = newsVersion();
  const entry = nv ? WHATS_NEW[nv] : null;
  const seen = seenWhatsNew();
  const show = !!entry && !needsOnboarding() && (!seen || versionNewer(nv, seen));
  card.style.display = show ? 'block' : 'none';
  if (!show) return;
  // Fresh card: no leftover hint, "Try it" pressable again (a language change
  // re-renders this while the card is up).
  const hint = document.getElementById('wnHint');
  if (hint) { hint.textContent = ''; hint.style.display = 'none'; }
  const tryBtn = document.getElementById('wnTry');
  if (tryBtn) tryBtn.style.display = '';
  const title = document.getElementById('wnTitle');
  if (title) title.textContent = L("What's new in " + APP_VERSION);
  const list = document.getElementById('wnList');
  if (list) {
    list.textContent = '';
    entry.items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = wnText(item);
      list.appendChild(li);
    });
  }
}
// The newest news this panel has (a fix release needs no entry of its own, and
// someone who skipped versions still sees the last news once) (1.16.7).
function newsVersion() {
  let best = '';
  Object.keys(WHATS_NEW).forEach((v) => {
    if (!versionNewer(v, APP_VERSION) && (!best || versionNewer(v, best))) best = v;
  });
  return best;
}
function hideWhatsNew() {
  markWhatsNewSeen(APP_VERSION);
  const card = document.getElementById('whatsNew');
  if (card) card.style.display = 'none';
}
// "Try it": the new styles, fonts and animations live in the review's style
// strip. With the review open, go there and let the card go at once. Before
// that, the card itself says what to do first (hint + log), then hides.
function whatsNewTry() {
  const strip = document.getElementById('styleStrip');
  const review = document.getElementById('review');
  const reviewOpen = !!(review && review.classList.contains('show'));
  if (reviewOpen && strip && strip.style.display !== 'none') {
    hideWhatsNew();
    try { strip.scrollIntoView({ block: 'center' }); } catch (e) { strip.scrollIntoView(); }
    log('Pick a style — the preview updates as you tap one.');
    return;
  }
  const hint = document.getElementById('wnHint');
  if (!hint) { hideWhatsNew(); return; }        // nowhere to say it: just close
  hint.textContent = wnText(WN_TRY_HINT);
  hint.style.display = 'block';
  const tryBtn = document.getElementById('wnTry');
  if (tryBtn) tryBtn.style.display = 'none';    // one press is enough
  const opts = document.getElementById('capSeg');
  if (opts) { try { opts.scrollIntoView({ block: 'center' }); } catch (e) {} }
  log('Styles, fonts and animations appear in the review after you press');
  log('Generate. Choose a style there, then press Customize.');
  setTimeout(hideWhatsNew, WN_HINT_MS);
}
function initWhatsNew() {
  const card = document.getElementById('whatsNew');
  if (!card) return;
  const close = document.getElementById('wnClose');
  const tryBtn = document.getElementById('wnTry');
  if (close) close.addEventListener('click', hideWhatsNew);
  if (tryBtn) tryBtn.addEventListener('click', whatsNewTry);
  if (typeof i18nOnChange === 'function') i18nOnChange(renderWhatsNew);
  if (needsOnboarding()) markWhatsNewSeen(APP_VERSION);   // first install: never "new"
  renderWhatsNew();
}

// Dark only (1.10.18): no light theme, whatever the host's brightness.
document.documentElement.setAttribute('data-theme', 'dark');

// ── Editing shortcuts stay in the panel ──────────────────────────────────────
// Unless a CEP panel registers interest, the host app takes Ctrl/Cmd + C, V,
// X, A, Z, Y even while the panel's text box has focus. In After Effects,
// copying a caption word or the Machine ID ran AE's own Copy and showed "After
// Effects must have keyframes selected in order to export them as text"; in
// Premiere, Ctrl+Z in the review box could undo the timeline instead.
// Key codes are the OS virtual-key codes (Windows VK_*, macOS kVK_ANSI_*).
const SHORTCUT_MOD = (typeof process !== 'undefined' && process.platform === 'darwin') ? '⌘' : 'Ctrl+';
const PANEL_SHORTCUT_KEYS = (() => {
  const mac = (typeof process !== 'undefined' && process.platform === 'darwin');
  const codes = mac ? { a: 0, z: 6, x: 7, c: 8, v: 9, y: 16, b: 11, d: 2, down: 125, up: 126 }
                    : { a: 65, c: 67, v: 86, x: 88, y: 89, z: 90, b: 66, d: 68, down: 40, up: 38 };
  const mod = mac ? 'metaKey' : 'ctrlKey';
  const list = [];
  Object.keys(codes).forEach((k) => {
    list.push({ keyCode: codes[k], [mod]: true });
    // Shift only for the editing keys (redo = Shift+Z); B / D / arrows (1.16.25:
    // ★, ✂, next/previous caption) leave Shift+ to Premiere
    if (k.length === 1 && 'acvxyz'.indexOf(k) >= 0) list.push({ keyCode: codes[k], [mod]: true, shiftKey: true });
  });
  // Amharic typing on / off (1.26.0): Ctrl+Space, on a Mac ⌘⇧Space (⌃Space and ⌘Space belong to macOS)
  list.push(mac ? { keyCode: 49, metaKey: true, shiftKey: true } : { keyCode: 32, ctrlKey: true });
  return list;
})();
try {
  if (window.__adobe_cep__ && window.__adobe_cep__.registerKeyEventsInterest) {
    window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(PANEL_SHORTCUT_KEYS));
  }
} catch (e) {}

// ── Amharic typing with Latin letters (1.26.0) ──────────────────────────────
// In the fields marked data-amh-type (caption text, fixes, Studio titles…)
// Latin keys write Amharic as you type (selam → ሰላም; core.js amhType). A
// small አ badge on the field shows it is on: click it — or Ctrl+Space (Mac
// ⌘⇧Space) — to type English. Real Amharic keyboards are not touched (their
// keys are not Latin letters). Typing goes through insertText, so Ctrl+Z
// still undoes it.
const AMH_TYPE_MAC = (typeof process !== 'undefined' && process.platform === 'darwin');
const AMH_TYPE_KEY = AMH_TYPE_MAC ? '⌘⇧Space' : 'Ctrl+Space';
let AMH_TYPE_ON = true;
try { AMH_TYPE_ON = localStorage.getItem('amh.type') !== '0'; } catch (e) {}
const amhTypeRun = { el: null, end: -1, n: 0 };
let amhTypeBadge = null;
let amhTypeBadgeFor = null;
const AMH_TYPE_TIPS = 'selam → ሰላም · biet → ቤት · tEwodros → ቴዎድሮስ · shi → ሺ · nya → ኛ · gwada → ጓዳ\n' +
  'T → ጥ · C → ጭ · P → ጵ · S → ጽ · H → ሕ · ^s → ሥ · ^h → ኅ · ^S → ፅ · `a → ዓ\n' +
  ':: → ።   ,, → ፣   ;; → ፤   :- → ፦';
function amhTypeField(el) { return !!el && !!el.matches && el.matches('textarea[data-amh-type], input[data-amh-type]'); }
function amhTypeSet(on) {
  AMH_TYPE_ON = !!on;
  try { localStorage.setItem('amh.type', AMH_TYPE_ON ? '1' : '0'); } catch (e) {}
  amhTypeRun.el = null;
  amhTypeBadgeShow(document.activeElement);
}
function amhTypeBadgeShow(el) {
  amhTypeBadgeFor = amhTypeField(el) ? el : null;
  if (!amhTypeField(el)) { if (amhTypeBadge) amhTypeBadge.style.display = 'none'; return; }
  if (!amhTypeBadge) {
    amhTypeBadge = document.createElement('button');
    amhTypeBadge.type = 'button';
    amhTypeBadge.className = 'amh-type-badge';
    amhTypeBadge.tabIndex = -1;
    // mousedown, not click: the caret stays in the field
    amhTypeBadge.addEventListener('mousedown', (e) => { e.preventDefault(); amhTypeSet(!AMH_TYPE_ON); });
    document.body.appendChild(amhTypeBadge);
  }
  amhTypeBadge.textContent = AMH_TYPE_ON ? 'አ' : 'A';
  amhTypeBadge.classList.toggle('off', !AMH_TYPE_ON);
  amhTypeBadge.title = (AMH_TYPE_ON
    ? L('Amharic typing: Latin letters write Amharic (selam → ሰላም).') + ' ' + L('For English:') + ' ' + AMH_TYPE_KEY
    : L('English typing.') + ' ' + L('For Amharic:') + ' ' + AMH_TYPE_KEY) + '\n\n' + AMH_TYPE_TIPS;
  const r = el.getBoundingClientRect();
  if (!r.width) { amhTypeBadge.style.display = 'none'; return; }
  amhTypeBadge.style.display = '';
  amhTypeBadge.style.left = Math.round(r.right - 21) + 'px';
  amhTypeBadge.style.top = Math.round(r.top + 3) + 'px';
}
document.addEventListener('focusin', (e) => amhTypeBadgeShow(e.target));
// focus events can be missed (a window without focus): a click or key in the field shows it too
document.addEventListener('mouseup', (e) => { if (amhTypeField(e.target) && amhTypeBadgeFor !== e.target) amhTypeBadgeShow(e.target); });
document.addEventListener('focusout', () => setTimeout(() => amhTypeBadgeShow(document.activeElement), 0));
window.addEventListener('scroll', () => { if (amhTypeBadge && amhTypeBadge.style.display !== 'none') amhTypeBadgeShow(document.activeElement); }, true);
window.addEventListener('resize', () => amhTypeBadgeShow(document.activeElement));
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!amhTypeField(el)) return;
  if (amhTypeBadgeFor !== el) amhTypeBadgeShow(el);
  const toggle = AMH_TYPE_MAC ? (e.metaKey && e.shiftKey && e.code === 'Space') : (e.ctrlKey && !e.shiftKey && e.code === 'Space');
  if (toggle) { e.preventDefault(); amhTypeSet(!AMH_TYPE_ON); return; }
  if (!AMH_TYPE_ON || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !e.key || e.key.length !== 1) return;
  const a = el.selectionStart, b = el.selectionEnd;
  if (a == null) return;
  const chained = (amhTypeRun.el === el && amhTypeRun.end === a && a === b) ? amhTypeRun.n : 0;
  const r = amhType(el.value.slice(0, a), e.key, chained);
  if (!r) { amhTypeRun.el = null; return; }
  e.preventDefault();
  const del = Math.min(r.del, a);
  el.setSelectionRange(a - del, b);
  let ok = false;
  try { ok = document.execCommand('insertText', false, r.ins); } catch (x) { ok = false; }
  if (!ok || el.value.slice(el.selectionStart - r.ins.length, el.selectionStart) !== r.ins) {
    el.setRangeText(r.ins, a - del, b, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  amhTypeRun.el = el; amhTypeRun.end = el.selectionStart;
  amhTypeRun.n = Math.min(3, Math.max(0, chained - del) + r.ins.length);
}, true);

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
    const features = !!RUNTIME && (isDegradedRuntime(RUNTIME) || ['amh_lm.py', 'amh_lm.json.gz', 'amh_vad.py', 'silero_vad.onnx']
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
      const msg = encodeURIComponent('ሰላም! በአማርኛ ካፕሽን ፕሮ ላይ እገዛ እፈልጋለሁ።\nMachine ID: ' + MACHINE_ID);
      const url = 'https://t.me/sumpak6?text=' + msg;
      try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
      catch (err) { window.open(url, '_blank'); }
    });
  }
}

// ── simple buying: Buy → pay in Telegram → this panel activates itself ──────
// The Buy button opens the bot with a /start link carrying this Machine ID and
// a random secret (nonce) kept here. Telegram keeps a /start link through the
// START tap — the old pre-typed message was dropped for first-time users, who
// then had to copy a 16-character id by hand. After the payment is approved
// the panel asks /api/license with that secret and activates by itself.
const PENDING_BUY_KEY = 'amh.pendingBuy';
const PENDING_BUY_DAYS = 14;
const BUY_POLL_MS = 30000;
let BUY_POLL = null;

function getPendingBuy() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_BUY_KEY) || 'null');
    if (p && /^[A-Za-z0-9]{12,32}$/.test(String(p.nonce)) && p.mid === MACHINE_ID &&
        Date.now() - Number(p.at || 0) < PENDING_BUY_DAYS * 86400000) return p;
  } catch (e) { /* unreadable: treat as none */ }
  return null;
}
function setPendingBuy(p) {
  try {
    if (p) localStorage.setItem(PENDING_BUY_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_BUY_KEY);
  } catch (e) { /* storage blocked: the key still arrives in Telegram */ }
}
function newBuyNonce() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (x) => abc[x % abc.length]).join('');
}
function showBuyPending(text, color) {
  const el = document.getElementById('buyPending');
  if (!el) return;
  el.style.display = text ? '' : 'none';
  el.textContent = text ? L(text) : '';
  el.style.color = color || '';
}
function stopBuyPoll() {
  if (BUY_POLL) { clearInterval(BUY_POLL); BUY_POLL = null; }
}
async function checkPendingBuy() {
  const p = getPendingBuy();
  if (LICENSED) { setPendingBuy(null); stopBuyPoll(); showBuyPending(''); return; }
  if (!p) { stopBuyPoll(); showBuyPending(''); return; }
  const r = await apiPost('/api/license', { mid: MACHINE_ID, nonce: p.nonce });
  if (!r) return;   // offline or busy: the next tick tries again
  if (r.status === 'approved' && r.key) {
    stopBuyPoll();
    showBuyPending('✓ Payment confirmed — activating…', 'var(--ok)');
    const input = document.getElementById('licenseInput');
    if (input) input.value = r.key;
    await activateLicense();
    if (LICENSED) { setPendingBuy(null); showBuyPending(''); }
    return;
  }
  if (r.status === 'pending') {
    showBuyPending('⏳ Payment received — waiting for confirmation. This panel activates itself.', 'var(--text-secondary)');
  } else if (r.status === 'rejected') {
    hideBuyQr();
    showBuyPending('⚠️ The payment could not be confirmed — see the bot’s message in Telegram.', 'var(--err)');
  } else if (r.status === 'revoked') {
    showBuyPending('License revoked — contact @sumpak6 on Telegram', 'var(--err)');
  } else {
    showBuyPending('After paying, send the screenshot to the bot in Telegram — this panel then activates itself.', 'var(--text-secondary)');
  }
}
// The bot link of a purchase: it carries this computer and the purchase's
// secret, so the computer activates itself once the payment is confirmed —
// whichever device opens it.
function buyUrl(p) { return 'https://t.me/AmharicCaptionsBot?start=m_' + MACHINE_ID + '_' + p.nonce; }
function openUrl(url) {
  try { if (window.__adobe_cep__) { window.cep.util.openURLInDefaultBrowser(url); return; } } catch (err) {}
  try { window.open(url, '_blank'); } catch (err) {}
}
// The QR code (qrcode.js, MIT): error correction M, auto size, black on white
// with the 4-module quiet zone phones need. No QR library -> straight to
// Telegram on this computer, as before.
function buyQrSvg(url) {
  if (typeof qrcode !== 'function') return '';
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: 'QR' });
}
function showBuyQr(url) {
  const card = document.getElementById('buyQrCard');
  const box = document.getElementById('buyQr');
  const svg = buyQrSvg(url);
  if (!card || !box || !svg) { openUrl(url); return; }
  box.innerHTML = svg;
  box.dataset.url = url;
  card.classList.add('show');
}
function hideBuyQr() {
  const card = document.getElementById('buyQrCard');
  if (card) card.classList.remove('show');
}
function startBuyPoll() {
  if (!BUY_POLL) BUY_POLL = setInterval(checkPendingBuy, BUY_POLL_MS);
  checkPendingBuy();
}

function initBuy() {
  initFeedback();
  initReport();
  initTrialCard();
  initFreeMinutes();
  const b = document.getElementById('buyBtn');
  if (b) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      track('buy_click');
      // Reuse the secret of an unfinished purchase so a second tap never
      // orphans the order that is already waiting.
      let p = getPendingBuy();
      if (!p) p = { nonce: newBuyNonce(), mid: MACHINE_ID };
      p.at = Date.now();
      setPendingBuy(p);
      // 1.41: buy on the PHONE — the bank app, the screenshot and Telegram
      // are all there; this computer still unlocks itself (the same link).
      showBuyQr(buyUrl(p));
      startBuyPoll();
    });
  }
  const pc = document.getElementById('buyQrPc');
  if (pc) pc.addEventListener('click', () => { const p = getPendingBuy(); if (p) openUrl(buyUrl(p)); hideBuyQr(); });
  const close = document.getElementById('buyQrClose');
  if (close) close.addEventListener('click', hideBuyQr);
  // A purchase started earlier (the panel was closed meanwhile): keep checking.
  if (getPendingBuy()) startBuyPoll();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => { if (getPendingBuy() && !LICENSED) checkPendingBuy(); });
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
// A key that ends on YYYYMMDD works until the day before.
function lastLicenseDay(exp) {
  const d = new Date(Date.UTC(+exp.slice(0, 4), +exp.slice(4, 6) - 1, +exp.slice(6, 8)) - 86400000);
  return d.toISOString().slice(0, 10);
}

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
    // A 1- or 2-month plan (1.10.12): show the last day it works.
    LICENSE_NOTE = (v.expiry && /^\d{8}$/.test(v.expiry) && v.expiry !== '00000000')
      ? 'Licensed until ' + lastLicenseDay(v.expiry) : 'Licensed';
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
  const result = await apiPost('/api/validate', { mid: MACHINE_ID, key: stored.key, hf: hostFingerprint() || undefined });
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

// ── Free trial: free MINUTES from the Telegram bot (1.10.7) ─────────────────
// An unlicensed computer gets N free minutes of audio (the live owner setting;
// 20 is only the fallback until the server answers) from
// our Telegram bot: the free-minutes box asks /api/trial/request for a
// one-time link, the person presses START in the bot, and this panel notices
// by itself. Each free job is charged in seconds when the engine starts; the
// engine's ticket says how many seconds of this job the free minutes cover
// (the rest of a longer video needs a license). The server decides
// everything; no server, no free caption (a license works offline).
let TRIAL_MIN = null;        // { status, seconds_left, seconds_total, minutes }
let TRIAL_WAIT = 0;          // when the bot link was opened (waiting for START)
let TRIAL_POLL = null;
let TRIAL_CHARGED_RUN = null; // run id of a charged free job (refund if it fails)
let TRIAL_CUT = null;         // seconds the free minutes covered, when less than the job
function trialRemaining() {
  return TRIAL_MIN && TRIAL_MIN.status === 'active' ? Math.max(0, TRIAL_MIN.seconds_left || 0) : 0;
}
// The live number comes from the server (owner setting); 20 is ONLY the
// fallback until the first answer, never a promise shown to a customer.
function trialMinutes() { return (TRIAL_MIN && TRIAL_MIN.minutes) || 20; }
function fmtMinSec(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function setTrialState(data) {
  if (!data || data.mode !== 'minutes') return;
  TRIAL_MIN = {
    status: data.status, minutes: data.minutes || 20,
    seconds_left: data.seconds_left || 0, seconds_total: data.seconds_total || 0,
    expires: /^\d{4}-\d{2}-\d{2}$/.test(String(data.expires || '')) ? data.expires : '',
  };
}
// Free captions are counted per computer too: the fingerprint goes along.
function trialHostParam() {
  const hf = hostFingerprint();
  return hf ? '&hf=' + encodeURIComponent(hf) : '';
}

let trialSyncPromise = null;
async function refreshTrialFromServer() {
  if (LICENSED) return trialRemaining();
  if (trialSyncPromise) return trialSyncPromise;
  trialSyncPromise = (async () => {
    try {
      const data = await apiGet('/api/trial?v=2&mid=' + encodeURIComponent(MACHINE_ID) + trialHostParam(), TRIAL_SYNC_TIMEOUT_MS);
      if (data && data.mode === 'minutes') {
        setTrialState(data);
        updateLicenseUI();
      }
    } catch (e) {}
    return trialRemaining();
  })();
  try {
    return await trialSyncPromise;
  } finally {
    trialSyncPromise = null;
  }
}
// Generate pressed without free minutes (1.10.16). 12 of 21 people who
// pressed Generate in two days stopped here: the old answer was one line in
// the Log. Now a card under Generate says exactly what to do, with one big
// button, and the job that was asked for starts by itself when the free
// minutes arrive.
let TRIAL_GATE = null;       // null | 'none' | 'pending' | 'offline'
let GATE_RESUME = null;      // the run to start when the minutes arrive
function showTrialGate(kind, resume) {
  TRIAL_GATE = kind;
  if (resume) GATE_RESUME = resume;
  renderTrialGate();
  renderFreeMinBox();
  const g = document.getElementById('trialGate');
  if (g && typeof g.scrollIntoView === 'function') { try { g.scrollIntoView({ block: 'center' }); } catch (e) {} }
}
function hideTrialGate() {
  TRIAL_GATE = null;
  GATE_RESUME = null;
  renderTrialGate();
  renderFreeMinBox();
}
function renderTrialGate() {
  const g = document.getElementById('trialGate');
  if (!g) return;
  const kind = LICENSED ? null : TRIAL_GATE;
  g.style.display = kind ? '' : 'none';
  if (!kind) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text ? L(text) : ''; };
  const mins = trialMinutes();
  const body = document.getElementById('trialGateBody');
  const btn = document.getElementById('trialGateBtn');
  const wait = document.getElementById('trialGateWait');
  if (body) body.textContent = '';
  const lines = (arr) => {
    if (!body) return;
    const ol = document.createElement('ol');
    for (const t of arr) { const li = document.createElement('li'); li.textContent = L(t); ol.appendChild(li); }
    body.appendChild(ol);
  };
  if (kind === 'none') {
    set('trialGateTitle', '🎁 First, get your ' + mins + ' free minutes');
    lines(['Tap the button below — our Telegram bot opens.',
           'Press START in Telegram.',
           'Come back here — your captions start by themselves.']);
    if (btn) { btn.style.display = ''; btn.textContent = L('🎁 Get ' + mins + ' free minutes — 1 tap'); }
    const msg = TRIAL_WAIT ? 'Waiting for Telegram… press START there. Your captions start by themselves.' : '';
    if (wait) { wait.textContent = msg ? L(msg) : ''; wait.style.display = msg ? '' : 'none'; }
    set('trialGateKey', 'Free, no payment. Already have a license key? Enter it below.');
  } else if (kind === 'pending') {
    set('trialGateTitle', '⏳ Your free minutes are being checked');
    lines(['We check a few requests by hand. You will get a message in Telegram.',
           'Then press Generate again.']);
    if (btn) btn.style.display = 'none';
    if (wait) wait.style.display = 'none';
    set('trialGateKey', 'Already have a license key? Enter it below.');
  } else {
    set('trialGateTitle', '📶 Cannot reach our server');
    lines(['The free minutes need the internet (a license works offline).',
           'Check the internet, then tap Try again.']);
    if (btn) { btn.style.display = ''; btn.textContent = L('↻ Try again'); }
    if (wait) wait.style.display = 'none';
    set('trialGateKey', 'Already have a license key? Enter it below.');
  }
}
async function onTrialGateButton() {
  if (TRIAL_GATE === 'offline') {
    const resume = GATE_RESUME;
    hideTrialGate();
    if (resume) resume();
    return;
  }
  await startFreeMinutes();
  renderTrialGate();
}
// The minutes are here: close the card and start the job that was asked for.
function resumeAfterTrial() {
  const resume = GATE_RESUME;
  const was = TRIAL_GATE;
  hideTrialGate();
  if (was && resume && !LICENSED && trialRemaining() > 0 && !runInProgress && !runStartInProgress) {
    log('✓ Free minutes received — starting your captions.');
    resume();
  }
}

// Shared license/trial gate for EVERY transcription entry point (run() and
// runFile()): licensed, or free minutes left. Otherwise say what to do.
function assertCanRun(resume) {
  if (LICENSED || trialRemaining() > 0) { hideTrialGate(); return true; }
  track('blocked_trial');
  const st = TRIAL_MIN ? TRIAL_MIN.status : null;
  if (st === 'none') showTrialGate('none', resume);
  else if (st === 'pending') showTrialGate('pending', null);
  else if (!st) showTrialGate('offline', resume);
  if (!st) {
    log('Connect to the internet for the free trial (a license works offline).');
  } else if (st === 'none') {
    log('Get your ' + trialMinutes() + ' free minutes in Telegram first — the button under Generate.');
  } else if (st === 'pending') {
    log('Your free-minutes request is being checked — we will tell you in Telegram.');
  } else if (st === 'expired') {
    log('Your free week has ended.');
    log('Buy a license (below) to keep making captions.');
  } else {
    log('Your free minutes are used up.');
    log('Buy a license (below) to keep making captions.');
  }
  return false;
}
function newRunId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) {}
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

// Charge free minutes for one job of `seconds` of audio. The answer carries
// the engine's ticket and how many seconds it allows (≤ asked, ≤ left).
async function consumeTrialCredit(runId, seconds) {
  if (LICENSED) return { allowed: true, licensed: true };
  const chargeRunId = runId || activeRunId || newRunId();
  const body = {
    mid: MACHINE_ID, run_id: chargeRunId, hf: hostFingerprint() || undefined,
    seconds: Math.max(1, Math.ceil(Number(seconds) || 1)),
  };
  let r = await apiPost('/api/trial/use', body);
  if (r && r.pending) {
    // The same run is still being booked by an earlier request: ask once more.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    r = await apiPost('/api/trial/use', body);
  }
  if (!r || r.mode !== 'minutes') return { allowed: false, charged: false, offline: !r };
  setTrialState(r);
  if (r.charged) {
    log('Free trial: ' + fmtMinSec(r.seconds) + ' of free minutes for this job, ' + fmtMinSec(r.seconds_left) + ' left.');
  }
  return {
    allowed: !!r.charged, charged: !!r.charged, ticket: r.ticket, seconds: r.seconds,
    remaining: r.seconds_left, run: chargeRunId, reason: r.reason,
  };
}
// A free job that failed or was cancelled gives its minutes back (the server
// allows this twice per trial).
async function refundTrialRun() {
  const run = TRIAL_CHARGED_RUN;
  TRIAL_CHARGED_RUN = null;
  if (!run || LICENSED) return;
  const r = await apiPost('/api/trial/refund', { mid: MACHINE_ID, run_id: run });
  if (r && r.mode === 'minutes') {
    setTrialState(r);
    if (r.refunded) log('The free minutes of the stopped job were given back.');
    updateLicenseUI();
  }
}
// Seconds of audio in a 16 kHz mono 16-bit WAV (what extractToWav writes).
function wavSeconds(p) {
  try { return Math.max(1, (fs.statSync(p).size - 44) / 32000); } catch (e) { return 1; }
}

// The free-minutes box → the bot. The panel then checks every few seconds
// (and when it gets focus back) until the minutes are there.
function openExternal(url) {
  try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
  catch (err) { window.open(url, '_blank'); }
}
async function startFreeMinutes() {
  track('trial_link');
  const status = document.getElementById('freeMinWait');
  const r = await apiPost('/api/trial/request', { mid: MACHINE_ID, hf: hostFingerprint() || undefined });
  if (!r || r.mode !== 'minutes') {
    if (status) { status.textContent = L('Cannot reach the server — check the internet and try again.'); status.style.display = ''; }
    return;
  }
  setTrialState(r);
  if (r.link) {
    openExternal(r.link);
    TRIAL_WAIT = Date.now();
    startTrialPoll();
  }
  updateLicenseUI();
}
function startTrialPoll() {
  if (TRIAL_POLL) return;
  TRIAL_POLL = setInterval(async () => {
    if (LICENSED || !TRIAL_WAIT || Date.now() - TRIAL_WAIT > 15 * 60 * 1000) {
      clearInterval(TRIAL_POLL); TRIAL_POLL = null; TRIAL_WAIT = 0; updateLicenseUI();
      return;
    }
    await refreshTrialFromServer();
    if (TRIAL_MIN && TRIAL_MIN.status !== 'none') {
      clearInterval(TRIAL_POLL); TRIAL_POLL = null; TRIAL_WAIT = 0;
      updateLicenseUI();
      if (TRIAL_MIN.status === 'active') {
        if (GATE_RESUME) resumeAfterTrial();
        else log('✓ ' + fmtMinSec(TRIAL_MIN.seconds_left) + ' free minutes are ready — press Generate.');
      } else if (TRIAL_GATE) {
        TRIAL_GATE = TRIAL_MIN.status === 'pending' ? 'pending' : null;
        renderTrialGate();
      }
    }
  }, 4000);
}
function renderFreeMinBox() {
  const box = document.getElementById('freeMinBox');
  if (!box) return;
  const st = !LICENSED && TRIAL_MIN ? TRIAL_MIN.status : null;
  box.style.display = (st === 'none' || st === 'pending') && !TRIAL_GATE ? '' : 'none';
  const title = document.getElementById('freeMinTitle');
  if (title) title.textContent = L('Try ' + trialMinutes() + ' minutes free');
  const btn = document.getElementById('freeMinBtn');
  const wait = document.getElementById('freeMinWait');
  if (btn) btn.style.display = st === 'pending' ? 'none' : '';
  if (wait) {
    const msg = st === 'pending' ? 'Your request is being checked — we will tell you in Telegram.'
      : (TRIAL_WAIT ? 'Waiting for Telegram — press START there, then come back. This updates by itself.' : '');
    wait.textContent = msg ? L(msg) : '';
    wait.style.display = msg ? '' : 'none';
  }
}
function initFreeMinutes() {
  const b = document.getElementById('freeMinBtn');
  if (b) b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); startFreeMinutes(); });
  const gb = document.getElementById('trialGateBtn');
  if (gb) gb.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); onTrialGateButton(); });
  const gc = document.getElementById('trialGateClose');
  if (gc) gc.addEventListener('click', () => { hideTrialGate(); updateLicenseUI(); });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => { if (TRIAL_WAIT && !LICENSED) refreshTrialFromServer(); });
  }
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
      licStatus.style.display = /until/.test(LICENSE_NOTE || '') ? '' : 'none';
    }
    if (runBtn) runBtn.disabled = false;
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
    // 1.30: no big thank-you box any more; the footer says "✓ Licensed".
    const licNote = document.getElementById('licensedNote');
    if (licNote) licNote.style.display = 'none';
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
    const st = TRIAL_MIN ? TRIAL_MIN.status : null;
    if (rem > 0) {
      // Free minutes left: Generate works.
      if (banner) banner.style.display = 'none';
      if (licStatus) {
        licStatus.textContent = L('Free trial: ' + fmtMinSec(rem) + ' minutes left') +
          (TRIAL_MIN.expires ? ' · ' + L('until ' + TRIAL_MIN.expires) : '');
        licStatus.style.color = 'var(--warn)';
        licStatus.style.display = '';
      }
      if (runBtn) runBtn.disabled = false;
    } else if (!st || st === 'none' || st === 'pending') {
      // No free minutes yet (or the server not reached): the free-minutes box
      // above says what to do; Generate explains it too.
      if (banner) banner.style.display = 'none';
      if (licStatus) licStatus.style.display = 'none';
      if (runBtn) runBtn.disabled = false;
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
  const footLic = document.getElementById('footLicensed');
  if (footLic) footLic.style.display = LICENSED ? '' : 'none';
  renderTrialGate();
  renderFreeMinBox();
  LICENSED_REFRESH = false;
}

// "k7qd 3mxp" / "K7QD3MXP" / "K7QD-3MXP" → "K7QD-3MXP"; null for anything else
// (a full AMH-… license key is 40+ characters and never matches).
function normActivationCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? c.slice(0, 4) + '-' + c.slice(4) : null;
}

async function activateLicense() {
  const licInput = document.getElementById('licenseInput');
  const licStatus = document.getElementById('licenseStatus');
  if (!licInput) return;

  let key = licInput.value.trim();
  if (!key) {
    if (licStatus) { licStatus.textContent = L('Paste your activation code or license key first'); licStatus.style.color = 'var(--err)'; }
    return;
  }

  // A short activation code (paid from the phone): redeem it once for THIS
  // computer, then activate with the key it returns exactly like a pasted key.
  const code = normActivationCode(key);
  if (code) {
    if (licStatus) { licStatus.textContent = L('Checking your activation code…'); licStatus.style.color = 'var(--text-secondary)'; licStatus.style.display = ''; }
    const red = await apiPost('/api/redeem', { mid: MACHINE_ID, code: code });
    const fail = (m) => { if (licStatus) { licStatus.textContent = L(m); licStatus.style.color = 'var(--err)'; licStatus.style.display = ''; } };
    if (!red) { fail('Cannot reach the license server (or too many tries) — check the internet and try again in a few minutes.'); return; }
    if (!red.ok || !red.key) {
      fail({
        used: 'This activation code was already used on another computer. Contact @sumpak6 on Telegram.',
        revoked: 'License revoked — contact @sumpak6 on Telegram',
        already_licensed: 'This computer already has a license — use your key from “My Key” in the bot.',
      }[red.reason] || 'Activation code not found — check the letters in the bot message.');
      return;
    }
    key = red.key;
    licInput.value = key;
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
    // hf: which computer (user account + home folder, hashed) — lets the
    // server tell a license copied to another PC from an honest buyer whose
    // internet address changes.
    const serverResult = await apiPost('/api/validate', { mid: MACHINE_ID, key: key, hf: hostFingerprint() || undefined });
    if (serverResult && serverResult.valid === false) {
      const reason = serverResult.reason === 'expired'
        ? 'License expired'
        : serverResult.reason === 'revoked'
        ? 'License revoked — contact @sumpak6 on Telegram'
        : serverResult.reason === 'shared'
        ? 'This key is used on other computers — contact @sumpak6 on Telegram'
        : 'Key not recognized — contact @sumpak6 on Telegram';
      if (licStatus) { licStatus.textContent = L(reason); licStatus.style.color = 'var(--err)'; }
      track('activate_fail');
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
      track('activate_ok');
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
    // A stored lease that turned out invalid: show the free-minutes state too.
    if (!LICENSED) refreshTrialFromServer();
  });

  // Free minutes left (best effort — offline the free-minutes box waits).
  const storedLicense = getLicense();
  if (!storedLicense || !storedLicense.token) refreshTrialFromServer();
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

// Released packages ship the license-relevant modules compiled (1.10.4,
// tools/compile_runtime.py): ethio_srt.pyc instead of ethio_srt.py. Python runs
// either directly. The compiled one wins if a stray .py sits next to it.
function engineFileIn(base, name) {
  const pyc = path.join(base, name + '.pyc');
  return fs.existsSync(pyc) ? pyc : path.join(base, name + '.py');
}

function runtimeComplete(base) {
  if (!base || !fs.existsSync(base)) return false;
  if (!fs.existsSync(engineFileIn(base, 'ethio_srt'))) return false;
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
    fs.existsSync(path.join(base, 'silero_vad.onnx'))
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

const SCRIPT = RUNTIME ? engineFileIn(RUNTIME, 'ethio_srt') : runtimePath('ethio_srt.py');
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
    showReportOffer(false);
    WORKER_TAIL = [];
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
// Asked only after a host call came back empty: plain ES3, no JSON / helper
// dependency, every step guarded — it must answer even when our code is broken.
const HOST_PROBE_JSX = '(function(){var s=[];' +
  'try{s.push("app "+app.version);}catch(e){s.push("app ?");}' +
  'try{s.push("json "+typeof JSON);}catch(e){}' +
  'try{s.push("helpers "+typeof amhGuard);}catch(e){}' +
  'try{s.push("ae-code "+(typeof amharic_getSelectedClip!=="undefined"&&amharic_getSelectedClip.amhAE===true));}catch(e){}' +
  'try{var p=app.project;s.push("project "+(p?"open":"none"));' +
  'if(p&&p.activeItem){s.push("active "+(p.activeItem.typeName||"item"));}else{s.push("active none");}}catch(e){s.push("project ? "+e);}' +
  'return s.join(", ");})()';

function evalScript(jsx, timeoutMs) {
  if (IS_AE) {
    jsx = aeHostCall(jsx,
      path.join(EXT_DIR, 'jsx', 'host.jsx').replace(/\\/g, '/'),
      path.join(EXT_DIR, 'jsx', 'host_ae.jsx').replace(/\\/g, '/'));
  }
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
        const failed = result === 'EvalScript error.';
        if (typeof result === 'string' && result.length > 0 && !failed) {
          try { finish(JSON.parse(result)); }
          catch (e) { finish({ ok: true, _raw: result }); }
        } else {
          // An empty answer (or CEP's bare "EvalScript error.") hides the
          // cause. Ask the host what it can see, so the customer's screenshot
          // says why (seen: After Effects on a Mac, Work Area, right after the load-error fix).
          const what = failed ? 'script error in ' + HOST_NAME : 'No result from ' + HOST_NAME;
          try {
            csi.evalScript(HOST_PROBE_JSX, (probe) => finish({ ok: false,
              error: what + ' (' + (probe && probe !== 'EvalScript error.' ? probe : 'the host did not answer a test either') + ')' }));
          } catch (e) { finish({ ok: false, error: what }); }
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
// Video shape → caption length: horizontal keeps the standard 42-letter
// subtitle line; vertical (TikTok / Reels / Shorts) needs short captions.
const FORMAT_CHARS = { h: 42, v: 22 };
let FORMAT = 'h';
let MAX_CHARS = FORMAT_CHARS.h;
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
// AMH_CAPTIONS_DIR: tests point this at a temporary folder (they once filled
// the owner's real Documents/AmharicCaptions and his 🕘 Recent list, 1.16.18).
const USER_CAPTIONS_DIR = (typeof process !== 'undefined' && process.env && process.env.AMH_CAPTIONS_DIR) ||
  path.join(os.homedir(), 'Documents', 'AmharicCaptions');
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
  // Old settings stored a raw number; 25 or fewer meant short captions.
  FORMAT = s.format === 'v' || s.format === 'h' ? s.format : ((s.chars && s.chars <= 25) ? 'v' : 'h');
  MAX_CHARS = FORMAT_CHARS[FORMAT];
  STYLE = STYLE_LIST.indexOf(s.style) >= 0 ? s.style : 'plain';
  document.querySelectorAll('#srcSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.src === SOURCE);
  });
  document.querySelectorAll('#capSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.cap === CAP);
  });
  $('groupSize').value = GROUP_SIZE;
  document.querySelectorAll('#fmtSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.fmt === FORMAT);
  });
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
  return f;
}

const WARM_TRANSPORT_ERRS = new Set(['worker error', 'worker exited', 'worker write failed']);

// A native extension (numpy, ctranslate2, onnxruntime) that cannot
// load its compiled DLL crashes the worker at import time with this signature.
// In the field the cause is almost always a security app (antivirus) that
// quarantined or deleted an engine file, a download that was not fully
// unzipped, or a missing Visual C++ runtime — never anything the editor did.
// Flag it so the one-line failure names the real fix (whitelist + reinstall)
// instead of a generic "engine stopped unexpectedly".
const DLL_ERROR_RE = /DLL load failed|Importing the numpy C-extensions failed|ImportError:\s*Error importing numpy/i;
let workerDllError = false;
function noteWorkerStderr(line) {
  if (workerDllError || !DLL_ERROR_RE.test(line)) return;
  workerDllError = true;
  // English in the Log on purpose (support reads it); the customer-facing line
  // under Generate is translated by humanError().
  log('HINT: A security app (antivirus) most likely blocked or deleted an engine');
  log('      file, or the download was not fully unzipped. Add this folder to your');
  log('      antivirus exclusions, then run Install.cmd again and restart Premiere:');
  log('      ' + EXT_DIR);
}

// --------------------------------------------------------------------------
// Warm ASR worker: ONE long-lived Python process keeps the model loaded.
// Requests are JSON lines on stdin; replies (and per-clip progress) are JSON
// lines on stdout tagged with the same id. Falls back to one-shot mode below
// if the server cannot start.
// --------------------------------------------------------------------------
const WARM_IDLE_MS = 20 * 60 * 1000; // kill the worker after 20 min idle
// Per-request watchdog (worker hung): fires only after this long WITHOUT any
// output from the worker. The engine reports progress every window (10-30 s
// even on a slow laptop), so a long video on a slow computer is never cut off
// — only a worker that has gone silent is.
const WARM_SEND_TIMEOUT_MS = 20 * 60 * 1000;
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
    warmBeat();
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
    warmBeat();
    // Split: a single chunk can carry several lines, and progress lines must
    // be consumed individually rather than logged as one blob.
    String(d).split('\n').forEach((raw) => {
      const t = raw.trim();
      if (!t) return;
      if (consumeProgressLine(t)) return;
      noteWorkerStderr(t);
      noteEngineLine(t);
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
    p.onTimeout = () => {
      warmPending.delete(req.id);
      const err = new Error('worker timeout');
      warmDiscard('worker timeout');
      reject(err);
    };
    p.timer = setTimeout(p.onTimeout, WARM_SEND_TIMEOUT_MS);
    try {
      const ok = warmChild.stdin.write(JSON.stringify(req) + '\n');
      if (!ok) setImmediate(warmDiscard, 'worker write failed');
    } catch (e) { warmPending.delete(req.id); if (p.timer) clearTimeout(p.timer); reject(e); }
  });
}

// Any output from the worker proves it is alive: restart every pending
// request's watchdog.
function warmBeat() {
  for (const [, p] of warmPending) {
    if (!p.onTimeout) continue;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(p.onTimeout, WARM_SEND_TIMEOUT_MS);
  }
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
  for (const f of ['ethio_srt.py', 'ctc_beam.py', 'amh_correct.py', 'amh_decode.py', 'amh_vad.py', 'amh_lm.py', 'amh_lm.json.gz']) {
    try {
      const base = RUNTIME || DEV_RUNTIME;
      const p = f === 'ethio_srt.py' ? engineFileIn(base, 'ethio_srt') : path.join(base, f);
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
  h.update(':' + CAP + ':' + GROUP_SIZE + ':' + MAX_CHARS);
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

// Doubtful-word marks from the engine (<srt>.doubt.json, keyed by SRT cue
// number): the words the model was unsure of, shown in orange in the review
// so the editor checks those first. Missing/broken file = no marks.
// Exact word times from the engine (<srt>.words.json, 1.16.26, keyed by SRT
// cue number): ✂ and 🔍 land on the word itself. Missing file = estimated.
function withWordTimes(cues, srtPath) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(srtPath + '.words.json', 'utf8')); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') return cues;
  return cues.map((c, i) => {
    const w = d[String(i + 1)];
    return Array.isArray(w) && w.length ? Object.assign({}, c, { wt: w }) : c;
  });
}
function withDoubts(cues, srtPath) {
  cues = withWordTimes(cues, srtPath);
  let d = null;
  try { d = JSON.parse(fs.readFileSync(srtPath + '.doubt.json', 'utf8')); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') return cues;
  return cues.map((c, i) => {
    const w = d[String(i + 1)];
    return Array.isArray(w) && w.length ? Object.assign({}, c, { doubt: w.map(String) }) : c;
  });
}

function cacheLookup(key) {
  const c = cacheLoad()[key];
  if (!c || !c.srt) return null;
  let cues = [];
  try { cues = normalizeCues(parseSrt(c.srt)); } catch (e) { cues = []; }
  if (!cues.length) return null;
  if (Array.isArray(c.doubts) && c.doubts.length === cues.length) {
    cues = cues.map((q, i) => (c.doubts[i] && c.doubts[i].length ? Object.assign({}, q, { doubt: c.doubts[i] }) : q));
  }
  return { srt: c.srt, cues, transcript: c.transcript || '' };
}

async function cacheStore(key, srt, transcript, cues) {
  const doubts = (cues || []).map((c) => (c && c.doubt) || []);
  cacheLoad()[key] = Object.assign({ srt, transcript, at: Date.now() },
    doubts.some((d) => d.length) ? { doubts } : {});
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
           max_chars: MAX_CHARS };
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

// A Work Area / Whole edit run's work file is named after its clips and
// caption style, so running the same edit again finds its resume journal.
const LIVE_MIN_SECS = 300;
function batchWorkKey(items) {
  const h = crypto.createHash('sha1');
  for (const it of items) h.update((it.sourcePath ? clipCacheKey(it) : String(it.wav)) + '|');
  return h.digest('hex').slice(0, 23);
}

function resumeWorkPath(key) {
  return path.join(os.tmpdir(), 'amh_work_' + String(key).slice(0, 24) + '.srt');
}

// Move the finished work file (and its doubt marks) to the run's own output.
function finishWork(work, outSrt) {
  for (const ext of ['', '.doubt.json', '.words.json']) {
    try {
      if (fs.existsSync(work + ext)) {
        fs.copyFileSync(work + ext, outSrt + ext);
        fs.unlinkSync(work + ext);
      } else if (ext) {
        try { fs.unlinkSync(outSrt + ext); } catch (e) {}
      }
    } catch (e) {}
  }
}

// Transcribe a single source (already a file path). range = {sourceIn, duration};
// offset shifts cue times to the timeline. Result: { outSrt, cues, transcript }.
async function transcribe(sourcePath, outSrt, range, offset) {
  workerDllError = false;
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
  let livePoll = null;
  let finished = false;
  try {
    if (!warmStart()) {
      // Server unavailable → one-shot process.
      return await transcribeOneShot(sourcePath, outSrt, range, offset, wav);
    }
    // The engine writes to a work file named after THIS video + settings and
    // keeps a progress journal next to it (<work>.part.json). If the run is
    // interrupted (power cut, sleep, crash, Cancel) the next run of the same
    // video continues where it stopped instead of starting again.
    const auth = await engineAuth(wavSeconds(wav));
    const work = resumeWorkPath(key);
    livePoll = startLivePoll(work);
    const r = await warmSend(Object.assign({
      wav, out_srt: work, offset: offset || 0
    }, warmStyle(), auth));
    warmTouch();
    finishWork(work, outSrt);
    protectTempFile(outSrt);
    let cues = [];
    try { cues = withDoubts(normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))), outSrt); } catch (e) {}
    lastCues = cues;
    lastSrtPath = outSrt;
    await cacheStore(key, fs.readFileSync(outSrt, 'utf8'), r.text || '', cues);
    finished = true;
    return { outSrt, cues, transcript: r.text || '', cached: false };
  } catch (e) {
    // Cancel kills the warm worker, which surfaces here as a transport error
    // ("worker exited"). Treat any failure while a cancel is pending as a
    // clean cancellation — never fall back into a new one-shot process.
    if (cancelRequested) throw new Error('Cancelled');
    if (e && e.message === 'Cancelled') throw e;
    if (!e || !WARM_TRANSPORT_ERRS.has(e.message)) throw e;
    // One-shot fallback (worker missing or failed this request).
    return await transcribeOneShot(sourcePath, outSrt, range, offset, wav);
  } finally {
    if (livePoll) clearInterval(livePoll);
    // Stopped before the end with a live review open: keep what is written.
    if (!finished && REVIEW_LIVE) {
      if (LIVE_OPENING) { try { await LIVE_OPENING; } catch (e) {} }
      finishLiveReview(null, false);
    }
    try { fs.unlinkSync(wav); } catch (e) {}
  }
}

// ── Permission for the engine (1.10.3) ──────────────────────────────────
// The engine refuses a job without either this computer's license lease or a
// server-signed trial ticket for one free caption (ethio_srt.require_license),
// so an edited panel or the engine started by hand no longer gives free
// captions. A free caption is therefore charged when the engine starts (it
// used to be charged when the review opened); a retry of the same run reuses
// the same ticket. Free captions need internet once, to get the ticket.
let ENGINE_AUTH = null;     // { run, auth } for the current run
async function engineAuth(seconds) {
  if (ENGINE_AUTH && ENGINE_AUTH.run === activeRunId) return ENGINE_AUTH.auth;
  const stored = getLicense();
  let auth;
  if (LICENSED && stored && stored.token) {
    auth = { lease: stored.token };
  } else {
    // Free minutes (1.10.7): charged in seconds of this job's audio.
    const r = await consumeTrialCredit(activeRunId, seconds);
    if (!r || !r.allowed) throw new Error(r && r.offline ? 'free caption needs internet' : 'trial used up');
    if (!r.ticket) throw new Error('free caption needs internet');
    reviewTrialCharged = true;
    TRIAL_CHARGED_RUN = r.run;
    TRIAL_CUT = (seconds && r.seconds < Math.ceil(seconds) - 1) ? r.seconds : null;
    if (!r.licensed && r.charged) TRIAL_CARD_DUE = { remaining: r.remaining, cut: TRIAL_CUT };
    auth = { ticket: r.ticket };
  }
  ENGINE_AUTH = { run: activeRunId, auth };
  return auth;
}
function authArgs(auth) {
  return auth.lease ? ['--lease', auth.lease] : (auth.ticket ? ['--ticket', auth.ticket] : []);
}

// Original per-run python process (fallback when the warm worker is absent).
// `onProgress` used to be a parameter here that every caller passed as an empty
// function and nothing ever invoked. Progress now flows the same way as on the
// warm path — parsed off the child's stderr — so the dead parameter is gone.
async function transcribeOneShot(sourcePath, outSrt, range, offset, wav) {
  const auth = await engineAuth(wavSeconds(wav));
  return new Promise((resolve, reject) => {
    const pyArgs = [SCRIPT, wav, outSrt].concat(pyFlags(), authArgs(auth));
    if (offset && offset !== 0) pyArgs.push('--offset', String(offset));
    activeChild = execFile(PYTHON, pyArgs, { maxBuffer: 32 * 1024 * 1024, env: AMH_ENV, timeout: 4 * 60 * 60 * 1000 }, (perr, stdout) => {
      activeChild = null;
      if (cancelRequested) { reject(new Error('Cancelled')); return; }
      if (perr) { reject(new Error('Python failed: ' + (perr.message || perr))); return; }
      const transcript = extractTranscripts(stdout).join('\n');
      protectTempFile(outSrt);
      let cues = [];
      try { cues = withDoubts(normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))), outSrt); } catch (e) {}
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
            if (!t || consumeProgressLine(t)) return;
            noteWorkerStderr(t);
            noteEngineLine(t);
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
  workerDllError = false;
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
      // Work Area / Whole edit while it works (1.10.9): a long run (over 5
      // minutes of audio, nothing from the cache, no overlapping clips) is
      // written as it goes into a work file named after these clips, with a
      // resume journal next to it — the review opens with the first captions
      // and a run stopped by sleep or a power cut continues next time.
      const secs = misses.reduce((s, it) => s + wavSeconds(it.wav), 0);
      const live = misses.length === items.length && !ambiguous.size &&
        secs > LIVE_MIN_SECS && liveReviewAllowed();
      const work = live ? resumeWorkPath('b' + batchWorkKey(misses)) : outSrt;
      const req = Object.assign({
        batch: misses.map((it) => ({ wav: it.wav, offset: it.offset, name: it.name || '' })),
        out_srt: work
      }, await engineAuth(secs));
      if (live) req.live = true;
      if (onProgress) req.onProgress = onProgress;
      const livePoll = live ? startLivePoll(work) : null;
      let r;
      try {
        r = await warmSend(Object.assign(req, warmStyle()));
      } finally {
        if (livePoll) clearInterval(livePoll);
      }
      warmTouch();
      if (live) finishWork(work, outSrt);
      if (r && r.skipped) {
        log('Note: skipped ' + r.skipped + ' clip(s) that could not be transcribed.');
      }
      let parsed = [];
      try { parsed = withDoubts(normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))), outSrt); } catch (e) {}
      byItem = attributeCues(parsed, misses);
      transcript = r.text || '';
    } else {
      // Server unavailable → one-shot process (one model load, misses only).
      const one = await transcribeBatchOneShot(misses, outSrt, onProgress);
      byItem = one.byItem;
      transcript = one.transcript;
    }
  } catch (e) {
    // Stopped with a live review open: keep what is written (the next run
    // continues from the work file's journal).
    const stopLive = async () => {
      if (!REVIEW_LIVE) return;
      if (LIVE_OPENING) { try { await LIVE_OPENING; } catch (x) {} }
      finishLiveReview(null, false);
    };
    // Same as the single-clip path: a pending cancel must not respawn work.
    if (cancelRequested) { await stopLive(); throw new Error('Cancelled'); }
    if (e && e.message === 'Cancelled') { await stopLive(); throw e; }
    if (!e || !WARM_TRANSPORT_ERRS.has(e.message)) { await stopLive(); throw e; }
    const one = await transcribeBatchOneShot(misses, outSrt, onProgress);
    byItem = one.byItem;
    transcript = one.transcript;
  }

  for (const it of misses) {
    if (!it.sourcePath) continue;
    if (ambiguous.has(it)) continue;   // overlapping clip: attribution unreliable
    const cs = byItem.get(it) || [];
    if (!cs.length) continue;
    await cacheStore(clipCacheKey(it), srtFromCues(cs), '', cs);
  }
  return finish(byItem, transcript);
}

// Original multi-clip one-shot fallback (one process, one model load).
async function transcribeBatchOneShot(items, outSrt, onProgress) {
  const auth = await engineAuth(items.reduce((s, it) => s + wavSeconds(it.wav), 0));
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
  const pyArgs = [SCRIPT, '--batch', reqPath, outSrt].concat(pyFlags(), authArgs(auth));
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
        try { cues = withDoubts(normalizeCues(parseSrt(fs.readFileSync(outSrt, 'utf8'))), outSrt); } catch (e) {}
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
    // execFile buffers stderr for its callback; attaching a listener leaves that
    // copy intact but lets a blocked-DLL crash surface the same actionable fix
    // as the warm path (the warm worker usually catches it first, but this is
    // the only engine process when the warm worker never started).
    try {
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => {
          String(d).split('\n').forEach((raw) => {
            const t = raw.trim();
            if (t) noteWorkerStderr(t);
          });
        });
      }
    } catch (e) {}
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


// ── auto-correct memory ─────────────────────────────────────────────────
// The editor's own fixes, kept in the home folder (survives Premiere
// upgrades) and applied to every later transcription. Nothing leaves the
// computer. A rule exists ONLY because the editor tapped "🧠 Always fix" —
// the panel never learns silently (it used to, after the same hand fix in two
// videos; in Amharic a fix that is right in one sentence is often wrong in
// the next, and a rule nobody chose surprises the editor). Rules learned that
// way by older versions are ignored.
const FIXES_FILE = '.amharic_captions_fixes.json';
const FIX_MAX = 500;
function fixStorePath() { return identityFile(FIXES_FILE); }
function loadFixStore() {
  try {
    const j = JSON.parse(fs.readFileSync(fixStorePath(), 'utf8'));
    if (j && j.fixes && typeof j.fixes === 'object') {
      Object.keys(j.fixes).forEach((w) => { if (!(j.fixes[w] && j.fixes[w].strong)) delete j.fixes[w]; });
      return j;
    }
  } catch (e) { /* none yet */ }
  return { v: 1, fixes: {} };
}
function saveFixStore(st) {
  try { fs.writeFileSync(fixStorePath(), JSON.stringify(st), { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
}
function activeFixes(st) {
  const out = {};
  Object.keys(st.fixes || {}).forEach((w) => {
    const f = st.fixes[w];
    if (f && f.to && f.to !== w && f.strong) out[w] = f.to;
  });
  return out;
}
function rememberFix(st, wrong, right, strong, max) {
  wrong = String(wrong || '').trim(); right = String(right || '').trim();
  if (!wrong || wrong === right) return;
  const cur = st.fixes[wrong];
  if (cur && cur.to === right) {
    cur.n = (cur.n || 0) + 1;
    if (strong) cur.strong = true;
  } else {
    st.fixes[wrong] = { to: right, n: 1, strong: !!strong };
  }
  st.fixes[wrong].at = Date.now();
  // Never keep the opposite rule (it would flip the word back and forth).
  if (st.fixes[right] && st.fixes[right].to === wrong) delete st.fixes[right];
  const cap = max || FIX_MAX;         // a client's own list is bigger than the machine's
  const keys = Object.keys(st.fixes);
  if (keys.length > cap) {
    keys.sort((a, b) => (st.fixes[a].at || 0) - (st.fixes[b].at || 0));
    keys.slice(0, keys.length - cap).forEach((k) => delete st.fixes[k]);
  }
}
// ── client glossaries ───────────────────────────────────────────────────
// A freelancer works for the same few clients (a clinic, a school, a shop) and
// retypes the same names in every video. A client list keeps those words on
// THIS computer (~/.amharic_captions_clients.json, 0600) and fixes them in
// that client's videos only. A client's spelling must never leak into another
// client's job, so a client word is kept out of the computer-wide memory — and
// nothing here leaves the machine: no cloud, no bot, no account, no upload.
const CLIENTS_FILE = '.amharic_captions_clients.json';
const CLIENT_MAX = 30;            // clients kept
const CLIENT_WORD_MAX = 2000;     // words per client
const CLIENT_PROJECT_MAX = 100;   // remembered "this project belongs to" links
let ACTIVE_CLIENT = '';           // '' = no client: exactly the old behaviour
function clientsPath() { return identityFile(CLIENTS_FILE); }
function loadClients() {
  try {
    const j = JSON.parse(fs.readFileSync(clientsPath(), 'utf8'));
    if (j && j.clients && typeof j.clients === 'object') {
      if (!j.projects || typeof j.projects !== 'object') j.projects = {};
      return j;
    }
  } catch (e) { /* none yet */ }
  return { v: 1, clients: {}, last: '', projects: {} };
}
function saveClients(st) {
  try { fs.writeFileSync(clientsPath(), JSON.stringify(st), { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
}
// Oldest first, so the client used last is at the top of the picker.
function pruneClients(st) {
  const names = Object.keys(st.clients || {});
  if (names.length > CLIENT_MAX) {
    names.sort((a, b) => (st.clients[a].at || 0) - (st.clients[b].at || 0));
    names.slice(0, names.length - CLIENT_MAX).forEach((n) => { delete st.clients[n]; });
  }
  const keys = Object.keys(st.projects || {});
  if (keys.length > CLIENT_PROJECT_MAX) keys.slice(0, keys.length - CLIENT_PROJECT_MAX).forEach((k) => { delete st.projects[k]; });
  return st;
}
function clientWords(st, name) { const c = (st.clients || {})[name]; return (c && c.words) || {}; }
// One client's rules, in the same shape as the computer memory's.
function clientFixes(name) {
  const st = loadClients();
  return (name && st.clients[name]) ? activeFixes({ fixes: clientWords(st, name) }) : {};
}
function clientWordCount(name) { return Object.keys(clientFixes(name)).length; }
function createClient(name) {
  name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) return '';
  const st = loadClients();
  if (!st.clients[name]) st.clients[name] = { at: Date.now(), words: {} };
  st.last = name;
  pruneClients(st);
  saveClients(st);
  return name;
}
function rememberClientFix(name, wrong, right) {
  const st = loadClients();
  if (!name || !st.clients[name]) return false;
  const holder = { fixes: clientWords(st, name) };
  rememberFix(holder, wrong, right, true, CLIENT_WORD_MAX);
  pruneClientWords(holder.fixes);
  st.clients[name].at = Date.now();
  st.last = name;
  saveClients(st);
  return true;
}
function forgetClientWord(name, wrong) {
  const st = loadClients();
  if (!name || !clientWords(st, name)[wrong]) return false;
  delete st.clients[name].words[wrong];
  saveClients(st);
  return true;
}
// Keep one client's list bounded: the least recently used words go first.
function pruneClientWords(words) {
  const keys = Object.keys(words || {});
  if (keys.length > CLIENT_WORD_MAX) {
    keys.sort((a, b) => (words[a].at || 0) - (words[b].at || 0));
    keys.slice(0, keys.length - CLIENT_WORD_MAX).forEach((k) => { delete words[k]; });
  }
  return words;
}
// Which project a client belongs to. Only a real, stable name of the editor's
// own material: the clip or video file name (the sequence name for a Work Area
// / Whole edit run). Never the temporary .srt the panel works in — those are
// made fresh for every run (amh_captions_<time>.srt), so a key taken from one
// would never match the next run and the client would be forgotten every time.
// A generic name (or none) means NO link: the editor picks the client again,
// which is better than one client's words landing in another client's video.
// That includes the names an editor never chose — Premiere's own "Sequence 01"
// appears in every project, so it can never identify a client's job.
// No folder paths are kept, so nothing about the editor's disk travels.
const GENERIC_PROJECTS = /^(captions?|clip|video|timeline|sequence|comp|composition|untitled|work area|whole edit)(\s*\d+)?$/;
function projectKey(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
  if (!base || GENERIC_PROJECTS.test(base)) return '';
  return base;
}
function activeClientForProject(st) {
  const key = (REVIEW && REVIEW.projectKey) || '';
  if (!key || !Object.prototype.hasOwnProperty.call(st.projects || {}, key)) return '';
  const name = String(st.projects[key] || '');
  return (name && st.clients[name]) ? name : '';
}
function setActiveClient(name) {
  const st = loadClients();
  name = String(name || '');
  if (name && !st.clients[name]) return false;
  const prev = ACTIVE_CLIENT;
  const same = prev === name;
  // ONE undo step for a whole switch (the old client's words out, the new
  // client's in). The snapshot is taken FIRST, while the header still shows the
  // old client, so the text and "which client wrote this word" agree again
  // after an undo. A no-op switch leaves no undo step behind.
  const snapshot = reviewOpen && !same;
  if (snapshot) pushReviewUndo('client words');
  let changed = false;
  if (prev && !same && unapplyClientWords(prev, { keepUndo: true })) changed = true;
  ACTIVE_CLIENT = name;
  st.last = name;
  const key = (REVIEW && REVIEW.projectKey) || '';
  if (key) st.projects[key] = name;
  pruneClients(st);
  saveClients(st);
  syncClientButton();
  if (applyClientWords(true, { keepUndo: snapshot })) changed = true;
  if (snapshot && !changed) { REVIEW_UNDO.pop(); syncReviewUndo(); }
  if (!changed) renderClientPanel();
  return true;
}
// Take the words one client had applied back out of this review (the editor
// switched client, or chose "No client"). Pushes ONE undo step, and only when
// the text really changes; no log of its own — the caller decides.
function unapplyClientWords(scope, opts) {
  opts = opts || {};
  if (!reviewOpen || !scope) return false;
  const words = Object.keys(REVIEW_CLIENT_WORDS).filter((w) => REVIEW_CLIENT_WORDS[w].scope === scope);
  if (!words.length) return false;
  // The words the computer memory also knows: while the client was chosen the
  // memory had no say, so it takes those words back at the end.
  const back = {};
  words.forEach((w) => { const f = REVIEW_CLIENT_WORDS[w].from; if (REVIEW_MEM_FIXES[f]) back[f] = REVIEW_MEM_FIXES[f]; });
  if (!opts.keepUndo) {
    let hits = 0;
    words.forEach((word) => {
      const from = REVIEW_CLIENT_WORDS[word].from;
      reviewCues.forEach((c) => { hits += replaceWords(c.text, word, from).n; });
    });
    if (hits) pushReviewUndo('client words');
  }
  let changed = false;
  words.forEach((word) => {
    const from = REVIEW_CLIENT_WORDS[word].from;
    reviewCues.forEach((c) => {
      const x = replaceWords(c.text, word, from);
      if (x.n) { c.text = x.text; changed = true; }
      if ((c._fixed || []).indexOf(word) >= 0) c._fixed = c._fixed.filter((v) => v !== word);
      const b = REVIEW_BASE.find((z) => String(z._id) === String(c._id));
      if (b) { const y = replaceWords(b.text, word, from); if (y.n) b.text = y.text; }
    });
    if (REVIEW_AUTOFIX.rules[from] === word) delete REVIEW_AUTOFIX.rules[from];
    delete REVIEW_CLIENT_WORDS[word];
  });
  // Give the memory its rule back for those words — the editor is now working
  // with "no client" (or another one), where the memory applies as everywhere.
  Object.keys(back).forEach((from) => {
    const to = back[from];
    reviewCues.forEach((c) => {
      const x = replaceWords(c.text, from, to);
      if (x.n) {
        c.text = x.text; changed = true;
        if ((c._fixed || []).indexOf(to) < 0) c._fixed = (c._fixed || []).concat([to]);
      }
      const b = REVIEW_BASE.find((z) => String(z._id) === String(c._id));
      if (b) { const y = replaceWords(b.text, from, to); if (y.n) b.text = y.text; }
    });
    REVIEW_AUTOFIX.rules[from] = to;
  });
  clearRowHint();
  renderReview();
  syncClientButton();
  renderClientPanel();
  return changed;
}
// The client's own words, applied to the captions as ONE undo step (nothing
// happens silently: the words turn green and ↩ Undo puts them back).
function applyClientWords(announce, opts) {
  opts = opts || {};
  if (!reviewOpen || !ACTIVE_CLIENT) return 0;
  const fx = clientFixes(ACTIVE_CLIENT);
  if (!Object.keys(fx).length) return 0;
  // A client's spelling beats the computer memory's for the same word — even
  // when the memory wrote its version first (the client was picked after the
  // review opened, or a memory rule was learned while it was open). Put the
  // memory's version back for those words, then apply the client's.
  const memTo = (from) => {
    const to = REVIEW_AUTOFIX.rules[from];
    return (to && to !== fx[from]) ? to : '';
  };
  const keys = Object.keys(fx).filter((from) => memTo(from));
  let total = keys.length;
  reviewCues.forEach((c) => { total += applyFixes(c.text, fx).applied.length; });
  if (!total) return 0;
  if (!opts.keepUndo) pushReviewUndo('client words');
  if (keys.length) {
    reviewCues.forEach((c) => {
      keys.forEach((from) => {
        const was = memTo(from);
        const x = replaceWords(c.text, was, from);
        if (x.n) c.text = x.text;
        if ((c._fixed || []).indexOf(was) >= 0) c._fixed = c._fixed.filter((v) => v !== was);
        const b = REVIEW_BASE.find((z) => String(z._id) === String(c._id));
        if (b) { const y = replaceWords(b.text, was, from); if (y.n) b.text = y.text; }
      });
    });
    keys.forEach((from) => { delete REVIEW_AUTOFIX.rules[from]; });
  }
  let n = 0;
  reviewCues.forEach((c) => {
    const r = applyFixes(c.text, fx);
    if (!r.applied.length) return;
    c.text = r.text;
    n += r.applied.length;
    r.applied.forEach((x) => { REVIEW_AUTOFIX.rules[x.from] = x.to; REVIEW_CLIENT_WORDS[x.to] = { from: x.from, scope: ACTIVE_CLIENT }; });
    c._fixed = (c._fixed || []).concat(r.applied.map((x) => x.to));
    // The "before" copy moves with it, so a client word is never learned as a
    // new fix (which would put it in the computer memory).
    const b = REVIEW_BASE.find((z) => String(z._id) === String(c._id));
    if (b) b.text = c.text;
  });
  clearRowHint();
  renderReview();
  syncClientButton();
  renderClientPanel();
  if (announce !== false) log('Client words: ' + n + ' word(s) fixed in this project.');
  return n;
}

let REVIEW_BASE = [];        // captions as the editor first saw them (after auto-fix)
let REVIEW_AUTOFIX = { rules: {} };   // this review's applied fixes: wrong -> right
let REVIEW_MEM_FIXES = {};    // the computer memory's own rules for this review (🧠)
let REVIEW_CLIENT_WORDS = {}; // this review: green word -> { from, scope } (a client's word)
let FIX_OFFER = null;        // { w, r } offered by the fix bar (Change all / Remember)
let REVIEW_UNDO = [];        // snapshots before split / join / delete / shift / add
let REVIEW_NEXT_ID = 0;      // _id for captions made by split / add

async function openReview(outSrt, label, startSeconds, opts) {
  opts = opts || {};
  // A transcription consumes a trial credit when it is produced, not only
  // when the user chooses to place it. This prevents unlimited discard/retry
  // loops. Licensed users are unaffected.
  // Free minutes are charged when the engine starts (engineAuth); a result
  // from the cache was charged when it was made. Nothing more to charge.
  reviewTrialCharged = true;
  if (!opts || !opts.projectId) STYLED_PREV = null;
  REVIEW = {
    outSrt, label: label || 'captions', startSeconds: startSeconds || 0,
    projectKey: projectKey(opts.projectId || label || 'captions'),
  };
  // Transcript cleanup pass: normalize spacing/punctuation in every cue as it
  // enters the review so the user edits (and we write) tidy Amharic.
  reviewCues = JSON.parse(JSON.stringify(lastCues)).map((c, i) =>
    Object.assign({}, c, { text: cleanCueLines(c.text), _id: i }));
  // Remembered fixes first, so the editor starts from their own spellings; the
  // client's own words win over them (that is why the client was chosen).
  REVIEW_AUTOFIX = { rules: {} };
  REVIEW_CLIENT_WORDS = {};
  FIX_OFFER = null;
  // The client of this project — only if THIS project used one before. Never
  // guessed for a new project, so one client's words cannot land in another
  // client's video. No client at all = exactly the old behaviour.
  ACTIVE_CLIENT = activeClientForProject(loadClients());
  const cfx = clientFixes(ACTIVE_CLIENT);
  // The computer memory's own rules are kept apart: a client's rule overrides
  // one of them while the client is chosen, and gives the word back to the
  // memory when the editor takes the client off again.
  REVIEW_MEM_FIXES = activeFixes(loadFixStore());
  const fx = Object.assign({}, REVIEW_MEM_FIXES, cfx);
  if (Object.keys(fx).length) {
    reviewCues.forEach((c) => {
      const r = applyFixes(c.text, fx);
      if (r.applied.length) {
        c.text = r.text;
        r.applied.forEach((x) => {
          REVIEW_AUTOFIX.rules[x.from] = x.to;
          if (cfx[x.from]) REVIEW_CLIENT_WORDS[x.to] = { from: x.from, scope: ACTIVE_CLIENT };
        });
        c._fixed = r.applied.map((x) => x.to);   // shown green: fixed from memory
      }
    });
  }
  REVIEW_BASE = JSON.parse(JSON.stringify(reviewCues));
  clearRowHint();
  REVIEW_UNDO = [];
  REVIEW_NEXT_ID = reviewCues.length;
  syncReviewUndo();
  syncMemoryButton();
  closeMemoryPanel();
  syncClientButton();
  closeClientPanel();
  reviewOpen = true;
  renderReview();
  $('review').classList.add('show');
  fitReviewBoxes();   // heights can only be measured once the overlay shows
  STYLE_CUSTOM_OPEN = false;      // closed again for every caption
  renderStyleStrip();
  loadStyleFrame().then(schedulePreview, schedulePreview);
  if (!opts.live) log('Review your captions below — edit, then click "Place on timeline".');
  track('run_ok');
  return true;
}

// ── Review while it is still working (long videos) ──────────────────────
// A 10-minute video takes minutes on a laptop; the editor used to stare at a
// bar. The engine writes a valid partial SRT after every window of a long
// video (>5 min, _run_long), so the review opens as soon as the first
// captions exist and new ones are added every few seconds — the editor fixes
// the start while the rest is being written. Never while typing: new rows
// wait until the editor leaves the text box. "Place on timeline" / "Save
// SRT" stay locked until everything is done.
// Licensed users and free minutes alike (1.10.19): free minutes are charged
// when the engine starts (engineAuth), never when the review opens, and a run
// that fails or is stopped gives them back as before.
let LIVE_WANTED = null;      // { outSrt, label, projectId } — set by the run that may go live
let REVIEW_LIVE = null;      // { seen, pending } while a live review is open
let LIVE_OPENING = null;     // the live review's openReview() while it runs
const LIVE_POLL_MS = 2000;

function liveReviewAllowed() {
  return !!LIVE_WANTED;
}

function startLivePoll(work) {
  if (!liveReviewAllowed()) return null;
  const want = LIVE_WANTED;
  let busy = false;
  const tick = async () => {
    if (busy || cancelRequested || want !== LIVE_WANTED) return;
    busy = true;
    try {
      if (!fs.existsSync(work)) return;
      let cues = [];
      try { cues = withDoubts(normalizeCues(parseSrt(fs.readFileSync(work, 'utf8'))), work); } catch (e) { return; }
      const seen = REVIEW_LIVE ? REVIEW_LIVE.seen : 0;
      if (REVIEW_LIVE && REVIEW_LIVE.pending && reviewOpen && !editingReview()) renderLive();
      if (cues.length <= seen) return;
      if (!REVIEW_LIVE) {
        if (reviewOpen) return;            // another review is open: leave it alone
        lastCues = cues;
        REVIEW_LIVE = { seen: cues.length, pending: false };
        LIVE_OPENING = openReview(want.outSrt, want.label, 0, { live: true, projectId: want.projectId });
        const opened = await LIVE_OPENING;
        LIVE_OPENING = null;
        if (!opened) { REVIEW_LIVE = null; return; }
        lockLivePlace(PROGRESS_EN || 'Transcribing…');
        log('The first captions are ready — you can start fixing them while the rest is written.');
      } else if (reviewOpen) {
        appendLiveCues(cues.slice(REVIEW_LIVE.seen));
        REVIEW_LIVE.seen = cues.length;
      }
    } finally { busy = false; }
  };
  return setInterval(tick, LIVE_POLL_MS);
}

// New captions enter the review exactly like the first ones did (tidy text,
// remembered fixes), then the list is redrawn — unless the editor is typing.
function appendLiveCues(cues) {
  if (!cues.length) return;
  const cfx = clientFixes(ACTIVE_CLIENT);
  const fx = Object.assign({}, activeFixes(loadFixStore()), cfx);
  cues.forEach((c) => {
    const cue = Object.assign({}, JSON.parse(JSON.stringify(c)), { text: cleanCueLines(c.text), _id: REVIEW_NEXT_ID++ });
    if (Object.keys(fx).length) {
      const r = applyFixes(cue.text, fx);
      if (r.applied.length) {
        cue.text = r.text;
        r.applied.forEach((x) => {
          REVIEW_AUTOFIX.rules[x.from] = x.to;
          if (cfx[x.from]) REVIEW_CLIENT_WORDS[x.to] = { from: x.from, scope: ACTIVE_CLIENT };
        });
        cue._fixed = r.applied.map((x) => x.to);
      }
    }
    reviewCues.push(cue);
    REVIEW_BASE.push(JSON.parse(JSON.stringify(cue)));
  });
  renderLive();
}

function editingReview() {
  const list = $('reviewList');
  return !!(list && document.activeElement && list.contains(document.activeElement));
}

// Redraw now, or — while the editor is typing — on a later poll tick, so
// the text box they are in is never rebuilt under their fingers.
function renderLive() {
  if (editingReview()) {
    if (REVIEW_LIVE) REVIEW_LIVE.pending = true;
    updateReviewCount();
    return;
  }
  if (REVIEW_LIVE) REVIEW_LIVE.pending = false;
  renderKeepingScroll();
}

// After the run: draw the waiting captions once the editor leaves the box.
function renderWhenNotTyping() {
  if (!editingReview()) { if (reviewOpen) renderKeepingScroll(); return; }
  const t = setInterval(() => {
    if (!reviewOpen) { clearInterval(t); return; }
    if (!editingReview()) { clearInterval(t); renderKeepingScroll(); }
  }, 1000);
}

function renderKeepingScroll() {
  const list = $('reviewList');
  const box = $('review');
  const a = list ? list.scrollTop : 0;
  const b = box ? box.scrollTop : 0;
  renderReview();
  if (list) list.scrollTop = a;
  if (box) box.scrollTop = b;
  updateReviewCount();
}

function lockLivePlace(progressText) {
  const btn = $('reviewPlace');
  if (btn) {
    if (btn.dataset.liveLabel === undefined) btn.dataset.liveLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ ' + L(progressText || 'Transcribing…');
  }
  const ex = $('reviewExport');
  if (ex) ex.disabled = true;
}

function unlockLivePlace() {
  const btn = $('reviewPlace');
  if (btn) {
    if (btn.dataset.liveLabel !== undefined) {
      btn.textContent = btn.dataset.liveLabel;
      delete btn.dataset.liveLabel;
    }
    btn.disabled = false;
  }
  const ex = $('reviewExport');
  if (ex) ex.disabled = false;
}

// The run finished: add the last captions and unlock "Place". If the run
// stopped early (error), keep what is there — Make captions again continues
// where it stopped (1.9.7 resume), Place/Save keeps the part that is done.
function finishLiveReview(finalCues, ok) {
  if (!REVIEW_LIVE) return false;
  const live = REVIEW_LIVE;
  if (ok && reviewOpen && finalCues && finalCues.length > live.seen) {
    appendLiveCues(finalCues.slice(live.seen));
  }
  REVIEW_LIVE = null;
  unlockLivePlace();
  if (!reviewOpen) return true;          // discarded while it was working
  if (live.pending) renderWhenNotTyping();
  log(ok ? 'All captions are written — check the last ones, then save or place them.'
         : 'Stopped before the end. The captions written so far are kept; Make captions again continues where it stopped.');
  return true;
}

// After a run: finish the live review, or open the review as before.
async function showRunResult(outSrt, label, r, projectId) {
  if (LIVE_OPENING) { try { await LIVE_OPENING; } catch (e) {} }
  if (REVIEW_LIVE && reviewOpen) {
    if (REVIEW) { REVIEW.outSrt = outSrt; if (projectId) REVIEW.projectKey = projectKey(projectId); }
    finishLiveReview(r.cues, true);
    return true;
  }
  REVIEW_LIVE = null;
  return openReview(outSrt, label, 0, { projectId });
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
  hideTiming();
  stopHearing();
  CLEAN = null;
  closeCleanupPanel();
  ZOOM = null;
  closeZoomPanel();
  if (!keepArtifact && REVIEW && REVIEW.outSrt) removeTempCaptionArtifact(REVIEW.outSrt);
  if (!keepArtifact) lastSrtPath = null;
  reviewOpen = false;
  reviewPlacing = false;
  REVIEW = null;
  ACTIVE_CLIENT = '';        // a client is never carried into another project
  REVIEW_CLIENT_WORDS = {};
  closeClientPanel();
  reviewCues = [];
  $('review').classList.remove('show');
  showTrialCardIfDue();
}

// ── After a free caption: the next step ─────────────────────────────────────
// 7 of the first 9 trial users stopped after one free caption, and the panel
// gave them no way to ask anything — most never opened the bot, so nobody
// could help them. After each free caption (placed or discarded) a small card
// offers the Telegram group, and Buy once the trial is used up. Licensed users
// never see it; it never covers the review.
const SUPPORT_GROUP_URL = 'https://t.me/+L-bMfmIRyEo3MDg0';
let TRIAL_CARD_DUE = null;   // { remaining } set when a free caption was charged

function showTrialCardIfDue() {
  const due = TRIAL_CARD_DUE;
  TRIAL_CARD_DUE = null;
  if (!due || LICENSED) return;
  const card = $('trialCard');
  if (!card) return;
  const last = !(due.remaining > 0);
  const cut = !!due.cut;
  card.classList.toggle('tc-left', !last && !cut);
  card.classList.toggle('tc-last', last && !cut);
  card.classList.toggle('tc-cut', cut);
  const lt = $('tcLeftText');
  if (lt) lt.textContent = L('You have ' + fmtMinSec(due.remaining) + ' free minutes left.');
  const ct = $('tcCutText');
  if (ct && cut) ct.textContent = L('Your free minutes covered the first ' + fmtMinSec(due.cut) + ' of this video.');
  const buyFirst = last || cut;
  // The main action first: the group while a free caption is left, Buy after.
  $('tcGroup').className = 'btn ' + (buyFirst ? 'btn-neutral' : 'btn-primary');
  $('tcBuy').className = 'btn ' + (buyFirst ? 'btn-primary' : 'btn-neutral');
  card.classList.add('show');
  log(cut ? 'Free minutes covered part of this video — showing the next-step card (buy).'
    : last ? 'Free trial finished — showing the next-step card (buy / group).'
      : 'Free caption done — showing the next-step card (group).');
}
function hideTrialCard() {
  const card = $('trialCard');
  if (card) card.classList.remove('show');
}
function initTrialCard() {
  const open = (url) => {
    try { window.__adobe_cep__ && window.cep.util.openURLInDefaultBrowser(url); }
    catch (err) { window.open(url, '_blank'); }
  };
  const g = $('tcGroup'); if (g) g.addEventListener('click', () => { open(SUPPORT_GROUP_URL); hideTrialCard(); });
  const b = $('tcBuy');
  if (b) b.addEventListener('click', () => { hideTrialCard(); const buy = $('buyBtn'); if (buy) buy.click(); });
  const l = $('tcLater'); if (l) l.addEventListener('click', hideTrialCard);
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

    // Split, join and delete are one click, always visible (Premiere hides
    // its own in an overflow menu on a narrow panel and editors cannot find
    // them). Shifting the time and adding a caption live behind "⋯".
    const acts = document.createElement('div');
    acts.className = 'row-acts';
    const act = (cls, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'act ' + cls; b.title = L(title);
      b.setAttribute('aria-label', L(title));
      const ic = document.createElement('span');
      ic.className = 'ic';
      b.appendChild(ic);
      return b;
    };
    const splitBtn = act('act-split', 'Split at the cursor (Enter)');
    const mergeBtn = act('act-join', 'Join with the next caption');
    const more = document.createElement('div');
    more.className = 'row-more';
    const moreBtn = act('act-more', 'More actions');
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    if (i >= 3 && i >= reviewCues.length - 2) menu.classList.add('up');   // near the bottom: open upwards
    more.appendChild(moreBtn);
    more.appendChild(menu);
    const del = act('act-del', 'Delete this caption');
    acts.appendChild(splitBtn);
    acts.appendChild(mergeBtn);
    acts.appendChild(more);
    acts.appendChild(del);
    const mk = (icon, title) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tool'; b.textContent = icon + '  ' + L(title);
      menu.appendChild(b);
      return b;
    };
    moreBtn.addEventListener('click', () => {
      const wasOpen = more.classList.contains('open');
      closeRowMenus();
      if (!wasOpen) more.classList.add('open');
    });
    const nudgeBack = mk('−0.1s', 'Shift this caption −0.1s');
    const nudgeFwd = mk('+0.1s', 'Shift this caption +0.1s');
    const addBelow = mk('+', 'Add a caption below');
    const popBtn = mk('★', 'Make the selected word pop');
    const nextCue = reviewCues[i + 1];
    mergeBtn.disabled = !canJoin(i);
    splitBtn.disabled = !splitTextAt(cue.text || '', -1);
    nudgeBack.addEventListener('click', () => nudgeReview(i, -0.1));
    nudgeFwd.addEventListener('click', () => nudgeReview(i, 0.1));
    addBelow.addEventListener('click', () => { const j = addReviewCue(i); focusReviewCue(j, 0); });
    // the textarea keeps its selection after the menu takes the focus
    popBtn.addEventListener('click', () => { closeRowMenus(); toggleEmphasis(i, ta.selectionStart, ta.selectionEnd); });
    splitBtn.addEventListener('click', () => {
      const j = splitReview(i, cue._caret);
      if (j >= 0) focusReviewCue(j, 0);
    });
    mergeBtn.addEventListener('click', () => mergeReview(i));
    // Hovering Join lights up the two captions that will become one; hovering
    // Delete tints the caption that will go.
    const joinPreview = (on) => {
      row.classList.toggle('join-preview', on);
      const nx = row.nextSibling || (row.parentNode && row.parentNode.children[i + 1]);
      if (nx && nx.classList) nx.classList.toggle('join-preview', on && !!nextCue);
    };
    mergeBtn.addEventListener('mouseenter', () => { if (!mergeBtn.disabled) joinPreview(true); });
    mergeBtn.addEventListener('mouseleave', () => joinPreview(false));
    del.addEventListener('mouseenter', () => row.classList.add('del-preview'));
    del.addEventListener('mouseleave', () => row.classList.remove('del-preview'));

    const textBox = document.createElement('div');
    textBox.className = 'text-box';
    const ta = document.createElement('textarea');
    ta.value = cue.text || ''; ta.placeholder = L('caption text');
    ta.rows = 1;
    ta.dataset.amhType = '1';
    // The captions are Amharic. Without this the whole review list is read as
    // English, and a screen reader pronounces Ge'ez with the wrong voice.
    ta.setAttribute('lang', 'am');
    ta.setAttribute('aria-label', 'Caption ' + (i + 1) + ' text');


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
    // The words the model was unsure of are highlighted orange right where
    // they are: an identical copy of the text sits behind the transparent
    // text box with only those words marked. Fixing a word clears its mark.
    const back = document.createElement('div');
    back.className = 'hl-back';
    back.setAttribute('aria-hidden', 'true');
    // Words fixed from the memory are marked green the same way.
    const paint = () => {
      const t = cue.text || '';
      const rs = doubtRanges(t, cue.doubt);
      const all = rs.map((r) => ({ start: r.start, end: r.end, cls: '' }));
      doubtRanges(t, cue._fixed).forEach((r) => {
        if (!all.some((x) => r.start < x.end && x.start < r.end)) all.push({ start: r.start, end: r.end, cls: 'fix' });
      });
      // ✂ struck words (1.16.24) win over the other marks
      const cr = cutRanges(t);
      if (cr.length) {
        for (let q = all.length - 1; q >= 0; q--) if (cr.some((r) => all[q].start < r.end && r.start < all[q].end)) all.splice(q, 1);
        cr.forEach((r) => all.push({ start: r.start, end: r.end, cls: 'cut' }));
      }
      row.classList.toggle('has-cut', cr.length > 0);
      all.sort((a, b) => a.start - b.start);
      back.textContent = '';
      let at = 0;
      const put = (tag, s, cls) => {
        if (!s) return;
        const n = document.createElement(tag);
        n.textContent = s;
        if (cls) n.className = cls;
        back.appendChild(n);
      };
      all.forEach((r) => { put('span', t.slice(at, r.start)); put('mark', t.slice(r.start, r.end), r.cls); at = r.end; });
      put('span', t.slice(at) + '\u200b');   // keeps a trailing line break the same height
      row.classList.toggle('doubt', rs.length > 0);
    };
    textBox.appendChild(ta);
    textBox.appendChild(back);
    // ★ right next to the text (1.16.17): click a word, press ★ - it pops.
    // mousedown + preventDefault keeps the cursor / selection in the text.
    const pop = document.createElement('button');
    pop.type = 'button';
    pop.className = 'pop-word';
    pop.textContent = '★';
    pop.title = L('Make the word at the cursor pop (★ again: back to normal)') + ' — ' + SHORTCUT_MOD + 'B';
    pop.addEventListener('mousedown', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      toggleEmphasis(i, ta.selectionStart, ta.selectionEnd);
    });
    textBox.appendChild(pop);
    const cutBtn = document.createElement('button');
    cutBtn.type = 'button';
    cutBtn.className = 'cut-word';
    cutBtn.textContent = '✂';
    cutBtn.title = L('Cut the word at the cursor (or the selected words) from the video — ✂ again: keep it') + ' — ' + SHORTCUT_MOD + 'D';
    cutBtn.addEventListener('mousedown', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      toggleTextCut(i, ta.selectionStart, ta.selectionEnd);
    });
    if (textCutAvailable()) textBox.appendChild(cutBtn);   // where something can cut (Premiere Clean up, Studio export)
    paint();
    ta.addEventListener('input', () => {
      cue.text = ta.value; paint(); fitReviewBox(ta); updateReviewCount();
      if (FIX_OFFER && FIX_OFFER.cue !== cue) clearRowHint();   // the line under another caption goes away
    });
    ta.addEventListener('scroll', () => { back.scrollTop = ta.scrollTop; });
    ta.addEventListener('change', () => offerFixAll(cue));
    const keepCaret = () => { cue._caret = ta.selectionStart; };
    ta.addEventListener('keyup', keepCaret);
    ta.addEventListener('select', keepCaret);
    ta.addEventListener('focus', () => { setTimeout(keepCaret, 0); });
    // Enter = split here, Shift+Enter = a line break inside the caption,
    // Backspace at the very start = join with the caption above (like the
    // transcript editors people know). Never while an Amharic keyboard (IME)
    // is still composing a letter.
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      // 1.16.25: Ctrl/⌘+B = ★, Ctrl/⌘+D = ✂, Ctrl/⌘+↓ / ↑ = next / previous caption
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = String(e.key || '').toLowerCase();
        if (k === 'b' || (k === 'd' && textCutAvailable())) {
          if (e.preventDefault) e.preventDefault();
          cue.text = ta.value;
          const at = ta.selectionEnd;
          if (k === 'b') toggleEmphasis(i, ta.selectionStart, ta.selectionEnd);
          else toggleTextCut(i, ta.selectionStart, ta.selectionEnd);
          focusReviewCue(i, at + 1);
          return;
        }
        if ((e.key === 'ArrowDown' && i + 1 < reviewCues.length) || (e.key === 'ArrowUp' && i > 0)) {
          if (e.preventDefault) e.preventDefault();
          cue.text = ta.value;
          focusReviewCue(e.key === 'ArrowDown' ? i + 1 : i - 1, 0);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.preventDefault) e.preventDefault();
        cue.text = ta.value;
        const j = splitReview(i, ta.selectionStart);
        if (j >= 0) focusReviewCue(j, 0);
        return;
      }
      if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0 && i > 0 && canJoin(i - 1)) {
        if (e.preventDefault) e.preventDefault();
        cue.text = ta.value;
        const at = (reviewCues[i - 1].text || '').trim().length + 1;
        mergeReview(i - 1);
        focusReviewCue(i - 1, at);
      }
    });
    // Click an orange word: it is selected, so typing replaces it, and the
    // playhead goes to this caption so the word can be heard.
    // Click a green word (fixed by the memory): a line under the caption says
    // what it was, with "put back" and "forget this fix".
    ta.addEventListener('click', () => {
      const pos = ta.selectionStart;
      if (typeof pos !== 'number' || ta.selectionEnd !== pos) return;
      const r = doubtRanges(ta.value, cue.doubt).find((x) => pos >= x.start && pos <= x.end);
      if (r) {
        try { ta.setSelectionRange(r.start, r.end); } catch (e) {}
        seekPlayhead(cue.start);
        return;
      }
      const g = doubtRanges(ta.value, cue._fixed).find((x) => pos >= x.start && pos <= x.end);
      if (g) offerMemoryWord(cue, ta.value.slice(g.start, g.end));
    });
    del.addEventListener('click', () => deleteReviewCue(i));

    row.appendChild(timeBox);
    row.appendChild(textBox);
    row.appendChild(acts);
    // the timing editor of the caption being edited (it survives a re-render)
    if (TIMING_I === i) showTiming(i, row, tIn, tOut);
    // 1.54 (owner): the sound-wave timing strip no longer opens on every click
    // into the text — exact times stay in the time boxes; a click on a word
    // plays the video from that word instead (Premiere panel)
    if (!IS_APP_MODE()) ta.addEventListener('click', () => {
      if (ta.selectionStart !== ta.selectionEnd) return;      // selecting words: no sound
      hearFrom(i, ta.selectionStart);
    });
    // Click a caption row to jump the Premiere playhead to that caption's start.
    row.addEventListener('click', (e) => {
      const el = e.target;
      if (el === tIn || el === tOut) return; // time inputs handle their own edits
      if (el.tagName === 'BUTTON' || el.tagName === 'TEXTAREA') return;
      if (el.parentNode && el.parentNode.tagName === 'BUTTON') return;
      seekPlayhead(cue.start);
    });
    list.appendChild(row);
  }

  if (shown === 0) {
    const empty = document.createElement('div');
    empty.className = 'review-empty';
    empty.textContent = L('No captions yet — click "+ Add cue".');
    list.appendChild(empty);
  }
  updateReviewCount();
  fitReviewBoxes();
}

// Review editor ops: nudge a caption's timing, split its text, merge with the
// next caption. All operate on the working copy; nothing reaches the timeline
// until the user places.
// Every structural edit (split, join, delete, shift, add, change all) saves a
// snapshot first, so "↩ Undo" puts it back — a one-click delete is safe. The
// client-word record and the chosen client travel with it: after an undo the
// text and "which client wrote this word" must agree again.
function pushReviewUndo(what) {
  REVIEW_UNDO.push({
    what, cues: JSON.stringify(reviewCues),
    client: JSON.stringify(REVIEW_CLIENT_WORDS), active: ACTIVE_CLIENT,
    // Which fixes are in the captions travels too: after an undo the panel must
    // believe exactly what the text says (a stale rule would silently stop the
    // next client's word from landing).
    fixes: JSON.stringify(REVIEW_AUTOFIX.rules), mem: JSON.stringify(REVIEW_MEM_FIXES),
  });
  if (REVIEW_UNDO.length > 30) REVIEW_UNDO.shift();
  syncReviewUndo();
}
function syncReviewUndo() {
  const b = $('revUndo');
  if (!b) return;
  const top = REVIEW_UNDO[REVIEW_UNDO.length - 1];
  b.style.display = top ? '' : 'none';
  b.textContent = top ? '↩ ' + L('Undo ' + top.what) : '';
  b.title = L('Undo the last change (Ctrl+Z)');
}
function undoReview() {
  const top = REVIEW_UNDO.pop();
  if (!top) return;
  reviewCues = JSON.parse(top.cues);
  if (top.client) REVIEW_CLIENT_WORDS = JSON.parse(top.client);
  if (top.fixes) REVIEW_AUTOFIX.rules = JSON.parse(top.fixes);
  if (top.mem) REVIEW_MEM_FIXES = JSON.parse(top.mem);
  if (typeof top.active === 'string') { ACTIVE_CLIENT = top.active; syncClientButton(); }
  if (reviewOpen) renderClientPanel();     // an open 👤 panel shows the right client again
  clearRowHint();
  renderReview();
  syncReviewUndo();
}
function canJoin(i) {
  const cue = reviewCues[i];
  const next = reviewCues[i + 1];
  return !!(cue && next && !(cue.speaker && next.speaker && cue.speaker !== next.speaker));
}
// Put the cursor in caption `i` at `caret` (after a split / join / add).
function focusReviewCue(i, caret) {
  const list = $('reviewList');
  const row = list && list.children ? list.children[i] : null;
  const ta = row && row.querySelector ? row.querySelector('textarea') : null;
  if (!ta) return;
  try {
    if (ta.focus) ta.focus();
    const at = Math.max(0, Math.min(caret || 0, (ta.value || '').length));
    if (ta.setSelectionRange) ta.setSelectionRange(at, at);
  } catch (e) { /* not focusable */ }
}

// ★ Emphasis (1.16.16): the selected word(s) - or the word at the cursor -
// get *asterisks*; pressing ★ on a marked word takes them off. The styled
// captions draw a marked word bigger in the accent colour; plain captions and
// exported files never show the asterisks.
// ✂ next to the text (1.16.24): strike the word at the cursor or the selected
// words (whole words; ✂ again on struck words takes the strike away). Struck
// words are written ~like this~; ✂ Clean up offers them as "Your cut".
function toggleTextCut(i, from, to) {
  const cue = reviewCues[i];
  if (!cue) return false;
  const text = String(cue.text || '');
  let a = Math.max(0, Math.min(Number(from) || 0, text.length));
  let b = Math.max(a, Math.min(Number(to) || a, text.length));
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (a === b) return false;
  pushReviewUndo('cut mark');
  const inner = text.slice(a, b);
  if (inner.startsWith('~') && inner.endsWith('~') && inner.length > 2 && inner.indexOf('~', 1) === inner.length - 1) {
    cue.text = text.slice(0, a) + inner.slice(1, -1) + text.slice(b);
  } else {
    cue.text = text.slice(0, a) + '~' + inner.replace(/~/g, '') + '~' + text.slice(b);
  }
  renderReview();
  schedulePreview();
  return true;
}
function toggleEmphasis(i, from, to) {
  const cue = reviewCues[i];
  if (!cue) return false;
  const text = String(cue.text || '');
  let a = Math.max(0, Math.min(Number(from) || 0, text.length));
  let b = Math.max(a, Math.min(Number(to) || a, text.length));
  // whole words only (a selection that cuts a word grows to the full word;
  // no selection = the word at the cursor)
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (a === b) return false;
  pushReviewUndo('emphasis');
  const inner = text.slice(a, b);
  if (inner.startsWith('*') && inner.endsWith('*') && inner.length > 2) {
    cue.text = text.slice(0, a) + inner.slice(1, -1) + text.slice(b);
  } else if (text[a - 1] === '*' && text[b] === '*') {
    cue.text = text.slice(0, a - 1) + inner + text.slice(b + 1);
  } else {
    cue.text = text.slice(0, a) + '*' + inner.replace(/\*/g, '') + '*' + text.slice(b);
  }
  renderReview();
  schedulePreview();
  return true;
}
// ── Timing editor (1.16.19) ──────────────────────────────────────────────────
// Click into a caption: a small sound wave of the editor's own footage opens
// UNDER that caption (nothing stays above the list), a little before and
// after it. The caption is the green part; drag its two handles to move the
// start / end - never over the neighbouring captions, never shorter than
// 0.2 s, one undo step per drag. Clicking the wave moves the Premiere
// playhead there. No footage known (an audio-only run is fine: the voice
// file IS the footage) -> nothing extra appears.
let TIMING_I = -1;
// ── ▶ click a word: hear the video from that word (1.54, Premiere panel) ──
// The panel plays the clip's own file from the word (a caption knows its file
// and offset, PREVIEW_MEDIA) and moves Premiere's playhead there too; the
// caption being heard is marked. ■ on top, Esc, or closing the list stops it.
const HEAR = { a: null, m: null, row: -1 };
function fileUrl(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const segs = s.split('/');
  return 'file://' + (s.charAt(0) === '/' ? '' : '/') + segs.map((x, j) => (j === 0 && /^[A-Za-z]:$/.test(x) ? x : encodeURIComponent(x))).join('/');
}
function hearFrom(i, caret) {
  const c = reviewCues[i];
  if (!c) return;
  const text = String(c.text || '');
  const before = text.slice(0, Math.max(0, caret || 0));
  const k = before.trim() ? before.trim().split(/\s+/).length - (/\s$/.test(before) ? 0 : 1) : 0;
  const ws = cleanupWords([c]);
  const w = ws[Math.max(0, Math.min(ws.length - 1, k))];
  const t = w ? w.s : Number(c.start) || 0;
  try { seekPlayhead(t); } catch (e) {}
  const m = previewMediaFor([[text, t, t]]);
  if (!m) return;
  try {
    if (!HEAR.a) {
      HEAR.a = new Audio();
      HEAR.a.addEventListener('timeupdate', hearFollow);
      HEAR.a.addEventListener('ended', stopHearing);
    }
    if (HEAR.m !== m.path) { HEAR.a.src = fileUrl(m.path); HEAR.m = m.path; }
    HEAR.a.currentTime = Math.max(0, t + m.offset);
    const p = HEAR.a.play();
    if (p && p.catch) p.catch(() => {});
    HEAR.off = m.offset;
    hearButton(true);
  } catch (e) {}
}
function hearFollow() {
  if (!HEAR.a) return;
  const t = HEAR.a.currentTime - (HEAR.off || 0);
  const list = $('reviewList');
  const i = reviewCues.findIndex((c) => t >= c.start && t < c.end);
  if (i === HEAR.row || !list) return;
  const rows = list.children || [];
  if (HEAR.row >= 0 && rows[HEAR.row] && rows[HEAR.row].classList) rows[HEAR.row].classList.remove('hearing');
  if (i >= 0 && rows[i] && rows[i].classList) rows[i].classList.add('hearing');
  HEAR.row = i;
}
function stopHearing() {
  if (HEAR.a) { try { HEAR.a.pause(); } catch (e) {} }
  const list = $('reviewList');
  if (list && HEAR.row >= 0 && list.children && list.children[HEAR.row] && list.children[HEAR.row].classList) list.children[HEAR.row].classList.remove('hearing');
  HEAR.row = -1;
  hearButton(false);
}
function hearButton(on) {
  const bar = $('reviewSteps');
  if (!bar) return;
  let b = $('hearStop');
  if (on && !b) {
    b = document.createElement('button');
    b.type = 'button'; b.id = 'hearStop'; b.className = 'rstep hearstop';
    b.textContent = '■ ' + L('Stop');
    b.title = L('Stop') + ' (Esc)';
    b.addEventListener('click', stopHearing);
    bar.insertBefore(b, bar.firstChild);
  }
  if (b) b.style.display = on ? '' : 'none';
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && HEAR.a && !HEAR.a.paused) stopHearing(); });

let TIMING_EL = null;
const WAVE_CACHE = {};
const TIMING_MIN = 0.2;
function timingWindow(c) {
  const pad = Math.max(1, Math.min(3, (c.end - c.start) * 0.6));
  return { from: Math.max(0, c.start - pad), to: c.end + pad };
}
function waveformPeaks(media, from, to, n, ff) {   // ff: tests only
  const key = media.path + '|' + (from + media.offset).toFixed(2) + '|' + (to - from).toFixed(2) + '|' + n;
  if (WAVE_CACHE[key]) return Promise.resolve(WAVE_CACHE[key]);
  return new Promise((resolve) => {
    const ss = Math.max(0, from + media.offset);
    try {
      execFile(ff || FFMPEG, ['-v', 'error', '-ss', ss.toFixed(3), '-t', (to - from).toFixed(3), '-i', media.path,
        '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 20000 }, (err, out) => {
        if (err || !out || out.length < 4) { resolve(null); return; }
        const samples = Math.floor(out.length / 2);
        const per = Math.max(1, Math.floor(samples / n));
        const peaks = [];
        let max = 1;
        for (let b = 0; b < n; b++) {
          let m = 0;
          for (let k = b * per; k < Math.min(samples, (b + 1) * per); k++) {
            const v = Math.abs(out.readInt16LE(k * 2));
            if (v > m) m = v;
          }
          peaks.push(m);
          if (m > max) max = m;
        }
        const res = peaks.map((v) => v / max);
        WAVE_CACHE[key] = res;
        resolve(res);
      });
    } catch (e) { resolve(null); }
  });
}
// Move one edge of caption i to time t (seconds), kept between the
// neighbours and at least TIMING_MIN long. Returns the time it got.
function setTimingEdge(i, which, t) {
  const c = reviewCues[i];
  if (!c) return null;
  const prev = reviewCues[i - 1];
  const next = reviewCues[i + 1];
  t = Math.round(Number(t) * 100) / 100;
  // never shorter than TIMING_MIN — but a caption already shorter (one
  // karaoke word) only cannot shrink; it never jumps longer (1.17.0)
  const min = Math.min(TIMING_MIN, Math.max(0.05, c.end - c.start));
  if (which === 'start') {
    t = Math.max(prev ? prev.end : 0, Math.min(t, c.end - min));
    c.start = t;
  } else {
    t = Math.min(next ? next.start : 1e9, Math.max(t, c.start + min));
    c.end = t;
  }
  return t;
}
function hideTiming() {
  if (TIMING_EL && TIMING_EL.parentNode) {
    if (TIMING_EL.parentNode.className) TIMING_EL.parentNode.className = TIMING_EL.parentNode.className.replace(/ ?timing-open/g, '');
    TIMING_EL.parentNode.removeChild(TIMING_EL);
  }
  TIMING_EL = null;
  TIMING_I = -1;
}
function showTiming(i, row, tIn, tOut) {
  const c = reviewCues[i];
  if (!c || !row) return null;
  const media = previewMediaFor([[c.text, c.start, c.end]]);
  if (!media) return null;                       // no footage known: nothing extra
  if (TIMING_EL && TIMING_I !== i) hideTiming();
  if (TIMING_EL && TIMING_EL.parentNode === row) return TIMING_EL;
  TIMING_I = i;
  const win = timingWindow(c);
  const span = win.to - win.from;
  const pct = (t) => Math.max(0, Math.min(100, (t - win.from) / span * 100));
  const strip = document.createElement('div');
  strip.className = 'timing-strip';
  const wave = document.createElement('div');
  wave.className = 'wave';
  const region = document.createElement('div');
  region.className = 'region';
  const hs = document.createElement('div');
  hs.className = 'handle';
  hs.title = L('Drag: when this caption starts');
  const he = document.createElement('div');
  he.className = 'handle';
  he.title = L('Drag: when this caption ends');
  strip.appendChild(wave);
  strip.appendChild(region);
  strip.appendChild(hs);
  strip.appendChild(he);
  const place = () => {
    region.style.left = pct(c.start) + '%';
    region.style.width = (pct(c.end) - pct(c.start)) + '%';
    hs.style.left = pct(c.start) + '%';
    he.style.left = pct(c.end) + '%';
    if (tIn) tIn.value = fmtReviewTs(c.start);
    if (tOut) tOut.value = fmtReviewTs(c.end);
  };
  place();
  const timeAt = (clientX) => {
    const r = strip.getBoundingClientRect ? strip.getBoundingClientRect() : { left: 0, width: 1 };
    return win.from + Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * span;
  };
  const drag = (which) => (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    pushReviewUndo('timing');
    const move = (ev) => { setTimingEdge(i, which, timeAt(ev.clientX)); place(); };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      schedulePreview();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  hs.addEventListener('mousedown', drag('start'));
  he.addEventListener('mousedown', drag('end'));
  strip.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (e && typeof e.clientX === 'number') seekPlayhead(timeAt(e.clientX));
  });
  row.className = (row.className || '') + ' timing-open';
  row.appendChild(strip);
  TIMING_EL = strip;
  waveformPeaks(media, win.from, win.to, 90).then((peaks) => {
    if (TIMING_EL !== strip) return;
    if (!peaks) { strip.className += ' no-wave'; return; }
    peaks.forEach((v) => {
      const bar = document.createElement('i');
      bar.style.height = Math.max(4, Math.round(v * 100)) + '%';
      wave.appendChild(bar);
    });
  });
  return strip;
}

// ── ✂ Clean-up cut (1.16.20) ─────────────────────────────────────────────────
// One button in the review header: the panel listens to the editor's own
// footage for long pauses, and reads the captions for repeated takes and
// hesitation sounds (core.js). Everything found is listed with a tick box (a
// click on a line jumps the playhead there to listen); "Cut on a copy" takes
// the ticked parts out of a COPY of the sequence (host amh_cleanupCut), and
// the captions follow the cut. Premiere only.
let CLEAN = null;            // { envs, items, busy, done, error }
const CLEAN_PAUSES = [0.5, 0.8, 1.2];
function cleanupAvailable() { return !IS_AE && !IS_APP_MODE(); }
// ✂ text cuts: Premiere (Clean up cuts the sequence) and the Studio, whose
// export cuts the video (1.19.0, window.__amhStudioCuts)
function textCutAvailable() { return cleanupAvailable() || !!(typeof window !== 'undefined' && window.__amhStudioCuts); }
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// Loudness of the footage, 50 times a second, for a stretch of the timeline.
function audioEnvelope(media, from, to, ff) {
  return new Promise((resolve) => {
    const ss = Math.max(0, from + media.offset);
    const dur = to - from;
    if (!(dur > 0.2)) { resolve(null); return; }
    try {
      execFile(ff || FFMPEG, ['-v', 'error', '-ss', ss.toFixed(3), '-t', dur.toFixed(3), '-i', media.path,
        '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: Math.ceil(dur * 8000) + (1 << 20), timeout: 300000 }, (err, out) => {
        if (err || !out || out.length < 160) { resolve(null); return; }
        const per = 80;                                  // 20 ms at 4 kHz
        const n = Math.floor(out.length / 2 / per);
        const db = new Array(n);
        for (let f = 0; f < n; f++) {
          let sum = 0;
          for (let k = 0; k < per; k++) { const v = out.readInt16LE((f * per + k) * 2); sum += v * v; }
          db[f] = 20 * Math.log10(Math.sqrt(sum / per) / 32768 + 1e-6);
        }
        resolve({ t0: from, step: 0.02, db });
      });
    } catch (e) { resolve(null); }
  });
}
function cleanupEnvAt(t) {
  return ((CLEAN && CLEAN.envs) || []).find((e) => t >= e.t0 && t <= e.t0 + e.db.length * e.step) || null;
}
function cleanupPause() {
  const v = Number(loadSettings().cleanupPause);
  return CLEAN_PAUSES.indexOf(v) >= 0 ? v : 0.8;
}
// Find everything (the sound is measured once per review; the pause length
// only re-reads it).
async function analyzeCleanup(ff) {
  CLEAN = { envs: [], items: [], busy: true };
  renderCleanupPanel();
  if (!reviewCues.length) { CLEAN.busy = false; renderCleanupPanel(); return CLEAN; }
  const lo = Math.max(0, Math.min.apply(null, reviewCues.map((c) => c.start)) - 0.5);
  const hi = Math.max.apply(null, reviewCues.map((c) => c.end)) + 0.5;
  for (const m of PREVIEW_MEDIA) {
    const a = Math.max(lo, m.from);
    const b = Math.min(hi, m.to);
    if (b - a > 0.5) {
      const env = await audioEnvelope(m, a, b, ff);
      if (env) CLEAN.envs.push(env);
    }
  }
  cleanupFindAll();
  CLEAN.busy = false;
  renderCleanupPanel();
  return CLEAN;
}
function cleanupFindAll() {
  const items = [];
  CLEAN.envs.forEach((env) => findSilences(env, { minLen: cleanupPause() }).forEach((s) =>
    items.push({ kind: 'pause', start: s.start, end: s.end, on: true })));
  findTextCuts(reviewCues).forEach((c) => {
    const env = cleanupEnvAt(c.start);
    const r = c.exact ? 0.06 : 0.15;                    // exact engine times: only a nudge
    items.push({ kind: 'text', text: c.text, words: c.words, on: true,
      start: c.whole ? c.start : snapQuiet(c.start, env, r), end: c.whole ? c.end : snapQuiet(c.end, env, r) });
  });
  findRepeats(reviewCues).forEach((r) => items.push({ kind: 'repeat', start: r.start, end: r.end, text: r.text, words: r.words, on: true }));
  findFillers(reviewCues).forEach((f) => {
    const env = cleanupEnvAt(f.start);
    const r = f.exact ? 0.06 : 0.2;
    items.push({ kind: f.word ? 'word' : 'filler', text: f.text, words: f.words, on: !f.word,
      start: snapQuiet(f.start, env, r), end: snapQuiet(f.end, env, r) });
  });
  items.sort((x, y) => x.start - y.start);
  CLEAN.items = items.filter((x) => x.end - x.start > 0.05);
}
// 1.54 (owner): two buttons on top — '🔇 Clean silence' (pauses, repeated
// takes, እ… sounds) and '✂ Edit with text' (the words marked ✂ in the text).
// One list underneath; each button shows and cuts only its own kind.
let CLEAN_MODE = 'silence';
const cleanupKindOf = (it) => (it.kind === 'text' ? 'text' : 'silence');
function cleanupShown() { return ((CLEAN && CLEAN.items) || []).filter((x) => cleanupKindOf(x) === CLEAN_MODE); }
function cleanupSelected() { return cleanupShown().filter((x) => x.on); }
function renderCleanupPanel() {
  syncReviewSteps();
  const p = $('cleanupPanel');
  if (!p || p.style.display === 'none') return;
  p.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const textMode = CLEAN_MODE === 'text';
  p.appendChild(el('div', 'mem-head', textMode ? '✂ ' + L('Edit with text') : '🔇 ' + L('Clean silence')));
  p.appendChild(el('div', 'mem-sub', textMode
    ? L('Cuts the words you marked ✂ in the captions (select words, then ✂ or Ctrl+D) — on a copy of your sequence.')
    : L('Cuts long pauses, repeated takes and እ… sounds — on a copy of your sequence.')));
  if (!CLEAN || CLEAN.busy) { p.appendChild(el('div', 'mem-sub', L('Listening for pauses…'))); return; }
  if (CLEAN.done) {
    p.appendChild(el('div', 'clean-done', L('Done') + ': ' + L('removed') + ' ' + fmtDur(CLEAN.done.removedSeconds) +
      ' — “' + CLEAN.done.sequence + '” ' + L('is open. Your captions moved with the cuts: press Place to put them on it.')));
    if (CLEAN.done.cuts < CLEAN.done.total) {
      p.appendChild(el('div', 'mem-sub', L('Stopped after') + ' ' + CLEAN.done.cuts + ' ' + L('of') + ' ' + CLEAN.done.total + ' ' +
        L('cuts — the ones nearer the start were not cut.')));
    }
    if (CLEAN.done.error) p.appendChild(el('div', 'clean-err', CLEAN.done.error));
    return;
  }
  if (!textMode) {
    const seg = el('div', 'clean-opt');
    seg.appendChild(el('span', '', L('Pauses longer than')));
    CLEAN_PAUSES.forEach((v) => {
      const b = el('button', 'sc-opt' + (v === cleanupPause() ? ' active' : ''), v + ' s');
      b.type = 'button';
      b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); saveSettings({ cleanupPause: v }); cleanupFindAll(); renderCleanupPanel(); });
      seg.appendChild(b);
    });
    p.appendChild(seg);
    if (!CLEAN.envs.length) p.appendChild(el('div', 'mem-sub', L('Pauses: your footage could not be read here — repeats and sounds only.')));
  }
  const names = { text: '✂ ' + L('Your cut'), pause: L('Pause'), repeat: L('Repeated take'), filler: L('Sound'), word: L('Filler word?') };
  const list = el('div', 'clean-list');
  const shown = cleanupShown();
  if (!shown.length) list.appendChild(el('div', 'mem-sub', textMode
    ? L('No words are marked yet: select words in a caption, then press ✂ (or Ctrl+D).')
    : L('Nothing to clean — it is already tight.')));
  shown.forEach((it) => {
    const row = el('label', 'clean-row' + (it.on ? '' : ' off'));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.on;
    cb.addEventListener('change', () => { it.on = cb.checked; renderCleanupPanel(); });
    row.appendChild(cb);
    row.appendChild(el('span', 'clean-t', fmtReviewTs(it.start)));
    const what = names[it.kind] + (it.text ? ' «' + it.text + '»' : '') + ' · ' + (it.end - it.start).toFixed(1) + ' s';
    const txt = el('span', 'clean-what', what);
    txt.title = L('Listen: moves the playhead here');
    txt.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); seekPlayhead(Math.max(0, it.start - 1)); });
    row.appendChild(txt);
    list.appendChild(row);
  });
  p.appendChild(list);
  const sel = mergeRanges(cleanupSelected());
  const total = sel.reduce((x, c) => x + c.end - c.start, 0);
  const length = Math.max.apply(null, reviewCues.map((c) => c.end).concat([0]));
  p.appendChild(el('div', 'clean-sum', L('Removes') + ' ' + fmtDur(total) + ' ' + L('of') + ' ' + fmtDur(length)));
  if (CLEAN.error) p.appendChild(el('div', 'clean-err', CLEAN.error));
  if (CLEAN.cutting) {
    const pr = CLEAN.progress || { done: 0, total: 0 };
    const bar = el('div', 'clean-progress');
    const fill = el('i');
    fill.style.width = (pr.total ? Math.round(pr.done / pr.total * 100) : 0) + '%';
    bar.appendChild(fill);
    p.appendChild(bar);
    p.appendChild(el('div', 'clean-sum', CLEAN.stop ? L('Stopping…')
      : L('Cutting') + ' ' + pr.done + ' ' + L('of') + ' ' + pr.total + '…'));
    const stop = el('button', 'btn btn-neutral clean-go', '✕ ' + L('Stop'));
    stop.type = 'button';
    stop.disabled = !!CLEAN.stop;
    stop.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); CLEAN.stop = true; renderCleanupPanel(); });
    p.appendChild(stop);
  } else {
    const go = el('button', 'btn btn-primary clean-go', '✂ ' + L('Cut on a copy of the sequence'));
    go.type = 'button';
    go.disabled = !sel.length;
    go.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); applyCleanup(); });
    p.appendChild(go);
  }
  p.appendChild(el('div', 'mem-sub', L('Your sequence stays as it is; the clean copy opens next to it. Clean up before you place the captions.')));
}
// Cut in small groups, last group first (1.16.22): the panel shows "Cutting
// 10 of 40…" and ✕ Stop between groups. A stop keeps what is already cut on
// the copy (in sync — each group is whole) and the captions follow exactly
// the cuts that were made.
const CLEAN_CHUNK = 5;
async function applyCleanup() {
  const sel = cleanupSelected();
  const cuts = mergeRanges(sel);
  if (!cuts.length || CLEAN.cutting) return null;
  CLEAN.cutting = true;
  CLEAN.stop = false;
  CLEAN.error = '';
  CLEAN.progress = { done: 0, total: cuts.length };
  renderCleanupPanel();
  const media = Array.from(new Set(PREVIEW_MEDIA.map((m) => m.path)));
  const fail = (r) => {
    CLEAN.cutting = false;
    CLEAN.error = L((r && r.error) || 'Premiere did not answer.');
    log('Clean up: ' + ((r && r.error) || 'no answer'));
    log('  (the captions were made from: ' + media.join(', ') + ')');
    renderCleanupPanel();
    return r;
  };
  const p = await evalScript('amh_cleanupPrepare(' + escJson(JSON.stringify({ cuts: cuts.map((c) => [c.start, c.end]), media })) + ')', 120000);
  if (!p || !p.ok) return fail(p);
  const list = p.list || [];
  CLEAN.progress.total = list.length;
  const applied = [];
  let removedSeconds = 0;
  let err = null;
  for (let end = list.length; end > 0 && !CLEAN.stop; end -= CLEAN_CHUNK) {
    const chunk = list.slice(Math.max(0, end - CLEAN_CHUNK), end);
    const r = await evalScript('amh_cleanupSome(' + escJson(JSON.stringify({ sequenceID: p.sequenceID, fps: p.fps, cuts: chunk })) + ')', 120000);
    if (!r || !r.ok) { err = r || { error: 'Premiere did not answer.' }; break; }
    applied.push(...chunk);
    removedSeconds += Number(r.removedSeconds) || 0;
    CLEAN.progress.done = applied.length;
    renderCleanupPanel();
  }
  CLEAN.cutting = false;
  if (!applied.length) {
    if (err) return fail(err);
    CLEAN.error = L('Stopped — nothing was cut.') + ' “' + p.sequence + '”';
    renderCleanupPanel();
    return null;
  }
  const done = applied.map((c) => ({ start: c[0], end: c[1] })).sort((x, y) => x.start - y.start);
  const inCut = (it) => done.some((c) => it.start >= c.start - 0.1 && it.end <= c.end + 0.1);
  const drop = [];
  sel.forEach((it) => { if (it.words && inCut(it)) it.words.forEach((w) => drop.push(w)); });
  hideTiming();
  reviewCues = remapCuesAfterCut(reviewCues, done, drop);
  setPreviewMedia(remapMediaAfterCut(PREVIEW_MEDIA, done));
  REVIEW_UNDO.length = 0;             // the old captions no longer match the timeline
  syncReviewUndo();
  renderReview();
  schedulePreview();
  CLEAN.done = { sequence: p.sequence, removedSeconds, cuts: applied.length, total: list.length,
    error: err ? L(err.error || 'Premiere did not answer.') : '' };
  log('✂ Clean up: removed ' + fmtDur(removedSeconds) + ' in ' + applied.length + ' of ' + list.length + ' cut(s) — "' + p.sequence + '"');
  renderCleanupPanel();
  return CLEAN.done;
}
function toggleCleanupPanel(mode) {
  const p = $('cleanupPanel');
  if (!p) return;
  mode = mode === 'text' ? 'text' : (mode === 'silence' ? 'silence' : CLEAN_MODE);
  // the other button while open: switch the list, keep it open
  const open = p.style.display === 'none' || mode !== CLEAN_MODE;
  CLEAN_MODE = mode;
  closeMemoryPanel();
  closeClientPanel();
  closeZoomPanel();
  p.style.display = open ? '' : 'none';
  if (open) {
    const b = $(mode === 'text' ? 'revCleanup' : 'revSilence') || $('revCleanup');
    if (b && typeof b.offsetTop === 'number' && b.offsetHeight) p.style.top = (b.offsetTop + b.offsetHeight + 4) + 'px';
    if (!CLEAN || CLEAN.done) analyzeCleanup(); else renderCleanupPanel();
  }
}
function closeCleanupPanel() {
  const p = $('cleanupPanel');
  if (p) p.style.display = 'none';
}

// ── 🔍 Auto zoom (1.16.23) ───────────────────────────────────────────────────
// One button in the review header: the moments worth a zoom (★ words, and
// numbers / money unless "★ only") are listed with tick boxes (a click on a
// line jumps the playhead there); "Add zooms" puts Scale keyframes on the
// footage in a copy of the sequence (host amh_autoZoom). Premiere only.
let ZOOM = null;             // { items, busy, done, error }
const ZOOM_STRENGTHS = [110, 115, 125];
function zoomSettings() {
  const s = loadSettings();
  return {
    style: s.zoomStyle === 'punch' ? 'punch' : 'smooth',
    strength: ZOOM_STRENGTHS.indexOf(Number(s.zoomStrength)) >= 0 ? Number(s.zoomStrength) : 115,
    stars: !!s.zoomStars,
  };
}
function zoomFind() {
  const st = zoomSettings();
  ZOOM.items = findZoomMoments(reviewCues, { auto: !st.stars }).map((m) => Object.assign(m, { on: true }));
}
function renderZoomPanel() {
  syncReviewSteps();
  const p = $('zoomPanel');
  if (!p || p.style.display === 'none') return;
  p.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  p.appendChild(el('div', 'mem-head', '🔍 ' + L('Auto zoom')));
  p.appendChild(el('div', 'mem-sub', L('A zoom on your video where it matters: ★ words, numbers and money — on a copy of your sequence.')));
  if (!ZOOM) return;
  if (ZOOM.done) {
    p.appendChild(el('div', 'clean-done', L('Done') + ': ' + ZOOM.done.zoomed + ' ' + L('zooms') + ' — “' + ZOOM.done.sequence + '” ' + L('is open.')));
    if (ZOOM.done.animated) p.appendChild(el('div', 'mem-sub', ZOOM.done.animated + ' ' + L('left alone: that clip already has your own Scale animation.')));
    if (ZOOM.done.noClip) p.appendChild(el('div', 'mem-sub', ZOOM.done.noClip + ' ' + L('left alone: no video clip there.')));
    return;
  }
  const st = zoomSettings();
  const seg = (label, options, cur, key) => {
    const row = el('div', 'clean-opt');
    row.appendChild(el('span', '', label));
    options.forEach(([v, text]) => {
      const b = el('button', 'sc-opt' + (v === cur ? ' active' : ''), text);
      b.type = 'button';
      b.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const o = {}; o[key] = v; saveSettings(o);
        if (key === 'zoomStars') zoomFind();
        renderZoomPanel();
      });
      row.appendChild(b);
    });
    p.appendChild(row);
  };
  seg(L('Zoom'), [['smooth', L('Smooth')], ['punch', L('Punch')]], st.style, 'zoomStyle');
  seg(L('Strength'), ZOOM_STRENGTHS.map((v) => [v, v + '%']), st.strength, 'zoomStrength');
  seg(L('Where'), [[false, L('★ + numbers')], [true, L('★ only')]], st.stars, 'zoomStars');
  const list = el('div', 'clean-list');
  if (!ZOOM.items.length) list.appendChild(el('div', 'mem-sub', L('No moments yet: mark words with ★ in the captions (or numbers and money with “★ + numbers”).')));
  ZOOM.items.forEach((it) => {
    const row = el('label', 'clean-row' + (it.on ? '' : ' off'));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.on;
    cb.addEventListener('change', () => { it.on = cb.checked; renderZoomPanel(); });
    row.appendChild(cb);
    row.appendChild(el('span', 'clean-t', fmtReviewTs(it.word)));
    const txt = el('span', 'clean-what', (it.star ? '★ ' : '') + '«' + it.text + '»');
    txt.title = L('Listen: moves the playhead here');
    txt.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); seekPlayhead(Math.max(0, it.start - 1)); });
    row.appendChild(txt);
    list.appendChild(row);
  });
  p.appendChild(list);
  if (ZOOM.error) p.appendChild(el('div', 'clean-err', ZOOM.error));
  const n = ZOOM.items.filter((x) => x.on).length;
  const go = el('button', 'btn btn-primary clean-go', ZOOM.busy ? L('Adding zooms…') : '🔍 ' + L('Add zooms on a copy') + (n ? ' (' + n + ')' : ''));
  go.type = 'button';
  go.disabled = !n || !!ZOOM.busy;
  go.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); applyZoom(); });
  p.appendChild(go);
  p.appendChild(el('div', 'mem-sub', L('Your sequence stays as it is. On your “- clean” copy the zooms go straight onto it.')));
}
async function applyZoom() {
  const sel = ((ZOOM && ZOOM.items) || []).filter((x) => x.on);
  if (!sel.length || ZOOM.busy) return null;
  const st = zoomSettings();
  ZOOM.busy = true;
  ZOOM.error = '';
  renderZoomPanel();
  const media = Array.from(new Set(PREVIEW_MEDIA.map((m) => m.path)));
  const r = await evalScript('amh_autoZoom(' + escJson(JSON.stringify({
    moments: sel.map((m) => ({ start: m.start, word: m.word, end: m.end })), style: st.style, strength: st.strength, media,
  })) + ')', 120000);
  ZOOM.busy = false;
  if (!r || !r.ok) {
    ZOOM.error = L((r && r.error) || 'Premiere did not answer.');
    log('Auto zoom: ' + ((r && r.error) || 'no answer'));
    renderZoomPanel();
    return r;
  }
  ZOOM.done = r;
  log('🔍 Auto zoom: ' + r.zoomed + ' zoom(s) — "' + r.sequence + '"' + (r.animated ? ', ' + r.animated + ' left alone (own animation)' : ''));
  renderZoomPanel();
  return r;
}
function toggleZoomPanel() {
  const p = $('zoomPanel');
  if (!p) return;
  const open = p.style.display === 'none';
  closeMemoryPanel();
  closeClientPanel();
  closeCleanupPanel();
  p.style.display = open ? '' : 'none';
  if (open) {
    const b = $('revZoom');
    if (b && typeof b.offsetTop === 'number' && b.offsetHeight) p.style.top = (b.offsetTop + b.offsetHeight + 4) + 'px';
    ZOOM = { items: [] };
    zoomFind();
    renderZoomPanel();
  }
}
function closeZoomPanel() {
  const p = $('zoomPanel');
  if (p) p.style.display = 'none';
}

// ── Review step bar (1.16.25) ────────────────────────────────────────────────
// One row under the review title shows the way through, in order:
// ① Text (doubtful words left, or ✓) → ② ✂ Clean up → ③ 🔍 Zoom → ④ 🎨 Style
// → ⑤ Place. A finished step gets ✓; each step is a button that goes there.
// Clean up / Zoom are Premiere only; Style only where styles can be drawn —
// the numbers follow what is shown.
const STEP_NUMS = ['①', '②', '③', '④', '⑤'];
function reviewDoubtCount() {
  return reviewCues.reduce((n, c) => n + doubtRanges(c.text || '', c.doubt).length, 0);
}
function syncReviewSteps() {
  const box = $('reviewSteps');
  if (!box) return;
  const tools = cleanupAvailable();
  const strip = $('styleStrip');
  const styles = !!(strip && strip.style.display !== 'none');
  const doubts = reviewDoubtCount();
  // 1.54 (owner: "too many steps, confusing"): only the main tools on top —
  // Text and Clean up (with the parts marked ✂ in the text); Zoom a small
  // icon; Style and Place are already at the bottom (the style row and the
  // big Place button), so no numbered steps and no repeats up here
  let marked = 0;
  try { marked = findTextCuts(reviewCues).length; } catch (e) {}
  void styles; void STEP_NUMS;
  const steps = [
    ['stepText', true, L('Text') + (doubts ? ' · ⚠ ' + doubts : ' ✓'), doubts ? 'warn' : 'done'],
    ['revSilence', tools, '🔇 ' + L('Clean silence'), ''],
    ['revCleanup', tools, '✂ ' + L('Edit with text') + (marked ? ' · ' + marked : '') + (CLEAN && CLEAN.done ? ' ✓' : ''), marked ? 'warn' : (CLEAN && CLEAN.done ? 'done' : '')],
    ['revZoom', tools, '🔍', ZOOM && ZOOM.done ? 'done rzoom' : 'rzoom'],
    ['stepStyle', false, '', ''],
    ['stepPlace', false, '', ''],
  ];
  steps.forEach(([id, show, text, cls]) => {
    const b = $(id);
    if (!b) return;
    b.style.display = show ? '' : 'none';
    if (!show) return;
    b.textContent = text;
    b.className = 'rstep' + (cls ? ' ' + cls : '');
  });
}
// ① goes to the first doubtful word (selected, so typing replaces it).
function goFirstDoubt() {
  for (let i = 0; i < reviewCues.length; i++) {
    const r = doubtRanges(reviewCues[i].text || '', reviewCues[i].doubt)[0];
    if (!r) continue;
    focusReviewCue(i, r.start);
    const row = $('reviewList') && $('reviewList').children[i];
    const ta = row && row.querySelector ? row.querySelector('textarea') : null;
    try { if (ta && ta.setSelectionRange) ta.setSelectionRange(r.start, r.end); } catch (e) {}
    try { if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); } catch (e) {}
    return i;
  }
  focusReviewCue(0, 0);
  return -1;
}
// ── ✔ Check words in the panel (1.52; the Studio has had it since 1.48) ──────
// One pass over the doubtful (orange) words: the Premiere playhead goes to the
// word; Enter = it is right (no longer doubtful) or the typed fix goes in and,
// one word for one word, is learned in 🧠; Tab = next, Shift+Tab = back,
// ↑ = to the word again, Esc = stop; Alt+1..3 = a suggestion (🧠 memory, this
// video's words, the Amharic dictionary). Every step is one undo.
const PCHK = { on: false, done: 0, note: '', at: [0, 0] };
function panelDoubts() {
  const out = [];
  reviewCues.forEach((c, i) => doubtRanges(c.text || '', c.doubt).forEach((r) => out.push({ i, start: r.start, end: r.end, word: String(c.text).slice(r.start, r.end) })));
  return out;
}
function panelCheckFixes() {
  let f = {};
  try { f = activeFixes(loadFixStore()); } catch (e) {}
  try { if (REVIEW_AUTOFIX && REVIEW_AUTOFIX.rules) f = Object.assign({}, f, REVIEW_AUTOFIX.rules); } catch (e) {}
  return f;
}
function startPanelCheck() {
  PCHK.on = true; PCHK.done = 0; PCHK.note = ''; PCHK.at = [0, 0];
  amhDict();
  showPanelCheck(false);
}
function stopPanelCheck() {
  PCHK.on = false;
  const c = $('chkCard');
  if (c) c.remove();
  const list = $('reviewList');
  if (list) Array.prototype.forEach.call(list.children || [], (r) => r.classList && r.classList.remove('chk-row'));
}
// the next doubtful word at/after PCHK.at (or before it, back); wraps around
function showPanelCheck(back) {
  if (!PCHK.on) return;
  const all = panelDoubts();
  const key = (d) => d.i * 1e6 + d.start;
  const at = PCHK.at[0] * 1e6 + PCHK.at[1];
  let d = back ? all.slice().reverse().find((x) => key(x) < at) : all.find((x) => key(x) >= at);
  if (!d) d = back ? all[all.length - 1] : all[0];
  let card = $('chkCard');
  const list = $('reviewList');
  if (!card) {
    card = document.createElement('div');
    card.id = 'chkCard';
    card.className = 'chk-card';
    if (list && list.parentNode) list.parentNode.insertBefore(card, list);
  }
  card.textContent = '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const head = el('div', 'chk-head');
  if (!d) {
    head.appendChild(el('b', 'chk-ok', '✓ ' + L('Every word is checked') + (PCHK.done ? ' (' + PCHK.done + ')' : '')));
    if (PCHK.note) head.appendChild(el('span', 'chk-note', PCHK.note));
    const x = el('button', 'chk-x', '✕'); x.type = 'button';
    x.addEventListener('click', stopPanelCheck);
    head.appendChild(x);
    card.appendChild(head);
    PCHK.on = false;
    setTimeout(() => { if (!PCHK.on) stopPanelCheck(); }, 4000);
    return;
  }
  PCHK.at = [d.i, d.start];
  head.appendChild(el('b', 'chk-left', '⚠ ' + all.length + ' ' + L('left')));
  if (PCHK.done) head.appendChild(el('span', '', '✓ ' + PCHK.done + ' ' + L('checked')));
  if (PCHK.note) head.appendChild(el('span', 'chk-note', PCHK.note));
  const x = el('button', 'chk-x', '✕'); x.type = 'button'; x.title = L('Stop') + ' (Esc)';
  x.addEventListener('click', stopPanelCheck);
  head.appendChild(x);
  card.appendChild(head);
  // the caption, the word marked
  const cue = reviewCues[d.i];
  const t = String(cue.text || '');
  const ctx = el('div', 'chk-ctx');
  ctx.appendChild(document.createTextNode(noEmph(t.slice(0, d.start))));
  ctx.appendChild(el('mark', '', noEmph(d.word)));
  ctx.appendChild(document.createTextNode(noEmph(t.slice(d.end))));
  card.appendChild(ctx);
  const row = el('div', 'chk-row-in');
  const was = noEmph(d.word).trim();
  const inp = el('input', 'chk-in');
  inp.type = 'text'; inp.value = was; inp.setAttribute('dir', 'auto');
  inp.setAttribute('data-amh-type', '1');
  const ok = el('button', 'btn btn-primary chk-okb', ''); ok.type = 'button';
  const sync = () => { ok.textContent = '✓ ' + (inp.value.replace(/\s+/g, ' ').trim() === was ? L('Correct') : L('Fix')); };
  inp.addEventListener('input', sync); sync();
  const wordTime = cue.start + (cue.end - cue.start) * (d.start / Math.max(1, t.length));
  const hear = () => { try { seekPlayhead(Math.max(0, wordTime - 0.3)); } catch (e) {} };
  const play = el('button', 'btn', '▶'); play.type = 'button'; play.title = L('To the word') + ' (↑)';
  const next = el('button', 'btn', '→'); next.type = 'button'; next.title = L('Skip') + ' (Tab)';
  [inp, ok, play, next].forEach((b) => row.appendChild(b));
  card.appendChild(row);
  const sug = suggestWords(d.word, reviewCues, panelCheckFixes(), 3, AMH_DICT);
  if (sug.length) {
    const sr = el('div', 'chk-sug');
    sug.forEach((w2, k) => {
      const b = el('button', '', w2); b.type = 'button'; b.title = 'Alt+' + (k + 1);
      b.addEventListener('click', () => { inp.value = w2; sync(); apply(); });
      sr.appendChild(b);
    });
    card.appendChild(sr);
  }
  if (list) {
    Array.prototype.forEach.call(list.children || [], (r, k) => r.classList && r.classList.toggle('chk-row', k === d.i));
    const r = list.children && list.children[d.i];
    try { if (r && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  hear();
  try { inp.focus(); inp.select(); } catch (e) {}
  function apply() {
    const v = inp.value.replace(/\s+/g, ' ').trim();
    const c = reviewCues[d.i];
    const clean = (w) => noEmph(String(w || '')).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (v === was) {
      pushReviewUndo('check');
      c.doubt = (c.doubt || []).filter((w) => clean(w) !== clean(was));
      PCHK.at = [d.i, d.end];
    } else {
      pushReviewUndo('edit');
      const s = String(c.text || '');
      const lead = (d.word.match(/^[*~]+/) || [''])[0], trail = (d.word.match(/[*~]+$/) || [''])[0];
      c.text = (s.slice(0, d.start) + (v ? lead + v + trail : '') + s.slice(d.end)).replace(/\s{2,}/g, ' ').trim();
      c.doubt = (c.doubt || []).filter((w) => clean(w) !== clean(was));
      if (v && !/\s/.test(v)) {
        try {
          const st = loadFixStore();
          rememberFix(st, was, v, true);
          saveFixStore(st);
          syncMemoryButton();
          PCHK.note = '🧠 ' + was + ' → ' + v;
        } catch (e) {}
      }
      PCHK.at = [d.i, d.start + (v ? (lead + v + trail).length : 0)];
    }
    PCHK.done++;
    renderReview();
    showPanelCheck(false);
  }
  ok.addEventListener('click', apply);
  play.addEventListener('click', hear);
  next.addEventListener('click', () => { PCHK.at = [d.i, d.end]; showPanelCheck(false); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    else if (e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) { PCHK.at = [d.i, d.start]; showPanelCheck(true); } else { PCHK.at = [d.i, d.end]; showPanelCheck(false); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hear(); }
    else if (e.key === 'Escape') { e.preventDefault(); stopPanelCheck(); }
    else if (e.altKey && /^[1-3]$/.test(e.key) && sug[Number(e.key) - 1]) { e.preventDefault(); inp.value = sug[Number(e.key) - 1]; sync(); apply(); }
  });
}
function initReviewSteps() {
  const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); fn(); }); };
  // ① Text: the doubtful words, one by one (1.52); none left -> the first caption
  on('stepText', () => { if (reviewDoubtCount() && !IS_APP_MODE()) startPanelCheck(); else goFirstDoubt(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F7' || IS_APP_MODE() || !$('review') || !$('review').classList.contains('show')) return;
    e.preventDefault();
    if (PCHK.on) stopPanelCheck(); else if (reviewDoubtCount()) startPanelCheck();
  });
  on('stepStyle', () => {
    const s = $('styleStrip');
    try { if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  });
  on('stepPlace', () => {
    const b = $('reviewPlace');
    if (!b) return;
    try { if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest' }); if (b.focus) b.focus(); } catch (e) {}
    b.classList.add('pulse');
    setTimeout(() => b.classList.remove('pulse'), 1400);
  });
}

// ── What will be captioned (1.16.25) ────────────────────────────────────────
// A line under Source, before Generate: the clip (or the edit) the panel would
// use right now, with its length — or, in orange, why there is nothing to use.
// Asked again when the mouse comes back to the panel (the editor just clicked
// something in the timeline), when the source changes, and after a run.
let SRC_PEEK_BUSY = false;
let SRC_PEEK_AT = 0;
async function refreshSourceLine(force) {
  const el = $('srcLine');
  if (!el || IS_APP_MODE()) return null;
  const now = Date.now();
  if (SRC_PEEK_BUSY || reviewOpen || (!force && now - SRC_PEEK_AT < 1500)) return null;
  if ($('runBtn') && $('runBtn').disabled && $('progWrap') && $('progWrap').style.display !== 'none') return null;   // a run is going
  SRC_PEEK_BUSY = true;
  SRC_PEEK_AT = now;
  const show = (ok, text) => { el.className = 'src-line ' + (ok ? 'ok' : 'warn'); el.textContent = text; el.style.display = ''; };
  try {
    if (SOURCE === 'clip') {
      const c = await getSelectedClip();
      if (c && c.ok && c.name) {
        const at = /playhead/.test(String(c.via || '')) ? ' · ' + L('the clip under the playhead') : '';
        show(true, '▶ ' + c.name + ' · ' + fmtDur(c.duration) + at);
      } else {
        show(false, '⚠ ' + L(IS_AE ? 'Select the layer with the speech in the composition.' : 'Select the clip with the speech on the timeline.'));
      }
    } else {
      const info = await getSequenceInfo(SOURCE === 'whole');
      const clips = ((info && info.clips) || []).filter((x) => !x.unsupported);
      if (info && info.ok && clips.length) {
        const a = Math.min.apply(null, clips.map((x) => x.timelineStart));
        const b = Math.max.apply(null, clips.map((x) => x.timelineStart + x.duration));
        show(true, '▶ ' + (info.sequence ? info.sequence + ' · ' : '') + clips.length + ' ' + L(clips.length === 1 ? 'clip' : 'clips') + ' · ' + fmtDur(b - a));
      } else {
        show(false, '⚠ ' + L(SOURCE === 'work' ? 'Nothing with speech inside the Work Area — move the Work Area bar over your video.' : 'No clips with speech in this sequence.'));
      }
    }
  } catch (e) {
    el.style.display = 'none';
  } finally {
    SRC_PEEK_BUSY = false;
  }
  return el.textContent;
}
function initSourceLine() {
  if (IS_APP_MODE()) return;
  const body = document.querySelector ? document.querySelector('.panel-body') : null;
  if (body) body.addEventListener('mouseenter', () => refreshSourceLine(false));
  window.addEventListener('focus', () => refreshSourceLine(false));
  document.querySelectorAll('#srcSeg button').forEach((b) => b.addEventListener('click', () => refreshSourceLine(true)));
  setTimeout(() => refreshSourceLine(true), 1200);
}

// ── Words per caption (1.16.25) ─────────────────────────────────────────────
// One row: 1 (karaoke) · 2 · 3 · 4 · 5 — instead of "Karaoke / Grouped" plus a
// number box (both kept, hidden, as the settings underneath).
function syncWpc() {
  const n = CAP === 'words' ? 1 : GROUP_SIZE;
  document.querySelectorAll('#wpcSeg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.wpc) === n));
}
function setWpc(n) {
  n = Math.max(1, Math.min(12, Number(n) || 1));
  CAP = n === 1 ? 'words' : 'grouped';
  if (n > 1) { GROUP_SIZE = n; if ($('groupSize')) $('groupSize').value = n; saveSettings({ group: n }); }
  saveSettings({ cap: CAP });
  document.querySelectorAll('#capSeg button').forEach((x) => x.classList.toggle('active', x.dataset.cap === CAP));
  syncWpc();
}

function nudgeReview(i, delta) {
  const cue = reviewCues[i];
  if (!cue) return;
  pushReviewUndo('shift');
  cue.start = Math.max(0, cue.start + delta);
  cue.end = Math.max(cue.start + 0.3, cue.end + delta);
  renderReview();
}

// Split at the cursor (snapped to the nearest space), or in the middle when
// the cursor is not inside the text. The time is shared by the length of the
// two halves. Returns the index of the second half, or -1.
function splitReview(i, pos) {
  const cue = reviewCues[i];
  if (!cue) return -1;
  const parts = splitTextAt(cue.text || '', pos);
  if (!parts) return -1;
  pushReviewUndo('split');
  const [first, second] = parts;
  const frac = (first.length + 1) / (first.length + second.length + 2);
  const cutAt = cue.start + (cue.end - cue.start) * Math.max(0.1, Math.min(0.9, frac));
  const original = cue.end;
  const keep = (words) => (words || []).filter((w) => doubtRanges(second, [w]).length);
  const secondCue = { start: Math.max(cue.start + 0.3, cutAt), end: original, text: second, _id: 'n' + (REVIEW_NEXT_ID++) };
  if (cue.speaker) secondCue.speaker = cue.speaker;
  if (cue.doubt) secondCue.doubt = keep(cue.doubt);
  if (cue._fixed) secondCue._fixed = keep(cue._fixed);
  cue.text = first;
  cue.end = secondCue.start;
  cue._caret = undefined;
  reviewCues.splice(i + 1, 0, secondCue);
  clearRowHint();
  renderReview();
  return i + 1;
}

function mergeReview(i) {
  if (!canJoin(i)) return;
  const cue = reviewCues[i];
  const next = reviewCues[i + 1];
  pushReviewUndo('join');
  cue.text = (cleanCueLines(cue.text) + ' ' + cleanCueLines(next.text)).trim();
  cue.end = next.end;
  if (next.doubt) cue.doubt = (cue.doubt || []).concat(next.doubt);
  if (next._fixed) cue._fixed = (cue._fixed || []).concat(next._fixed);
  reviewCues.splice(i + 1, 1);
  clearRowHint();
  renderReview();
}

function deleteReviewCue(i) {
  if (!reviewCues[i]) return;
  pushReviewUndo('delete');
  reviewCues.splice(i, 1);
  clearRowHint();
  renderReview();
}

// A new empty caption right after caption `i` (or at the end), in the gap
// when there is one. Returns its index.
function addReviewCue(i) {
  pushReviewUndo('add');
  const prev = i >= 0 ? reviewCues[i] : reviewCues[reviewCues.length - 1];
  const next = i >= 0 ? reviewCues[i + 1] : null;
  const start = prev ? prev.end : 0;
  const end = next ? Math.max(start + 0.3, Math.min(start + 2, next.start)) : start + 2;
  const at = i >= 0 ? i + 1 : reviewCues.length;
  reviewCues.splice(at, 0, { start, end, text: '', _id: 'n' + (REVIEW_NEXT_ID++) });
  renderReview();
  return at;
}

// The doubtful words still present in a cue's (possibly edited) text.
function cueDoubts(cue) {
  const t = String((cue && cue.text) || '');
  return ((cue && cue.doubt) || []).filter((w) => w && doubtRanges(t, [w]).length);
}
function closeRowMenus() {
  const list = $('reviewList');
  const open = list && list.querySelectorAll ? list.querySelectorAll('.row-more') : [];
  for (let k = 0; k < open.length; k++) open[k].classList.remove('open');
}
// Each caption box is exactly as tall as its text (one line = one line).
function fitReviewBox(ta) {
  if (!ta || !ta.style) return;
  ta.style.height = 'auto';
  if (ta.scrollHeight) ta.style.height = ta.scrollHeight + 'px';
}
function fitReviewBoxes() {
  const list = $('reviewList');
  const all = list && list.querySelectorAll ? list.querySelectorAll('textarea') : [];
  for (let k = 0; k < all.length; k++) fitReviewBox(all[k]);
}
function updateReviewCount() {
  const toCheck = reviewCues.filter((c) => cueDoubts(c).length).length;
  $('reviewCount').textContent = L(reviewCues.length + ' caption' + (reviewCues.length === 1 ? '' : 's')) +
    (toCheck ? ' · ⚠ ' + L(toCheck + ' to check') : '');
}

function writeReviewSrt(outDir) {
  // This file is what Premiere shows: speaker changes as "– ", never "[S1]".
  const out = displaySrtTextFromCues(reviewCues);
  const dest = path.join(outDir || os.tmpdir(), 'amh_review_' + Date.now() + '.srt');
  try { fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dest), 0o700); } catch (e) {}
  fs.writeFileSync(dest, out, { encoding: 'utf8', mode: 0o600 });
  protectTempFile(dest);
  return dest;
}

// ── Caption styles (1.11) ───────────────────────────────────────────────────
// Plain = the host's own captions (Premiere caption track / AE text layer),
// editable there. A style is drawn by our ffmpeg into a transparent video
// layer (amh_styles.py, Noto Sans Ethiopic) that goes on an empty video track
// above the footage. If anything fails, the plain captions are placed
// instead, so the editor never ends up with nothing. The strip only shows
// when this computer's ffmpeg can draw them (libass).
const STYLE_LIST = ['plain', 'glide', 'spotlight', 'bounce', 'karaoke', 'fill', 'highlight', 'bold', 'podcast', 'reveal', 'typewriter',
  'pop', 'word', 'impact', 'neon', 'retro', 'habesha', 'cinema', 'clean'];
// the newest looks get a small NEW mark on their button
const STYLE_NEW = [];   // 1.49: none "new" now
const STYLE_NAMES = {
  plain: 'Plain', glide: 'Glide', spotlight: 'Spotlight', bounce: 'Bounce', karaoke: 'Karaoke', fill: 'Fill', highlight: 'Highlight', bold: 'Bold', podcast: 'Podcast',
  reveal: 'Reveal', typewriter: 'Typewriter', pop: 'Pop', word: 'Word', impact: 'Impact', neon: 'Neon',
  retro: 'Retro', habesha: 'Habesha', cinema: 'Cinema', clean: 'Clean',
};
let STYLE = 'plain';
let STYLE_OK = false;
// Customize starts closed for every caption: it opens only when pressed.
let STYLE_CUSTOM_OPEN = false;
function styleFilesHere() {
  try {
    return !!(RUNTIME && FFMPEG && fs.existsSync(runtimePath('amh_styles.py')) && fs.existsSync(runtimePath('fonts')));
  } catch (e) { return false; }
}
function checkStyles() {
  if (!styleFilesHere()) { STYLE_OK = false; renderStyleStrip(); return Promise.resolve(false); }
  return new Promise((resolve) => {
    try {
      execFile(FFMPEG, ['-hide_banner', '-filters'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
        STYLE_OK = !err && / subtitles /.test(String(stdout || ''));
        renderStyleStrip();
        resolve(STYLE_OK);
      });
    } catch (e) { STYLE_OK = false; renderStyleStrip(); resolve(false); }
  });
}
function styleNote() {
  if (STYLE === 'plain') {
    return IS_APP_MODE() ? 'Plain: the .srt file only — style it in your editor.'
      : 'Plain: ' + HOST_NAME + '\'s own captions — you can edit and restyle them there.';
  }
  const what = IS_APP_MODE() ? 'Saves the video with these captions drawn in, next to your video.'
    : 'Drawn as a video layer on an empty track above your video.';
  return LICENSED ? what : what + ' Free version: a small "Amharic Captions Pro" tag is added — a license removes it.';
}
function IS_APP_MODE() { return typeof window !== 'undefined' && !!window.__amhApp; }
// ── My styles (1.13) ─────────────────────────────────────────────────────────
// A customized look saved under a name ("My channel", "Client X"): its own
// button in the strip, one click to use it again. Kept on this computer.
const MY_MAX = 20;
function myStyles() {
  const l = loadSettings().myStyles;
  if (!Array.isArray(l)) return [];
  return l.filter((x) => x && typeof x.name === 'string' && x.name.trim() && STYLE_LIST.indexOf(x.style) > 0 && x.id)
    .slice(0, MY_MAX);
}
function sameLook(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function activeMyStyle() {
  const cur = styleOpts(STYLE);
  return myStyles().find((x) => x.style === STYLE && sameLook(styleOpts(null, x.opts), cur)) || null;
}
function saveMyStyle(name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name || STYLE === 'plain') return false;
  const list = myStyles().filter((x) => x.name.toLowerCase() !== name.toLowerCase());
  if (list.length >= MY_MAX) list.shift();
  // unique even for two saves in the same millisecond (same id = ✕ deleted both)
  let id = 'm' + Date.now().toString(36);
  for (let n = 1; list.some((x) => x.id === id); n++) id = 'm' + Date.now().toString(36) + '_' + n;
  list.push({ id, name, style: STYLE, opts: styleOpts(STYLE) });
  saveSettings({ myStyles: list });
  renderStyleStrip();
  const note = $('styleNote');
  if (note) note.textContent = '★ ' + L('Saved as') + ' "' + name + '"';
  return true;
}
function applyMyStyle(id) {
  const m = myStyles().find((x) => x.id === id);
  if (!m) return;
  const all = loadSettings().styleOpts || {};
  all[m.style] = styleOpts(null, m.opts);
  STYLE = m.style;
  saveSettings({ style: m.style, styleOpts: all });
  renderStyleStrip();
  schedulePreview();
}
function deleteMyStyle(id) {
  saveSettings({ myStyles: myStyles().filter((x) => x.id !== id) });
  renderStyleStrip();
}
function styleChip(id, label, img, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'style-chip';
  b.title = label;
  const pic = document.createElement('img');
  pic.src = 'img/styles/' + img + '.jpg';
  pic.alt = '';
  const name = document.createElement('span');
  name.textContent = label;
  b.appendChild(pic);
  b.appendChild(name);
  b.addEventListener('click', onClick);
  return b;
}
function renderStyleStrip() {
  syncReviewSteps();
  const strip = $('styleStrip');
  const chips = $('styleChips');
  if (!strip || !chips) return;
  strip.style.display = STYLE_OK ? '' : 'none';
  if (!STYLE_OK) return;
  const mine = activeMyStyle();
  const list = myStyles();
  // Rebuilt only when the saved looks change: rebuilding on every click
  // would also jump the strip back to the start after scrolling to a style.
  const sig = JSON.stringify(list.map((m) => [m.id, m.name, m.style, m.opts && m.opts.color]));
  if (chips.dataset.sig === sig && chips.children.length) {
    for (const b of Array.from(chips.children)) {
      const on = b.dataset.my ? !!mine && mine.id === b.dataset.my : b.dataset.style === STYLE && !mine;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const n0 = $('styleNote');
    if (n0) n0.textContent = L(styleNote());
    renderStyleCustom();
    return;
  }
  chips.dataset.sig = sig;
  chips.textContent = '';
  const builtIn = (id) => {
    const b = styleChip(id, STYLE_NAMES[id], id, () => {
      STYLE = id;
      saveSettings({ style: id });
      renderStyleStrip();
      schedulePreview();
    });
    b.dataset.style = id;
    if (STYLE_NEW.indexOf(id) >= 0) {
      const tag = document.createElement('i');
      tag.className = 'style-new';
      tag.textContent = L('NEW');
      b.appendChild(tag);
    }
    const on = id === STYLE && !mine;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    chips.appendChild(b);
  };
  builtIn('plain');
  list.forEach((m) => {
    const b = styleChip(m.id, m.name, m.style, () => applyMyStyle(m.id));
    b.classList.add('mine');
    b.dataset.style = m.style;
    b.dataset.my = m.id;
    if (m.opts && m.opts.color) b.style.setProperty('--my-color', m.opts.color);
    const on = !!mine && mine.id === m.id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const star = document.createElement('i');
    star.className = 'my-star';
    star.textContent = '★';
    b.appendChild(star);
    const del = document.createElement('i');
    del.className = 'my-del';
    del.textContent = '✕';
    del.title = L('Delete');
    del.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); deleteMyStyle(m.id); });
    b.appendChild(del);
    chips.appendChild(b);
  });
  STYLE_LIST.slice(1).forEach(builtIn);
  const note = $('styleNote');
  if (note) note.textContent = L(styleNote());
  renderStyleCustom();
}
function styleCues(cues) {
  return (cues || []).filter((c) => (c.text || '').trim()).map((c) => [String(c.text).replace(/~/g, '').replace(/\s+/g, ' ').trim(), c.start, c.end]);
}
// Runs runtime/amh_styles.py render: "[style] 0.42" progress lines, then one
// JSON line {ok, out, t0, duration}.
function renderStyled(job, onProgress) {
  return new Promise((resolve, reject) => {
    const jobPath = path.join(os.tmpdir(), 'amh_style_job_' + Date.now() + '_' + Math.floor(Math.random() * 1e5) + '.json');
    const drop = () => { try { fs.unlinkSync(jobPath); } catch (e) {} };
    let child;
    try {
      fs.writeFileSync(jobPath, JSON.stringify(Object.assign({ ffmpeg: FFMPEG, fonts: runtimePath('fonts') }, job)),
        { encoding: 'utf8', mode: 0o600 });
      child = spawn(PYTHON, ['-E', '-s', runtimePath('amh_styles.py'), 'render', jobPath], { env: AMH_ENV, windowsHide: true });
    } catch (e) { drop(); reject(e); return; }
    activeChild = child;
    let out = '';
    let result = null;
    child.stdout.on('data', (buf) => {
      out += buf.toString('utf8');
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        const m = /^\[style\] ([\d.]+)$/.exec(line);
        if (m) { if (onProgress) onProgress(Number(m[1])); continue; }
        if (line.charAt(0) === '{') { try { result = JSON.parse(line); } catch (e) {} }
      }
    });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      if (activeChild === child) activeChild = null;
      drop();
      if (result && result.ok) resolve(result);
      else reject(new Error((result && result.error) || 'the styled captions could not be drawn'));
    });
    child.on('error', (e) => { if (activeChild === child) activeChild = null; drop(); reject(e); });
  });
}
// Premiere / After Effects: render the transparent layer at the sequence's
// size and rate, then put it above the footage.
// ── Styled captions you can edit (1.27.0) ───────────────────────────────────
// Premiere: every caption on screen is its own clip (cut from one rendered
// file), so it can be moved, trimmed or deleted on its own. Placing again
// after an edit (Recent, or "✎ Edit the selected caption") redraws only the
// captions that changed. Any trouble -> one layer for all, as before.
let STYLED_PREV = null;          // the placement a reopened review came from
let STYLED_LAST = null;          // the placement just made (saved in Recent)
const hostCall = (fn, obj, ms) => evalScript(fn + '(' + escJson(escJson(obj)) + ')', ms || 60000);
async function placeSpans(file, spans, base, prep, show, done, total) {
  const CH = 40;
  for (let i = 0; i < spans.length; i += CH) {
    const res = await hostCall('amh_overlaySpans', { itemName: prep.itemName, track: prep.track, base, spans: spans.slice(i, i + CH), check: i === 0 });
    if (!res || !res.ok) {
      const e = new Error((res && res.error) || HOST_NAME + ' did not place the captions');
      e.range = !!(res && res.range);
      throw e;
    }
    done += res.placed || 0;
    if (show) show(0.5 + 0.5 * Math.min(1, done / Math.max(1, total)), L('Placing captions') + ' ' + done + '/' + total);
  }
  return done;
}
async function placeStyled(cues, label, startSeconds) {
  const fr = await evalScript('amharic_getFrame()');
  if (!fr || !fr.ok) throw new Error((fr && fr.error) || 'could not read the sequence frame size');
  const btn = $('reviewPlace');
  if (btn && btn.dataset.styleLabel === undefined) btn.dataset.styleLabel = btn.textContent;
  const show = (x, what) => { if (btn) btn.textContent = '⏳ ' + (what || L('Styling captions…')) + ' ' + Math.round(Math.max(0, Math.min(1, x)) * 100) + '%'; };
  show(0);
  const prefix = 'amhstyle_' + safeFileName(label || 'captions') + '__';
  const sc = styleCues(cues);
  const opts = styleOpts(STYLE);
  const base0 = Number(startSeconds) || 0;
  const job = (list, out) => ({ cues: list, style: STYLE, opts, width: fr.width, height: fr.height, fps: fr.fps, out, mode: 'overlay', tag: !LICENSED });
  const newOut = () => path.join(ensureCaptionsDir(), prefix + STYLE + '_' + Date.now() + '.mov');
  STYLED_LAST = null;
  const prev = STYLED_PREV;
  // an edit of captions placed as clips: only the changed ones are drawn again
  if (!IS_AE && prev && prev.mode === 'cut' && prev.prefix === prefix && prev.style === STYLE && JSON.stringify(prev.opts) === JSON.stringify(opts) &&
      Math.abs((Number(prev.start) || 0) - base0) < 1e-6 && prev.frame && prev.frame.width === fr.width && prev.frame.height === fr.height) {
    const plan = styledUpdatePlan(prev.cues, sc);
    if (!plan.whole) {
      try {
        let file = null, done = 0, track = prev.track;
        const total = plan.windows.length;
        for (let k = 0; k < plan.windows.length; k++) {
          const w = plan.windows[k];
          const from = base0 + w.start - 0.05, to = base0 + w.end + 0.6;
          if (!w.cues.length) { await hostCall('amh_removeStyledRange', { replacePrefix: prefix, rangeStart: from, rangeEnd: to }); continue; }
          const r = await renderStyled(job(w.cues, newOut()), (x) => show((k + x * 0.5) / Math.max(1, total), L('Updating captions…')));
          const prep = await hostCall('amh_overlayPrepare', { path: r.out, rangeStart: Math.min(from, base0 + r.t0), rangeEnd: Math.max(to, base0 + r.t0 + r.duration),
            replacePrefix: prefix, preferTrack: track });
          if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'prepare');
          track = prep.track;
          await placeSpans(r.out, r.spans || [], base0 + (r.t0 || 0), prep, null, 0, 0);
          file = r.out; done++;
        }
        STYLED_LAST = { mode: 'cut', prefix, style: STYLE, opts, start: base0, frame: { width: fr.width, height: fr.height }, cues: sc, track };
        log('✓ Updated only the changed captions (' + plan.windows.length + (plan.windows.length === 1 ? ' place' : ' places') + ').');
        return { file: file || '', track, addedTrack: false, replaced: done, updated: plan.windows.length };
      } catch (e) {
        log('Could not update only the changed captions (' + (e && e.message ? e.message : e) + ') — placing them all again.');
      }
    }
  }
  const out = newOut();
  const r = await renderStyled(job(sc, out), (x) => show(IS_AE ? x : x * 0.5));
  const base = base0 + (r.t0 || 0);
  if (!IS_AE && Array.isArray(r.spans) && r.spans.length) {
    try {
      const prep = await hostCall('amh_overlayPrepare', { path: r.out, rangeStart: base, rangeEnd: base + (r.duration || 0), replacePrefix: prefix });
      if (!prep || !prep.ok) throw new Error((prep && prep.error) || 'prepare');
      await placeSpans(r.out, r.spans, base, prep, show, 0, r.spans.length);
      STYLED_LAST = { mode: 'cut', prefix, style: STYLE, opts, start: base0, frame: { width: fr.width, height: fr.height }, cues: sc, track: prep.track };
      return { file: r.out, track: prep.track, addedTrack: prep.addedTrack, replaced: prep.replaced || 0, clips: r.spans.length };
    } catch (e) {
      if (!e.range) throw e;
      log('This ' + HOST_NAME + ' did not cut the captions into clips (' + e.message + ') — placing them as one layer.');
    }
  }
  const args = escJson({ path: r.out, startSeconds: base, duration: r.duration || 0, replacePrefix: prefix });
  const pl = await evalScript('amh_placeOverlay(' + escJson(args) + ')', 60000);
  if (!pl || !pl.ok || pl.placed !== true) throw new Error((pl && pl.error) || HOST_NAME + ' did not confirm the styled captions');
  STYLED_LAST = { mode: 'layer', prefix, style: STYLE, opts, start: base0, frame: { width: fr.width, height: fr.height }, cues: sc, track: pl.track };
  return { file: r.out, track: pl.track, addedTrack: pl.addedTrack, replaced: pl.replaced || 0 };
}

// "✎ Edit the selected caption": a styled caption clip selected on the
// Premiere timeline opens that caption in the review (via Recent).
let SELCAP_AT = 0;
let SELCAP_BUSY = false;
function findStyledRecent(sel) {
  const mid = (Number(sel.start) + Number(sel.end)) / 2;
  return readHistory().find((h) => {
    const pl = h.placed;
    if (!pl || pl.mode !== 'cut' || String(sel.name).indexOf(pl.prefix) !== 0) return false;
    const cs = h.cues;
    const a = (Number(h.startSeconds) || 0) + Number(cs[0].start), z = (Number(h.startSeconds) || 0) + Number(cs[cs.length - 1].end);
    return mid >= a - 1 && mid <= z + 2;
  }) || null;
}
async function checkSelectedCaption() {
  const bar = $('selCapBar');
  if (!bar || IS_AE || SELCAP_BUSY) return;
  if (reviewOpen) { bar.style.display = 'none'; return; }
  SELCAP_BUSY = true;
  try {
    const r = await evalScript('amh_selectedStyled()', 5000);
    const rec = r && r.ok && !r.none ? findStyledRecent(r) : null;
    if (!rec) { bar.style.display = 'none'; return; }
    const t = (Number(r.start) + Number(r.end)) / 2 - (Number(rec.startSeconds) || 0);
    const dist = (c) => (t < Number(c.start) ? Number(c.start) - t : (t > Number(c.end) ? t - Number(c.end) : 0));
    const cue = rec.cues.reduce((best, c) => (dist(c) < dist(best) ? c : best), rec.cues[0]);
    bar.textContent = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-primary sel-cap-btn';
    b.textContent = '✎ ' + L('Edit the selected caption');
    b.addEventListener('click', () => editSelectedCaption(rec, t));
    const txt = document.createElement('span');
    txt.className = 'sel-cap-text';
    txt.textContent = '“' + String(cue.text || '').replace(/[*~]/g, '').slice(0, 40) + '”';
    bar.appendChild(b);
    bar.appendChild(txt);
    bar.style.display = '';
  } catch (e) {
    bar.style.display = 'none';
  } finally { SELCAP_BUSY = false; }
}
async function editSelectedCaption(rec, t) {
  const bar = $('selCapBar');
  if (bar) bar.style.display = 'none';
  if (!(await reopenHistory(rec))) return;
  let best = 0;
  (reviewCues || []).forEach((c, i) => { if (Math.abs((c.start + c.end) / 2 - t) < Math.abs((reviewCues[best].start + reviewCues[best].end) / 2 - t)) best = i; });
  if (typeof focusReviewCue === 'function' && reviewCues && reviewCues.length) focusReviewCue(best, 0);
}
// asked when the editor comes back to the panel (no polling while it is away)
function selCapSoon() {
  if (IS_AE || Date.now() - SELCAP_AT < 1500) return;
  SELCAP_AT = Date.now();
  checkSelectedCaption();
}
document.addEventListener('mousemove', selCapSoon, { passive: true });
window.addEventListener('focus', selCapSoon);

// ── Install the Amharic fonts on this computer (1.28.0) ──────────────────────
// runtime/amh_styles.py install-fonts: this user's font folder (no admin),
// so Premiere's own titles, CapCut and DaVinci get the same 12 fonts.
function installFonts() {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      child = spawn(PYTHON, ['-E', '-s', runtimePath('amh_styles.py'), 'install-fonts', runtimePath('fonts')], { env: AMH_ENV, windowsHide: true });
    } catch (e) { reject(e); return; }
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => {
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch (e) {}
      if (r && r.ok) resolve(r); else reject(new Error((r && r.error) || 'the fonts could not be installed'));
    });
  });
}
// ── the Amharic dictionary for ✔ Check words (1.52) ─────────────────────────
// The language model's words used at least twice (~69,000), made ONCE into a
// small text file (Python reads the model in about half a second) and kept in
// the captions folder; until it exists the suggestions come without it.
let AMH_DICT = null;
let AMH_DICT_BUSY = false;
function amhDictFile() { return path.join(USER_CAPTIONS_DIR, '.cache', 'amh_words_v1.txt'); }
function amhDict() {
  if (AMH_DICT) return AMH_DICT;
  const f = amhDictFile();
  try {
    if (fs.existsSync(f)) { AMH_DICT = dictFromText(fs.readFileSync(f, 'utf8')); return AMH_DICT; }
  } catch (e) {}
  if (!AMH_DICT_BUSY) makeAmhDict();
  return null;
}
function makeAmhDict() {
  let lm = '';
  try { lm = runtimePath('amh_lm.json.gz'); } catch (e) {}
  if (!lm || !fs.existsSync(lm) || typeof PYTHON === 'undefined' || !fs.existsSync(PYTHON)) return;
  const f = amhDictFile();
  const tmp = f + '.part';
  const code = 'import gzip,json,re,sys\n' +
    "d=json.load(gzip.open(sys.argv[1],'rt',encoding='utf-8'))['counts']\n" +
    "e=re.compile('^[\\u1200-\\u137F]+$')\n" +
    'w=sorted(((k,v) for k,v in d.items() if v>=2 and e.match(k)),key=lambda x:-x[1])\n' +
    "open(sys.argv[2],'w',encoding='utf-8').write('\\n'.join(k+'\\t'+str(v) for k,v in w))\n";
  AMH_DICT_BUSY = true;
  try {
    if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
    const child = spawn(PYTHON, ['-E', '-s', '-c', code, lm, tmp], { env: AMH_ENV, windowsHide: true });
    child.on('error', () => { AMH_DICT_BUSY = false; });
    child.on('close', () => {
      AMH_DICT_BUSY = false;
      try { if (fs.existsSync(tmp)) fs.renameSync(tmp, f); } catch (e) {}
    });
  } catch (e) { AMH_DICT_BUSY = false; }
}
async function installFontsClick(btn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '⏳ ' + L('Installing the fonts…');
  try {
    const r = await installFonts();
    const n = (r.installed || []).length + (r.already || []).length;
    btn.textContent = '✓ ' + L('Fonts installed') + ' (' + n + ')';
    log(L('Amharic fonts installed on this PC') + ' (' + n + '): ' + r.dir + ' — ' +
      L('restart Premiere, CapCut or DaVinci to see them in their own font lists.'));
    if ((r.failed || []).length) log('Not installed: ' + r.failed.join('; '));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '⬇ ' + L('Install these fonts on this PC');
    log(L('The fonts could not be installed') + ': ' + (e && e.message ? e.message : e));
  }
}

// ── Customize + live preview (1.12) ──────────────────────────────────────────
// Per style: highlight colour, text colour, size, position (incl. TikTok-safe),
// words per line, box. Remembered per style. The preview is a few seconds of
// THIS video's first captions, drawn by the same code that places them.
const STYLE_COLORS = ['', '#FFE500', '#39FF14', '#FF3B30', '#2F80ED', '#FF2D95', '#FF9500', '#FFFFFF'];
const TEXT_COLORS = ['', '#FFFFFF', '#000000', '#FFE500'];
const STYLE_SIZES = ['s', 'm', 'l', 'xl'];
const STYLE_POS = ['bottom', 'middle', 'top', 'safe'];
const STYLE_WORDS = [0, 1, 2, 3, 4, 5];
// The Amharic fonts in runtime/fonts (amh_styles.FONTS ids), all OFL.
// Entrance animations (amh_styles.ANIMS); Auto = the style's own.
const STYLE_ANIMS = [['auto', 'Auto'], ['none', 'None'], ['fade', 'Fade'], ['slide', '↑ Slide'], ['drop', '↓ Slide'],
  ['pop', 'Pop'], ['zoom', 'Zoom'], ['blur', 'Blur'],
  // 1.40 animation pack
  ['typewriter', '⌨ Typing'], ['wave', '〰 Wave'], ['slidecolor', '↑ Slide + colour'], ['shake', 'Shake'], ['glow', '✨ Glow'], ['blurzoom', 'Blur zoom']];
const STYLE_FONTS = [['sans', 'Modern'], ['menbere', 'Rounded'], ['serif', 'Classic'], ['abyssinica', 'Traditional'],
  // 1.28.0
  ['yebse', 'Heavy'], ['washra', 'Bold'], ['agbalumo', 'Playful'], ['tint', 'Brush'], ['fantuwua', 'Handwritten'],
  ['jiret', 'Book'], ['hibur', 'Typewriter'], ['gothic', 'Ornate']];
let STYLE_FRAME = null;          // { width, height } of the sequence / video
let PREVIEW_TIMER = null;
let PREVIEW_SEQ = 0;
// The footage behind the captions being reviewed (1.16.14): the style preview
// plays the editor's own video under the captions. Each item: a media file and
// the caption-time range it covers; source second = caption second + offset.
let PREVIEW_MEDIA = [];
function setPreviewMedia(list) {
  PREVIEW_MEDIA = (list || []).filter((m) => m && m.path)
    .map((m) => ({ path: m.path, offset: Number(m.offset) || 0, from: Number(m.from) || 0, to: Number(m.to) || 1e12 }));
}
function previewMediaFor(cues) {
  const t = cues.length ? Number(cues[0][1]) || 0 : 0;
  return PREVIEW_MEDIA.find((m) => t >= m.from - 0.5 && t < m.to) || null;
}
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
// Size (1.32): a slider, 60-180 % (S/M/L/XL of older settings still work).
const SIZE_STEP = { s: 0.8, m: 1, l: 1.2, xl: 1.45 };
function cleanSize(v) {
  if (STYLE_SIZES.indexOf(v) >= 0) return v;
  const n = typeof v === 'number' ? v : NaN;
  return n >= 0.6 && n <= 1.8 ? Math.round(n * 20) / 20 : 'm';
}
function sizeNum(v) { return typeof v === 'number' ? v : (SIZE_STEP[v] || 1); }
// Height (1.32): where the caption's bottom edge sits, 0-1 of the frame from
// the top (dragged in the Studio player, or the ↕ slider). null = Position.
function cleanY(v) {
  const n = typeof v === 'number' ? v : NaN;
  return n >= 0.1 && n <= 0.97 ? Math.round(n * 1000) / 1000 : null;
}
// About where a Position puts the bottom edge (the ↕ slider's start)
function posBottom(pos) {
  const tall = FORMAT === 'v' || (STYLE_FRAME && STYLE_FRAME.height > STYLE_FRAME.width);
  return { bottom: tall ? 0.76 : 0.9, middle: 0.54, top: 0.16, safe: tall ? 0.7 : 0.84 }[pos] || 0.85;
}
function styleOpts(style, raw) {
  const all = raw ? null : (loadSettings().styleOpts || {});
  const o = raw || all[style || STYLE] || {};
  return {
    color: HEX_COLOR.test(o.color || '') ? o.color.toUpperCase() : '',
    text: HEX_COLOR.test(o.text || '') ? o.text.toUpperCase() : '',
    size: cleanSize(o.size),
    pos: STYLE_POS.indexOf(o.pos) >= 0 ? o.pos : 'bottom',
    y: cleanY(o.y),
    words: STYLE_WORDS.indexOf(Number(o.words)) >= 0 ? Number(o.words) : 0,
    box: !!o.box,
    font: STYLE_FONTS.some((f) => f[0] === o.font) ? o.font : 'sans',
    anim: STYLE_ANIMS.some((a) => a[0] === o.anim) ? o.anim : 'auto',
    emph: o.emph === 'off' ? 'off' : 'auto',
    lines: Number(o.lines) === 2 ? 2 : 1,          // 1.50: two balanced lines per caption
  };
}
function setStyleOpt(key, value) {
  const s = loadSettings();
  const all = s.styleOpts || {};
  const o = styleOpts(STYLE);
  o[key] = value;
  if (key === 'pos') o.y = null;          // a Position button: its own height again
  all[STYLE] = o;
  saveSettings({ styleOpts: all });
  renderStyleCustom();
  schedulePreview();
}
function resetStyleOpts() {
  const s = loadSettings();
  const all = s.styleOpts || {};
  delete all[STYLE];
  saveSettings({ styleOpts: all });
  renderStyleCustom();
  schedulePreview();
}
// Dark check mark on a light colour, white on a dark one.
function inkFor(hex) {
  if (!HEX_COLOR.test(hex || '')) return '#ffffff';
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#111111' : '#ffffff';
}
function scRow(parent, label) {
  const row = document.createElement('div');
  row.className = 'sc-row';
  const l = document.createElement('span');
  l.className = 'sc-label';
  l.textContent = L(label);
  row.appendChild(l);
  parent.appendChild(row);
  return row;
}
// Round swatches (✓ on the chosen one), "Auto" = the style's own colour,
// and a rainbow swatch that opens the full colour picker (any brand colour).
function colorRow(parent, label, presets, current, key) {
  const row = scRow(parent, label);
  const box = document.createElement('span');
  box.className = 'sc-swatches';
  const add = (value, cls, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-sw' + (cls ? ' ' + cls : '');
    b.dataset.value = value;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (value && cls !== 'custom') b.style.background = value;
    b.classList.toggle('active', value === current && (cls !== 'custom' || presets.indexOf(current) < 0));
    b.style.setProperty('--sw-ink', inkFor(value));
    box.appendChild(b);
    return b;
  };
  presets.forEach((c) => {
    const b = add(c, c ? '' : 'auto', c ? c : L('Style colour'));
    b.addEventListener('click', () => setStyleOpt(key, c));
  });
  const own = current && presets.indexOf(current) < 0 ? current : '';
  const custom = add(own || '#custom', 'custom', L('Any colour…'));
  if (own) { custom.style.background = own; custom.classList.add('picked'); custom.classList.add('active'); }
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'sc-color-input';
  input.value = own || current || '#FFE500';
  input.tabIndex = -1;
  input.addEventListener('change', () => setStyleOpt(key, String(input.value).toUpperCase()));
  custom.addEventListener('click', () => { try { input.click(); } catch (e) {} });
  box.appendChild(input);
  row.appendChild(box);
}
function segRow(parent, label, items, current, key, pills) {
  const row = scRow(parent, label);
  const box = document.createElement('span');
  box.className = pills ? 'sc-seg pills' : 'sc-seg';
  items.forEach(([value, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-opt';
    b.textContent = text;
    b.dataset.value = String(value);
    b.classList.toggle('active', value === current);
    b.setAttribute('aria-pressed', value === current ? 'true' : 'false');
    b.addEventListener('click', () => setStyleOpt(key, value));
    box.appendChild(b);
  });
  row.appendChild(box);
  return row;
}
// A slider (1.32): `live` while it moves (the Studio shows it in the video at
// once), `done` when let go (saved, and the captions are drawn again).
function rangeRow(parent, label, min, max, step, value, fmt, live, done, cls) {
  const row = /(^|\s)sc-row(\s|$)/.test(parent.className || '') ? parent : scRow(parent, label);
  const box = document.createElement('span');
  box.className = 'sc-range' + (cls ? ' ' + cls : '');
  if (row === parent) {
    const l = document.createElement('span');
    l.className = 'sc-rlab';
    l.textContent = label;
    box.appendChild(l);
  }
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', L(label));
  const out = document.createElement('span');
  out.className = 'sc-rval';
  out.textContent = fmt(value);
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); if (live) live(v); });
  input.addEventListener('change', () => done(Number(input.value)));
  box.appendChild(input);
  box.appendChild(out);
  row.appendChild(box);
  return row;
}
function switchRow(parent, label, on, key) {
  const row = scRow(parent, label);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sc-switch';
  b.dataset.value = on ? 'true' : 'false';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', on ? 'true' : 'false');
  b.classList.toggle('on', on);
  b.addEventListener('click', () => setStyleOpt(key, !on));
  row.appendChild(b);
  row.className += ' sc-inline';
}
function renderStyleCustom() {
  const wrap = $('styleCustom');
  const opts = $('styleOpts');
  if (!wrap || !opts) return;
  const styled = STYLE_OK && STYLE !== 'plain';
  const open = styled && STYLE_CUSTOM_OPEN;
  const tog = $('styleCustomToggle');
  if (tog) {
    tog.style.display = styled ? '' : 'none';
    tog.textContent = (open ? '▾ ' : '⚙ ') + L('Customize');
    tog.classList.toggle('open', open);
    if (!tog.dataset.wired) {
      tog.dataset.wired = '1';
      tog.addEventListener('click', () => {
        STYLE_CUSTOM_OPEN = !STYLE_CUSTOM_OPEN;
        renderStyleCustom();
        schedulePreview();
      });
    }
  }
  wrap.style.display = open ? '' : 'none';
  if (!open) return;
  const o = styleOpts(STYLE);
  opts.textContent = '';
  const fontRow = segRow(opts, 'Font', STYLE_FONTS.map(([id, name]) => [id, L(name)]), o.font, 'font', true);
  if (fontRow) {
    fontRow.className = (fontRow.className || '') + ' wrap';
    const inst = document.createElement('button');
    inst.type = 'button';
    inst.className = 'sc-install';
    inst.id = 'fontInstall';
    inst.textContent = '⬇ ' + L('Install these fonts on this PC');
    inst.title = L('So Premiere titles, CapCut and DaVinci can use the same Amharic fonts.');
    inst.addEventListener('click', () => installFontsClick(inst));
    fontRow.appendChild(inst);
  }
  rangeRow(opts, 'Size', 60, 180, 5, Math.round(sizeNum(o.size) * 100), (v) => v + '%',
    (v) => { if (window.__amhCapLive) window.__amhCapLive({ size: v / 100 }); },
    (v) => setStyleOpt('size', v / 100));
  const posRow = segRow(opts, 'Position', [['bottom', L('Bottom')], ['middle', L('Middle')], ['top', L('Top')], ['safe', 'TikTok']],
    o.y === null ? o.pos : '', 'pos');
  if (posRow) {
    posRow.className = (posRow.className || '') + ' wrap';
    const y0 = o.y === null ? posBottom(o.pos) : o.y;
    rangeRow(posRow, '↕ ' + L('Exact height'), 10, 97, 1, Math.round(y0 * 100), (v) => (o.y === null && v === Math.round(y0 * 100) ? '' : v + '%'),
      (v) => { if (window.__amhCapLive) window.__amhCapLive({ y: v / 100, from: y0 }); },
      (v) => setStyleOpt('y', v / 100), 'sc-sub');
    if (document.documentElement.classList.contains('amh-studio')) {
      const dh = document.createElement('div');
      dh.className = 'sc-hint';
      dh.textContent = L('Or drag the caption up or down in the video.');
      posRow.appendChild(dh);
    }
  }
  colorRow(opts, 'Highlight colour', STYLE_COLORS, o.color, 'color');
  colorRow(opts, 'Text colour', TEXT_COLORS, o.text, 'text');
  segRow(opts, 'Pop words', [['auto', L('Numbers too')], ['off', L('My ★ only')]], o.emph, 'emph');
  const popHint = document.createElement('div');
  popHint.className = 'sc-hint';
  popHint.textContent = L('★ = click a word in a caption, then press the ★ next to it. Numbers and money can pop by themselves.');
  const popRow = opts.lastChild;            // the hint sits inside the Pop words row
  if (popRow) { popRow.className = (popRow.className || '') + ' wrap'; popRow.appendChild(popHint); }
  switchRow(opts, 'Box', o.box, 'box');
  segRow(opts, 'Animation', STYLE_ANIMS.map(([id, name]) => [id, L(name)]), o.anim, 'anim', true);
  segRow(opts, 'Lines', [[1, '1'], [2, '2']], o.lines, 'lines');
  segRow(opts, 'Words per caption', [[0, L('Auto')], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], o.words, 'words');
  if (!document.documentElement.classList.contains('amh-studio')) fontSamples(opts.firstChild);
  const foot = document.createElement('div');
  foot.className = 'sc-foot';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'sc-reset';
  reset.textContent = '↺ ' + L('Reset');
  reset.addEventListener('click', resetStyleOpts);
  foot.appendChild(reset);
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'sc-name';
  name.id = 'myStyleName';
  name.maxLength = 24;
  name.placeholder = L('Name, e.g. My channel');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sc-save';
  save.id = 'myStyleSave';
  save.textContent = '★ ' + L('Save as My style');
  const doSave = () => { if (saveMyStyle(name.value)) name.value = ''; else if (name.focus) name.focus(); };
  save.addEventListener('click', doSave);
  name.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); doSave(); } });
  foot.appendChild(name);
  foot.appendChild(save);
  opts.appendChild(foot);
  styleTabs(opts);
}
// ── 1.58: Customize in four tabs (owner: one long list was hard to use) ──────
// The rows stay in one list (same order as before); each belongs to a tab and
// only the open tab's rows show. Font · Colour · Place & lines · Motion — the
// order the caption apps use (captions.ai, CapCut, Descript). The Studio keeps
// its own one-column layout.
const STYLE_TABS = [['font', 'Font'], ['color', 'Colour'], ['place', 'Place & lines'], ['motion', 'Motion']];
const STYLE_ROW_TAB = ['font', 'font', 'place', 'color', 'color', 'color', 'color', 'motion', 'place', 'place'];
let STYLE_TAB = 'font';
const TAB_ICONS = {
  font: '<path d="M4 20 10 4h1l6 16M6.5 14h8"/><path d="M17 20v-6a2.5 2.5 0 0 1 5 0v6M17 17h5"/>',
  color: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  place: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15h10M9 18h6"/>',
  motion: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};
function styleTabs(opts) {
  const bar = $('styleTabs');
  const tabbed = !!bar && !document.documentElement.classList.contains('amh-studio');
  if (bar) bar.style.display = tabbed ? '' : 'none';
  if (opts.classList) opts.classList.toggle('tabbed', tabbed);
  if (!tabbed) return;
  bar.textContent = '';
  STYLE_TABS.forEach(([id, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sc-tab' + (id === STYLE_TAB ? ' active' : '');
    b.dataset.tab = id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', id === STYLE_TAB ? 'true' : 'false');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + TAB_ICONS[id] + '</svg>';
    const t = document.createElement('span');
    t.textContent = L(label);
    b.appendChild(t);
    b.addEventListener('click', () => { STYLE_TAB = id; styleTabs(opts); });
    bar.appendChild(b);
  });
  Array.from(opts.children).forEach((row, i) => {
    const tab = STYLE_ROW_TAB[i];
    if (tab) row.style.display = tab === STYLE_TAB ? '' : 'none';
  });
}
// Each font button says ሰላም in its own letters (W3C elreq: Ethiopic letter
// heights differ a lot between fonts, so a name alone does not show it).
// The shipped font files, read from the runtime (also in the Studio); on any
// trouble the button keeps the panel's font.
const FONT_FILES = { sans: 'NotoSansEthiopic-Bold.ttf', menbere: 'Menbere-Bold.ttf', serif: 'NotoSerifEthiopic-Bold.ttf',
  abyssinica: 'AbyssinicaSIL-Regular.ttf', yebse: 'yebse.ttf', washra: 'washrab.ttf', agbalumo: 'Agbalumo-Regular.ttf',
  tint: 'tint.ttf', fantuwua: 'fantuwua.ttf', jiret: 'jiret.ttf', hibur: 'HiburMono-Regular.ttf', gothic: 'yigezubisratgothic.ttf' };
const FONT_LOADED = {};
function fontFace(id) {
  if (FONT_LOADED[id] !== undefined) return FONT_LOADED[id];
  FONT_LOADED[id] = '';
  try {
    if (typeof FontFace !== 'function' || !document.fonts || !FONT_FILES[id]) return '';
    const fam = 'amhpv-' + id;
    const bin = atob(fileBase64(runtimePath('fonts', FONT_FILES[id])));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const f = new FontFace(fam, bytes.buffer);
    f.load().then((x) => { document.fonts.add(x); }).catch(() => {});
    FONT_LOADED[id] = fam;
  } catch (e) {}
  return FONT_LOADED[id];
}
function fontSamples(row) {
  const box = row && row.children && row.children[1];
  if (!box || !box.children) return;
  if (box.classList) box.classList.add('sc-fonts');
  Array.from(box.children).forEach((b) => {
    if (!b.dataset || !FONT_FILES[b.dataset.value]) return;
    const name = b.textContent;
    b.textContent = '';
    const sample = document.createElement('span');
    sample.className = 'sc-fsample';
    sample.textContent = 'ሰላም';
    const fam = fontFace(b.dataset.value);
    if (fam) sample.style.fontFamily = '"' + fam + '", "Noto Sans Ethiopic", sans-serif';
    const n = document.createElement('span');
    n.className = 'sc-fname';
    n.textContent = name;
    b.appendChild(sample);
    b.appendChild(n);
    b.title = name;
  });
}

// The preview picture as base64: the desktop app reads binary files through
// its own bridge (its readFileSync is text-only).
function fileBase64(p) {
  if (typeof fs.readBase64 === 'function') return fs.readBase64(p);
  return fs.readFileSync(p).toString('base64');
}
function previewFrame() {
  if (STYLE_FRAME && STYLE_FRAME.width && STYLE_FRAME.height) return STYLE_FRAME;
  return FORMAT === 'v' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}
// Asked once per review (the sequence can change between reviews).
async function loadStyleFrame() {
  STYLE_FRAME = null;
  if (IS_APP_MODE() || !STYLE_OK) return;
  try {
    const fr = await evalScript('amharic_getFrame()');
    if (fr && fr.ok && fr.width > 0 && fr.height > 0) STYLE_FRAME = { width: fr.width, height: fr.height };
  } catch (e) {}
}
function schedulePreview() {
  if (PREVIEW_TIMER) clearTimeout(PREVIEW_TIMER);
  PREVIEW_TIMER = setTimeout(renderPreview, 300);
}
async function renderPreview() {
  PREVIEW_TIMER = null;
  const img = $('stylePreview');
  const note = $('stylePreviewNote');
  if (!img || !STYLE_OK || STYLE === 'plain' || !reviewOpen || !STYLE_CUSTOM_OPEN) return;
  const cues = styleCues(reviewCues);
  if (!cues.length) return;
  const seq = ++PREVIEW_SEQ;
  if (note) { note.textContent = L('Making the preview…'); note.style.display = ''; }
  const fr = previewFrame();
  try {
    const media = previewMediaFor(cues);
    const r = await renderStyled(Object.assign({ cues, style: STYLE, opts: styleOpts(STYLE), width: fr.width, height: fr.height,
      mode: 'preview', out: path.join(os.tmpdir(), 'amh_style_preview_' + Date.now()), tag: !LICENSED },
      media ? { video: media.path, videoOffset: media.offset } : {}));
    if (seq !== PREVIEW_SEQ) return;              // a newer preview is on its way
    const b64 = fileBase64(r.out);
    try { fs.unlinkSync(r.out); } catch (e) {}
    img.src = 'data:image/' + (/\.gif$/i.test(r.out) ? 'gif' : 'webp') + ';base64,' + b64;
    img.style.display = '';
    if (note) note.style.display = 'none';
  } catch (e) {
    if (seq !== PREVIEW_SEQ) return;
    if (note) { note.textContent = L('No preview — the captions are still placed in this style.'); note.style.display = ''; }
  }
}

async function placeReview() {
  if (!reviewOpen || !REVIEW || reviewPlacing || REVIEW_LIVE) return;
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
    if (STYLE !== 'plain' && STYLE_OK) {
      log('Placing your captions in the "' + STYLE_NAMES[STYLE] + '" style (' + reviewCues.length + ')…');
      try {
        const st = await placeStyled(reviewCues, REVIEW.label || 'captions', REVIEW.startSeconds);
        if (!st.updated) {
          log('✓ Styled captions on track V' + st.track + (st.addedTrack ? ' (a new track)' : '') +
            (st.clips ? ' — ' + st.clips + ' clips, one per caption: select one in the timeline to edit it' : '') +
            (st.replaced ? ' — replaced the earlier styled captions' : '') + ': ' + st.file);
        }
        if (!LICENSED) log('Free version: a small "Amharic Captions Pro" tag is in the corner — a license removes it.');
        setSuccess('✓ Styled captions on timeline');
        track('placed');
        saveHistory(dest);
        closeReview(true);
        return;
      } catch (e) {
        log('The style could not be used (' + (e && e.message ? e.message : String(e)) + ') — placing plain captions instead.');
      }
    }
    log('Placing your edited captions (' + reviewCues.length + ')…');
    const placed = await finishImport(dest, REVIEW.label || 'captions', REVIEW.startSeconds);
    if (!placed) return; // keep the review and edits open for recovery
    // Premiere's caption item links to this file. Deleting it triggers a
    // "Locate file" prompt on every project open.
    log('Captions saved to ' + dest + '  (Premiere keeps a file link to this).');
    track('placed');
    saveHistory(dest);
    closeReview(true);
  } catch (e) {
    log('ERROR: placement failed: ' + (e && e.message ? e.message : String(e)));
  } finally {
    reviewPlacing = false;
    if (placeBtn) {
      placeBtn.disabled = false;
      if (placeBtn.dataset.styleLabel !== undefined) {
        placeBtn.textContent = placeBtn.dataset.styleLabel;
        delete placeBtn.dataset.styleLabel;
      }
    }
    if (discardBtn) discardBtn.disabled = false;
  }
}

// ── Recent captions: reopen and edit what was placed (1.16.15) ───────────────
// After a successful placement a small companion file is saved next to the
// .srt in Documents/AmharicCaptions (captions, style + options, name, timeline
// position, footage). "🕘 Recent" lists the newest; one tap reopens it in the
// review, and placing again REPLACES the old captions (same name = the
// existing replace rules for plain captions and styled layers).
// Safety: a reopened review works on a fresh TEMPORARY copy - the .srt that
// Premiere links to is never the review file (Place / Discard clean up the
// review file). Deleting an entry removes only the companion file.
const HISTORY_MAX = 30;
const HISTORY_EXT = '.amh.json';
function saveHistory(srtPath) {
  try {
    if (!srtPath || !REVIEW) return;
    const rec = {
      v: 1, at: Date.now(), srt: srtPath, label: REVIEW.label || 'captions',
      startSeconds: Number(REVIEW.startSeconds) || 0, host: HOST_NAME,
      style: STYLE_OK ? STYLE : 'plain', opts: (STYLE_OK && STYLE !== 'plain') ? styleOpts(STYLE) : null,
      media: PREVIEW_MEDIA.slice(0, 50),
      cues: (lastCues || []).map((c) => ({ start: c.start, end: c.end, text: c.text })),
      placed: (STYLED_LAST && STYLE_OK && STYLE === STYLED_LAST.style) ? STYLED_LAST : null,
    };
    fs.writeFileSync(srtPath + HISTORY_EXT, JSON.stringify(rec), { encoding: 'utf8', mode: 0o600 });
    const all = readHistory();
    all.slice(HISTORY_MAX).forEach((h) => { try { fs.unlinkSync(h.file); } catch (e) {} });
  } catch (e) {}
}
function readHistory() {
  const out = [];
  try {
    const dir = ensureCaptionsDir();
    fs.readdirSync(dir).filter((f) => f.endsWith(HISTORY_EXT)).forEach((f) => {
      try {
        const file = path.join(dir, f);
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (rec && rec.v === 1 && Array.isArray(rec.cues) && rec.cues.length) out.push(Object.assign(rec, { file }));
      } catch (e) {}
    });
  } catch (e) {}
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
function deleteHistory(file) {
  try { if (String(file).endsWith(HISTORY_EXT)) fs.unlinkSync(file); } catch (e) {}
}
async function reopenHistory(rec) {
  if (!rec || !Array.isArray(rec.cues) || !rec.cues.length) return false;
  if (reviewOpen) closeReview();
  hideRecent();
  lastCues = rec.cues.map((c) => ({ start: Number(c.start) || 0, end: Number(c.end) || 0, text: String(c.text || '') }));
  setPreviewMedia(rec.media || []);
  STYLED_PREV = rec.placed || null;
  if (rec.style && STYLE_LIST.indexOf(rec.style) >= 0) {
    STYLE = rec.style;
    const s = { style: rec.style };
    if (rec.opts && rec.style !== 'plain') {
      const all = loadSettings().styleOpts || {};
      all[rec.style] = styleOpts(rec.style, rec.opts);
      s.styleOpts = all;
    }
    saveSettings(s);
  }
  // a TEMPORARY copy: the review file is cleaned up after Place / Discard
  const tmp = path.join(os.tmpdir(), 'amh_reopen_' + Date.now() + '.srt');
  try { fs.writeFileSync(tmp, displaySrtTextFromCues(lastCues), { encoding: 'utf8', mode: 0o600 }); } catch (e) {}
  log('Reopened "' + rec.label + '" (' + lastCues.length + ' captions). Edit, then press Place — it replaces the old ones.');
  await openReview(tmp, rec.label, rec.startSeconds, { projectId: rec.label });
  return true;
}
function fmtWhen(ms) {
  const d = new Date(ms || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function hideRecent() {
  const box = $('recentBox');
  if (box) box.style.display = 'none';
}
function renderRecent() {
  const box = $('recentBox');
  const list = $('recentList');
  if (!box || !list) return;
  const items = readHistory().slice(0, HISTORY_MAX);
  list.textContent = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.textContent = L('No captions placed yet.');
    list.appendChild(empty);
  }
  items.forEach((rec) => {
    const row = document.createElement('div');
    row.className = 'recent-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'recent-open';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = rec.label;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = fmtWhen(rec.at) + ' · ' + (STYLE_NAMES[rec.style] || 'Plain') + ' · ' + rec.cues.length;
    open.appendChild(name);
    open.appendChild(meta);
    open.addEventListener('click', () => { reopenHistory(rec); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-del';
    del.title = L('Remove from this list');
    del.textContent = '✕';
    del.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); deleteHistory(rec.file); renderRecent(); });
    row.appendChild(open);
    row.appendChild(del);
    list.appendChild(row);
  });
}
function toggleRecent() {
  const box = $('recentBox');
  if (!box) return;
  const show = box.style.display === 'none' || !box.style.display;
  if (show) renderRecent();
  box.style.display = show ? 'block' : 'none';
}

function discardReview() {
  if (!reviewOpen || reviewPlacing) return;
  if (REVIEW_LIVE) {
    cancelRequested = true;
    try { if (activeChild) activeChild.kill(); } catch (e) {}
    try { if (warmChild && !warmChild.killed) warmChild.kill(); } catch (e) {}
  }
  log('Discarded — nothing was placed on the timeline.');
  closeReview();
}

// Export the (edited) captions as a set of files into a user-chosen folder.
// Writes <name>.srt + <name>.vtt + <name>.txt together (overwriting).
function exportReviewFiles() {
  if (!reviewOpen || REVIEW_LIVE) return;
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
    fs.writeFileSync(srt, displaySrtTextFromCues(cues), { encoding: 'utf8', mode: 0o600 });
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
    const j = addReviewCue(-1);
    focusReviewCue(j, 0);
  });
  const undoEdit = $('revUndo');
  if (undoEdit) undoEdit.addEventListener('click', undoReview);
  const memBtn = $('revMemory');
  if (memBtn) memBtn.addEventListener('click', toggleMemoryPanel);
  const cliBtn = $('revClient');
  if (cliBtn) cliBtn.addEventListener('click', toggleClientPanel);
  const cleanBtn = $('revCleanup');
  if (cleanBtn) {
    if (cleanupAvailable()) cleanBtn.addEventListener('click', () => toggleCleanupPanel('text'));
    else cleanBtn.style.display = 'none';                   // Premiere only
  }
  const silenceBtn = $('revSilence');
  if (silenceBtn) {
    if (cleanupAvailable()) silenceBtn.addEventListener('click', () => toggleCleanupPanel('silence'));
    else silenceBtn.style.display = 'none';                 // Premiere only
  }
  initReviewSteps();
  initSourceLine();
  const zoomBtn = $('revZoom');
  if (zoomBtn) {
    if (cleanupAvailable()) zoomBtn.addEventListener('click', toggleZoomPanel);
    else zoomBtn.style.display = 'none';                    // Premiere only
  }



  // Keyboard shortcuts while the overlay is open:
  //   Cmd/Ctrl+Enter → place; Esc → discard.
  // A click anywhere else closes an open "⋯" menu; so does the panel resizing
  // (which also re-fits the caption boxes to the new width).
  document.addEventListener('click', (e) => {
    if (!reviewOpen) return;
    const el = e && e.target;
    // 1.55: where the click WAS — the clicked icon may already be gone (a
    // button re-draws its label while it opens its list), so the event's own
    // path is asked first; then the element itself
    const path = (e && e.composedPath && e.composedPath()) || [];
    const inside = (sel) => path.some((n) => n && n.matches && n.matches(sel)) || !!(el && el.closest && el.closest(sel));
    if (!inside('#memoryPanel, #revMemory')) closeMemoryPanel();
    if (!inside('#clientPanel, #revClient')) closeClientPanel();
    if (!inside('#cleanupPanel, #revCleanup, #revSilence')) closeCleanupPanel();
    if (!inside('#zoomPanel, #revZoom')) closeZoomPanel();
    if (inside('.row-more')) return;
    closeRowMenus();
  });
  window.addEventListener('resize', () => { if (reviewOpen) fitReviewBoxes(); });

  document.addEventListener('keydown', (e) => {
    if (!reviewOpen) return;
    if (e.key === 'Escape') {
      const list = $('reviewList');
      if (list && list.querySelector && list.querySelector('.row-more.open')) { closeRowMenus(); return; }
      const mp = $('memoryPanel');
      if (mp && mp.style.display !== 'none') { closeMemoryPanel(); return; }
      const cp = $('clientPanel');
      if (cp && cp.style.display !== 'none') { closeClientPanel(); return; }
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
    else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      // In a text box Ctrl+Z undoes typing (the browser's own); elsewhere it
      // undoes the last split / join / delete.
      const el = e.target;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return;
      if (e.preventDefault) e.preventDefault();
      undoReview();
    }
  });
}

// ── review: the fix line under a caption, and the memory ────────────────
// Nothing appears at the top of the list and nothing stays open: after a
// word is fixed, one slim line appears UNDER THAT CAPTION — change it in the
// other captions, or "Always fix" (here, now, and in every new video). It
// goes away after the tap, when another caption is edited, or with ✕.
let ROW_HINT_TIMER = null;
function clearRowHint() {
  if (ROW_HINT_TIMER) { clearTimeout(ROW_HINT_TIMER); ROW_HINT_TIMER = null; }
  FIX_OFFER = null;
  const list = $('reviewList');
  const old = list && list.querySelectorAll ? list.querySelectorAll('.row-hint') : [];
  for (let k = 0; k < old.length; k++) if (old[k].parentNode) old[k].parentNode.removeChild(old[k]);
}
function showRowHint(cue, parts, offer) {
  clearRowHint();
  const list = $('reviewList');
  const row = list && list.children ? list.children[reviewCues.indexOf(cue)] : null;
  if (!row) return null;
  FIX_OFFER = offer || { cue };
  const h = document.createElement('div');
  h.className = 'row-hint';
  parts.forEach((p) => {
    if (p.text != null) {
      const t = document.createElement('span');
      t.className = p.cls || 'hint-text';
      t.textContent = p.text;
      h.appendChild(t);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hint-btn' + (p.cls ? ' ' + p.cls : '');
    b.textContent = p.btn;
    if (p.title) b.title = p.title;
    b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); p.onClick(); });
    h.appendChild(b);
  });
  row.appendChild(h);
  return h;
}
// A short "✓ done" in the same place, gone by itself.
function flashRowHint(cue, text) {
  const h = showRowHint(cue, [{ text, cls: 'hint-ok' }]);
  if (h) ROW_HINT_TIMER = setTimeout(clearRowHint, 2500);
}

function offerFixAll(cue) {
  if (!reviewOpen) return;
  const base = REVIEW_BASE.find((b) => String(b._id) === String(cue._id));
  if (!base) return;
  const pairs = learnFixes([base], [cue]);
  if (!pairs.length) return;
  const w = pairs[0][0], r = pairs[0][1];
  const n = reviewCues.filter((c) => c !== cue && replaceWords(c.text, w, r).n).length;
  const st = loadFixStore();
  const known = !!(st.fixes[w] && st.fixes[w].to === r && st.fixes[w].strong);
  const clientKnown = !!(ACTIVE_CLIENT && clientFixes(ACTIVE_CLIENT)[w] === r);
  if (known && clientKnown && !n) return;   // already fixed everywhere and remembered: nothing to ask
  const parts = [{ text: w + ' → ' + r, cls: 'hint-pair' }];
  if (n) parts.push({ btn: L('Change all') + ' (' + n + ')', cls: 'primary', title: L('Change this word in the other captions of this video'), onClick: () => applyFix(false) });
  if (!known) parts.push({ btn: '🧠 ' + L('Always fix'), cls: n ? '' : 'primary', title: L('Change this word in every caption now and in every new video'), onClick: () => applyFix(true) });
  // A client has its own words: keeping them in the client's list means one
  // client's spelling can never turn up in another client's video.
  if (ACTIVE_CLIENT && !clientKnown) parts.push({
    btn: '👤 ' + L('For this client'),
    cls: (n || known || clientKnown) ? '' : 'primary',
    title: L('Fix this word in this client’s videos only'),
    onClick: () => applyFix(false, 'client'),
  });
  parts.push({ btn: '✕', cls: 'close', title: L('Close'), onClick: clearRowHint });
  showRowHint(cue, parts, { w, r, cue });
}
// Change all (this video) — and, with `always`, remember it for every new
// video too, or, with scope "client", for this client's videos only.
// The changed words turn green so the memory is visible.
function applyFix(always, scope) {
  if (!FIX_OFFER || !FIX_OFFER.w) return;
  const w = FIX_OFFER.w, r = FIX_OFFER.r, cue = FIX_OFFER.cue;
  const forClient = scope === 'client' && !!ACTIVE_CLIENT;
  pushReviewUndo('change all');
  let n = 0;
  reviewCues.forEach((c) => {
    const x = replaceWords(c.text, w, r);
    if (x.n) { c.text = x.text; n += x.n; if (always || forClient) c._fixed = (c._fixed || []).concat([r]); }
  });
  if (always || forClient) {
    cue._fixed = (cue._fixed || []).concat([r]);
    REVIEW_AUTOFIX.rules[w] = r;
    if (forClient) {
      rememberClientFix(ACTIVE_CLIENT, w, r);
      REVIEW_CLIENT_WORDS[r] = { from: w, scope: ACTIVE_CLIENT };
      syncClientButton();
      log('Client words: "' + w + '" → "' + r + '" will be fixed in this client’s videos.');
    } else {
      const st = loadFixStore();
      rememberFix(st, w, r, true);
      saveFixStore(st);
      syncMemoryButton();
      renderMemoryPanel();
      log('Auto-correct memory: "' + w + '" → "' + r + '" will be fixed in every new transcription.');
    }
  }
  if (n) log('Changed "' + w + '" to "' + r + '" in ' + n + ' place(s).');
  clearRowHint();
  renderReview();
  if (always || forClient) {
    flashRowHint(cue, '✓ ' + (forClient ? '👤 ' : '🧠 ') + w + ' → ' + r + ' · ' +
      L(forClient ? 'Fixed in this client’s videos' : 'Will be fixed automatically from now on'));
  }
  renderClientPanel();
}

// Which remembered rule produced `word` (a green word) — and where it lives:
// the active client's own list, or the computer-wide memory.
function memoryRuleFor(word) {
  if (ACTIVE_CLIENT) {
    const words = clientWords(loadClients(), ACTIVE_CLIENT);
    const fromClient = Object.keys(words).find((k) => words[k] && words[k].to === word);
    if (fromClient) return { from: fromClient, scope: ACTIVE_CLIENT };
  }
  const st = loadFixStore();
  const fromStore = Object.keys(st.fixes).find((k) => st.fixes[k] && st.fixes[k].to === word);
  if (fromStore) return { from: fromStore, scope: '' };
  const fromReview = Object.keys(REVIEW_AUTOFIX.rules || {}).find((k) => REVIEW_AUTOFIX.rules[k] === word);
  if (fromReview) return { from: fromReview, scope: (REVIEW_CLIENT_WORDS[word] || {}).scope || '' };
  return null;
}
function offerMemoryWord(cue, word) {
  const rule = memoryRuleFor(word);
  if (!rule) return;
  const from = rule.from, scope = rule.scope;
  showRowHint(cue, [
    { text: (scope ? '👤 ' + L('from the client list') : '🧠 ' + L('from memory')) + ' ' + from + ' → ' + word, cls: 'hint-pair' },
    { btn: '↩ ' + L('Put back'), title: L('Put the original word back in this caption'), onClick: () => putBackWord(cue, word, from, false, scope) },
    { btn: L('Forget this fix'), cls: 'danger', title: scope ? L('Stop fixing this word in this client’s videos, and put the original back everywhere') : L('Stop fixing this word, and put the original back everywhere'), onClick: () => putBackWord(cue, word, from, true, scope) },
    { btn: '✕', cls: 'close', title: L('Close'), onClick: clearRowHint },
  ], { cue });
}
// Put the original word back — in this caption, or (forget) everywhere the
// memory changed it, and drop the rule. The "before" copy is updated too, so
// putting a word back is never mistaken for a new fix to learn.
function putBackWord(cue, word, from, forget, scope) {
  pushReviewUndo(forget ? 'forget' : 'put back');
  const targets = forget ? reviewCues.filter((c) => (c._fixed || []).indexOf(word) >= 0) : [cue];
  targets.forEach((c) => {
    const x = replaceWords(c.text, word, from);
    if (x.n) c.text = x.text;
    c._fixed = (c._fixed || []).filter((v) => v !== word);
    const b = REVIEW_BASE.find((z) => String(z._id) === String(c._id));
    if (b) { const y = replaceWords(b.text, word, from); if (y.n) b.text = y.text; }
  });
  if (forget) {
    if (scope) {
      forgetClientWord(scope, from);
      delete REVIEW_CLIENT_WORDS[word];
      log('Client words: forgot "' + from + '" → "' + word + '".');
    } else {
      const st = loadFixStore();
      if (st.fixes[from] && st.fixes[from].to === word) delete st.fixes[from];
      saveFixStore(st);
      syncMemoryButton();
      log('Auto-correct memory: forgot "' + from + '" → "' + word + '".');
    }
    delete REVIEW_AUTOFIX.rules[from];
    renderMemoryPanel();
    renderClientPanel();
  }
  clearRowHint();
  renderReview();
  if (forget) flashRowHint(cue, '✓ ' + L('Forgotten — it will not be changed again'));
}
function syncMemoryButton() {
  const b = $('revMemory');
  if (!b) return;
  const n = Object.keys(activeFixes(loadFixStore())).length;
  // Hidden until the editor has remembered something: a new user never sees it.
  b.style.display = n ? '' : 'none';
  b.textContent = '🧠 ' + L('Memory') + (n ? ' (' + n + ')' : '');
  if (!n) closeMemoryPanel();
  b.title = L('Words you taught the panel — they are fixed automatically in every new transcription.');
}
// The memory list is a small dropdown under its button: it closes on any
// click outside it, on Esc, and on a second tap of the button.
function toggleMemoryPanel() {
  const p = $('memoryPanel');
  if (!p) return;
  const open = p.style.display === 'none';
  p.style.display = open ? '' : 'none';
  if (open) {
    // Just below the 🧠 button, wherever the header wrapped it to.
    const b = $('revMemory');
    if (b && typeof b.offsetTop === 'number' && b.offsetHeight) p.style.top = (b.offsetTop + b.offsetHeight + 4) + 'px';
    renderMemoryPanel();
  }
}
function closeMemoryPanel() {
  const p = $('memoryPanel');
  if (p) p.style.display = 'none';
}
function renderMemoryPanel() {
  const p = $('memoryPanel');
  if (!p || p.style.display === 'none') return;
  const st = loadFixStore();
  const words = Object.keys(activeFixes(st)).sort((a, b) => (st.fixes[b].at || 0) - (st.fixes[a].at || 0));
  p.textContent = '';
  const head = document.createElement('div');
  head.className = 'mem-head';
  head.textContent = '🧠 ' + L('Remembered fixes');
  p.appendChild(head);
  const sub = document.createElement('div');
  sub.className = 'mem-sub';
  sub.textContent = words.length
    ? L('Words you taught the panel — they are fixed automatically in every new transcription.')
    : L('Nothing remembered yet — fix a word, then tap “🧠 Remember”.');
  p.appendChild(sub);
  const list = document.createElement('div');
  list.className = 'mem-list';
  words.forEach((w) => {
    const f = st.fixes[w];
    const line = document.createElement('div');
    line.className = 'mem-row';
    const txt = document.createElement('span');
    txt.className = 'mem-pair';
    txt.textContent = w + ' → ' + f.to;
    line.appendChild(txt);
    const state = document.createElement('span');
    state.className = 'mem-state';
    state.textContent = '✓';
    line.appendChild(state);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'mem-del'; x.textContent = '✕';
    x.title = L('Forget this fix');
    x.addEventListener('click', () => {
      const cur = loadFixStore();
      delete cur.fixes[w];
      saveFixStore(cur);
      syncMemoryButton();
      renderMemoryPanel();
    });
    line.appendChild(x);
    list.appendChild(line);
  });
  p.appendChild(list);
  if (words.length) {
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'mem-all';
    all.textContent = L('Forget all');
    all.addEventListener('click', () => {
      if (all.dataset.armed !== '1') { all.dataset.armed = '1'; all.textContent = L('Tap again to forget all'); return; }
      saveFixStore({ v: 1, fixes: {} });
      log('Auto-correct memory cleared.');
      syncMemoryButton();
      renderMemoryPanel();
    });
    p.appendChild(all);
  }
}

// ── the client picker (👤, a dropdown like 🧠 Memory) ───────────────────
// Nothing sits above the caption list: one button in the review header, a
// panel that opens on demand and closes on a click elsewhere. The list lives
// on this computer only (see the note in the storage block above).
function syncClientButton() {
  const b = $('revClient');
  if (!b) return;
  const n = ACTIVE_CLIENT ? clientWordCount(ACTIVE_CLIENT) : 0;
  b.textContent = '👤 ' + (ACTIVE_CLIENT || L('Client')) + (n ? ' (' + n + ')' : '');
  b.title = ACTIVE_CLIENT
    ? L('This client’s words are fixed in this project')
    : L('Choose a client — their names and words are fixed automatically');
}
function toggleClientPanel() {
  const p = $('clientPanel');
  if (!p) return;
  const open = p.style.display === 'none';
  closeMemoryPanel();                      // one dropdown at a time
  p.style.display = open ? '' : 'none';
  if (open) {
    // Just below the 👤 button, wherever the header wrapped it to.
    const b = $('revClient');
    if (b && typeof b.offsetTop === 'number' && b.offsetHeight) p.style.top = (b.offsetTop + b.offsetHeight + 4) + 'px';
    renderClientPanel();
  }
}
function closeClientPanel() {
  const p = $('clientPanel');
  if (p) p.style.display = 'none';
}
function cliButton(text, cls, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function renderClientPanel() {
  const p = $('clientPanel');
  if (!p || p.style.display === 'none') return;
  const st = loadClients();
  p.textContent = '';

  const head = document.createElement('div');
  head.className = 'mem-head';
  head.textContent = '👤 ' + L('Client words');
  p.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'mem-sub';
  sub.textContent = ACTIVE_CLIENT
    ? L('This client’s names and words — fixed automatically in this project.')
    : L('Choose a client — their names and words are fixed in that client’s videos only.');
  p.appendChild(sub);

  // The clients, newest first; then "no client" and "new client".
  const chips = document.createElement('div');
  chips.className = 'cli-chips';
  Object.keys(st.clients || {})
    .sort((a, b) => (st.clients[b].at || 0) - (st.clients[a].at || 0))
    .forEach((name) => {
      const n = clientWordCount(name);
      chips.appendChild(cliButton(
        name + (n ? ' (' + n + ')' : ''),
        'cli-chip' + (name === ACTIVE_CLIENT ? ' active' : ''),
        L('Use this client in this project'),
        () => { setActiveClient(name === ACTIVE_CLIENT ? '' : name); renderClientPanel(); }));
    });
  if (ACTIVE_CLIENT) {
    chips.appendChild(cliButton(L('No client'), 'cli-chip', L('Fix no client words in this project'),
      () => { setActiveClient(''); renderClientPanel(); }));
  }
  chips.appendChild(cliButton('➕ ' + L('New client…'), 'cli-chip add', L('Add a client of this computer'),
    () => clientNewForm()));
  p.appendChild(chips);

  if (ACTIVE_CLIENT) {
    const fx = clientFixes(ACTIVE_CLIENT);
    const words = Object.keys(fx).sort((a, b) => (fx[b].at || 0) - (fx[a].at || 0));
    const list = document.createElement('div');
    list.className = 'mem-list';
    words.forEach((w) => {
      const line = document.createElement('div');
      line.className = 'mem-row';
      const txt = document.createElement('span');
      txt.className = 'mem-pair';
      txt.textContent = w + ' → ' + fx[w];
      line.appendChild(txt);
      const x = cliButton('✕', 'mem-del', L('Forget this fix'), () => {
        forgetClientWord(ACTIVE_CLIENT, w);
        log('Client words: forgot "' + w + '".');
        renderClientPanel();
        syncClientButton();
      });
      line.appendChild(x);
      list.appendChild(line);
    });
    p.appendChild(list);
    if (!words.length) {
      const none = document.createElement('div');
      none.className = 'mem-sub';
      none.textContent = L('Nothing in this client’s list yet — fix a word in a caption, then tap “👤 For this client”, or add one here.');
      p.appendChild(none);
    }

    const acts = document.createElement('div');
    acts.className = 'cli-actions';
    acts.appendChild(cliButton('➕ ' + L('Add a word'), 'mem-all', L('Add a word to this client’s list'),
      () => clientNewWordForm()));
    const imp = cliButton('⬆ ' + L('Import'), 'mem-all', L('Import a client word list from a .txt or .json file'),
      () => clientImport());
    const exp = cliButton('⬇ ' + L('Export'), 'mem-all', L('Export this client’s list as .txt and .json'),
      () => clientExport());
    acts.appendChild(imp);
    acts.appendChild(exp);
    p.appendChild(acts);

    if (words.length) {
      const all = cliButton(L('Forget all'), 'mem-all', L('Forget every word of this client'),
        () => {
          if (all.dataset.armed !== '1') { all.dataset.armed = '1'; all.textContent = L('Tap again to forget all'); return; }
          const cur = loadClients();
          if (cur.clients[ACTIVE_CLIENT]) cur.clients[ACTIVE_CLIENT].words = {};
          saveClients(cur);
          log('Client words: the list was cleared.');
          renderClientPanel();
          syncClientButton();
        });
      p.appendChild(all);
    }

    const note = document.createElement('div');
    note.className = 'cli-note';
    note.textContent = '🔒 ' + L('Saved on this computer only — nothing is uploaded.');
    p.appendChild(note);
  }
}
function clientNewForm() {
  const p = $('clientPanel');
  if (!p) return;
  const box = document.createElement('div');
  box.className = 'cli-form';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'cli-input'; inp.placeholder = L('Client name'); inp.maxLength = 60;
  box.appendChild(inp);
  const save = cliButton(L('Save'), 'cli-save', '', () => {
    const name = createClient(inp.value);
    if (!name) { inp.focus(); return; }
    log('Client list: a client was added.');
    setActiveClient(name);
    renderClientPanel();
  });
  const cancel = cliButton(L('Cancel'), 'cli-cancel', '', () => renderClientPanel());
  box.appendChild(save);
  box.appendChild(cancel);
  p.appendChild(box);
  try { inp.focus(); } catch (e) {}
}
function clientNewWordForm() {
  const p = $('clientPanel');
  if (!p || !ACTIVE_CLIENT) return;
  const box = document.createElement('div');
  box.className = 'cli-form';
  const w = document.createElement('input');
  w.type = 'text'; w.className = 'cli-input'; w.placeholder = L('Wrong word'); w.maxLength = 120; w.dataset.amhType = '1';
  const r = document.createElement('input');
  r.type = 'text'; r.className = 'cli-input'; r.placeholder = L('Right word'); r.maxLength = 120; r.dataset.amhType = '1';
  box.appendChild(w);
  box.appendChild(r);
  const save = cliButton(L('Save'), 'cli-save', '', () => {
    const wrong = w.value.trim(), right = r.value.trim();
    if (!wrong || !right || wrong === right) { log('Client words: nothing added — the two words must be different.'); return; }
    rememberClientFix(ACTIVE_CLIENT, wrong, right);
    log('Client words: "' + wrong + '" → "' + right + '" will be fixed in this client’s videos.');
    setActiveClient(ACTIVE_CLIENT);      // applies it and redraws the panel
    renderClientPanel();
  });
  const cancel = cliButton(L('Cancel'), 'cli-cancel', '', () => renderClientPanel());
  box.appendChild(save);
  box.appendChild(cancel);
  p.appendChild(box);
  try { w.focus(); } catch (e) {}
}
// A file dialog (the app's own chooser; CEP's on the panel side).
function pickDialogPath(chooseDir, title) {
  try {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
      const res = window.cep.fs.showOpenDialog(false, chooseDir, title, '');
      if (res && res.err === 0 && res.data && res.data.length) return res.data[0];
    }
  } catch (e) {}
  return null;
}
// One line per word: "wrong=right" (the same shape a translator can keep).
function clientExport() {
  if (!ACTIVE_CLIENT) return;
  const fx = clientFixes(ACTIVE_CLIENT);
  const words = Object.keys(fx);
  if (!words.length) { log('The client list is empty — nothing to export.'); return; }
  const dir = pickDialogPath(true, 'Choose a folder for the client word list') || ensureCaptionsDir();
  const base = safeFileName(ACTIVE_CLIENT) || 'client';
  const pairs = {};
  words.forEach((w) => { pairs[w] = fx[w]; });
  const txt = words.map((w) => w + '=' + fx[w]).join('\n') + '\n';
  const json = JSON.stringify({ v: 1, client: ACTIVE_CLIENT, words: pairs }, null, 2) + '\n';
  try {
    fs.writeFileSync(path.join(dir, base + '.amhglossary.txt'), txt, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(path.join(dir, base + '.amhglossary.json'), json, { encoding: 'utf8', mode: 0o600 });
  } catch (e) { log('Could not write the client list to that folder — try another folder.'); return; }
  log('Exported ' + words.length + ' word(s) to the folder you chose.');
}
// Read a word list: our .json, or plain "wrong=right" lines (.txt). # starts
// a comment in the text form. Unknown lines are ignored, never an error box.
function parseGlossary(raw) {
  const out = {};
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) return out;
  if (text.charAt(0) === '{') {
    let j = null;
    try { j = JSON.parse(text); } catch (e) { return out; }
    const words = (j && j.words) || j || {};
    Object.keys(words).forEach((k) => {
      const v = words[k];
      const to = (v && typeof v === 'object') ? v.to : v;
      const from = String(k || '').trim();
      if (from && typeof to === 'string' && to.trim()) out[from] = to.trim();
    });
    return out;
  }
  text.split(/\r?\n/).forEach((line) => {
    const cut = line.split('#')[0];
    const i = cut.indexOf('=');
    if (i < 1) return;
    const w = cut.slice(0, i).trim(), to = cut.slice(i + 1).trim();
    if (w && to && w !== to) out[w] = to;
  });
  return out;
}
function clientImport() {
  if (!ACTIVE_CLIENT) return;
  const file = pickDialogPath(false, 'Choose a client word list (.txt or .json)');
  if (!file) { log('Import cancelled.'); return; }
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { log('Could not read that file.'); return; }
  const words = parseGlossary(raw);
  const keys = Object.keys(words);
  if (!keys.length) { log('No words found in that file.'); return; }
  const st = loadClients();
  if (!st.clients[ACTIVE_CLIENT]) return;
  const holder = { fixes: clientWords(st, ACTIVE_CLIENT) };
  let added = 0, updated = 0;
  keys.forEach((w) => {
    const had = !!(holder.fixes[w] && holder.fixes[w].strong && holder.fixes[w].to === words[w]);
    rememberFix(holder, w, words[w], true, CLIENT_WORD_MAX);
    if (had) updated++; else added++;
  });
  pruneClientWords(holder.fixes);
  st.clients[ACTIVE_CLIENT].at = Date.now();
  saveClients(st);
  log('Imported ' + added + ' new word(s), ' + updated + ' already there.');
  setActiveClient(ACTIVE_CLIENT);
  renderClientPanel();
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
let onBattery = false;

// Parse one engine stderr line. Returns true when it was a progress line and
// has been consumed, so the caller can keep it out of the log — one line per
// 20s window would otherwise bury real messages on a long clip.
function consumeProgressLine(line) {
  // `[power] battery`: a long job on a laptop running on battery (2-3x
  // slower). The progress line then suggests plugging in the charger.
  if (/^\[power\]\s+battery\s*$/.test(String(line).trim())) {
    if (!onBattery) log('🔌 This computer is on battery — plug in the charger and captions are made 2-3x faster.');
    onBattery = true;
    return true;
  }
  const m = /^\[progress\]\s+(\d+)\/(\d+)\s*$/.exec(String(line).trim());
  if (!m) return false;
  if (!windowProgress) return true;
  const done = Number(m[1]);
  const total = Number(m[2]);
  if (!total) return true;
  windowProgress(done, total);
  return true;
}

// Toggle indeterminate (pulsing) progress bar for short clips that emit
// no per-window progress. The bar slides left-right to show "working".
function setIndeterminate(on) {
  const track = $('progTrack');
  if (track) track.classList.toggle('indeterminate', !!on);
}

// Set up the windowProgress callback for a transcription run. After the
// first real progress event the bar switches from indeterminate to
// determinate (fraction-based) mode automatically.
function setWindowProgress(startedAt) {
  onBattery = false;
  // The time estimate is measured from the FIRST progress line: a resumed
  // job starts at e.g. 20/39 at once, which would otherwise look instant.
  let first = null;
  windowProgress = (done, total) => {
    const frac = Math.max(0, Math.min(1, done / total));
    let eta = '';
    if (!first) first = { done: done, at: done > 0 ? startedAt : Date.now() };
    if (done > first.done && done < total) {
      const perWindow = (Date.now() - first.at) / (done - first.done);
      const left = Math.round((perWindow * (total - done)) / 1000);
      if (left > 0) {
        eta = left >= 60
          ? ' · about ' + Math.ceil(left / 60) + ' min left'
          : ' · about ' + left + 's left';
      }
    }
    if (onBattery && done < total) eta += ' · 🔌 plug in the charger to go faster';
    setIndeterminate(false);
    setProgress(0.15 + frac * 0.75, 'Transcribing ' + done + '/' + total + eta);
    if (REVIEW_LIVE && reviewOpen) lockLivePlace(PROGRESS_EN);
  };
}

function clearWindowProgress() {
  windowProgress = null;
  setIndeterminate(false);
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
  track('run_click');
  clearLog();
  cancelRequested = false;
  runFailed = false;
  reviewTrialCharged = false;
  activeRunId = newRunId();
  setProgress(0, '');
  if (!RUNTIME) {
    track('blocked_runtime');
    log('ERROR: Transcription runtime not found.');
    log('The extension folder is missing the bundled "runtime" directory.');
    log('Reinstall the correct platform build, then restart Premiere.');
    if (typeof EXT_DIR !== 'undefined') log('Looking in: ' + EXT_DIR);
    return;
  }
  if (!PYTHON || !FFMPEG || !fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    track('blocked_runtime');
    log('ERROR: Runtime is incomplete — missing python or ffmpeg.');
    log('python: ' + PYTHON + ' -> ' + (fs.existsSync(PYTHON) ? 'OK' : 'MISSING'));
    log('ffmpeg: ' + FFMPEG + ' -> ' + (fs.existsSync(FFMPEG) ? 'OK' : 'MISSING'));
    log('Reinstall the correct platform build and restart Premiere.');
    return;
  }
  if (!modelReadyForRun(() => run())) return;
  runStartInProgress = true;
  try { await refreshTrialFromServer(); }
  finally { runStartInProgress = false; }
  if (cancelRequested) return;
  if (!assertCanRun(() => run())) return;
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
    if (TRIAL_CHARGED_RUN && (cancelRequested || runFailed)) refundTrialRun();
    else TRIAL_CHARGED_RUN = null;
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
  const kind = errorStep(raw);
  if (kind === 'err_memory') {
    return 'Your computer ran out of memory. Close other programs (Chrome, other editors), then try again.';
  }
  if (kind === 'err_av_blocked' && !workerDllError && !t.includes('dll load failed')) {
    return 'Windows or an antivirus blocked the transcription engine. Allow Amharic Captions in your antivirus, then try again.';
  }
  if (kind === 'err_engine_hang') {
    return 'The transcription engine stopped responding. Close other programs, plug in the charger, and try again.';
  }
  if (workerDllError || t.includes('dll load failed')) {
    return 'Your antivirus or an incomplete install blocked part of the transcription engine. Add the extension folder to your antivirus exclusions, then reinstall and restart Premiere.';
  }
  if (t.includes('trial used up')) {
    return TRIAL_MIN && TRIAL_MIN.status === 'none'
      ? 'Get your free minutes in Telegram first (the button above the license).'
      : TRIAL_MIN && TRIAL_MIN.status === 'expired'
        ? 'Your free week has ended. Buy a license to keep making captions.'
        : 'Your free minutes are used up. Buy a license to keep making captions.';
  }
  if (t.includes('free caption needs internet')) return 'Connect to the internet for the free trial (a license works offline).';
  if (t.includes('license required')) return 'This computer has no active license. Activate your license key (or connect to the internet for the free trial).';
  if (t.includes('audio too short')) return 'That clip is too short to transcribe.';
  if (t.includes('no speech')) return 'No speech found in that audio.';
  if (t.includes('audio-bearing')) return NO_CLIPS_HELP || 'No transcribable clips in that range.';
  if (t.includes('precomp has no layer with sound')) {
    return 'This precomp has no layer with sound in that part. Open it and select the layer, or use Whole comp.';
  }
  if (t.includes('nested sequence has no clip with sound')) {
    return 'This nested sequence has no clip with sound in that part. Open it and select the clip, or use Whole edit.';
  }
  if (t.includes('caption layer made by amharic captions')) {
    return 'That is a caption layer made by Amharic Captions. Select your video or audio clip instead.';
  }
  if (t.includes('no clip found') || t.includes('no selected clip') || t.includes('select a clip')) {
    return 'Select a clip on the timeline (or put the playhead on it), then try again.';
  }
  if (t.includes('source path') || t.includes('no media file')) {
    return 'That item has no media file — try a regular video or audio clip.';
  }
  if (NO_AUDIO_RE.test(t)) {
    return 'This clip has no sound. Select the clip with the voice (usually on an audio track, A1), then try again.';
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
  const step = errorStep(raw);
  if (step) track(step);
  removeTempCaptionArtifact(lastSrtPath);
  const msg = humanError(raw);
  setStatus('err', 'failed');
  // progLabel is an aria-live region, so this is announced as well as shown.
  setProgress(0, msg + ' See “Details for support” below.');
  LAST_FAIL = { raw: String(raw || ''), step: step || '', at: Date.now() };
  showReportOffer(true);
}

// ── Problem report (1.10.11) ────────────────────────────────────────────────
// After a failed run: "📨 Send problem report". Only on that tap, the error,
// the engine's last lines, the end of the Log (home folder and keys/tickets
// removed), the version, the system (Windows/macOS, memory, processors) and
// the Machine ID go to our bot, which forwards them to the owner — the cause
// of a failure on a customer's computer was otherwise invisible. Never any
// video, audio or captions.
let LAST_FAIL = null;
function showReportOffer(on) {
  const box = document.getElementById('reportBox');
  if (!box) return;
  box.style.display = on ? '' : 'none';
  const st = document.getElementById('reportStatus');
  if (st && on) { st.textContent = ''; st.style.display = 'none'; }
  const b = document.getElementById('reportBtn');
  if (b && on) b.disabled = false;
}
function scrubReport(s) {
  let out = String(s == null ? '' : s);
  try {
    const home = os.homedir();
    if (home) out = out.split(home).join('~');
  } catch (e) {}
  return out
    .replace(/AMH-[0-9A-Za-z-]{8,}/g, 'AMH-…')
    .replace(/\b[vt][12]\.[0-9A-Za-z._:-]{20,}/g, '[ticket]')
    .replace(/[A-Z2-9]{4}-[A-Z2-9]{4}\b/g, '[code]');
}
function buildReport() {
  const logLines = String((document.getElementById('logBox') || {}).textContent || '').split('\n').slice(-60);
  let sys = {};
  try {
    sys = {
      platform: process.platform, release: os.release(), arch: process.arch,
      ram_gb: Math.round(os.totalmem() / 1e8) / 10, free_gb: Math.round(os.freemem() / 1e8) / 10,
      cpus: (os.cpus() || []).length,
    };
  } catch (e) {}
  return {
    mid: MACHINE_ID, v: APP_VERSION, host: TRACK_HOST, sys,
    licensed: !!LICENSED,
    trial: TRIAL_MIN ? (TRIAL_MIN.status + ' ' + fmtMinSec(TRIAL_MIN.seconds_left) + ' left') : '',
    step: LAST_FAIL ? LAST_FAIL.step : '',
    error: scrubReport(LAST_FAIL ? LAST_FAIL.raw : '').slice(0, 500),
    tail: WORKER_TAIL.slice(-20).map(scrubReport),
    log: logLines.map(scrubReport),
  };
}
async function sendReport() {
  const b = document.getElementById('reportBtn');
  const st = document.getElementById('reportStatus');
  if (b) b.disabled = true;
  const r = await apiPost('/api/report', buildReport());
  track('report_sent');
  if (st) {
    st.textContent = L(r && r.ok
      ? 'Sent — thank you. We will look at it and reply in Telegram.'
      : 'Could not send — check the internet and try again, or send a screenshot of the Log to @AmharicCaptionsBot.');
    st.style.display = '';
  }
  if (b && !(r && r.ok)) b.disabled = false;
}
// ── Feedback (1.10.12) ──────────────────────────────────────────────────────
// "💡 Ideas" in the footer: a short message (and, if they like, their
// Telegram @username) goes to the owner's bot with the Machine ID, version
// and whether this computer is licensed or on the free trial. Nothing else.
function openFeedback(on) {
  const card = document.getElementById('feedbackCard');
  if (!card) return;
  card.classList.toggle('show', !!on);
  const st = document.getElementById('feedbackStatus');
  if (st && on) { st.textContent = ''; st.style.display = 'none'; }
  const send = document.getElementById('feedbackSend');
  if (send && on) send.disabled = false;
}
async function sendFeedback() {
  const box = document.getElementById('feedbackText');
  const tgBox = document.getElementById('feedbackTg');
  const st = document.getElementById('feedbackStatus');
  const send = document.getElementById('feedbackSend');
  const text = String((box && box.value) || '').trim();
  const say = (m) => { if (st) { st.textContent = L(m); st.style.display = ''; } };
  if (text.length < 3) { say('Write a few words first.'); return; }
  const tg = String((tgBox && tgBox.value) || '').trim().replace(/^(?:https?:\/\/)?t\.me\//i, '').replace(/^@?/, '@');
  if (send) send.disabled = true;
  const r = await apiPost('/api/feedback', {
    mid: MACHINE_ID, v: APP_VERSION, host: TRACK_HOST, text: text.slice(0, 1500),
    tg: /^@[A-Za-z0-9_]{4,32}$/.test(tg) ? tg : '',
    licensed: !!LICENSED,
    trial: TRIAL_MIN ? (TRIAL_MIN.status + ' ' + fmtMinSec(TRIAL_MIN.seconds_left) + ' left') : '',
  });
  track('feedback_sent');
  if (r && r.ok) {
    if (box) box.value = '';
    say('Thank you! We read every message.');
  } else {
    if (send) send.disabled = false;
    say('Could not send — check the internet and try again.');
  }
}
function initFeedback() {
  openFeedback(false);
  const link = document.getElementById('feedbackLink');
  if (link) link.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); openFeedback(true); });
  const send = document.getElementById('feedbackSend');
  if (send) send.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); sendFeedback(); });
  const close = document.getElementById('feedbackCancel');
  if (close) close.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); openFeedback(false); });
}

function initReport() {
  showReportOffer(false);
  const b = document.getElementById('reportBtn');
  if (b) b.addEventListener('click', (e) => { if (e && e.preventDefault) e.preventDefault(); sendReport(); });
}

async function runSelectedClip() {
  log('Checking your selected clip…');
  const c = await getSelectedClip();
  if (!c.ok || !c.sourcePath) throw new Error(c.error || 'No selected clip.');
  setPreviewMedia([{ path: c.sourcePath, offset: c.sourceIn - c.timelineStart, from: c.timelineStart,
    to: c.timelineStart + c.duration }]);
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
  // Short clips (single window) emit no per-window progress, so show an
  // indeterminate pulsing bar until the first real progress event arrives.
  const startedAt = Date.now();
  setWindowProgress(startedAt);
  setIndeterminate(true);
  setProgress(0.5, 'Transcribing…');

  // Bake the clip's absolute timeline position into the SRT timestamps (so the
  // cues carry their real timeline times), then place the caption band at 0.
  let r;
  LIVE_WANTED = { outSrt, label: cleanName };
  try {
    try {
      r = await transcribe(c.sourcePath, outSrt,
        { sourceIn: c.sourceIn, duration: c.duration }, c.timelineStart);
    } catch (e) {
      // The video file has no sound, but the voice is a clip on an audio
      // track under it: use that, for the same part of the timeline (1.16.8).
      const alt = c.audioAlt;
      if (!alt || !alt.sourcePath || !NO_AUDIO_RE.test(String((e && e.message) || e))) throw e;
      log('The video has no sound — using the audio under it: ' + alt.name);
      r = await transcribe(alt.sourcePath, outSrt,
        { sourceIn: alt.sourceIn, duration: alt.duration }, alt.timelineStart);
    }
  } finally {
    // Always clear, including on cancel or error — a stale reporter would
    // otherwise keep moving the bar during the next run.
    clearWindowProgress();
    LIVE_WANTED = null;
  }
  setProgress(0.9, 'Transcription complete');

  if (!r.cues.length) log('No speech detected in this audio — nothing to place.');
  log('Done writing captions.');

  // Review flow: let the user edit before anything hits the timeline (or
  // finish the review that opened while it was still working).
  await showRunResult(outSrt, cleanName, r);
}

// Why Work Area / Whole Edit found nothing, in words the editor can act on
// (customer report, 1.10.15: "no clips" alone did not say what to do).
let NO_CLIPS_HELP = '';
function fmtClipTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
}
function noClipsHelp(info, unsupportedCount) {
  if (info && info.outside && info.outside.count) {
    return 'The Work Area bar is not over your clips (they are at ' + fmtClipTime(info.outside.first) +
      '–' + fmtClipTime(info.outside.last) + '). Drag the Work Area bar over them, or choose Whole Edit.';
  }
  if (unsupportedCount) {
    return 'These clips have a speed change or play in reverse, so captions cannot follow them. ' +
      'Set the speed to 100% (right-click › Speed/Duration), or export the audio and caption that file.';
  }
  if (info && info.noMedia) {
    return 'These clips have no media file (titles, graphics, adjustment layers). ' +
      'Put the video or audio with the speech on the timeline, then try again.';
  }
  return IS_AE ? 'There are no video or audio layers in this composition.'
               : 'There are no clips on this timeline. Open the sequence with your video, then try again.';
}

async function runWorkArea() {
  NO_CLIPS_HELP = '';
  log('Reading your edit area…');
  const info = await getSequenceInfo(SOURCE === 'whole');
  if (!info.ok || !info.clips) throw new Error(info.error || 'No sequence info.');
  const unsupported = Array.isArray(info.unsupported) ? info.unsupported : [];
  if (unsupported.length) {
    log('Skipping ' + unsupported.length + ' clip(s) with unsupported speed/retime/reverse mapping.');
    unsupported.slice(0, 8).forEach((u) => log('  - ' + (u.name || 'unnamed clip') + ': ' + (u.reason || 'unsupported')));
  }
  const clips = (info.clips || []).filter((c) => !c.unsupported);
  setPreviewMedia(clips.map((c) => ({ path: c.sourcePath, offset: c.sourceIn - c.timelineStart,
    from: c.timelineStart, to: c.timelineStart + c.duration })));
  if (clips.length === 0) {
    NO_CLIPS_HELP = noClipsHelp(info, unsupported.length);
    log('Nothing to transcribe: ' + NO_CLIPS_HELP);
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
  // Wire per-window progress from the engine (long clips) into the batch bar.
  // Short clips show an indeterminate pulsing bar until the first window event.
  setWindowProgress(Date.now());
  setIndeterminate(true);
  setProgress(0.5, 'Preparing…');

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
    await openReview(outSrt, 'sequence', 0, { projectId: info.sequence });
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
    LIVE_WANTED = { outSrt, label: 'sequence', projectId: info.sequence };
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

    LIVE_WANTED = null;
    if (!r.cues.length) log('No speech detected in these clips — nothing to place.');
    log('Done — ' + r.cues.length + ' captions written.');
    await showRunResult(outSrt, 'sequence', r, info.sequence);
  } finally {
    // Always remove every temporary WAV, including failures and cancellation.
    for (const it of items) {
      if (it.wav) { try { fs.unlinkSync(it.wav); } catch (e) {} }
    }
    // Temporary WAVs are gone; do not retain audio paths after this block.
    clearWindowProgress();
    LIVE_WANTED = null;
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
  setPreviewMedia([{ path: filePath, offset: 0 }]);
  track('run_click');
  clearLog();
  cancelRequested = false;
  reviewTrialCharged = false;
  runFailed = false;
  activeRunId = newRunId();
  if (!RUNTIME || !PYTHON || !FFMPEG || !fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    track('blocked_runtime');
    log('ERROR: Transcription runtime is missing or incomplete.');
    log('Reinstall the correct platform build and restart Premiere.');
    return;
  }
  if (!modelReadyForRun(() => runFile(filePath, fileName))) return;
  runStartInProgress = true;
  try { await refreshTrialFromServer(); }
  finally { runStartInProgress = false; }
  if (cancelRequested) return;
  if (!assertCanRun(() => runFile(filePath, fileName))) return;
  runInProgress = true;
  setBusy(true);
  setProgress(0, '');
  try {
    const base = filePath.replace(/\.[^.]+$/, '');
    const outSrt = path.join(os.tmpdir(), 'amh_file_' + Date.now() + '.srt');
    lastSrtPath = outSrt;
    const cleanName = (fileName || path.basename(base) || 'captions').replace(/\.[^.]+$/, '');
    log('Writing captions… this can take a minute.');
    setWindowProgress(Date.now());
    setIndeterminate(true);
    setProgress(0.5, 'Transcribing…');
    let r;
    LIVE_WANTED = { outSrt, label: cleanName };
    try {
      r = await transcribe(filePath, outSrt);
    } finally {
      clearWindowProgress();
      LIVE_WANTED = null;
    }
    setProgress(0.9, 'Transcription complete');
    if (!r.cues.length) log('No speech detected in this audio — nothing to place.');
    log('Done writing captions.');
    await showRunResult(outSrt, cleanName, r);
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
    if (TRIAL_CHARGED_RUN && (cancelRequested || runFailed)) refundTrialRun();
    else TRIAL_CHARGED_RUN = null;
    runInProgress = false;
    setBusy(false);
    if (!cancelRequested && !runFailed) setProgress(0, '');
    updateLicenseUI();
  }
}

// ── Captions for another video of a Studio project (1.29.0) ────────────────
// The same engine and the same rules as a normal run (runtime, model,
// license or free minutes, refund when it fails), but the open review, its
// captions and its file are left exactly as they are. -> the captions.
async function transcribeExtra(filePath) {
  if (runInProgress || runStartInProgress) throw new Error(L('Captions are already being made — wait for them to finish.'));
  if (!RUNTIME || !PYTHON || !FFMPEG || !fs.existsSync(PYTHON) || !fs.existsSync(FFMPEG)) {
    throw new Error(L('The transcription runtime is missing — reinstall the app.'));
  }
  if (!modelReadyForRun(null)) throw new Error(L('The Amharic model is downloading — try again when it is ready.'));
  runStartInProgress = true;
  try { await refreshTrialFromServer(); } finally { runStartInProgress = false; }
  if (!assertCanRun(null)) throw new Error(L('No free minutes left — a license makes captions for every video.'));
  const keep = { cues: lastCues, srt: lastSrtPath, charged: reviewTrialCharged };
  const outSrt = path.join(os.tmpdir(), 'amh_extra_' + Date.now() + '.srt');
  cancelRequested = false;
  runFailed = false;
  activeRunId = newRunId();
  runInProgress = true;
  track('run_click');
  try {
    const r = await transcribe(filePath, outSrt);
    return (r.cues || []).map((c) => Object.assign({}, c));
  } catch (e) {
    runFailed = true;
    throw e;
  } finally {
    if (TRIAL_CHARGED_RUN && (cancelRequested || runFailed)) refundTrialRun();
    else TRIAL_CHARGED_RUN = null;
    lastCues = keep.cues;
    lastSrtPath = keep.srt;
    reviewTrialCharged = keep.charged;
    runInProgress = false;
    try { fs.unlinkSync(outSrt); } catch (e) {}
    updateLicenseUI();
  }
}

// ------------------------------------------------------------------ wiring
// ── One-time model download (lite packages) ────────────────────────────────
// Runs runtime/amh_model.py download, which resumes a partial file, verifies
// every file's SHA-256 and only then marks the model complete. Pause kills the
// child; the partial file stays, so Resume continues from the same byte.
//
// 1.10.17: of 25 computers that needed the model in two days, 6 never started
// the download (Generate was greyed out with no word why) and 2 stopped when
// the internet dropped (the download then waited for a tap). Now Generate
// always answers: it starts the download and the captions follow by
// themselves; a dropped connection is retried by itself (it keeps every byte);
// the card shows the time left.
let modelChild = null;
let MODEL_RESUME = null;       // the job to start when the model is ready
const MODEL_STARTED_KEY = 'amh.model.started';
const MODEL_PAUSED_KEY = 'amh.model.paused';
let MODEL_RETRY = { n: 0, timer: null, tick: null, at: 0 };
const MODEL_RETRY_S = [10, 20, 30, 60, 60, 120, 120, 300, 300, 300];
let MODEL_SPEED = { t: 0, bytes: 0, bps: 0 };
function modelReadyForRun(resume) {
  if (!MODEL_MISSING) return true;
  track('blocked_model');
  if (resume) MODEL_RESUME = resume;
  log('First the Amharic model is downloaded (' + mb(MODEL_TOTAL_BYTES) + ' MB, one time only).');
  log('Your captions start by themselves when it is ready.');
  setStatus('err', 'model needed');
  if (!modelChild) {
    if (MODEL_UI.state === 'retrying') retryModelNow();
    else startModelDownload();
  }
  const card = $('modelCard');
  if (card && typeof card.scrollIntoView === 'function') { try { card.scrollIntoView({ block: 'center' }); } catch (e) {} }
  return false;
}
function clearModelRetry() {
  if (MODEL_RETRY.timer) clearTimeout(MODEL_RETRY.timer);
  if (MODEL_RETRY.tick) clearInterval(MODEL_RETRY.tick);
  MODEL_RETRY.timer = null; MODEL_RETRY.tick = null;
}
function retryModelNow() {
  clearModelRetry();
  if (MODEL_MISSING && !modelChild) startModelDownload();
}
// The connection dropped: try again by itself, later and later. Every byte
// already downloaded is kept (amh_model.py resumes with HTTP Range).
// 1.42: never gives up while the program is open — after the list, every
// 5 minutes (Ethiopian connections often come back after a long while).
function scheduleModelRetry() {
  clearModelRetry();
  const wait = MODEL_RETRY_S[Math.min(MODEL_RETRY.n, MODEL_RETRY_S.length - 1)];
  MODEL_RETRY.n++;
  MODEL_RETRY.at = Date.now() + wait * 1000;
  modelUi('retrying');
  MODEL_RETRY.tick = setInterval(() => { if (MODEL_UI.state === 'retrying') setModelUi('retrying', MODEL_UI.done); }, 1000);
  MODEL_RETRY.timer = setTimeout(retryModelNow, wait * 1000);
}
function modelTimeLeft(done) {
  const now = Date.now();
  if (!MODEL_SPEED.t || done < MODEL_SPEED.bytes) { MODEL_SPEED = { t: now, bytes: done, bps: MODEL_SPEED.bps }; return ''; }
  const dt = (now - MODEL_SPEED.t) / 1000;
  if (dt >= 3) {
    const bps = (done - MODEL_SPEED.bytes) / dt;
    MODEL_SPEED = { t: now, bytes: done, bps: MODEL_SPEED.bps ? MODEL_SPEED.bps * 0.7 + bps * 0.3 : bps };
  }
  if (!MODEL_SPEED.bps || MODEL_SPEED.bps < 1000) return '';
  const left = Math.max(0, MODEL_TOTAL_BYTES - done) / MODEL_SPEED.bps;
  return left >= 90 ? ' · about ' + Math.round(left / 60) + ' min left' : ' · less than 2 min left';
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
    if (label) label.textContent = L('Wi-Fi is best. Pause any time — it continues exactly where it stopped, nothing is lost.');
  } else if (state === 'running') {
    btn.textContent = L('Pause');
    btn.disabled = false;
    if (label) label.textContent = L('Downloading… ' + mb(done || 0) + ' / ' + mb(MODEL_TOTAL_BYTES) + ' MB' + modelTimeLeft(done || 0));
  } else if (state === 'retrying') {
    const s = Math.max(0, Math.ceil((MODEL_RETRY.at - Date.now()) / 1000));
    btn.textContent = L('Try now');
    btn.disabled = false;
    if (label) label.textContent = L('Internet connection lost at ' + mb(done || 0) + ' / ' + mb(MODEL_TOTAL_BYTES) +
      ' MB — trying again in ' + s + ' s. Nothing downloaded is lost.');
  } else if (state === 'paused') {
    btn.textContent = L('Resume download');
    btn.disabled = false;
    if (label) label.textContent = L('Paused at ' + mb(done || 0) + ' / ' + mb(MODEL_TOTAL_BYTES) + ' MB');
  } else if (state === 'failed') {
    btn.textContent = L('Resume download');
    btn.disabled = false;
    if (label) label.textContent = L('Download stopped. Check your internet and press Resume; it continues where it stopped.');
  } else if (state === 'waiting') {
    btn.textContent = L('Pause');
    btn.disabled = false;
    if (label) label.textContent = L('Connecting…');
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
  track('model_dl_ok');
  log('✓ Amharic model downloaded and verified: ' + dir);
  setStatus('ready', 'ready');
  renderHealthList();
  updateLicenseUI();
  clearModelRetry();
  const resume = MODEL_RESUME;
  MODEL_RESUME = null;
  if (resume && !runInProgress && !runStartInProgress) {
    log('✓ Model ready — starting your captions.');
    resume();
  }
}
function startModelDownload() {
  if (modelChild) return;
  const script = runtimePath('amh_model.py');
  if (!fs.existsSync(script)) { log('ERROR: amh_model.py is missing from the runtime. Reinstall.'); return; }
  clearModelRetry();
  MODEL_SPEED = { t: 0, bytes: 0, bps: 0 };
  modelUi('waiting');
  if (!MODEL_RETRY.n) track('model_dl_start');
  // 1.42: remember it was started (and not paused), so it goes on by itself
  // when the program opens again — after closing it or a restart.
  try { localStorage.setItem(MODEL_STARTED_KEY, '1'); localStorage.removeItem(MODEL_PAUSED_KEY); } catch (e) {}
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
      if (m) {
        const got = Number(m[1]);
        if (MODEL_UI.state === 'waiting' || MODEL_UI.state === 'running') {
          // Bytes are flowing again: the next drop starts the waits over.
          if (got > MODEL_UI.done && MODEL_UI.state === 'running') MODEL_RETRY.n = 0;
          modelUi('running', got);
        }
        continue;
      }
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
    if (MODEL_RETRY.n === 0) track('model_dl_fail');
    scheduleModelRetry();
  });
  child.on('error', () => { modelChild = null; modelUi('failed'); track('model_dl_fail'); });
}
function initModelDownload() {
  const btn = $('modelBtn');
  if (!btn) return;
  if (!MODEL_MISSING) { const c = $('modelCard'); if (c) c.style.display = 'none'; return; }
  track('model_needed');
  btn.addEventListener('click', () => {
    if (modelChild) {
      modelChild.__paused = true;
      try { localStorage.setItem(MODEL_PAUSED_KEY, '1'); } catch (e) {}
      clearModelRetry();
      try { modelChild.kill(); } catch (e) {}
      return;
    }
    MODEL_RETRY.n = 0;
    retryModelNow();
  });
  // Internet back: do not wait for the timer.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => { if (MODEL_UI.state === 'retrying') retryModelNow(); });
  }
  modelUi('idle', 0);
  if (typeof i18nOnChange === 'function') i18nOnChange(() => setModelUi(MODEL_UI.state, MODEL_UI.done));
  // 1.42: started before and not paused -> continue by itself (never a first
  // download on its own: 612 MB can cost real money on mobile data)
  let started = false, paused = false;
  try { started = localStorage.getItem(MODEL_STARTED_KEY) === '1'; paused = localStorage.getItem(MODEL_PAUSED_KEY) === '1'; } catch (e) {}
  if (started && paused) modelUi('paused', 0);
  else if (started) setTimeout(() => { if (MODEL_MISSING && !modelChild && MODEL_UI.state === 'idle') { log('Continuing the Amharic model download…'); startModelDownload(); } }, 2500);
}

function setup() {
  applySettings();
  checkStyles();

  // Words-per-caption and Video shape only matter in Grouped mode: karaoke is
  // one word per caption, which always fits either shape. Hidden otherwise,
  // so the options card stays short.
  const syncStyleControls = () => {
    $('groupSize').disabled = (CAP !== 'grouped');
    const fmt = $('fmtField');
    if (fmt) fmt.style.display = (CAP === 'grouped') ? '' : 'none';
    // the number box only for an old setting above 5 (the row has 1-5)
    const gs = $('groupSizeField');
    if (gs) gs.style.display = (CAP === 'grouped' && GROUP_SIZE > 5) ? '' : 'none';
    syncWpc();
  };
  syncStyleControls();
  document.querySelectorAll('#wpcSeg button').forEach((b) => {
    b.addEventListener('click', () => { setWpc(Number(b.dataset.wpc)); syncStyleControls(); });
  });

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
    syncWpc();
  });
  document.querySelectorAll('#fmtSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#fmtSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      FORMAT = b.dataset.fmt === 'v' ? 'v' : 'h';
      MAX_CHARS = FORMAT_CHARS[FORMAT];
      saveSettings({ format: FORMAT, chars: MAX_CHARS });
    });
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
    log('Caption styles fonts, all SIL Open Font License 1.1:');
    log('Noto Sans Ethiopic and Noto Serif Ethiopic (https://github.com/notofonts/ethiopic),');
    log('Menbere (https://github.com/SorkinType/Menbere), Abyssinica SIL (https://software.sil.org/abyssinica/),');
    log('Agbalumo (https://github.com/SorkinType/Agbalumo), Hibur Mono by TypeHabesha (https://github.com/typehabesha/HiburMono),');
    log('the Senamirmir fonts Yebse, WashRa, Tint, Fantuwua, Jiret, Yigezu Bisrat Gothic (http://www.senamirmir.org).');
    log('');
    log('Desktop app, live caption style in the Studio player: JASSUB (MIT, https://github.com/ThaUnknown/jassub) =');
    log('libass + FreeType + HarfBuzz + FriBidi (LGPL-2.1) in WebAssembly; notices in app/vendor/NOTICE.txt.');
    log('');
    log('Voice activity detection: Silero VAD (https://github.com/snakers4/silero-vad).');
    log('License: MIT.');
    log('');
    log('Audio/video processing: FFmpeg (https://ffmpeg.org), bundled unmodified as a');
    log('separate executable and run as a child process. FFmpeg is licensed to you');
    log('under the GNU GPL. The full license text and a written offer for the');
    log('corresponding source code ship in the "legal" folder of the installed extension.');
    log('');
    log('Runtime: CPython (PSF-2.0) with CTranslate2 (MIT), NumPy (BSD-3-Clause),');
    log('onnxruntime (MIT) and soundfile (BSD-3-Clause).');
    log('Panel: Adobe CSInterface.js (BSD-3-Clause), json2 (Public Domain).');
    log('');
    log('Full per-component attribution: legal/THIRD-PARTY-NOTICES.md');
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
    log('The Amharic model is not on this computer yet (' + Math.round(MODEL_TOTAL_BYTES / 1e6) + ' MB).');
    log('Press Generate (or "Download the Amharic model" at the top). It is a');
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
  initWhatsNew();
  syncProgressRow();   // idle: no empty progress row
}

setup();
