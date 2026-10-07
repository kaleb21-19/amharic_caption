/**
 * Amharic Captions — Telegram sales bot (Cloudflare Worker).
 *
 * Stateless webhook adaptation of tools/telegram/bot.py.
 *   - Telegram pushes updates to / (webhook). Replies via the Bot API.
 *   - State lives in D1 (orders/customers/fsm); screenshots stored in D1 as
 *     base64 BLOBs (R2 intentionally skipped — avoids needing a card).
 *   - HMAC license secret is a Worker secret (env), never served to clients.
 *
 * Deploy: see DEPLOY.md in this folder.
 */

const API = 'https://api.telegram.org/bot';

// ── tiny Telegram API helper (stateless) ────────────────────────────────────
async function tg(token, method, params = {}) {
  let url = `${API}${token}/${method}`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  if (method === 'sendPhoto') {
    // multipart photo upload — handled separately. photo is either:
    //   - a data URI string "data:image/jpeg;base64,...." (BLOB fetched from D1)
    //   - an existing Telegram file_id
    url = `${API}${token}/sendPhoto`;
    const fd = new FormData();
    if (typeof params.photo === 'string' && params.photo.startsWith('data:')) {
      // legacy base64 blob (kept for back-compat with old rows) — unlikely now
      const comma = params.photo.indexOf(',');
      const b64 = params.photo.slice(comma + 1);
      const bytes = base64ToArrayBuffer(b64);
      fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'proof.jpg');
    } else {
      // modern path: photo is a Telegram file_id — pass straight through
      fd.append('photo', params.photo);
    }
    ['chat_id', 'caption', 'parse_mode'].forEach((k) => {
      if (params[k] != null) fd.append(k, params[k]);
    });
    if (params.reply_markup) fd.append('reply_markup', JSON.stringify(params.reply_markup));
    init.body = fd;
    delete init.headers['Content-Type'];
  } else {
    init.body = JSON.stringify(params);
  }
  const res = await fetch(url, init);
  try {
    return await res.json();
  } catch {
    return { ok: false };
  }
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ── license key logic (identical to bot.py / keygen.py ─────────────────────
// NOTE: key derivation is async (HMAC via WebCrypto). The key is computed in
// `approve()`; do NOT derive it in a sync context.
async function keyFor(machineId, expiry = '00000000') {
  const mid = String(machineId).trim().toLowerCase();
  if (!((mid.length === 8 || mid.length === 16) && /^[0-9a-f]+$/.test(mid))) throw new Error('Invalid Machine ID');
  if (!isValidExpiry(expiry)) throw new Error('Invalid expiry');
  const sig = await hmacHex(SECRET, `${mid}|${expiry}`);
  const raw = mid + expiry + sig.slice(0, 16);
  return 'AMH-' + raw.match(/.{1,4}/g).join('-');
}

function hmacHex(secret, msg) {
  // WebCrypto HMAC-SHA256, hex output
  const enc = new TextEncoder();
  const keyPromise = crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return keyPromise.then(async (k) => {
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

// License keys are displayed with a human-readable prefix and dashes, while
// D1 historically stored that formatted form. Compare one canonical body so
// `AMH-...`, spaced, dashless, and mixed-case pastes cannot select a different
// cache entry or miss the customer row.
function canonicalLicenseKey(value) {
  return String(value || '').trim().replace(/^amh/i, '').replace(/[\s-]+/g, '').toLowerCase();
}

function isValidMid(value) {
  return /^(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(String(value || '').trim().toLowerCase());
}

function isValidExpiry(value) {
  const exp = String(value || '');
  if (!/^\d{8}$/.test(exp)) return false;
  if (exp === '00000000') return true;
  const y = Number(exp.slice(0, 4));
  const m = Number(exp.slice(4, 6));
  const d = Number(exp.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ── signed install lease (verify side: panel/js/core.js verifyLicenseToken) ─
// The panel ships only LICENSE_TOKEN_PUBKEY_PEM — the public half of the key
// below — so a stored localStorage license can be verified LOCALLY, and a
// hand-written {valid:true} cannot unlock the panel. The private half lives only
// in this worker: env secret AMH_LICENSE_SIGNING_KEY (PKCS8 PEM). The signing
// secret is required for successful validation; a missing or invalid key makes
// the endpoint fail closed rather than returning a boolean-only success.
async function signLease(machineId, expiry) {
  const mid = String(machineId).trim().toLowerCase();
  const exp = String(expiry || '00000000');
  const der = pemToDer(SIGN_KEY);
  if (!der) throw new Error('AMH_LICENSE_SIGNING_KEY not set');
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const msg = new TextEncoder().encode(mid + '|' + exp);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg));
  const sigHex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'v1.' + mid + exp + '.' + sigHex; // matches licenseTokenParse() in core.js
}

async function licenseServicesReady() {
  if (!SECRET || !SIGN_KEY) return false;
  try {
    // Exercise both cryptographic services before an approval changes order
    // state. This catches a missing HMAC secret or malformed signing PEM.
    await keyFor('00000000', '00000000');
    await signLease('00000000', '00000000');
    return true;
  } catch (e) {
    log('error', 'license_service_preflight_failed', { err: String(e && e.message || e) });
    return false;
  }
}

function pemToDer(pem) {
  const b64 = String(pem || '')
    .replace(/-----BEGIN [\s\S]*?-----/g, '')
    .replace(/-----END [\s\S]*?-----/g, '')
    .replace(/\s+/g, '');
  return b64 ? base64ToArrayBuffer(b64) : null;
}

// Since generateKey must be sync in places but WebCrypto is async, we cache.
// For simplicity we compute keys lazily with an await in approve (async anyway).
let SECRET = '';
// Previous HMAC secret, accepted at VALIDATION only — never used to mint.
// Without it, one `wrangler secret put AMH_SECRET` silently invalidates every
// key ever issued: the signature check runs before the database lookup, so
// every existing customer gets "Key not recognized" with nothing in the logs
// tying it to the rotation. Set AMH_SECRET_PREV to the old value when
// rotating, leave it for a release or two, then clear it.
let SECRET_PREV = '';
let TOKEN = '';
let ADMIN_ID = ''; // may be comma-separated (multi-admin)
let ADMIN_PIN = '';
let GROUP_ID = '';
let PRICE = 'ETB 2,500'; // display string
let PRICE_ETB = 2500;    // numeric (source of truth for revenue/orders)
let ACCT_NAME = 'KALEB TEGEGEN';
let PAY_ACCOUNTS = 'CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015';

// Render the accounts one per line with each NUMBER in <code>. Telegram makes
// <code> tap-to-copy on mobile, and copying one account number into a banking
// app is the single most error-prone action in the whole sale. As a run-on
// bold string ("CBE 100… · Abyssinia 402… · Zemen 103…") it wrapped across
// two or three lines on a phone and the buyer had to hand-select a substring.
function accountLines() {
  return String(PAY_ACCOUNTS)
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(.*?)\s+([0-9][0-9\s-]*)$/.exec(part);
      return m ? `   <b>${m[1].trim()}</b>  <code>${m[2].replace(/[\s-]/g, '')}</code>`
               : `   <code>${part}</code>`;
    })
    .join('\n');
}
let ALLOWED_ORIGIN = ''; // comma-separated CORS allow-list ('' => * open)
const SUPPORT_URL = 'https://t.me/sumpak6';
const SITE_URL = 'https://amharic-caption-pro.vercel.app';
let WEBHOOK_SECRET = '';
let API_KEY = ''; // Optional deployment-level gate; never a license security boundary.
let API_KEY_REQUIRED = false;
let SIGN_KEY = ''; // PKCS8 PEM (ECDSA P-256) for signing install leases. Required for activation.
let CACHE = null; // optional KV namespace (AMH_KV). Absent => graceful fallback.
let BLOCK_SHARED = false;  // when '1', /api/validate refuses a key seen from too many IPs
let SHARE_ALERT_HOSTS = 2; // different computers per key (30 days) before the owner is told
let SHARE_HOSTS = 3;       // ... before AMH_BLOCK_SHARED=1 refuses it
let FRESH_MID_LIMIT = 5;   // max new (never-before-seen) mids per IP/day before trial use saturates
// Invite link for the support group. Configurable so the link can be rotated or
// swapped without a code change; this is the same link the Support button has
// always used.
let SUPPORT_INVITE = 'https://t.me/+L-bMfmIRyEo3MDg0';
// Optional public channel that mirrors every job card (AMH_JOBS_CHANNEL,
// '@name' or -100… id; the bot must be an admin there). Channels are easy to
// find and forward, so they grow faster than a group; every card links back.
let JOBS_PUBLIC = '';
// Public username of the support group (AMH_GROUP_USERNAME, no @).
let GROUP_USERNAME = '';

// ── config / env ────────────────────────────────────────────────────────────
function initEnv(env) {
  TOKEN = env.AMH_TG_TOKEN || '';
  // Fail-safe: never fall back to a hardcoded admin. Without AMH_ADMIN_ID
  // nobody is admin (approve/reject/broadcast all refuse), which is better than
  // silently granting an arbitrary Telegram user admin rights by default.
  ADMIN_ID = (env.AMH_ADMIN_ID || '').toString();
  if (!ADMIN_ID) log('warn', 'admin_id_missing', { hint: 'set AMH_ADMIN_ID (comma-separated chat ids) via wrangler secret put' });
  GROUP_ID = env.AMH_GROUP_ID || '';
  GROUP_TOPICS = parseGroupTopics(env.AMH_GROUP_TOPICS);
  SUPPORT_GROUP = String(env.AMH_SUPPORT_GROUP || '');
  JOBS_PUBLIC = String(env.AMH_JOBS_CHANNEL || '').trim();
  GROUP_USERNAME = String(env.AMH_GROUP_USERNAME || '').trim().replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  SUPPORT_INVITE = String(env.AMH_SUPPORT_INVITE || SUPPORT_INVITE);
  JOB_CHANNELS = String(env.AMH_JOB_CHANNELS || '').split(',')
    .map((c) => c.trim().replace(/^@/, '')).filter((c) => /^[A-Za-z0-9_]{4,40}$/.test(c));
  PRICE = env.AMH_PRICE || 'ETB 2,500';
  ACCT_NAME = env.AMH_ACCT_NAME || ACCT_NAME;
  PAY_ACCOUNTS = env.AMH_PAY_ACCOUNTS || PAY_ACCOUNTS;
  SECRET = env.AMH_SECRET || '';
  SECRET_PREV = env.AMH_SECRET_PREV || '';
  WEBHOOK_SECRET = env.AMH_WEBHOOK_SECRET || '';
  // Optional step-up PIN for money / broadcast / export actions (see "admin
  // security" below). Unset = those actions work without it (dashboard warns).
  ADMIN_PIN = String(env.AMH_ADMIN_PIN || '').trim();
  API_KEY = env.AMH_API_KEY || '';
  // The client cannot keep a secret: a desktop panel is public code. API-key
  // enforcement is therefore opt-in infrastructure gating, not the auth model.
  API_KEY_REQUIRED = String(env.AMH_REQUIRE_API_KEY || '') === '1';
  SIGN_KEY = env.AMH_LICENSE_SIGNING_KEY || '';
  ALLOWED_ORIGIN = env.AMH_ALLOWED_ORIGIN || '';
  PRICE_ETB = parseInt(env.AMH_PRICE_ETB, 10) || parseInt(PRICE.replace(/[^\d]/g, ''), 10) || 2500;
  BLOCK_SHARED = String(env.AMH_BLOCK_SHARED || '').toLowerCase() === '1';
  SHARE_ALERT_HOSTS = parseInt(env.AMH_SHARE_ALERT_HOSTS, 10) || 2;
  SHARE_HOSTS = parseInt(env.AMH_SHARE_HOSTS, 10) || 3;
  FRESH_MID_LIMIT = parseInt(env.AMH_FRESH_MID_DAY, 10) || 5;
  CACHE = env.AMH_KV || null;
  SETTINGS_CACHE = null;   // owner settings are re-read on every request
  globalThis.DB = env.DB;
}

// ── tiny shared helpers (KV cache, rate-limit marker, throttle) ─────────────
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function kvGet(key) {
  try {
    return CACHE ? await CACHE.get(key) : null;
  } catch (e) {
    log('error', 'kv_get_failed', { message: String((e && e.message) || e) });
    return null;
  }
}
async function kvPut(key, val, ttl) {
  try {
    if (!CACHE) return false;
    const options = {};
    if (ttl !== undefined && ttl !== null) {
      const seconds = Number(ttl);
      if (!Number.isFinite(seconds) || seconds < 60) {
        log('error', 'kv_ttl_invalid', { seconds: String(ttl) });
        return false;
      }
      options.expirationTtl = Math.floor(seconds);
    }
    await CACHE.put(key, String(val), options);
    return true;
  } catch (e) {
    // KV failures must be visible. Silently swallowing them previously made
    // rate-limit writes look successful while no marker was stored.
    log('error', 'kv_put_failed', { message: String((e && e.message) || e) });
    return false;
  }
}
async function kvDel(key) {
  try {
    if (!CACHE) return false;
    await CACHE.delete(key);
    return true;
  } catch (e) {
    log('error', 'kv_delete_failed', { message: String((e && e.message) || e) });
    return false;
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── structured logging (single JSON line per event → wrangler tail / dashboard)
function log(level, event, payload = {}) {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...payload }));
}

// ── multi-admin support: AMH_ADMIN_ID may be "111,222"
function adminUids() {
  return (ADMIN_ID || '').split(',').map((s) => String(s).trim()).filter(Boolean);
}
function isAdmin(uid) {
  return adminUids().includes(String(uid));
}

// ── admin security: audit log + step-up PIN ─────────────────────────────────
// The whole shop is controlled from the owner's Telegram account. If that
// account is taken over (SIM swap, a stolen session on another device), the
// attacker must not be able to broadcast a fake bank account to every
// customer, redirect partner payouts, mark money as paid, or export every
// license key. Those actions need a PIN that lives only in the owner's head
// (Worker secret AMH_ADMIN_PIN): /unlock PIN opens them for 12 hours on that
// account; 5 wrong PINs lock it for an hour and alert every admin.
const UNLOCK_HOURS = 12;
const PIN_MAX_FAILS = 5;

async function audit(adminUid, action, detail = '') {
  try {
    await DB.prepare('INSERT INTO admin_audit (admin_uid, action, detail) VALUES (?, ?, ?)')
      .bind(String(adminUid || ''), String(action), String(detail).slice(0, 300)).run();
  } catch (e) { /* migration 0020 not applied: never block the action */ }
}

async function adminUnlocked(uid) {
  if (!ADMIN_PIN) return true;
  return !!(await kvGet('adminunlock:' + uid));
}

// true = go ahead. Otherwise tells the admin how to unlock and returns false.
async function requireUnlock(uid, chatId, cbId, what) {
  if (await adminUnlocked(uid)) return true;
  if (cbId) await answerCb(cbId, '🔒 PIN needed — send /unlock PIN');
  await sendText(chatId,
    `🔒 <b>${esc(what)}</b> needs your admin PIN.\n\n` +
    `Send <code>/unlock YOUR-PIN</code> — it stays unlocked for ${UNLOCK_HOURS} hours on this account ` +
    '(the PIN message is deleted right away). Then tap again.\n\n' +
    '<i>This protects the shop if someone ever gets into your Telegram.</i>');
  await audit(uid, 'blocked_locked', what);
  return false;
}

async function handleUnlock(uid, chatId, messageId, pin) {
  // Never leave the PIN sitting in the chat history.
  if (messageId) await safeSend(tg(TOKEN, 'deleteMessage', { chat_id: chatId, message_id: messageId }));
  if (!ADMIN_PIN) {
    await sendText(chatId, 'ℹ️ No admin PIN is set, so nothing is locked. Set one: <code>npx wrangler secret put AMH_ADMIN_PIN</code>');
    return;
  }
  if (await kvGet('pinlock:' + uid)) {
    await sendText(chatId, '⛔ Too many wrong PINs — locked for an hour. Try again later.');
    return;
  }
  if (safeEqual(String(pin || '').trim(), ADMIN_PIN)) {
    await kvPut('adminunlock:' + uid, '1', UNLOCK_HOURS * 3600);
    await kvDel('pinfail:' + uid);
    await audit(uid, 'unlock', 'ok');
    await sendText(chatId, `🔓 Unlocked for ${UNLOCK_HOURS} hours. <i>/lock locks again now.</i>`,
      [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  const fails = (parseInt((await kvGet('pinfail:' + uid)) || '0', 10) || 0) + 1;
  await kvPut('pinfail:' + uid, String(fails), 3600);
  await audit(uid, 'unlock_failed', `attempt ${fails}`);
  if (fails >= PIN_MAX_FAILS) {
    await kvPut('pinlock:' + uid, '1', 3600);
    for (const adm of adminUids()) {
      await sendText(adm,
        `🚨 <b>${PIN_MAX_FAILS} wrong admin PINs</b> on account <code>${esc(uid)}</code> — PIN locked for 1 hour.\n` +
        '<i>If this was not you, someone may be in your Telegram: Settings → Devices → terminate other sessions, and turn on Two-Step Verification.</i>');
    }
    return;
  }
  await sendText(chatId, `❌ Wrong PIN (${fails}/${PIN_MAX_FAILS}).`);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A Telegram message's own formatting (bold, italic, links… as "entities") →
// Bot API HTML, with every other character escaped. Offsets are UTF-16 code
// units, the same as JavaScript string indexes.
const ENTITY_TAGS = {
  bold: ['<b>', '</b>'], italic: ['<i>', '</i>'], underline: ['<u>', '</u>'],
  strikethrough: ['<s>', '</s>'], spoiler: ['<tg-spoiler>', '</tg-spoiler>'],
  code: ['<code>', '</code>'], pre: ['<pre>', '</pre>'], blockquote: ['<blockquote>', '</blockquote>'],
};
function entitiesToHtml(text, entities) {
  text = String(text || '');
  const opens = {};
  const closes = {};
  for (const e of entities || []) {
    let tags = ENTITY_TAGS[e.type];
    if (e.type === 'text_link' && /^https?:\/\//i.test(String(e.url || ''))) {
      tags = [`<a href="${esc(e.url).replace(/"/g, '&quot;')}">`, '</a>'];
    }
    if (!tags || !(e.length > 0)) continue;
    (opens[e.offset] = opens[e.offset] || []).push({ tag: tags[0], len: e.length });
    (closes[e.offset + e.length] = closes[e.offset + e.length] || []).unshift({ tag: tags[1], len: e.length });
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    // Inner (shorter) entities close first; outer (longer) ones open first.
    if (closes[i]) out += closes[i].sort((a, b) => a.len - b.len).map((x) => x.tag).join('');
    if (opens[i]) out += opens[i].sort((a, b) => b.len - a.len).map((x) => x.tag).join('');
    if (i < text.length) out += esc(text[i]);
  }
  return out;
}

// ── menu text (port from bot.py) ────────────────────────────────────────────
function heroText(first = '', offer = null) {
  const name = first ? `${esc(first)}, ` : '';
  const invited = offer && offer.discount > 0
    ? `\n\n🎁 <b>በጓደኛዎ ግብዣ</b> ፈቃዱን በ <b>ETB ${money(offer.price)}</b> ያገኛሉ (<s>${PRICE}</s>)።\n` +
      `<i>Invited by a friend: your license is ETB ${money(offer.price)} instead of ${PRICE}.</i>`
    : '';
  return (
    `${name}ወደ <b>አማርኛ ካፕሽን ፕሮ</b> እንኳን በደህና መጡ 👋\n` +
    '<i>Welcome to Amharic Captions Pro</i>\n\n' +
    '💯 ሙሉ በሙሉ <b>በኮምፒውተርዎ ላይ</b> ይሰራል — ቪዲዮዎ ወደ ኢንተርኔት አይላክም።\n' +
    '<i>Runs 100% on your computer — your video is never uploaded.</i>\n\n' +
    '🎁 <b>2 ካፕሽን በነጻ</b> ይሞክሩ — ከወደዱት በኋላ ብቻ ይክፈሉ።\n' +
    '<i>Try 2 captions free — pay only if you like it.</i>\n\n' +
    `💰 <s>ETB 3,500</s> → <b>${PRICE}</b> — አንድ ጊዜ ብቻ ይከፍላሉ።\n` +
    '<i>One payment. No subscription.</i>' + invited
  );
}
// One button per row on purpose: Amharic labels are longer than their English
// equivalents, and two per row truncates them with an ellipsis on a phone.
// `invite` adds the referral button (programme ON and the user is a buyer).
const FAQ_BTN = { text: '❓ ጥያቄዎች · Questions', callback_data: 'faq:home' };
const heroKeyboard = (invite = false) => [
  [{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }],
  [FAQ_BTN],
  [{ text: '🔑 ቁልፌ · My Key', callback_data: 'menu:mykey' }],
  ...(invite ? [[{ text: '🎁 ጓደኛ ይጋብዙ · Invite friends', callback_data: 'ref:invite' }]] : []),
  [{ text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` }],
  [{ text: '💬 ድጋፍ · Support', url: SUPPORT_INVITE }],
];

// The shop owner's /start opens the same dashboard as /admin (adminPanel):
// one admin home, with every button, instead of a shorter greeting screen.

// Amharic first, English under it. This is the screen where someone parts with
// ETB 2,500, and it was English-only — the panel and the website both speak
// Amharic, but the one moment that involves their money did not.
function payText(offer = null) {
  // Deliberately short. This screen exists so the buyer can do ONE thing: send
  // money to one of three accounts. The previous version ran 18 lines and 587
  // characters on a phone — price, accounts, a two-line key promise in both
  // languages, a three-line scam warning and a "tap below" instruction the
  // button already gives. Everything that is not the amount, the accounts or
  // the one risk that costs them money has been cut.
  const priceLines = offer && offer.discount > 0
    ? `💰 <b>ETB ${money(offer.price)}</b> · የጓደኛ ቅናሽ / friend discount\n` +
      `<s>${PRICE}</s> — መደበኛ ዋጋ / regular price\n\n`
    : `💰 <b>${PRICE}</b> · አንድ ጊዜ ብቻ / one-time\n` +
      `<s>ETB 3,500</s> — መግቢያ ዋጋ / launch price\n\n`;
  return (
    priceLines +
    `🏦 <b>${ACCT_NAME}</b> — ባንክ ዝውውር / bank transfer\n` +
    'ቁጥሩን ለመቅዳት ይንኩት / tap a number to copy:\n' +
    accountLines() + '\n\n' +
    '📸 <b>ከከፈሉ በኋላ የክፍያውን ስክሪንሾት እዚሁ ይላኩ — ያ ብቻ ነው።</b>\n' +
    '<i>After paying, send the payment screenshot right here — that is all.</i>\n\n' +
    `⚠️ <b>${ACCT_NAME}</b> ብቻ ይክፈሉ — ሌላ ስም ወይም አካውንት ቢጠየቁ እኛ አይደለንም።\n` +
    '<i>Pay only this name. Anyone asking for a different account is not us.</i>'
  );
}

const payKeyboard = (fromPanel = false) => [
  [{ text: '✅ ከፍያለሁ — ስክሪንሾት ልላክ · I’ve paid', callback_data: 'pay:proof' }],
  ...(fromPanel ? [] : [[{ text: '🎁 መጀመሪያ በነጻ ልሞክር · Try 2 free', url: `${SITE_URL}/install` }]]),
];

const MENU = 'ሰላም! 👋 ከታች ይምረጡ / Choose below:';
// Was a byte-identical copy of heroKeyboard(). Two definitions of one menu is
// how they drift apart — this one still said "Pay" in English after the other
// had been translated.
const MENU_KEYBOARD = heroKeyboard();

// ── D1 helpers ──────────────────────────────────────────────────────────────
async function findKey(mid) {
  const r = await DB.prepare('SELECT key FROM customers WHERE machine_id = ? LIMIT 1').bind(mid).first();
  return r ? r.key : null;
}
async function countSold() {
  const r = await DB.prepare("SELECT COUNT(*) AS n FROM customers WHERE status='sold'").first();
  return r ? r.n : 0;
}
async function pendingCount() {
  const cached = await kvGet('pending:count');
  if (cached) { const n = parseInt(cached, 10); if (!isNaN(n)) return n; }
  const r = await DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending'").first();
  const n = r ? r.n : 0;
  await kvPut('pending:count', n, 60);
  return n;
}
// Auto-prune: keep only the last 30 days of orders + funnel events. Called on
// every admin action + the cron trigger so history stays small.
async function pruneOld() {
  const o = await DB.prepare("DELETE FROM orders WHERE created_at < datetime('now', '-30 days')").run();
  const f = await DB.prepare("DELETE FROM funnel WHERE ts < datetime('now', '-30 days')").run();
  // key_activations stores raw source IPs for spread detection — keep a 30-day
  // window, then drop them (run_set ttl; privacy: do not hold IPs indefinitely).
  const k = await DB.prepare("DELETE FROM key_activations WHERE last_seen < datetime('now', '-30 days')").run();
  try { await DB.prepare("DELETE FROM key_hosts WHERE last_seen < datetime('now', '-30 days')").run(); } catch (e) { /* 0024 */ }
  try { await DB.prepare("DELETE FROM events_daily WHERE day < date('now', '-120 days')").run(); } catch (e) { /* 0025 */ }
  const c = await DB.prepare("DELETE FROM ip_counters WHERE updated_at < datetime('now', '-30 days')").run();
  // Rate-limit rows whose window has already closed (0021). Windows are short
  // (60 s on the panel endpoints), so the table stays small; this just stops it
  // growing for good between deploys.
  const rl = await DB.prepare('DELETE FROM rl_counters WHERE window_end < ?').bind(Math.floor(Date.now() / 1000)).run();
  // Jobs-feed dedupe markers (0022): the KV form carried a 30-day TTL, so the
  // same window is applied by hand now. Only rows older than that can be
  // re-posted anyway, since the feed ignores anything past JOB_SEED_HOURS.
  const js = await DB.prepare("DELETE FROM jobs_seen WHERE seen_at < datetime('now', '-30 days')").run();
  // Abandoned purchase flows: getFsm ignores them after 24h, this clears the rows.
  const fs = await DB.prepare("DELETE FROM fsm WHERE updated_at < datetime('now', '-2 days')").run();
  const tu = await DB.prepare("DELETE FROM trial_uses WHERE used_at < datetime('now', '-30 days')").run();
  const wu = await DB.prepare("DELETE FROM webhook_updates WHERE received_at < datetime('now', '-30 days')").run();
  // The audit log is kept for a year (who approved / paid / broadcast what).
  try { await DB.prepare("DELETE FROM admin_audit WHERE ts < datetime('now', '-365 days')").run(); } catch (e) { /* 0020 */ }
  // Finished broadcasts: the per-recipient queue is only needed while sending.
  await DB.prepare(
    "DELETE FROM broadcast_queue WHERE broadcast_id IN (SELECT id FROM broadcasts " +
    "WHERE status IN ('done','cancelled','draft') AND created_at < datetime('now', '-30 days'))").run();
  await DB.prepare(
    "DELETE FROM broadcasts WHERE status IN ('done','cancelled','draft') AND created_at < datetime('now', '-30 days')").run();
  log('info', 'prune_run', {
    orders: o && o.meta ? o.meta.changes : 0,
    funnel: f && f.meta ? f.meta.changes : 0,
    key_activations: k && k.meta ? k.meta.changes : 0,
    ip_counters: c && c.meta ? c.meta.changes : 0,
    rl_counters: rl && rl.meta ? rl.meta.changes : 0,
    jobs_seen: js && js.meta ? js.meta.changes : 0,
    fsm: fs && fs.meta ? fs.meta.changes : 0,
    trial_uses: tu && tu.meta ? tu.meta.changes : 0,
    webhook_updates: wu && wu.meta ? wu.meta.changes : 0,
  });
}
// An in-progress purchase is only meaningful for a day. Without this, a buyer
// who tapped "I've paid", sent a Machine ID and then wandered off would come
// back WEEKS later, send an unrelated photo, and have it booked as payment
// proof against that ancient flow — or get "I'm waiting for your screenshot"
// for something they no longer remember starting.
const FSM_TTL_HOURS = 24;
async function getFsm(uid) {
  const r = await DB.prepare(
    "SELECT * FROM fsm WHERE uid = ? AND updated_at >= datetime('now', ?)")
    .bind(uid, `-${FSM_TTL_HOURS} hours`).first();
  if (r) return r;
  // Self-healing: drop the stale row so the buyer starts clean rather than
  // sitting in a step the bot no longer honours.
  await DB.prepare('DELETE FROM fsm WHERE uid = ?').bind(uid).run();
  return null;
}
async function setFsm(uid, s) {
  if (!s) {
    await DB.prepare('DELETE FROM fsm WHERE uid = ?').bind(uid).run();
    return;
  }
  const args = [
    uid, s.step, s.mid || null, s.photo_key || null, s.ref || '', s.hint ? 1 : 0,
    s.status_msg_id != null ? s.status_msg_id : null,
  ];
  try {
    // nonce: the panel's secret from its Buy button (migration 0019), which
    // lets that panel activate itself after approval.
    await DB.prepare(
      `INSERT INTO fsm (uid, step, mid, photo_key, ref, hint, status_msg_id, nonce, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uid) DO UPDATE SET
         step=excluded.step, mid=excluded.mid, photo_key=excluded.photo_key,
         ref=excluded.ref, hint=excluded.hint, status_msg_id=excluded.status_msg_id,
         nonce=excluded.nonce, updated_at=datetime('now')`
    ).bind(...args, s.nonce || null).run();
  } catch (e) {
    // Migration 0019 not applied yet: everything but self-activation works.
    await DB.prepare(
      `INSERT INTO fsm (uid, step, mid, photo_key, ref, hint, status_msg_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(uid) DO UPDATE SET
         step=excluded.step, mid=excluded.mid, photo_key=excluded.photo_key,
         ref=excluded.ref, hint=excluded.hint, status_msg_id=excluded.status_msg_id,
         updated_at=datetime('now')`
    ).bind(...args).run();
  }
}
async function addFunnel(uid, event) {
  await DB.prepare('INSERT INTO funnel (uid, event) VALUES (?, ?)').bind(uid, event).run();
}

// ── referral programme ("invite a friend") ─────────────────────────────────
// The owner controls it from the admin panel (🎁 Referrals): ON/OFF, friend
// discount, reward per sale and the waiting period (migration 0015). It is OFF
// until switched on.
//
// Safety rule for everything below: every read is defensive. If the tables are
// missing (deploy without `npm run migrate`) or a query fails, the bot behaves
// as if the programme were OFF — a referral problem can never block or change
// a normal sale.
const REF_DEFAULTS = {
  referral_enabled: '0',
  referral_discount_etb: '200',
  referral_reward_etb: '300',
  referral_hold_days: '14',
};
// No 0/O, 1/I/L: codes are read aloud and typed from screenshots.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BOT_LINK = 'https://t.me/AmharicCaptionsBot';
let SETTINGS_CACHE = null;

async function getSettings() {
  if (SETTINGS_CACHE) return SETTINGS_CACHE;
  const s = { ...REF_DEFAULTS };
  try {
    const { results } = await DB.prepare('SELECT key, value FROM settings').all();
    for (const r of results || []) s[r.key] = String(r.value);
  } catch (e) {
    log('warn', 'settings_unavailable', { err: String((e && e.message) || e) });
  }
  SETTINGS_CACHE = s;
  return s;
}

async function setSetting(key, value) {
  await DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, String(value)).run();
  SETTINGS_CACHE = null;
}

function refTerms(s) {
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  return {
    on: s.referral_enabled === '1',
    discount: Math.min(Math.max(int(s.referral_discount_etb, 200), 0), PRICE_ETB - 1),
    reward: Math.max(int(s.referral_reward_etb, 300), 0),
    hold: Math.min(Math.max(int(s.referral_hold_days, 14), 0), 365),
  };
}
const refCutoff = (t) => `-${t.hold} days`;

async function isBuyer(uid) {
  const r = await DB.prepare('SELECT 1 AS x FROM customers WHERE uid = ? AND revoked = 0 LIMIT 1')
    .bind(String(uid)).first();
  if (r) return true;
  // Paid from the phone and holding an activation code not used yet.
  try {
    const c = await DB.prepare('SELECT 1 AS x FROM activation_codes WHERE uid = ? AND revoked = 0 LIMIT 1')
      .bind(String(uid)).first();
    return !!c;
  } catch (e) { return false; }
}

async function refCodeFor(uid) {
  const have = await DB.prepare('SELECT code FROM referral_codes WHERE uid = ?').bind(String(uid)).first();
  if (have) return have.code;
  for (let i = 0; i < 6; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(7));
    const code = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
    if (await partnerByCode(code)) continue;
    const r = await DB.prepare('INSERT OR IGNORE INTO referral_codes (uid, code) VALUES (?, ?)')
      .bind(String(uid), code).run();
    if (r && r.meta && r.meta.changes) return code;
    const again = await DB.prepare('SELECT code FROM referral_codes WHERE uid = ?').bind(String(uid)).first();
    if (again) return again.code; // a parallel request created it first
  }
  throw new Error('could not allocate a referral code');
}
const refLink = (code) => `${BOT_LINK}?start=r_${code}`;

// Partner sales are credited to the partner CODE ("partner:EDITGROUP"), not to
// a Telegram account. So the public link works before the partner connects
// (rewards wait for them), and a partner who changes phone/account keeps every
// sale and every birr owed (/partnerreset issues a new private link).
const partnerKey = (code) => 'partner:' + code;
const isPartnerKey = (k) => String(k || '').startsWith('partner:');
const ATTRIBUTION_DAYS = 60;   // an unused link stops holding a person after this
const QUOTE_HOURS = 48;        // the price shown on the pay screen is honoured this long

// The Telegram account that receives messages and payouts for a referrer key
// (null: a partner who has not connected yet).
async function recipientOf(key) {
  if (!isPartnerKey(key)) return String(key);
  const partner = await partnerByCode(String(key).slice('partner:'.length));
  return partner && partner.uid ? partner.uid : null;
}

// Is this link still able to give a discount right now?
async function codeIsLive(code) {
  const b = await DB.prepare('SELECT 1 AS x FROM referral_codes WHERE code = ?').bind(code).first();
  if (b) return refTerms(await getSettings()).on;
  const partner = await partnerByCode(code);
  return !!(partner && partner.active);
}

// Someone opened a link (/start r_CODE) or typed a partner code. The first LIVE
// link wins: an earlier link keeps the person only while it is still active and
// younger than ATTRIBUTION_DAYS — a paused or forgotten link cannot hold them
// forever. The referrer's own link, admins and existing buyers do nothing.
// Returns 'ok' (link applied) or why not: 'buyer', 'inactive', 'self',
// 'kept' (still held by another live link), 'admin', 'error'.
async function attachReferral(uid, code) {
  try {
    code = String(code).toUpperCase();
    if (isAdmin(uid)) return 'admin';
    let owner = null;
    const buyerCode = await DB.prepare('SELECT uid FROM referral_codes WHERE code = ?').bind(code).first();
    if (buyerCode) {
      if (!refTerms(await getSettings()).on) return 'inactive';   // buyer links follow the programme switch
      owner = buyerCode.uid;
    } else {
      const partner = await partnerByCode(code);                // partner links have their own switch
      if (!partner || !partner.active) return 'inactive';
      if (partner.uid && partner.uid === String(uid)) return 'self';
      owner = partnerKey(partner.code);
    }
    if (owner === String(uid)) return 'self';
    if (await isBuyer(uid)) return 'buyer';
    const cur = await DB.prepare(
      "SELECT referrer_uid, code, (created_at >= datetime('now', ?)) AS fresh FROM referrals WHERE friend_uid = ?"
    ).bind(`-${ATTRIBUTION_DAYS} days`, String(uid)).first();
    if (!cur) {
      await DB.prepare('INSERT OR IGNORE INTO referrals (friend_uid, referrer_uid, code) VALUES (?, ?, ?)')
        .bind(String(uid), owner, code).run();
      return 'ok';
    }
    if (cur.code === code) return 'ok';
    if (cur.fresh && (await codeIsLive(cur.code))) return 'kept';
    await DB.prepare(
      `UPDATE referrals SET referrer_uid = ?, code = ?, created_at = datetime('now'),
         quoted_discount = NULL, quoted_reward = NULL, quoted_at = NULL
       WHERE friend_uid = ?`
    ).bind(owner, code, String(uid)).run();
    return 'ok';
  } catch (e) {
    log('error', 'referral_attach_failed', { err: String((e && e.message) || e) });
    return 'error';
  }
}

// One line under the welcome when a link opened but gives no discount, so the
// person knows why instead of thinking the link is broken.
function linkNote(reason) {
  if (reason === 'buyer') {
    return '\n\nℹ️ ቀደም ብለው ፈቃድ ስላለዎት ይህ ቅናሽ ለእርስዎ አይሰራም — ለአዲስ ደንበኞች ብቻ ነው።\n' +
      '<i>You already have a license, so this discount is for new customers only.</i>';
  }
  if (reason === 'inactive') {
    return '\n\nℹ️ ይህ የቅናሽ ሊንክ አሁን አይሰራም።\n<i>This discount link is not active right now.</i>';
  }
  if (reason === 'self') {
    return '\n\nℹ️ የራስዎን ሊንክ ነው የከፈቱት — ለሌሎች ያጋሩት።\n<i>This is your own link — share it with others.</i>';
  }
  return '';
}

// Current terms of a referral row, or null when its link gives nothing now.
async function liveTerms(r) {
  const partner = await partnerByCode(r.code);
  if (partner) {
    if (!partner.active || r.referrer_uid !== partnerKey(partner.code)) return null;
    const pt = await partnerTerms(partner);
    return { discount: pt.discount, reward: pt.reward, partner: partner.code, partnerUid: partner.uid };
  }
  const g = refTerms(await getSettings());
  if (!g.on) return null;
  return { discount: g.discount, reward: g.reward, partner: null, partnerUid: null };
}

// Self-referral, existing buyers and the referrer's own computer never qualify.
async function referralEligible(uid, mid, r, partnerUid) {
  if (partnerUid && partnerUid === String(uid)) return false;
  if (await isBuyer(uid)) return false;
  if (mid) {
    const ownerUid = isPartnerKey(r.referrer_uid) ? partnerUid : r.referrer_uid;
    if (ownerUid) {
      const own = await DB.prepare('SELECT 1 AS x FROM customers WHERE uid = ? AND machine_id = ?')
        .bind(ownerUid, String(mid).toLowerCase()).first();
      if (own) return false;
    }
  }
  return true;
}

// The live offer for an invited person, or null.
async function referralOffer(uid, mid = null) {
  try {
    const r = await DB.prepare('SELECT * FROM referrals WHERE friend_uid = ?').bind(String(uid)).first();
    if (!r || r.referrer_uid === String(uid)) return null;
    const t = await liveTerms(r);
    if (!t || !(await referralEligible(uid, mid, r, t.partnerUid))) return null;
    return { referrer: r.referrer_uid, discount: t.discount, reward: t.reward, price: PRICE_ETB - t.discount, partner: t.partner };
  } catch (e) {
    log('error', 'referral_offer_failed', { err: String((e && e.message) || e) });
    return null;
  }
}

// Remember the price shown on the pay screen (the buyer may transfer it now).
async function quoteOffer(uid, offer) {
  if (!offer) return;
  try {
    await DB.prepare(
      "UPDATE referrals SET quoted_discount = ?, quoted_reward = ?, quoted_at = datetime('now') WHERE friend_uid = ?"
    ).bind(offer.discount, offer.reward, String(uid)).run();
  } catch (e) { /* migration 0017 not applied: live terms only */ }
}

// The offer for the review screen and the order: the price the buyer SAW
// (valid QUOTE_HOURS) even if the link was paused or the terms changed since;
// otherwise the live offer.
async function orderOffer(uid, mid) {
  try {
    const r = await DB.prepare(
      "SELECT *, (quoted_at >= datetime('now', ?)) AS quote_ok FROM referrals WHERE friend_uid = ?"
    ).bind(`-${QUOTE_HOURS} hours`, String(uid)).first();
    if (r && r.quote_ok && r.quoted_discount != null && r.referrer_uid !== String(uid)) {
      const partner = await partnerByCode(r.code);
      if (!(await referralEligible(uid, mid, r, partner ? partner.uid : null))) return null;
      return {
        referrer: r.referrer_uid, discount: r.quoted_discount, reward: r.quoted_reward,
        price: PRICE_ETB - r.quoted_discount, partner: partner ? partner.code : null,
      };
    }
  } catch (e) { /* no quote columns yet: live terms */ }
  return referralOffer(uid, mid);
}

// Main menu for a user: the 🎁 button only for buyers while the programme is ON.
async function menuKeyboardFor(uid) {
  try {
    const partner = await partnerByUid(uid);
    if (partner && partner.active) return heroKeyboard(true);
    if (refTerms(await getSettings()).on && (await isBuyer(uid))) return heroKeyboard(true);
  } catch (e) { /* plain menu */ }
  return heroKeyboard(false);
}

async function rewardStats(uid) {
  const row = await DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('earned','paid') THEN 1 ELSE 0 END), 0) AS bought,
       COALESCE(SUM(CASE WHEN status IN ('earned','paid') THEN amount_etb ELSE 0 END), 0) AS earned,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_etb ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN status = 'earned' THEN amount_etb ELSE 0 END), 0) AS owed,
       COALESCE(SUM(CASE WHEN status IN ('earned','paid') AND earned_at >= date('now','start of month') THEN 1 ELSE 0 END), 0) AS month_n,
       COALESCE(SUM(CASE WHEN status IN ('earned','paid') AND earned_at >= date('now','start of month') THEN amount_etb ELSE 0 END), 0) AS month_etb
     FROM referral_rewards WHERE referrer_uid = ?`
  ).bind(String(uid)).first();
  return row || { bought: 0, earned: 0, paid: 0, owed: 0, month_n: 0, month_etb: 0 };
}

function shareUrl(link, t) {
  const text = 'አማርኛ ካፕሽን ፕሮ — የአማርኛ ካፕሽን በደቂቃዎች፣ ለPremiere፣ After Effects፣ CapCut እና DaVinci።' +
    (t.discount > 0 ? ` በዚህ ሊንክ ሲገዙ ${money(t.discount)} ብር ቅናሽ ያገኛሉ 👇` : ' 👇');
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

// Buyer's "🎁 Invite friends" screen (/invite, the menu button, and the
// message that follows a new buyer's key).
async function showInvite(uid, chatId, messageId) {
  const asPartner = await partnerByUid(uid);
  if (asPartner) { await showPartner(asPartner, uid, chatId, messageId); return; }
  const back = [{ text: '⬅ ወደ ዋና ገጽ · Menu', callback_data: 'menu:home' }];
  const show = async (text, kb) => {
    const r = messageId ? await editText(chatId, messageId, text, kb) : null;
    if (!r || !r.ok) await sendText(chatId, text, kb);
  };
  let t;
  let st;
  let acct;
  try {
    t = refTerms(await getSettings());
    st = await rewardStats(uid);
    acct = await DB.prepare('SELECT details FROM payout_accounts WHERE uid = ?').bind(String(uid)).first();
  } catch (e) {
    await show('🎁 የግብዣ ፕሮግራሙ አሁን አይገኝም።\n<i>The invite programme is not available right now.</i>', [back]);
    return;
  }
  const acctLine = acct
    ? `🏦 የክፍያ አካውንት / Payout account: <code>${esc(acct.details)}</code>`
    : '🏦 የክፍያ አካውንት አልተመዘገበም — ከታች ያስገቡ።\n<i>No payout account yet — add it below.</i>';
  const stats = st.bought
    ? `📊 በሊንክዎ የገዙ፦ <b>${st.bought}</b> · ያገኙት፦ <b>${money(st.earned)} ብር</b> · የተከፈለ፦ <b>${money(st.paid)} ብር</b>\n` +
      `<i>Friends who bought: ${st.bought} · earned ${money(st.earned)} ብር · paid ${money(st.paid)} ብር</i>`
    : '';

  if (!t.on) {
    const owed = st.owed > 0;
    const text = '🎁 <b>ጓደኛ ይጋብዙ · Invite friends</b>\n\n' +
      'የግብዣ ፕሮግራሙ አሁን ዝግ ነው።' + (owed ? ' ቀደም ብለው ያገኙት ሽልማት ግን ይከፈልዎታል።' : '') + '\n' +
      '<i>The invite programme is paused.' + (owed ? ' Rewards you already earned will still be paid.' : '') + '</i>' +
      (stats ? '\n\n' + stats : '') + (owed ? '\n\n' + acctLine : '');
    await show(text, owed ? [[{ text: '🏦 የክፍያ አካውንት · Payout account', callback_data: 'ref:payout' }], back] : [back]);
    return;
  }
  if (!(await isBuyer(uid))) {
    await show(
      '🎁 <b>ጓደኛ ይጋብዙ · Invite friends</b>\n\n' +
      'የግብዣ ሊንክ የሚሰጠው ፈቃድ ለገዙ ደንበኞች ነው።\n' +
      '<i>Invite links are for customers who bought a license.</i>',
      [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }], back]);
    return;
  }

  const link = refLink(await refCodeFor(uid));
  const offer = t.discount > 0
    ? `👥 ጓደኛዎ በሊንክዎ ሲገዛ <b>${money(t.discount)} ብር ቅናሽ</b> ያገኛል፤ እርስዎ ደግሞ <b>${money(t.reward)} ብር</b> ያገኛሉ።\n` +
      `<i>Your friend gets ${money(t.discount)} ብር off, and you earn ${money(t.reward)} ብር for each friend who buys.</i>`
    : `👥 ጓደኛዎ በሊንክዎ ሲገዛ እርስዎ <b>${money(t.reward)} ብር</b> ያገኛሉ።\n` +
      `<i>You earn ${money(t.reward)} ብር for each friend who buys with your link.</i>`;
  const text =
    '🎁 <b>ጓደኛ ይጋብዙ · Invite friends</b>\n\n' +
    'ይህን ሊንክ ለጓደኞችዎ ያጋሩ፦\n' +
    `<code>${link}</code>\n\n` +
    offer + '\n\n' +
    (stats ? stats + '\n\n' : '') +
    `💸 ሽልማቱ ጓደኛዎ ከገዛ ከ${t.hold} ቀን በኋላ፣ በወር አንድ ጊዜ በባንክ ይላክልዎታል።\n` +
    `<i>Rewards are sent by bank transfer once a month, ${t.hold} days after your friend's purchase.</i>\n\n` +
    acctLine;
  await show(text, [
    [{ text: '📤 ሊንኩን ያጋሩ · Share link', url: shareUrl(link, t) }],
    [{ text: '🏦 የክፍያ አካውንት · Payout account', callback_data: 'ref:payout' }],
    [{ text: '📜 ውሎች · Terms', url: `${SITE_URL}/legal/#referral` }],
    back,
  ]);
}

// ── partner links (a group, channel or influencer) ─────────────────────────
// Created by the owner with their own terms and their own on/off switch,
// independent of the buyer-referral switch (migration 0016). The partner
// opens a private claim link once, which connects their Telegram account:
// that is where their stats are shown and where their rewards are paid.
// Every read is defensive: without the table, partner links simply do nothing.
const PARTNER_CODE_RE = /^[A-Z0-9]{3,20}$/;

async function partnerByCode(code) {
  try {
    return await DB.prepare('SELECT * FROM partners WHERE code = ?').bind(String(code).toUpperCase()).first();
  } catch (e) { return null; }
}
async function partnerByUid(uid) {
  try {
    return await DB.prepare('SELECT * FROM partners WHERE uid = ?').bind(String(uid)).first();
  } catch (e) { return null; }
}
// The partner's payout account: the one they saved themselves, else the one
// the owner recorded for them (/partnerbank — before or without connecting).
async function partnerAccount(p) {
  if (!p) return null;
  if (p.uid) {
    const own = await DB.prepare('SELECT details, updated_at FROM payout_accounts WHERE uid = ?').bind(p.uid).first();
    if (own) return { ...own, byOwner: false };
  }
  const rec = await DB.prepare('SELECT details, updated_at FROM payout_accounts WHERE uid = ?').bind(partnerKey(p.code)).first();
  return rec ? { ...rec, byOwner: true } : null;
}
// Payout account for any referrer key (a buyer's uid or "partner:CODE").
async function accountOf(key) {
  if (isPartnerKey(key)) return partnerAccount(await partnerByCode(String(key).slice('partner:'.length)));
  return DB.prepare('SELECT details, updated_at FROM payout_accounts WHERE uid = ?').bind(String(key)).first();
}
// What is payable right now for a referrer key (older than the hold days).
async function payableOf(key, t) {
  const r = await DB.prepare(
    `SELECT COALESCE(SUM(amount_etb), 0) AS etb, COUNT(*) AS n, GROUP_CONCAT(order_id) AS orders
     FROM referral_rewards WHERE referrer_uid = ? AND status = 'earned' AND earned_at <= datetime('now', ?)`
  ).bind(String(key), refCutoff(t)).first();
  return r || { etb: 0, n: 0, orders: null };
}
async function partnerSold(p) {
  if (!p) return 0;
  const r = await DB.prepare(
    "SELECT COUNT(*) AS n FROM referral_rewards WHERE referrer_uid = ? AND status IN ('earned','paid')")
    .bind(partnerKey(p.code)).first();
  return r ? r.n : 0;
}
// Terms for the partner's NEXT sale (the reward steps up after tier_after sales).
async function partnerTerms(p) {
  const sold = await partnerSold(p);
  const tier = p.tier_after > 0 && p.tier_reward > 0 && sold >= p.tier_after;
  return {
    discount: Math.min(Math.max(p.discount_etb || 0, 0), PRICE_ETB - 1),
    reward: Math.max(tier ? p.tier_reward : (p.reward_etb || 0), 0),
    sold,
    tier,
  };
}

function partnerTermsText(p) {
  return `friend −${money(p.discount_etb)} ብር · ${money(p.reward_etb)} ብር/sale` +
    (p.tier_after > 0 && p.tier_reward > 0 ? ` (${money(p.tier_reward)} after ${p.tier_after} sales)` : '');
}

// The partner's own screen (/invite, the menu button, the claim link).
async function showPartner(p, uid, chatId, messageId) {
  const back = [{ text: '⬅ ወደ ዋና ገጽ · Menu', callback_data: 'menu:home' }];
  const show = async (text, kb) => {
    const r = messageId ? await editText(chatId, messageId, text, kb) : null;
    if (!r || !r.ok) await sendText(chatId, text, kb);
  };
  const pt = await partnerTerms(p);
  const st = await rewardStats(partnerKey(p.code));
  const opened = await DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE code = ?').bind(p.code).first();
  const openedN = opened ? opened.n : 0;
  const conv = openedN ? Math.round((100 * st.bought) / openedN) : 0;
  const acct = await partnerAccount(p);
  const hold = refTerms(await getSettings()).hold;
  const link = refLink(p.code);
  const offer = pt.discount > 0
    ? `👥 በሊንክዎ የሚገዙ <b>${money(pt.discount)} ብር ቅናሽ</b> ያገኛሉ፤ እርስዎ በእያንዳንዱ ሽያጭ <b>${money(pt.reward)} ብር</b> ያገኛሉ።\n` +
      `<i>People who buy through your link get ${money(pt.discount)} ብር off; you earn ${money(pt.reward)} ብር per sale.</i>`
    : `👥 በሊንክዎ በሚደረግ በእያንዳንዱ ሽያጭ <b>${money(pt.reward)} ብር</b> ያገኛሉ።\n` +
      `<i>You earn ${money(pt.reward)} ብር for every sale through your link.</i>`;
  let tierLine = '';
  if (p.tier_after > 0 && p.tier_reward > 0) {
    tierLine = pt.tier
      ? `\n🏆 ከ${p.tier_after} ሽያጭ በላይ ደርሰዋል — በእያንዳንዱ ሽያጭ <b>${money(p.tier_reward)} ብር</b>!\n` +
        `<i>Top tier reached: ${money(p.tier_reward)} ብር per sale.</i>`
      : `\n🏆 ${p.tier_after} ሽያጭ ሲደርሱ በእያንዳንዱ ሽያጭ <b>${money(p.tier_reward)} ብር</b> ያገኛሉ (አሁን ${pt.sold}/${p.tier_after})።\n` +
        `<i>After ${p.tier_after} sales you earn ${money(p.tier_reward)} ብር per sale (now ${pt.sold}/${p.tier_after}).</i>`;
  }
  const acctLine = acct
    ? `🏦 የክፍያ አካውንት / Payout account: <code>${esc(acct.details)}</code>`
    : '🏦 የክፍያ አካውንት አልተመዘገበም — ከታች ያስገቡ።\n<i>No payout account yet — add it below.</i>';
  const text =
    `🤝 <b>የአጋር ሊንክ · Partner link</b> — ${esc(p.label)}\n\n` +
    (p.active ? '' : '⏸ ይህ ሊንክ ለጊዜው ቆሟል።\n<i>This link is paused for now.</i>\n\n') +
    'ሊንክዎ / Your link:\n' +
    `<code>${link}</code>\n` +
    `ወይም በቦቱ ውስጥ <b>${esc(p.code)}</b> ብለው ይጻፉ (ለTikTok/YouTube)።\n` +
    `<i>Or people can type <b>${esc(p.code)}</b> in the bot (for TikTok/YouTube).</i>\n\n` +
    offer + tierLine + '\n\n' +
    `📊 ሊንኩን የከፈቱ፦ <b>${openedN}</b> · የገዙ፦ <b>${st.bought}</b> (${conv}%)\n` +
    `📅 ይህ ወር፦ <b>${st.month_n}</b> ሽያጭ · <b>${money(st.month_etb)} ብር</b>\n` +
    `💰 ያገኙት፦ <b>${money(st.earned)} ብር</b> · የተከፈለ፦ <b>${money(st.paid)} ብር</b> · የሚከፈልዎ፦ <b>${money(st.owed)} ብር</b>\n` +
    `<i>Opened: ${openedN} · bought: ${st.bought} (${conv}%) · this month: ${st.month_n} sales, ${money(st.month_etb)} ብር · ` +
    `earned ${money(st.earned)} · paid ${money(st.paid)} · owed ${money(st.owed)} ብር</i>\n\n` +
    `💸 ክፍያ በወር አንድ ጊዜ፣ ከእያንዳንዱ ሽያጭ ${hold} ቀን በኋላ በባንክ ይላካል።\n` +
    `<i>Paid monthly by bank transfer, ${hold} days after each sale.</i>\n\n` +
    acctLine + '\n\n' +
    '💬 ጥያቄ ካለዎት እዚሁ ይጻፉ — ለቡድናችን ይደርሳል።\n<i>Questions? Just write here — it reaches our team.</i>';
  const kb = [];
  if (p.active) kb.push([{ text: '📤 ሊንኩን ያጋሩ · Share link', url: shareUrl(link, pt) }]);
  if (st.bought) kb.push([{ text: '📄 ሽያጮቼ · My sales', callback_data: 'ref:sales' }]);
  kb.push([{ text: '🏦 የክፍያ አካውንት · Payout account', callback_data: 'ref:payout' }]);
  kb.push([{ text: '📜 ውሎች · Terms', url: `${SITE_URL}/legal/#referral` }]);
  kb.push(back);
  await show(text, kb);
}

// The partner opened their private claim link (/start p_TOKEN).
async function claimPartner(uid, chatId, token, who) {
  let p;
  try {
    p = await DB.prepare('SELECT * FROM partners WHERE claim_token = ?').bind(token).first();
  } catch (e) { p = null; }
  if (!p) {
    await sendText(chatId, '⚠️ ይህ የአጋር ሊንክ አይሰራም።\n<i>This partner link is not valid.</i>', MENU_KEYBOARD);
    return;
  }
  if (p.uid && p.uid !== String(uid)) {
    await sendText(chatId,
      '⚠️ ይህ የአጋር ሊንክ ቀድሞ በሌላ የቴሌግራም አካውንት ተመዝግቧል። እባክዎ ሻጩን ያግኙ።\n' +
      '<i>This partner link was already connected to another Telegram account. Please contact the seller.</i>');
    return;
  }
  if (!p.uid) {
    const other = await partnerByUid(uid);
    if (other && other.code !== p.code) {
      await sendText(chatId,
        `⚠️ የእርስዎ አካውንት ቀድሞ ለሌላ የአጋር ሊንክ (${esc(other.code)}) ተመዝግቧል።\n` +
        `<i>Your Telegram account is already the partner for ${esc(other.code)}. Please contact the seller.</i>`);
      return;
    }
    let r;
    try {
      r = await DB.prepare(
        "UPDATE partners SET uid = ?, tg_username = ?, connected_at = datetime('now') WHERE code = ? AND uid IS NULL"
      ).bind(String(uid), who, p.code).run();
    } catch (e) {
      r = await DB.prepare('UPDATE partners SET uid = ? WHERE code = ? AND uid IS NULL').bind(String(uid), p.code).run();
    }
    if (r && r.meta && r.meta.changes) {
      log('info', 'partner_claimed', { code: p.code, uid });
      for (const adm of adminUids()) {
        await sendText(adm, `🤝 Partner <b>${esc(p.code)}</b> (${esc(p.label)}) connected: ${esc(who)} (id <code>${esc(uid)}</code>). Their stats and rewards now reach them.`);
      }
    }
    p = await partnerByCode(p.code);
  }
  await showPartner(p, uid, chatId, null);
}

// ── partner links: owner side ───────────────────────────────────────────────
function claimLink(p) { return `${BOT_LINK}?start=p_${p.claim_token}`; }

// One query for the whole list (stays inside the 50-queries-per-request limit
// with any number of partners), best partners first, 10 per page.
const PARTNERS_PAGE = 10;
async function adminPartners(chatId, messageId, page = 0) {
  let list = [];
  try {
    const t = refTerms(await getSettings());
    const { results } = await DB.prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM referrals x WHERE x.code = p.code) AS opened,
         COALESCE(SUM(CASE WHEN r.status IN ('earned','paid') THEN 1 ELSE 0 END), 0) AS sold,
         COALESCE(SUM(CASE WHEN r.status IN ('earned','paid') AND r.earned_at >= date('now','start of month') THEN 1 ELSE 0 END), 0) AS month_n,
         COALESCE(SUM(CASE WHEN r.status IN ('earned','paid') THEN r.amount_etb ELSE 0 END), 0) AS earned,
         COALESCE(SUM(CASE WHEN r.status = 'earned' THEN r.amount_etb ELSE 0 END), 0) AS owed,
         COALESCE(SUM(CASE WHEN r.status = 'earned' AND r.earned_at <= datetime('now', ?) THEN r.amount_etb ELSE 0 END), 0) AS payable
       FROM partners p LEFT JOIN referral_rewards r ON r.referrer_uid = 'partner:' || p.code
       GROUP BY p.code ORDER BY p.active DESC, sold DESC, p.created_at`
    ).bind(refCutoff(t)).all();
    list = results || [];
  } catch (e) {
    await sendText(chatId, '⚠️ Partner table missing — run <code>npm run migrate</code>, then deploy.');
    return;
  }
  const sum = (k) => list.reduce((a, p) => a + (p[k] || 0), 0);
  const pages = Math.max(1, Math.ceil(list.length / PARTNERS_PAGE));
  page = Math.min(Math.max(page || 0, 0), pages - 1);
  const shown = list.slice(page * PARTNERS_PAGE, (page + 1) * PARTNERS_PAGE);
  const lines = shown.map((p) =>
    `${p.active ? '🟢' : '⏸'} <b>${esc(p.code)}</b> — ${esc(p.label)} · ${p.uid ? '✅' : '⏳ not connected'}\n` +
    `   ${partnerTermsText(p)}\n` +
    `   opened ${p.opened} · sold ${p.sold} (${p.opened ? Math.round((100 * p.sold) / p.opened) : 0}%) · ` +
    `this month ${p.month_n} · owed ${money(p.owed)} ብር` + (p.payable ? ` (💰 ${money(p.payable)} due)` : ''));
  const kb = shown.map((p) => [{ text: `📋 ${p.code} — ${p.label}`.slice(0, 60), callback_data: `admin:partner:${p.code}` }]);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `admin:partners:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `admin:partners:${page}` });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `admin:partners:${page + 1}` });
    kb.push(nav);
  }
  if (sum('payable')) kb.push([{ text: `💰 Pay rewards (${money(sum('payable'))} ብር due)`, callback_data: 'admin:ref-pay' }]);
  kb.push([{ text: '🎁 Referrals', callback_data: 'admin:ref' }, { text: '🛠 Admin', callback_data: 'admin:panel' }]);
  const totals = list.length
    ? `${list.filter((p) => p.active).length} active · ${list.filter((p) => p.uid).length} connected · ` +
      `${sum('sold')} sales (${sum('month_n')} this month)\n` +
      `💰 earned ${money(sum('earned'))} · owed <b>${money(sum('owed'))} ብር</b> · due now <b>${money(sum('payable'))} ብር</b>\n\n`
    : '';
  const text =
    `🤝 <b>Partners</b> (${list.length})\n` + totals +
    (lines.length ? lines.join('\n\n') : 'No partners yet.') + '\n\n' +
    '📋 Tap a partner for the full card: bank, sales, payouts, messages, actions.\n\n' +
    '➕ Create: <code>/partner EDITGROUP Editors Ethiopia</code>\n' +
    '⚙ Terms: <code>/partnerterms EDITGROUP 300 200 20 400</code>\n' +
    '<i>(reward per sale · buyer discount · optional: after N sales · reward then)</i>\n' +
    '✏️ Rename: <code>/partnername EDITGROUP New name</code> · 📱 New phone/account: <code>/partnerreset EDITGROUP</code>\n' +
    '🏦 Bank for them: <code>/partnerbank EDITGROUP CBE 1000123456789 Name</code>\n' +
    '<i>Partner links have their own switch — the buyer-referral ON/OFF does not affect them.</i>';
  const r = messageId ? await editText(chatId, messageId, text, kb) : null;
  if (!r || !r.ok) await sendText(chatId, text, kb);
}

async function sendPartnerLinks(chatId, p, created) {
  await sendText(chatId,
    `🤝 Partner <b>${esc(p.code)}</b> ${created ? 'created' : ''} — ${esc(p.label)}\n` +
    `Terms: ${partnerTermsText(p)}\n\n` +
    '1️⃣ <b>Private link — send it only to the partner</b> (opening it once connects their Telegram account, where they see their stats and receive rewards):\n' +
    `<code>${claimLink(p)}</code>\n\n` +
    '2️⃣ <b>Public link for their group post</b> — works right away; rewards wait for them until step 1 is done:\n' +
    `<code>${refLink(p.code)}</code>\n` +
    `<i>On TikTok/YouTube (no clickable links) people can type <b>${esc(p.code)}</b> in the bot instead.</i>\n\n` +
    `<i>Change terms: /partnerterms ${esc(p.code)} 300 200 20 400</i>`,
    [[{ text: '🤝 Partners', callback_data: 'admin:partners' }]]);
}

const PARTNER_DEFAULT_REWARD = 300;
const PARTNER_DEFAULT_DISCOUNT = 200;
function newClaimToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

async function adminCreatePartner(chatId, code, label) {
  code = code.toUpperCase();
  if (!PARTNER_CODE_RE.test(code)) {
    await sendText(chatId, '⚠️ The code must be 3–20 letters or digits, e.g. <code>EDITGROUP</code>.');
    return;
  }
  if (/^[0-9A-F]{8}([0-9A-F]{8})?$/.test(code)) {
    await sendText(chatId, '⚠️ That code looks like a Machine ID — pick a name-like code, e.g. <code>EDITGROUP</code>.');
    return;
  }
  label = String(label || '').trim().slice(0, 60) || code;
  try {
    const clash = await DB.prepare('SELECT 1 AS x FROM referral_codes WHERE code = ?').bind(code).first();
    if (clash || (await partnerByCode(code))) {
      await sendText(chatId, `⚠️ <b>${esc(code)}</b> is already in use — pick another code.`);
      return;
    }
    await DB.prepare(
      'INSERT INTO partners (code, label, claim_token, reward_etb, discount_etb) VALUES (?, ?, ?, ?, ?)'
    ).bind(code, label, newClaimToken(), PARTNER_DEFAULT_REWARD, PARTNER_DEFAULT_DISCOUNT).run();
  } catch (e) {
    await sendText(chatId, '⚠️ Could not create the partner — run <code>npm run migrate</code>, then deploy.');
    return;
  }
  await sendPartnerLinks(chatId, await partnerByCode(code), true);
}

async function adminPartnerTerms(chatId, code, reward, discount, after, tierReward) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>. See /partners.`); return; }
  if (reward > PRICE_ETB || discount >= PRICE_ETB || (after && !tierReward) || tierReward > PRICE_ETB) {
    await sendText(chatId, `⚠️ Check the numbers: reward ≤ ${PRICE_ETB}, discount < ${PRICE_ETB}, and a tier needs both "after" and its reward.`);
    return;
  }
  await DB.prepare(
    'UPDATE partners SET reward_etb = ?, discount_etb = ?, tier_after = ?, tier_reward = ? WHERE code = ?'
  ).bind(reward, discount, after || 0, tierReward || 0, p.code).run();
  const np = await partnerByCode(p.code);
  const warn = [];
  const cost = Math.max(reward, tierReward || 0) + discount;
  if (cost > PRICE_ETB / 2) {
    warn.push(`⚠️ Reward + discount = ${money(cost)} ብር — ${Math.round((100 * cost) / PRICE_ETB)}% of the ETB ${money(PRICE_ETB)} price.`);
  }
  if (tierReward && tierReward < reward) warn.push('⚠️ The tier reward is LOWER than the normal reward — did you swap them?');
  await sendText(chatId,
    `✅ <b>${esc(np.code)}</b> terms updated\n` +
    `   before: ${partnerTermsText(p)}\n` +
    `   now: <b>${partnerTermsText(np)}</b>\n` +
    (warn.length ? warn.join('\n') + '\n' : '') +
    `<i>New orders use these terms; orders already placed keep theirs.${np.uid ? ' The partner was told.' : ''}</i>`,
    [[{ text: `📋 ${np.code}`, callback_data: `admin:partner:${np.code}` }]]);
  if (np.uid) {
    const tierAm = np.tier_after > 0 && np.tier_reward > 0
      ? `\n• ከ${np.tier_after} ሽያጭ በኋላ፦ <b>${money(np.tier_reward)} ብር</b> በሽያጭ` : '';
    const tierEn = np.tier_after > 0 && np.tier_reward > 0
      ? ` · ${money(np.tier_reward)} ብር after ${np.tier_after} sales` : '';
    await sendText(np.uid,
      '🤝 <b>የአጋር ውሎችዎ ተሻሽለዋል · Your partner terms were updated</b>\n\n' +
      `• በእያንዳንዱ ሽያጭ፦ <b>${money(np.reward_etb)} ብር</b>${tierAm}\n` +
      `• ገዢዎች የሚያገኙት ቅናሽ፦ <b>${money(np.discount_etb)} ብር</b> (ETB ${money(PRICE_ETB - np.discount_etb)} ይከፍላሉ)\n` +
      `<i>Per sale: ${money(np.reward_etb)} ብር${tierEn} · buyers get ${money(np.discount_etb)} ብር off (pay ETB ${money(PRICE_ETB - np.discount_etb)})</i>\n\n` +
      'ቀደም ያሉ ሽያጮች ሽልማታቸውን ይዘው ይቀጥላሉ።\n<i>Sales already made keep their rewards.</i>',
      [[{ text: '🤝 የአጋር ገጽ · Partner page', callback_data: 'ref:invite' }]]);
  }
}

// The owner records a partner's bank account (given by phone, or before they
// connect). Once connected, the partner's own saved account is used first.
async function adminPartnerBank(chatId, code, details) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>. See /partners.`); return; }
  details = String(details || '').replace(/\s+/g, ' ').trim();
  if (details === '-') {
    await DB.prepare('DELETE FROM payout_accounts WHERE uid = ?').bind(partnerKey(p.code)).run();
    await adminPartnerCard(chatId, null, p.code);
    return;
  }
  if (details.length < 8 || details.length > 200 || (details.match(/\d/g) || []).length < 6) {
    await sendText(chatId, `⚠️ Give bank, account number and name: <code>/partnerbank ${esc(p.code)} CBE 1000123456789 Abebe Kebede</code>`);
    return;
  }
  const key = p.uid || partnerKey(p.code);
  await DB.prepare(
    `INSERT INTO payout_accounts (uid, details, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET details=excluded.details, updated_at=excluded.updated_at`
  ).bind(key, details).run();
  if (p.uid) {
    await sendText(p.uid,
      `🏦 የክፍያ አካውንትዎ ተመዝግቧል፦ <code>${esc(details)}</code>\n<i>Your payout account was recorded by our team. If it is wrong, tap below to fix it.</i>`,
      [[{ text: '🏦 የክፍያ አካውንት · Payout account', callback_data: 'ref:payout' }]]);
  }
  await adminPartnerCard(chatId, null, p.code);
}

// Delete a partner created by mistake — only while it has no sales at all
// (with sales, pause it instead: the books must keep every sale).
async function adminPartnerDelete(chatId, messageId, code, confirmed) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>.`); return; }
  const key = partnerKey(p.code);
  const used = await DB.prepare(
    `SELECT (SELECT COUNT(*) FROM referral_rewards WHERE referrer_uid = ?) +
            (SELECT COUNT(*) FROM orders WHERE referrer_uid = ? AND status = 'pending') AS n`
  ).bind(key, key).first();
  if (used && used.n) {
    await sendText(chatId, `⚠️ <b>${esc(p.code)}</b> has sales or a pending order, so it cannot be deleted — use ⏸ Pause instead.`,
      [[{ text: `📋 ${p.code}`, callback_data: `admin:partner:${p.code}` }]]);
    return;
  }
  if (!confirmed) {
    await sendText(chatId,
      `🗑 <b>Delete ${esc(p.code)} — ${esc(p.label)}?</b>\n\nIt has no sales. Its links stop working and people who opened it are released.`,
      [[{ text: '🗑 Yes, delete', callback_data: `admin:partner-del-yes:${p.code}` },
        { text: '✖ Cancel', callback_data: `admin:partner:${p.code}` }]]);
    return;
  }
  await DB.prepare('DELETE FROM referrals WHERE code = ?').bind(p.code).run();
  await DB.prepare('DELETE FROM payout_accounts WHERE uid = ?').bind(key).run();
  await DB.prepare('DELETE FROM partners WHERE code = ?').bind(p.code).run();
  log('info', 'partner_deleted', { code: p.code });
  await sendText(chatId, `🗑 <b>${esc(p.code)}</b> deleted.`, [[{ text: '🤝 Partners', callback_data: 'admin:partners' }]]);
}

// Pay one partner from the card: shows the amount and the bank account to copy
// first; marks paid (and tells the partner) only after the second tap, and only
// if the amount is still exactly what the owner saw.
async function adminPartnerPay(chatId, messageId, cbId, code, amount) {
  const p = await partnerByCode(code);
  if (!p) return;
  const t = refTerms(await getSettings());
  const due = await payableOf(partnerKey(p.code), t);
  if (!due.etb) {
    await answerCb(cbId, 'Nothing payable right now');
    await adminPartnerCard(chatId, messageId, p.code);
    return;
  }
  if (amount != null && amount === due.etb) {
    const total = await payReferrer(partnerKey(p.code));
    await answerCb(cbId, total ? `✅ Marked paid · ${money(total)} ብር` : 'Already marked paid');
    await adminPartnerCard(chatId, messageId, p.code);
    return;
  }
  const acct = await partnerAccount(p);
  const text =
    (amount != null ? '⚠️ <b>The amount changed since you opened this</b> — check it again.\n\n' : '') +
    `💰 <b>Pay ${esc(p.code)}</b> — ${esc(p.label)}\n\n` +
    `Amount: <b>${money(due.etb)} ብር</b> (${due.n} sale${due.n === 1 ? '' : 's'}: #${esc(String(due.orders || '').split(',').join(', #'))})\n` +
    (acct ? `🏦 To: <code>${esc(acct.details)}</code>\n\n` : '🏦 ⚠️ No payout account — ask them first.\n\n') +
    `1️⃣ Transfer <b>${money(due.etb)} ብር</b> from your bank.\n` +
    '2️⃣ Then tap ✅ — it is recorded as paid' + (p.uid ? ' and the partner is told.' : '.');
  const kb = [
    [{ text: `✅ I sent ${money(due.etb)} ብር`, callback_data: `admin:partner-paid:${p.code}:${due.etb}` }],
    [{ text: '✖ Cancel', callback_data: `admin:partner:${p.code}` }],
  ];
  await answerCb(cbId, '');
  const r = messageId ? await editText(chatId, messageId, text, kb) : null;
  if (!r || !r.ok) await sendText(chatId, text, kb);
}

// New phone / new Telegram account: a fresh private link; the old connection is
// removed. Sales and money owed stay with the partner code.
async function adminPartnerReset(chatId, code) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>. See /partners.`); return; }
  // Keep their bank account with the partner code, so payouts still have one
  // until they save it again from the new account.
  if (p.uid) {
    await DB.prepare(
      `INSERT INTO payout_accounts (uid, details, updated_at)
       SELECT ?, details, updated_at FROM payout_accounts WHERE uid = ?
       ON CONFLICT(uid) DO UPDATE SET details=excluded.details, updated_at=excluded.updated_at`
    ).bind(partnerKey(p.code), p.uid).run();
  }
  await DB.prepare('UPDATE partners SET uid = NULL, claim_token = ? WHERE code = ?').bind(newClaimToken(), p.code).run();
  try {
    await DB.prepare('UPDATE partners SET tg_username = NULL, connected_at = NULL WHERE code = ?').bind(p.code).run();
  } catch (e) { /* 0018 not applied */ }
  if (p.uid) {
    await sendText(p.uid,
      '🤝 የአጋር ገጽዎ ወደ አዲስ የቴሌግራም አካውንት እየተዛወረ ነው። ሽያጮችዎና የሚከፈልዎ ገንዘብ አይጠፉም።\n' +
      '<i>Your partner page is being moved to a new Telegram account. Your sales and money owed are kept.</i>');
  }
  await sendText(chatId, `♻ <b>${esc(p.code)}</b>: the old connection is removed. Sales and money owed stay. Send the new private link below to the partner.`);
  await sendPartnerLinks(chatId, await partnerByCode(p.code), false);
}

async function adminPartnerName(chatId, code, label) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>. See /partners.`); return; }
  label = String(label || '').trim().slice(0, 60);
  if (!label) { await sendText(chatId, '⚠️ Give the new name after the code.'); return; }
  await DB.prepare('UPDATE partners SET label = ? WHERE code = ?').bind(label, p.code).run();
  await sendText(chatId, `✅ <b>${esc(p.code)}</b> is now called <b>${esc(label)}</b>.`);
}

const PAYOUT_PROMPT =
  '🏦 <b>የክፍያ አካውንት · Payout account</b>\n\n' +
  'ሽልማትዎ የሚላክበትን ባንክ፣ የአካውንት ቁጥር እና የአካውንት ስም በአንድ መልዕክት ይላኩ፦\n' +
  'ለምሳሌ፦ <code>CBE 1000123456789 Abebe Kebede</code>\n' +
  '<i>Send your bank, account number and account name in one message.</i>';

async function savePayoutAccount(uid, chatId, text) {
  const details = String(text || '').replace(/\s+/g, ' ').trim();
  const digits = (details.match(/\d/g) || []).length;
  // A lone Machine ID / key pasted by mistake is not a bank account.
  const looksLikeId = /^[0-9a-f]{8}([0-9a-f]{8})?$/i.test(details) || /^AMH-/i.test(details);
  if (details.length < 8 || details.length > 200 || digits < 6 || looksLikeId || !/[^\d\s]/.test(details)) {
    await sendText(chatId,
      '⚠️ ባንክ፣ የአካውንት ቁጥር እና ስም በአንድ መልዕክት ይላኩ (ለምሳሌ፦ <code>CBE 1000123456789 Abebe Kebede</code>)።\n' +
      '<i>Please send the bank, account number and name in one message.</i>',
      [[{ text: '⬅ ተመለስ · Back', callback_data: 'ref:invite' }]]);
    return;
  }
  const old = await DB.prepare('SELECT details FROM payout_accounts WHERE uid = ?').bind(String(uid)).first();
  await DB.prepare(
    `INSERT INTO payout_accounts (uid, details, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET details=excluded.details, updated_at=excluded.updated_at`
  ).bind(String(uid), details).run();
  await setFsm(uid, null);
  // A partner's bank account decides where real money goes: the owner sees
  // every addition or change (a stolen phone cannot quietly redirect payouts).
  const partner = await partnerByUid(uid);
  if (partner && (!old || old.details !== details)) {
    for (const adm of adminUids()) {
      await sendText(adm,
        `🏦 Partner <b>${esc(partner.code)}</b> (${esc(partner.label)}) ${old ? 'CHANGED' : 'added'} their payout account:\n` +
        (old ? `   old: <code>${esc(old.details)}</code>\n` : '') +
        `   new: <code>${esc(details)}</code>\n` +
        (old ? '<i>If you did not expect this, call the partner before paying.</i>' : ''),
        [[{ text: `📋 ${partner.code}`, callback_data: `admin:partner:${partner.code}` }]]);
    }
  }
  await sendText(chatId,
    `✅ ተመዝግቧል፦ <code>${esc(details)}</code>\n<i>Saved — rewards will be sent to this account.</i>`,
    [[{ text: '🎁 ጓደኛ ይጋብዙ · Invite friends', callback_data: 'ref:invite' }]]);
}

// Buyer-side buttons: ref:invite, ref:payout
async function handleRefCallback(data, cbId, fromUid, chatId, messageId) {
  await answerCb(cbId, '');
  const action = data.split(':')[1];
  if (action === 'invite') {
    const s = await getFsm(fromUid);
    if (s && s.step === 'payout') await setFsm(fromUid, null);   // leaving the payout prompt
    await showInvite(fromUid, chatId, messageId);
  } else if (action === 'payout') {
    await setFsm(fromUid, { step: 'payout' });
    await sendText(chatId, PAYOUT_PROMPT, [[{ text: '⬅ ተመለስ · Back', callback_data: 'ref:invite' }]]);
  } else if (action === 'sales') {
    await showMySales(fromUid, chatId, messageId);
  }
}

// A partner's (or referrer's) own sales: date, reward and when it is paid.
// Only order numbers — never who bought.
async function showMySales(uid, chatId, messageId) {
  const partner = await partnerByUid(uid);
  const key = partner ? partnerKey(partner.code) : String(uid);
  const t = refTerms(await getSettings());
  const rows = (await DB.prepare(
    `SELECT order_id, earned_at, amount_etb, status, paid_at, date(earned_at, ?) AS payable_on
     FROM referral_rewards WHERE referrer_uid = ? ORDER BY order_id DESC LIMIT 20`
  ).bind(`+${t.hold} days`, key).all()).results || [];
  const lines = rows.map((r) => {
    const state = r.status === 'paid' ? `✅ ተከፍሏል ${fmtDate(r.paid_at)}`
      : r.status === 'cancelled' ? '🚫 ተሰርዟል (ተመላሽ)'
        : `⏳ ${fmtDate(r.payable_on)} ይከፈላል`;
    return `#${r.order_id} · ${fmtDate(r.earned_at)} · <b>${money(r.amount_etb)} ብር</b> · ${state}`;
  });
  const text = '📄 <b>ሽያጮቼ · My sales</b>' + (rows.length === 20 ? ' (የመጨረሻዎቹ 20 · latest 20)' : '') + '\n\n' +
    (lines.length ? lines.join('\n') : 'እስካሁን ሽያጭ የለም።\n<i>No sales yet.</i>') + '\n\n' +
    '<i>✅ paid · ⏳ payable on that date · 🚫 cancelled (refund)</i>';
  const kb = [[{ text: '⬅ ተመለስ · Back', callback_data: 'ref:invite' }]];
  const r = messageId ? await editText(chatId, messageId, text, kb) : null;
  if (!r || !r.ok) await sendText(chatId, text, kb);
}

// ── referral programme: owner side ─────────────────────────────────────────
async function adminReferrals(chatId, messageId) {
  const t = refTerms(await getSettings());
  let body;
  let ready = { n: 0, etb: 0, people: 0 };
  try {
    const cut = refCutoff(t);
    ready = await DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount_etb),0) AS etb, COUNT(DISTINCT referrer_uid) AS people " +
      "FROM referral_rewards WHERE status='earned' AND earned_at <= datetime('now', ?)").bind(cut).first();
    const waiting = await DB.prepare(
      "SELECT COALESCE(SUM(amount_etb),0) AS etb FROM referral_rewards WHERE status='earned' AND earned_at > datetime('now', ?)")
      .bind(cut).first();
    const paid = await DB.prepare("SELECT COALESCE(SUM(amount_etb),0) AS etb FROM referral_rewards WHERE status='paid'").first();
    const sold = await DB.prepare("SELECT COUNT(*) AS n FROM referral_rewards WHERE status IN ('earned','paid')").first();
    const links = await DB.prepare('SELECT COUNT(*) AS n FROM referral_codes').first();
    const invited = await DB.prepare('SELECT COUNT(*) AS n FROM referrals').first();
    body =
      `🔗 Links shared: ${links.n} · 👥 friends invited: ${invited.n} · 🛒 bought: ${sold.n}\n` +
      `💰 Ready to pay: <b>${money(ready.etb)} ብር</b> (${ready.people} people)\n` +
      `⏳ Waiting (inside the ${t.hold}-day refund window): ${money(waiting.etb)} ብር\n` +
      `✅ Paid so far: ${money(paid.etb)} ብር`;
  } catch (e) {
    body = '⚠️ Referral tables are missing — run <code>npm run migrate</code>, then deploy.';
  }
  const text =
    `🎁 <b>Referrals · ${t.on ? '🟢 ON' : '⚪ OFF'}</b>\n\n` +
    `Friend discount: <b>${money(t.discount)} ብር</b> (friend pays ETB ${money(PRICE_ETB - t.discount)})\n` +
    `Reward: <b>${money(t.reward)} ብር</b> per sale · paid <b>${t.hold} days</b> after the sale\n\n` +
    body + '\n\n' +
    '⚙ Change: <code>/refdiscount 200</code> · <code>/refreward 300</code> · <code>/refhold 14</code>\n' +
    (t.on
      ? '<i>Turning it OFF stops new links and discounts at once. Rewards already earned stay owed and listed here.</i>'
      : '<i>While OFF nobody gets a link or a discount. Rewards already earned stay owed and listed here.</i>');
  const kb = [[{ text: t.on ? '⚪ Turn OFF' : '🟢 Turn ON', callback_data: 'admin:ref-toggle' }]];
  if (ready.n) kb.push([{ text: `💰 Pay rewards (${ready.people} · ${money(ready.etb)} ብር)`, callback_data: 'admin:ref-pay' }]);
  if (t.on) kb.push([{ text: '📣 Announce to buyers', callback_data: 'admin:ref-announce' }]);
  kb.push([{ text: '🤝 Partners (groups & channels)', callback_data: 'admin:partners' }]);
  kb.push([{ text: '🛠 Admin', callback_data: 'admin:panel' }]);
  const r = messageId ? await editText(chatId, messageId, text, kb) : null;
  if (!r || !r.ok) await sendText(chatId, text, kb);
}

async function adminRefPayList(chatId, messageId) {
  const t = refTerms(await getSettings());
  let list = [];
  try {
    const { results } = await DB.prepare(
      `SELECT r.referrer_uid AS uid, SUM(r.amount_etb) AS total, COUNT(*) AS n,
              GROUP_CONCAT(r.order_id) AS orders,
              COALESCE(
                (SELECT details FROM payout_accounts pa WHERE pa.uid =
                   (SELECT p.uid FROM partners p WHERE 'partner:' || p.code = r.referrer_uid)),
                (SELECT details FROM payout_accounts pa2 WHERE pa2.uid = r.referrer_uid)) AS acct,
              COALESCE((SELECT '🤝 ' || p2.label FROM partners p2 WHERE 'partner:' || p2.code = r.referrer_uid),
                       (SELECT name FROM customers c WHERE c.uid = r.referrer_uid LIMIT 1)) AS name
       FROM referral_rewards r
       WHERE r.status = 'earned' AND r.earned_at <= datetime('now', ?)
       GROUP BY r.referrer_uid ORDER BY total DESC LIMIT 20`
    ).bind(refCutoff(t)).all();
    list = results || [];
  } catch (e) { /* tables missing: shown as nothing to pay */ }
  const show = async (text, kb) => {
    const r = messageId ? await editText(chatId, messageId, text, kb) : null;
    if (!r || !r.ok) await sendText(chatId, text, kb);
  };
  if (!list.length) {
    await show(`💰 <b>Nothing to pay right now.</b>\n\nA reward becomes payable ${t.hold} days after the friend's purchase.`,
      [[{ text: '🎁 Referrals', callback_data: 'admin:ref' }]]);
    return;
  }
  const lines = list.map((p, i) =>
    `${i + 1}. <b>${esc(p.name || 'buyer')}</b> (id ${esc(p.uid)}) — <b>${money(p.total)} ብር</b> · order #${esc(String(p.orders).split(',').join(', #'))}\n` +
    (p.acct ? `   🏦 <code>${esc(p.acct)}</code>` : '   ⚠️ no payout account yet'));
  const kb = list.map((p) => [p.acct
    ? { text: `✅ Paid ${p.name || p.uid} · ${money(p.total)} ብር`, callback_data: `admin:ref-paid:${p.uid}` }
    : { text: `📩 Ask ${p.name || p.uid} for an account`, callback_data: `admin:ref-ask:${p.uid}` }]);
  kb.push([{ text: '🎁 Referrals', callback_data: 'admin:ref' }]);
  await show(`💰 <b>Rewards ready to pay</b> (older than ${t.hold} days)\n\n` + lines.join('\n\n') +
    '\n\n<i>Transfer each amount from your bank, then tap ✅ Paid. The referrer is told automatically.</i>', kb);
}

async function adminRefMarkPaid(chatId, messageId, cbId, uid) {
  // Only what is payable right now (payReferrer), so a reward still inside the
  // refund window is never marked paid by accident.
  const total = await payReferrer(uid);
  await answerCb(cbId, total ? `✅ Marked paid · ${money(total)} ብር` : 'Already marked paid');
  await adminRefPayList(chatId, messageId);
}

// Ready-made announcement the owner can send (it goes through the normal
// broadcast preview: Buyers only / Everyone / Cancel).
function referralAnnouncement(t) {
  return (
    '🎁 <b>አዲስ፦ ጓደኛ ይጋብዙ፣ ሽልማት ያግኙ!</b>\n\n' +
    'ጓደኛዎ በእርስዎ ሊንክ አማርኛ ካፕሽን ፕሮን ሲገዛ፦\n' +
    (t.discount > 0 ? `• ጓደኛዎ <b>${money(t.discount)} ብር ቅናሽ</b> ያገኛል\n` : '') +
    `• እርስዎ <b>${money(t.reward)} ብር</b> ያገኛሉ\n\n` +
    'የእርስዎን ሊንክ ለማግኘት /invite ይጫኑ።\n\n' +
    '<i>New: invite friends. ' +
    (t.discount > 0 ? `Your friend gets ${money(t.discount)} ብር off and ` : '') +
    `you earn ${money(t.reward)} ብር for each friend who buys. Tap /invite for your link.</i>`
  );
}

// Once a month (checked by the 6-hour cron): tell the owner when rewards are
// payable, so payouts happen in one short session instead of one by one.
async function remindReferralPayouts() {
  try {
    const s = await getSettings();
    const month = new Date().toISOString().slice(0, 7);
    if (s.referral_last_reminder === month) return;
    const t = refTerms(s);
    const ready = await DB.prepare(
      "SELECT COUNT(DISTINCT referrer_uid) AS people, COALESCE(SUM(amount_etb),0) AS etb " +
      "FROM referral_rewards WHERE status='earned' AND earned_at <= datetime('now', ?)").bind(refCutoff(t)).first();
    if (!ready || !ready.etb) return;
    await setSetting('referral_last_reminder', month);
    for (const adm of adminUids()) {
      await sendText(adm,
        `💰 <b>Referral rewards ready to pay:</b> ${money(ready.etb)} ብር to ${ready.people} people.`,
        [[{ text: '💰 Pay rewards', callback_data: 'admin:ref-pay' }]]);
      await sleep(90);
    }
  } catch (e) {
    log('warn', 'referral_reminder_skipped', { err: String((e && e.message) || e) });
  }
}

// ── partner management centre (owner) ───────────────────────────────────────
// One card per partner with everything the owner needs — identity, terms, bank
// account, performance, each sale with its reward status, payout history — and
// every action as a button. Two-way messages, monthly statements, private notes.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : '—';
}
function fmtMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : ym;
}

// Everything the card and the monthly statement need, in one place.
async function partnerFacts(p) {
  const key = partnerKey(p.code);
  const t = refTerms(await getSettings());
  const cut = refCutoff(t);
  const opened = await DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE code = ?').bind(p.code).first();
  const st = await rewardStats(key);
  const money2 = await DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN r.status='earned' AND r.earned_at <= datetime('now', ?) THEN r.amount_etb ELSE 0 END), 0) AS payable,
       MIN(CASE WHEN r.status='earned' AND r.earned_at > datetime('now', ?) THEN date(r.earned_at, ?) END) AS next_date,
       COALESCE(SUM(CASE WHEN r.status='earned' AND r.earned_at > datetime('now', ?) THEN r.amount_etb ELSE 0 END), 0) AS waiting,
       MAX(CASE WHEN r.status IN ('earned','paid') THEN r.earned_at END) AS last_sale,
       COUNT(r.order_id) AS reward_rows,
       COALESCE(SUM(CASE WHEN r.status IN ('earned','paid') THEN s.amount_etb ELSE 0 END), 0) AS revenue
     FROM referral_rewards r LEFT JOIN sales s ON s.order_id = r.order_id
     WHERE r.referrer_uid = ?`
  ).bind(cut, cut, `+${t.hold} days`, cut, key).first();
  const acct = await partnerAccount(p);
  const pt = await partnerTerms(p);
  return { t, st, pt, acct, openedN: opened ? opened.n : 0, ...(money2 || {}) };
}

async function adminPartnerCard(chatId, messageId, code) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>. See /partners.`); return; }
  const f = await partnerFacts(p);
  const key = partnerKey(p.code);
  const sales = (await DB.prepare(
    `SELECT r.order_id, r.earned_at, r.amount_etb AS reward, r.status, r.paid_at, s.amount_etb AS price,
            date(r.earned_at, ?) AS payable_on, (r.earned_at <= datetime('now', ?)) AS payable_now
     FROM referral_rewards r LEFT JOIN sales s ON s.order_id = r.order_id
     WHERE r.referrer_uid = ? ORDER BY r.order_id DESC LIMIT 8`
  ).bind(`+${f.t.hold} days`, refCutoff(f.t), key).all()).results || [];
  const payouts = (await DB.prepare(
    `SELECT paid_at, SUM(amount_etb) AS etb, COUNT(*) AS n FROM referral_rewards
     WHERE referrer_uid = ? AND status = 'paid' GROUP BY paid_at ORDER BY paid_at DESC LIMIT 6`
  ).bind(key).all()).results || [];
  const conv = f.openedN ? Math.round((100 * f.st.bought) / f.openedN) : 0;
  const who = p.uid
    ? `👤 Telegram: ${p.tg_username ? esc(p.tg_username) + ' · ' : ''}id <code>${esc(p.uid)}</code> · connected ${fmtDate(p.connected_at)}`
    : '👤 ⏳ <b>Not connected yet</b> — send them the private link (📨 Links). Sales still count and wait for them.';
  const tierLine = p.tier_after > 0 && p.tier_reward > 0
    ? ` · ${money(p.tier_reward)} after ${p.tier_after} sales (${f.pt.tier ? '🏆 reached' : `now ${f.pt.sold}/${p.tier_after}`})`
    : '';
  const saleLines = sales.length
    ? sales.map((r) => {
      const state = r.status === 'paid' ? `✅ paid ${fmtDate(r.paid_at)}`
        : r.status === 'cancelled' ? '🚫 cancelled (refund/revoke)'
          : r.payable_now ? '💰 payable now' : `⏳ payable ${fmtDate(r.payable_on)}`;
      return `   #${r.order_id} · ${fmtDate(r.earned_at)} · ETB ${money(r.price || 0)} → ${money(r.reward)} ብር · ${state}`;
    }).join('\n')
    : '   (no sales yet)';
  const payoutLines = payouts.length
    ? payouts.map((x) => `   ${fmtDate(x.paid_at)} — <b>${money(x.etb)} ብር</b> (${x.n} sale${x.n === 1 ? '' : 's'})`).join('\n')
    : '   (none yet)';
  const text =
    `🤝 <b>${esc(p.code)}</b> — ${esc(p.label)} · ${p.active ? '🟢 Active' : '⏸ Paused'}\n` +
    `${who}\n` +
    `📅 Partner since ${fmtDate(p.created_at)}` + (f.last_sale ? ` · last sale ${fmtDate(f.last_sale)}` : '') + '\n' +
    `📋 Terms: <b>${money(p.reward_etb)} ብር</b>/sale · buyer −${money(p.discount_etb)} ብር (pays ETB ${money(PRICE_ETB - p.discount_etb)})${tierLine}\n` +
    (f.acct
      ? `🏦 Bank: <code>${esc(f.acct.details)}</code> (${f.acct.byOwner ? 'entered by you' : 'updated'} ${fmtDate(f.acct.updated_at)})\n`
      : `🏦 Bank: ⚠️ no payout account yet — ${p.uid ? 'ask them (✉️) or' : ''} set it: <code>/partnerbank ${esc(p.code)} …</code>\n`) +
    (p.note ? `📝 Note: <i>${esc(p.note)}</i>\n` : '') +
    '\n<b>📊 Performance</b>\n' +
    `   Opened ${f.openedN} · bought ${f.st.bought} (${conv}%) · this month ${f.st.month_n} (${money(f.st.month_etb)} ብር)\n` +
    `   Revenue they brought: <b>ETB ${money(f.revenue || 0)}</b>\n` +
    '\n<b>💰 Rewards</b>\n' +
    `   Earned ${money(f.st.earned)} · paid ${money(f.st.paid)} · owed <b>${money(f.st.owed)} ብር</b>\n` +
    `   → payable now <b>${money(f.payable || 0)} ብር</b>` +
    (f.waiting ? ` · ${money(f.waiting)} ብር on ${fmtDate(f.next_date)}` : '') + '\n' +
    '\n<b>🛒 Latest sales</b>\n' + saleLines + '\n' +
    '\n<b>💸 Payouts</b>\n' + payoutLines;
  const c = p.code;
  const kb = [
    [p.active
      ? { text: '⏸ Pause', callback_data: `admin:partner-pause:${c}` }
      : { text: '▶ Resume', callback_data: `admin:partner-toggle:${c}:card:tell` },
    ...(f.payable && f.acct ? [{ text: `💰 Pay ${money(f.payable)} ብር`, callback_data: `admin:partner-pay:${c}` }] : [])],
    [{ text: '✉️ Message', callback_data: `admin:partner-msg:${c}` },
      { text: '📊 Send report', callback_data: `admin:partner-report:${c}` }],
    [{ text: '📄 All sales', callback_data: `admin:partner-sales:${c}` },
      { text: '📨 Links', callback_data: `admin:partner-links:${c}` }],
    [{ text: '📝 Note / terms help', callback_data: `admin:partner-help:${c}` },
      { text: '♻ New phone', callback_data: `admin:partner-reset:${c}` }],
    ...(f.reward_rows ? [] : [[{ text: '🗑 Delete (no sales)', callback_data: `admin:partner-del:${c}` }]]),
    [{ text: '🤝 Partners', callback_data: 'admin:partners' }, { text: '🛠 Admin', callback_data: 'admin:panel' }],
  ];
  const r = messageId ? await editText(chatId, messageId, text, kb) : null;
  if (!r || !r.ok) await sendText(chatId, text, kb);
}

// Every sale of one partner (bookkeeping / dispute answers).
async function adminPartnerSales(chatId, code) {
  const p = await partnerByCode(code);
  if (!p) return;
  const rows = (await DB.prepare(
    `SELECT r.order_id, r.earned_at, r.amount_etb AS reward, r.status, r.paid_at, s.amount_etb AS price
     FROM referral_rewards r LEFT JOIN sales s ON s.order_id = r.order_id
     WHERE r.referrer_uid = ? ORDER BY r.order_id`
  ).bind(partnerKey(p.code)).all()).results || [];
  if (!rows.length) { await sendText(chatId, `📄 <b>${esc(p.code)}</b>: no sales yet.`); return; }
  let chunk = `📄 <b>${esc(p.code)} — all sales (${rows.length})</b>\n\n<pre>order\tdate\tprice\treward\tstatus\n`;
  for (const r of rows) {
    const line = esc(`${r.order_id}\t${String(r.earned_at).slice(0, 10)}\t${r.price || 0}\t${r.reward}\t${r.status}${r.paid_at ? ' ' + String(r.paid_at).slice(0, 10) : ''}`);
    if (chunk.length + line.length > 3500) { await sendText(chatId, chunk + '</pre>'); chunk = '<pre>'; }
    chunk += line + '\n';
  }
  await sendText(chatId, chunk + '</pre>', [[{ text: `📋 ${p.code}`, callback_data: `admin:partner:${p.code}` }]]);
}

// Statement for the partner: one month's sales plus all-time money.
async function partnerStatement(p, ym, t) {
  // Two queries only: the monthly run sends many of these in one request.
  const f = { t, st: await rewardStats(partnerKey(p.code)) };
  const m = await DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_etb), 0) AS etb FROM referral_rewards
     WHERE referrer_uid = ? AND status IN ('earned','paid') AND strftime('%Y-%m', earned_at) = ?`
  ).bind(partnerKey(p.code), ym).first();
  return (
    `📊 <b>የወር ሪፖርት · Monthly report</b> — ${esc(p.label)}\n<b>${fmtMonth(ym)}</b>\n\n` +
    `🛒 ሽያጭ፦ <b>${m.n}</b> · ያገኙት፦ <b>${money(m.etb)} ብር</b>\n<i>Sales: ${m.n} · earned ${money(m.etb)} ብር</i>\n\n` +
    `💰 በአጠቃላይ፦ ያገኙት ${money(f.st.earned)} · የተከፈለ ${money(f.st.paid)} · የሚከፈልዎ <b>${money(f.st.owed)} ብር</b>\n` +
    `<i>All time: earned ${money(f.st.earned)} · paid ${money(f.st.paid)} · owed ${money(f.st.owed)} ብር</i>\n` +
    (f.st.owed
      ? `💸 የሚከፈልዎ በወሩ ክፍያ ከ${f.t.hold} ቀን በኋላ ይላካል።\n<i>Money owed is sent in the monthly payout, ${f.t.hold} days after each sale.</i>\n`
      : '') +
    `\n🔗 <code>${refLink(p.code)}</code>\nስላጋሩን እናመሰግናለን! 🙏 <i>Thank you for sharing us!</i>`
  );
}

async function sendPartnerStatement(p, ym, t) {
  if (!p.uid) return false;
  t = t || refTerms(await getSettings());
  const r = await sendText(p.uid, await partnerStatement(p, ym, t),
    [[{ text: '🤝 የአጋር ገጽ · Partner page', callback_data: 'ref:invite' }]]);
  return !!(r && r.ok);
}

// 1st of the month (6-hour cron): last month's statement to every connected
// partner. The first run after deploy only records the month (no old report).
// At most PARTNER_REPORTS_PER_RUN per run (Workers' 50-query / 50-subrequest
// limit); the rest go out on the next runs, each partner exactly once.
const PARTNER_REPORTS_PER_RUN = 10;
async function sendMonthlyPartnerReports() {
  try {
    const s = await getSettings();
    const month = new Date().toISOString().slice(0, 7);
    if (s.partner_report_month === month) return;
    if (!s.partner_report_month) { await setSetting('partner_report_month', month); return; }
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const last = d.toISOString().slice(0, 7);
    const [doneMonth, doneList] = String(s.partner_report_done || '').split('|');
    const done = new Set(doneMonth === month ? String(doneList || '').split(',').filter(Boolean) : []);
    const { results } = await DB.prepare('SELECT * FROM partners WHERE uid IS NOT NULL ORDER BY code').all();
    const todo = (results || []).filter((p) => !done.has(p.code));
    const t = refTerms(s);
    for (const p of todo.slice(0, PARTNER_REPORTS_PER_RUN)) {
      done.add(p.code);   // once each, even if Telegram refuses (blocked bot)
      await sendPartnerStatement(p, last, t);
      await sleep(90);
    }
    if (todo.length <= PARTNER_REPORTS_PER_RUN) await setSetting('partner_report_month', month);
    else await setSetting('partner_report_done', `${month}|${[...done].join(',')}`);
  } catch (e) {
    log('warn', 'partner_reports_skipped', { err: String((e && e.message) || e) });
  }
}

// Owner → partner message (✉️ button, or /pmsg CODE text).
async function messagePartner(chatId, code, text) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>.`); return; }
  if (!p.uid) { await sendText(chatId, `⚠️ <b>${esc(p.code)}</b> has not connected yet — send them the private link first.`); return; }
  const r = await sendText(p.uid,
    `📩 <b>ከአማርኛ ካፕሽን ፕሮ · From Amharic Captions Pro</b>\n\n${esc(text)}`,
    [[{ text: '🤝 የአጋር ገጽ · Partner page', callback_data: 'ref:invite' }]]);
  await sendText(chatId, r && r.ok
    ? `✅ Sent to <b>${esc(p.code)}</b>${p.tg_username ? ' (' + esc(p.tg_username) + ')' : ''}.`
    : '⚠️ Telegram could not deliver it (they may have blocked the bot).',
  [[{ text: `📋 ${p.code}`, callback_data: `admin:partner:${p.code}` }]]);
}

// Partner → owner: a connected partner's free text goes to the owner.
async function forwardFromPartner(p, chatId, text, username) {
  for (const adm of adminUids()) {
    await sendText(adm,
      `📨 <b>From partner ${esc(p.code)}</b> (${esc(p.label)}${username ? ' · @' + esc(username) : ''}):\n\n${esc(text)}`,
      [[{ text: `✉️ Reply`, callback_data: `admin:partner-msg:${p.code}` }, { text: `📋 ${p.code}`, callback_data: `admin:partner:${p.code}` }]]);
  }
  await sendText(chatId, '✅ መልዕክትዎ ለቡድኑ ደርሷል።\n<i>Your message was sent to the team.</i>',
    [[{ text: '🤝 የአጋር ገጽ · Partner page', callback_data: 'ref:invite' }]]);
}

async function adminPartnerNote(chatId, code, note) {
  const p = await partnerByCode(code);
  if (!p) { await sendText(chatId, `⚠️ No partner <b>${esc(code)}</b>.`); return; }
  const v = String(note || '').trim().slice(0, 300);
  try {
    await DB.prepare('UPDATE partners SET note = ? WHERE code = ?').bind(v === '-' ? null : v, p.code).run();
  } catch (e) {
    await sendText(chatId, '⚠️ Run <code>npm run migrate</code>, then deploy.');
    return;
  }
  await adminPartnerCard(chatId, null, p.code);
}

// Pay everything payable for one referrer key; tells the recipient. → total
async function payReferrer(key) {
  const t = refTerms(await getSettings());
  const { results } = await DB.prepare(
    `UPDATE referral_rewards SET status='paid', paid_at=datetime('now')
     WHERE referrer_uid = ? AND status = 'earned' AND earned_at <= datetime('now', ?)
     RETURNING amount_etb`
  ).bind(String(key), refCutoff(t)).all();
  const total = (results || []).reduce((a, r) => a + (r.amount_etb || 0), 0);
  if (!total) return 0;
  const to = await recipientOf(key);
  if (to) {
    const acct = await accountOf(key);
    await sendText(to,
      `💸 <b>${money(total)} ብር ተልኮልዎታል!</b>` + (acct ? ` ወደ፦ <code>${esc(acct.details)}</code>` : '') + '\n' +
      `<i>Your referral reward of ${money(total)} ብር has been sent. Thank you for recommending us!</i>`);
  }
  log('info', 'referral_paid', { uid: key, total });
  return total;
}

// ── message senders (never throw: an outbound failure must not abort the
// ─────────────────── handler or bubble up into a Telegram 500 retry loop) ──
function safeSend(promise) { return promise.catch(() => ({ ok: false })); }
// Safety net: a formatting mistake (a bare "&" or "<") makes Telegram refuse
// the WHOLE message, and the screen silently never appears. Retry the same
// words as plain text so a screen can never go missing over formatting.
const refusedFormatting = (r) => !!(r && !r.ok && /parse entities/i.test(String(r.description || '')));
function plainText(html) {
  return String(html).replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
async function sendText(chatId, text, kb) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  const r = await safeSend(tg(TOKEN, 'sendMessage', params));
  if (!refusedFormatting(r)) return r;
  log('error', 'html_refused', { method: 'sendMessage', err: r.description });
  delete params.parse_mode;
  return safeSend(tg(TOKEN, 'sendMessage', { ...params, text: plainText(text) }));
}
// Edit a message in place. Order cards with the payment screenshot are photo /
// document messages: they have a CAPTION, not text, and editMessageText is
// refused on them — Approve / Decline then changed nothing on screen. So a
// refused text edit is retried as a caption edit, and failing that the result
// is sent as a new message, so every tap visibly does something.
async function editText(chatId, messageId, text, kb) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  let r = await safeSend(tg(TOKEN, 'editMessageText', params));
  if (refusedFormatting(r)) {
    log('error', 'html_refused', { method: 'editMessageText', err: r.description });
    const { parse_mode, ...plain } = params;
    r = await safeSend(tg(TOKEN, 'editMessageText', { ...plain, text: plainText(text) }));
  }
  if (r && !r.ok && /no text in the message/i.test(String(r.description || ''))) {
    const { text: _t, ...base } = params;
    const fits = String(text).length <= 1024;
    const capParams = fits
      ? { ...base, caption: text }
      : (({ parse_mode, ...p }) => ({ ...p, caption: plainText(text).slice(0, 1020) + '…' }))(base);
    const c = await safeSend(tg(TOKEN, 'editMessageCaption', capParams));
    if (c && c.ok) return c;
    return sendText(chatId, text, kb);
  }
  return r;
}
// Swap only the buttons on an existing message. The order card can be a PHOTO
// (the payment screenshot) as well as text, and editMessageText fails on a
// photo message — editMessageReplyMarkup works for both, which matters because
// the decline-reason picker replaces the buttons under whichever it is.
// Show the main menu, whatever state the tapped message is in.
//
// editText goes through safeSend, which swallows EVERY error and returns
// {ok:false}: editing fails on a photo message, and Telegram also rejects an
// edit whose content is unchanged. Either way nothing moved on screen and
// nobody was told — which is what "Back to menu doesn't work" looked like.
// Fall back to sending the menu so the tap always produces something visible.
async function showMenu(chatId, messageId) {
  const home = await homeScreen(chatId);
  if (messageId) {
    const r = await editText(chatId, messageId, home.text, home.kb);
    if (r && r.ok) return r;
  }
  return sendText(chatId, home.text, home.kb);
}

function editKeyboard(chatId, messageId, kb) {
  return safeSend(tg(TOKEN, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId,
    reply_markup: { inline_keyboard: kb },
  }));
}

// Payment-proof card for the admin. A screenshot sent "as a file" has a
// Document file_id (BQAC…), and Telegram refuses it in sendPhoto — the admin
// used to get nothing: no card, no buttons, an empty detail view. So: photo →
// document → plain text with Telegram's reason. The buttons always arrive.
async function sendPhoto(chatId, photo, caption, kb) {
  const markup = kb ? { reply_markup: { inline_keyboard: kb } } : {};
  const r = await safeSend(tg(TOKEN, 'sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...markup }));
  if (r && r.ok) return r;
  const d = await safeSend(tg(TOKEN, 'sendDocument', { chat_id: chatId, document: photo, caption, parse_mode: 'HTML', ...markup }));
  if (d && d.ok) return d;
  const why = String((r && r.description) || (d && d.description) || 'unknown');
  log('error', 'proof_send_failed', { photo: r && r.description, document: d && d.description });
  const t = await sendText(chatId,
    caption + `\n\n⚠️ <i>Screenshot could not be shown (${esc(why)}).</i>`, kb);
  if (t && t.ok) return t;
  // Last resort: the caption itself was refused (bad HTML) — send it as plain text.
  return safeSend(tg(TOKEN, 'sendMessage', {
    chat_id: chatId,
    text: String(caption).replace(/<[^>]+>/g, '') + `\n\n⚠️ Screenshot could not be shown (${why}).`,
    ...markup,
  }));
}
function answerCb(id, text) {
  return safeSend(tg(TOKEN, 'answerCallbackQuery', { callback_query_id: id, text: text || '' }));
}

// One-time reply keyboard hint for the Machine ID prompt (a cheap affordance —
// the keyboard vanishes after the first tap thanks to one_time_keyboard).
// Kept only so the old reply-keyboard button still works for anyone who has
// one stuck in their chat from a previous version.
const MACHINE_ID_HINT_KEY = '📍 Show me where to find my Machine ID';

// Where the Machine ID really is (panel/index.html, section-license). Keep in
// step with the panel's wording: "ፈቃድ ይግዙ" (lic.buy), "👇 ይቅዱ · ከክፍያው ጋር
// ይላኩ" (lic.copyLabel), "📋 ቅዳ" (lic.copy).
function midHelpText() {
  return (
    '📍 <b>Machine ID የት ነው? / Where is my Machine ID?</b>\n\n' +
    '<b>ቀላሉ መንገድ፦</b> በፓነሉ ላይ <b>«ፈቃድ ይግዙ»</b> ይጫኑ — ቦቱ ከMachine ID ዎ ጋር ይከፈታል፣ መጻፍ አያስፈልግዎትም።\n' +
    '<i>Easiest: press “Buy a license” in the panel — this bot opens with your Machine ID already filled in.</i>\n\n' +
    '<b>ወይም፦</b> Window → Extensions → Amharic Captions Pro ይክፈቱ። ከፓነሉ ግርጌ «👇 ይቅዱ · ከክፍያው ጋር ይላኩ» ስር ያለውን <b>16 ፊደል</b> ኮድ <b>📋 ቅዳ</b> ብለው እዚህ ይለጥፉ።\n' +
    '<i>Or open the panel and, at the bottom, copy the 16-character code under “Copy · send with payment” (📋 Copy), then paste it here.</i>\n\n' +
    '<b>CapCut ወይም DaVinci?</b> ዴስክቶፕ ላይ «Make Amharic Captions» ን ይክፈቱ — እዚያም «ፈቃድ ይግዙ» እና Machine ID አለ።\n' +
    '<i>CapCut or DaVinci? Open “Make Amharic Captions” on your desktop — it has the same “Buy a license” button and Machine ID.</i>'
  );
}
const MID_HELP_BTN = { text: '📍 Machine ID የት ነው? · Where is it?', callback_data: 'help:mid' };

// The Machine ID prompt used to carry a REPLY keyboard (the bar pinned to the
// bottom of the chat). Telegram leaves those on screen until something removes
// them, and Cancel never did — so "Send your Machine ID (16 characters)" stayed
// visible after the buyer had abandoned the flow. It also duplicated an inline
// "Where is it?" button that was already on the same message. Inline only now,
// so nothing can get stuck.
const MID_HELP_KB = [
  [MID_HELP_BTN],
  [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
];
function sendHintKb(chatId, text) {
  return sendText(chatId, text, MID_HELP_KB);
}

// Generic thin reply via raw Bot API for any method.
async function apiCall(method, params) {
  return tg(TOKEN, method, params);
}

// ── inline keyboard for pending orders (admin approve/decline) ──────────────
// See adminKeyboardPend() in the admin section below (it now includes Details).

// ── message handler: the stateless re-implementation of bot.py ─────────────
async function handleMessage(msg, env) {
  const text = (msg.text || '').trim();
  const user = msg.from || {};
  const uid = String(user.id || '');
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const privateChat = chatType === 'private';
  const first = user.first_name || '';

  // Groups (the support group) have their own, quiet handler: the buying flow
  // below answers every message, which in a group would reply to everyone.
  if (!privateChat) {
    await handleGroupMessage(msg, text);
    return;
  }

  // /start etc.
  const lower = text.toLowerCase();
  // Any command cancels a broadcast that is being composed, so a later "ok" or
  // note can never go out to every customer by accident.
  if (privateChat && isAdmin(user.id) && lower.startsWith('/')) await cancelBroadcastCompose(uid);
  // "/start r_CODE" = a friend opened a buyer's invite link.
  const startArg = text.match(/^\/start(?:@\w+)?\s+(\S+)$/i);
  if (startArg || ['/start', '/start@amhariccaptionsbot', '/menu', 'menu'].includes(lower)) {
    if (privateChat) {
      if (isAdmin(user.id)) {
        await adminPanel(chatId, null);
      } else {
        // The panel's Buy button: m_<MachineID>_<secret>. Telegram keeps a
        // /start payload through the START tap (a pre-typed message is lost).
        const buy = startArg && /^m_([0-9a-fA-F]{16}|[0-9a-fA-F]{8})(?:_([A-Za-z0-9]{12,32}))?$/.exec(startArg[1]);
        if (buy) {
          await startPanelPurchase(uid, chatId, buy[1].toLowerCase(), buy[2] || null, null);
          return;
        }
        const claim = startArg && /^p_([A-Za-z0-9]{10,40})$/.exec(startArg[1]);
        if (claim) {
          await claimPartner(uid, chatId, claim[1], user.username ? '@' + user.username : (first || uid));
          return;
        }
        const inv = startArg && /^r_([A-Za-z0-9]{3,20})$/.exec(startArg[1]);
        const reason = inv ? await attachReferral(uid, inv[1]) : null;
        const offer = await referralOffer(uid);
        const home = await homeScreen(uid, first, offer);
        await sendText(chatId, home.text + (offer || !inv ? '' : linkNote(reason)), home.kb);
      }
    }
    return;
  }
  if (lower === '/invite' || lower === '/invite@amhariccaptionsbot') {
    if (privateChat) await showInvite(uid, chatId, null);
    return;
  }
  if (lower === '/mykey' || lower === '/mykey@amhariccaptionsbot') {
    if (privateChat) await showMyKey(msg, chatId, null);
    return;
  }
  if (lower === '/admin' || lower === '/admin@amhariccaptionsbot') {
    if (privateChat && isAdmin(user.id)) await adminPanel(chatId, null);
    else await sendText(chatId, '🔒 ይህ ለአስተዳዳሪ ብቻ ነው። <i>Admin only.</i>');
    return;
  }

  if (lower === '/topics' || lower === '/topics@amhariccaptionsbot') {
    if (privateChat && isAdmin(user.id)) await adminTopics(chatId);
    else await sendText(chatId, '🔒 ይህ ለአስተዳዳሪ ብቻ ነው። <i>Admin only.</i>');
    return;
  }

  // admin security: /unlock PIN, /lock, /audit, and the PIN gate for the
  // commands that move money, change bank details or revoke licenses.
  if (privateChat && isAdmin(user.id)) {
    const un = text.match(/^\/unlock(?:\s+(\S+))?$/i);
    if (un) { await handleUnlock(uid, chatId, msg.message_id, un[1] || ''); return; }
    if (lower === '/lock') {
      await kvDel('adminunlock:' + uid);
      await audit(uid, 'lock');
      await sendText(chatId, '🔒 Locked. Money, broadcast and export actions need /unlock again.');
      return;
    }
    if (lower === '/audit') { await adminAudit(chatId); return; }
    const sensitive = /^\/(partnerbank|partnerterms|refdiscount|refreward|refhold|revoke|unrevoke|ban|unban|revoke-mid|unrevoke-mid|setexpiry)\b/i.exec(text);
    if (sensitive && !(await requireUnlock(uid, chatId, null, '/' + sensitive[1]))) return;
    if (sensitive) await audit(uid, 'command', text.slice(0, 120));
  }

  // admin: referral programme amounts → /refdiscount 200, /refreward 300, /refhold 14
  if (privateChat && isAdmin(user.id)) {
    if (lower === '/referrals' || lower === '/referral') { await adminReferrals(chatId, null); return; }
    if (lower === '/partners') { await adminPartners(chatId, null); return; }
    const pinfo = text.match(/^\/partnerinfo\s+([A-Za-z0-9]+)$/i);
    if (pinfo) { await adminPartnerCard(chatId, null, pinfo[1].toUpperCase()); return; }
    const pmsg = text.match(/^\/pmsg\s+([A-Za-z0-9]+)\s+([\s\S]+)$/i);
    if (pmsg) { await messagePartner(chatId, pmsg[1].toUpperCase(), pmsg[2].trim()); return; }
    const pnote = text.match(/^\/partnernote\s+([A-Za-z0-9]+)\s+([\s\S]+)$/i);
    if (pnote) { await adminPartnerNote(chatId, pnote[1].toUpperCase(), pnote[2]); return; }
    const pbank = text.match(/^\/partnerbank\s+([A-Za-z0-9]+)\s+([\s\S]+)$/i);
    if (pbank) { await adminPartnerBank(chatId, pbank[1].toUpperCase(), pbank[2]); return; }
    const prs = text.match(/^\/partnerreset\s+([A-Za-z0-9]+)$/i);
    if (prs) { await adminPartnerReset(chatId, prs[1]); return; }
    const pnm = text.match(/^\/partnername\s+([A-Za-z0-9]+)\s+(.+)$/i);
    if (pnm) { await adminPartnerName(chatId, pnm[1], pnm[2]); return; }
    const pc = text.match(/^\/partner\s+([A-Za-z0-9]+)(?:\s+(.+))?$/i);
    if (pc) { await adminCreatePartner(chatId, pc[1], pc[2]); return; }
    const pt = text.match(/^\/partnerterms\s+([A-Za-z0-9]+)\s+(\d{1,5})\s+(\d{1,5})(?:\s+(\d{1,5})\s+(\d{1,5}))?$/i);
    if (pt) {
      await adminPartnerTerms(chatId, pt[1], parseInt(pt[2], 10), parseInt(pt[3], 10),
        pt[4] ? parseInt(pt[4], 10) : 0, pt[5] ? parseInt(pt[5], 10) : 0);
      return;
    }
    const rc = text.match(/^\/(refdiscount|refreward|refhold)\s+(\d{1,6})$/i);
    if (rc) {
      const which = rc[1].toLowerCase();
      const n = parseInt(rc[2], 10);
      const spec = {
        refdiscount: ['referral_discount_etb', 0, PRICE_ETB - 1, 'Friend discount', ' ብር'],
        refreward: ['referral_reward_etb', 0, PRICE_ETB, 'Reward per sale', ' ብር'],
        refhold: ['referral_hold_days', 0, 90, 'Waiting period', ' days'],
      }[which];
      if (n < spec[1] || n > spec[2]) {
        await sendText(chatId, `⚠️ /${which} must be between ${spec[1]} and ${spec[2]}.`);
        return;
      }
      try {
        await setSetting(spec[0], n);
        await sendText(chatId, `✅ ${spec[3]} set to <b>${money(n)}${spec[4]}</b>. ` +
          'New orders use it; orders already placed keep their terms.');
      } catch (e) {
        await sendText(chatId, '⚠️ Could not save — run <code>npm run migrate</code>, then deploy.');
        return;
      }
      await adminReferrals(chatId, null);
      return;
    }
  }

  // admin: custom expiry for a pending/rejected order → /setexpiry ORDERID YYYYMMDD
  if (privateChat && isAdmin(user.id)) {
    const ex = text.match(/^\/(?:setexpiry|expiry)\s+(\d+)\s+(\d{4})(\d{2})(\d{2})$/i);
    if (ex) {
      const id = ex[1];
      const exp = ex[2] + ex[3] + ex[4];
      if (!isValidExpiry(exp)) {
        await sendText(chatId, '⚠️ Expiry must be a real calendar date in YYYYMMDD form, or 00000000 for perpetual.');
        return;
      }
      const r = await DB.prepare(
        "UPDATE orders SET expiry=? WHERE id=? AND status IN ('pending','rejected')"
      ).bind(exp, id).run();
      const n = r && r.meta ? r.meta.changes : 0;
      await sendText(chatId, n
        ? `⏰ Order <b>#${id}</b> → expiry <code>${exp}</code>. Approve it and the key will embed this date.`
        : `⚠️ Order <b>#${id}</b> was not found or has already been issued.`);
      return;
    }
  }

  // admin: revoke / unrevoke a sold license → /revoke ORDERID, /unrevoke ORDERID
  if (privateChat && isAdmin(user.id)) {
    const rv = text.match(/^\/(?:revoke|ban)\s+(\d+)$/i);
    if (rv) {
      await revokeOrder(chatId, rv[1], true);
      return;
    }
    const urv = text.match(/^\/(?:unrevoke|unban)\s+(\d+)$/i);
    if (urv) {
      await revokeOrder(chatId, urv[1], false);
      return;
    }
    const rm = text.match(/^\/revoke-mid\s+([0-9a-f]{8}|[0-9a-f]{16})$/i);
    if (rm) {
      await revokeMid(chatId, rm[1], true);
      return;
    }
    const urm = text.match(/^\/unrevoke-mid\s+([0-9a-f]{8}|[0-9a-f]{16})$/i);
    if (urm) {
      await revokeMid(chatId, urm[1], false);
      return;
    }

    // Look a customer up by Machine ID. This is THE support request — someone
    // messages "my key doesn't work" and gives their installation id — and
    // there was no way to answer it: history is browsable but not searchable,
    // and /revoke needs an ORDER id nobody has to hand. Paste the machine id
    // and get the whole picture, with the actions attached.
    const look = text.match(/^\/(?:find|lookup|who)\s+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})$/);
    if (look) { await adminFind(chatId, look[1].toLowerCase()); return; }

    // New computer / reinstalled Windows: /move OLD-MACHINE-ID NEW-MACHINE-ID
    const mv = text.match(/^\/move\s+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})\s+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})$/);
    if (mv) { await moveLicense(chatId, uid, mv[1], mv[2]); return; }
    if (/^\/move\b/i.test(text)) {
      await sendText(chatId, 'ℹ️ <code>/move OLD-MACHINE-ID NEW-MACHINE-ID</code>\n\n' +
        '<i>Easier: /find the old Machine ID and tap 🔁 Move to a new computer.</i>');
      return;
    }
    // Fill a new public jobs channel once with the recent real jobs.
    if (/^\/postjobs(?:\s+force)?$/i.test(text)) { await backfillJobsChannel(chatId, /force/i.test(text)); return; }
    // Free license (partner, tester, reviewer): /givekey MACHINE-ID [name]
    const gk = text.match(/^\/givekey\s+([0-9a-fA-F]{8}|[0-9a-fA-F]{16})(?:\s+(.{1,60}))?$/);
    if (gk) { await giveKey(chatId, uid, gk[1], gk[2]); return; }
    if (/^\/givekey\b/i.test(text)) {
      await sendText(chatId, 'ℹ️ <code>/givekey MACHINE-ID name</code> — e.g. <code>/givekey 1a2b3c4d5e6f7a8b Panda</code>');
      return;
    }
    // What happens in the program before people buy (opened, errors, …)
    const fun = text.match(/^\/funnel(?:\s+(7|30))?$/i);
    if (fun) { await adminUsage(chatId, null, parseInt(fun[1] || '7', 10)); return; }
    // Did the customer really activate? /active MACHINE-ID or /active CODE
    const act = text.match(/^\/active\s+(\S{8,19})$/i);
    if (act) { await adminActive(chatId, act[1]); return; }
    if (/^\/active\b/i.test(text)) {
      await sendText(chatId, 'ℹ️ <code>/active MACHINE-ID</code> or <code>/active XXXX-XXXX</code> — is the license activated on that computer?');
      return;
    }
    if (['/help', '/help@amhariccaptionsbot', '/commands'].includes(lower)) { await adminHelp(chatId); return; }
  }

  // admin: composing a broadcast → the next free-text message becomes a DRAFT
  // that is shown back as a preview with Send / Cancel. Nothing goes out
  // without that second tap.
  if (privateChat && isAdmin(user.id)) {
    const bd = await kvGet('bcast:await:' + uid);
    if (bd && !lower.startsWith('/')) {
      await kvDel('bcast:await:' + uid);
      // The owner's words exactly as typed ("Premiere & After Effects" used to
      // be refused by Telegram), keeping the bold / italic / links they set.
      await draftBroadcast(chatId, entitiesToHtml(msg.text || '', msg.entities).trim());
      return;
    }
    const pm = await kvGet('pmsg:await:' + uid);
    if (pm && !lower.startsWith('/')) {
      await kvDel('pmsg:await:' + uid);
      await messagePartner(chatId, pm, text);
      return;
    }
    // "🔍 Find a customer" / "🔁 Move" buttons: the next message is a Machine ID.
    const midTyped = /^\s*([0-9a-fA-F]{8}|[0-9a-fA-F]{16})\s*$/.exec(text);
    const mvFrom = await kvGet('move:await:' + uid);
    if (mvFrom && !lower.startsWith('/')) {
      if (!midTyped) {
        await sendText(chatId, '⚠️ That is not a Machine ID (8 or 16 letters/numbers). Send the NEW computer\'s Machine ID, or /start to cancel.');
        return;
      }
      await kvDel('move:await:' + uid);
      await moveLicense(chatId, uid, mvFrom, midTyped[1]);
      return;
    }
    if (await kvGet('find:await:' + uid) && !lower.startsWith('/')) {
      if (!midTyped) {
        await sendText(chatId, '⚠️ Send a Machine ID (8 or 16 letters/numbers), or /start to cancel.');
        return;
      }
      await kvDel('find:await:' + uid);
      await adminFind(chatId, midTyped[1].toLowerCase());
      return;
    }
  }

  // photos / documents (payment screenshot)
  if (msg.photo || msg.document) {
    if (!privateChat) {
      await sendText(chatId, '🔒 የክፍያ ፎቶና Machine ID በግል ቻት ብቻ ይላኩ።\n<i>For your privacy, send payment screenshots and Machine IDs in a private chat with this bot.</i>');
      return;
    }
    await handlePhoto(msg, uid, chatId, privateChat, text);
    return;
  }

  // generic buy-flow commands
  if (['/buy', '/buy@amhariccaptionsbot'].includes(lower)) {
    const offer = await referralOffer(uid);
    await quoteOffer(uid, offer);
    await sendText(chatId, payText(offer), payKeyboard());
    return;
  }

  // /support — the "/" menu had no way to reach a person. Two doors: the
  // group (everyone, fast) and a private chat with the owner.
  if (['/support', '/support@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId,
      '💬 <b>ድጋፍ / Support</b>\n\n' +
      'ጥያቄ ወይም ችግር ካለዎት በቴሌግራም ግሩፓችን <b>Discussion</b> ላይ ይጻፉ — በፍጥነት እንመልሳለን።\n' +
      '<i>Questions or a problem? Write in the Discussion topic of our group — we answer fast.</i>\n\n' +
      'የፈቃድ ወይም የክፍያ ጉዳይ ከሆነ በግል ያናግሩን።\n' +
      '<i>License or payment issue? Message us privately.</i>',
      [[{ text: '👥 ግሩፑን ይክፈቱ · Open the group', url: SUPPORT_INVITE }],
       [{ text: '🙋 ሰው ያናግሩ · Ask a person', url: SUPPORT_URL }],
       [MENU_BTN]]);
    return;
  }

  // /help — a buyer who is stuck types this before anything else, and the bot
  // used to answer "I didn't understand that" and show a menu, which reads as
  // "you are on your own". Answer the three questions support actually gets.
  if (['/help', '/help@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId,
      '❓ <b>እገዛ / Help</b>\n\n' +
      '<b>1. እንዴት እገዛለሁ? / How do I buy?</b>\n' +
      `ከታች <b>ክፍያ</b> ይንኩ → ${PRICE} በባንክ ይላኩ → የክፍያ ፎቶ ይላኩ → ቁልፍዎ በዚሁ ቻት ይደርሳል።\n` +
      '<i>Tap Pay, transfer the amount, send the screenshot, get your key here.</i>\n\n' +
      '<b>2. Machine ID የት ነው? / Where is my Machine ID?</b>\n' +
      'በፓነሉ ላይ «ፈቃድ ይግዙ» ሲጫኑ በራሱ ይላካል፤ ወይም ከፓነሉ ግርጌ ያለውን 16 ፊደል ኮድ ይቅዱ።\n' +
      '<i>Press “Buy a license” in the panel and it is sent for you — or copy the 16-character code at the bottom of the panel.</i>\n\n' +
      '<b>3. ቁልፌ አይሰራም / My key does not work</b>\n' +
      'አንድ ቁልፍ ለአንድ ኮምፒውተር ነው። ኮምፒውተር ከቀየሩ ወይም Windows እንደገና ከጫኑ ይጻፉልን — ፈቃድዎን እናዛውርልዎታለን።\n' +
      '<i>One key works on one computer. Changed computer or reinstalled Windows? Message us and we will move your license.</i>',
      [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }],
       [MID_HELP_BTN],
       [{ text: '🔑 ቁልፌ · My Key', callback_data: 'menu:mykey' }],
       [{ text: '💬 ድጋፍ · Contact support', url: SUPPORT_URL }]]);
    return;
  }

  // FSM buy flow
  await handleBuyerMessage(msg, uid, chatId, privateChat, text);
}

// ── support group ───────────────────────────────────────────────────────────
// In a group the bot stays quiet. It only: welcomes new members (one welcome
// on screen at a time), removes the "X joined / X left" lines, takes down a
// license key / Machine ID / activation code someone posts by mistake, and
// answers the three questions everyone asks (price, free trial, install) —
// each at most once per half hour, so people still talk to people.
// The bot needs admin rights "Delete messages" (and topics: "Manage topics").
const BOT_URL = 'https://t.me/AmharicCaptionsBot';
const OPEN_BOT_BTN = { text: '🤖 ቦቱን ይክፈቱ · Open the bot', url: BOT_URL };
const GROUP_FAQ_COOLDOWN = 30 * 60;

// What must never sit in a group: a key (AMH-xxxx-…, also without dashes), a
// Machine ID (16 hex, or 8 hex mixing letters and digits so plain numbers and
// words pass) or a phone activation code (K7QD-3MXP: it has a digit).
function groupSecretKind(text) {
  const t = String(text || '');
  if (/AMH[-\s]?[0-9a-f]{4}(?:[-\s]?[0-9a-f]{4}){3,}/i.test(t) || /\b[0-9a-f]{32,}\b/i.test(t)) return 'key';
  if (/\b[0-9a-f]{16}\b/i.test(t) || /\b(?=[0-9a-f]{0,7}[a-f])(?=[0-9a-f]{0,7}\d)[0-9a-f]{8}\b/i.test(t)) return 'mid';
  const codes = t.match(/\b(?=[A-HJ-NP-Z2-9-]{0,8}\d)[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g) || [];
  if (codes.some((c) => !c.split('-').some((h) => VIDEO_WORDS.has(h)))) return 'code';
  return null;
}
// Editors write "H264-HEVC"; those are formats, not codes.
const VIDEO_WORDS = new Set(['H264', 'H265', 'X264', 'X265', 'HEVC', 'AVC1', 'PRORES', 'MPEG', 'UHD4', 'HDR10']);

// A message reads as a question: a question mark, or a question word.
function looksLikeQuestion(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  return /[?፧]/.test(t) ||
    /(እንዴት|ስንት|የት|ምንድን|ይቻላል|አለ ወይ|ነው ወይ|endet|sint|how |what |where |can i|is it|does it)/.test(t);
}

// Same message to the same topic the person wrote in.
async function groupSend(msg, text, kb, reply) {
  const params = { chat_id: msg.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (msg.is_topic_message && msg.message_thread_id) params.message_thread_id = msg.message_thread_id;
  if (reply) params.reply_parameters = { message_id: msg.message_id, allow_sending_without_reply: true };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return safeSend(tg(TOKEN, 'sendMessage', params));
}
const groupDelete = (chatId, messageId) =>
  safeSend(tg(TOKEN, 'deleteMessage', { chat_id: chatId, message_id: messageId }));

// AMH_GROUP_TOPICS = "questions:91,problems:92,ideas:93,work:94,windows:75,mac:80,payment:41"
// (the topic ids of the support group). With it, topic names in the bot's
// group messages are links that open the topic — on a phone a new member
// otherwise lands in one topic and never sees the others.
let GROUP_TOPICS = {};
function parseGroupTopics(spec) {
  const out = {};
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*([a-z]+)\s*:\s*(\d{1,9})\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}
// Link into one topic of the support group. A public group (AMH_GROUP_USERNAME)
// gets t.me/<username>/<topic>, which opens for anyone — also people who have
// not joined yet, who then see that topic first with a Join button. Without
// it, t.me/c/<id>/<topic> (members only).
function topicUrl(key, chatId = SUPPORT_GROUP) {
  const id = GROUP_TOPICS[key];
  if (!id) return '';
  if (GROUP_USERNAME) return `https://t.me/${GROUP_USERNAME}/${id}`;
  const chat = String(chatId).replace(/^-100/, '');
  return chat === String(chatId) ? '' : `https://t.me/c/${chat}/${id}`;
}
// "Discussion" as a link into that topic of this group, or bold if unknown.
function topicRef(chatId, key, label) {
  const url = topicUrl(key, chatId);
  return url ? `<a href="${url}">${label}</a>` : '<b>' + label + '</b>';
}

// ── forum topic inventory ────────────────────────────────────────────────
// Telegram exposes no getForumTopics: a bot cannot enumerate a group's topics,
// and cannot read history to recover any it missed. So we record only what we
// are genuinely told — forum_topic_created / edited / closed / reopened service
// messages, plus the thread id on every message we see — and report from that.
// A topic listed from config but never heard from is reported as such rather
// than dressed up as confirmed.
async function noteTopic(chatId, tid, patch) {
  if (!tid) return;
  let cur = {};
  try { cur = JSON.parse((await kvGet('topics:' + chatId)) || '{}'); } catch (e) { cur = {}; }
  if (!cur || typeof cur !== 'object') cur = {};
  const prev = cur[tid] || {};
  cur[tid] = {
    n: patch.n !== undefined ? patch.n : (prev.n || ''),
    s: patch.s !== undefined ? patch.s : (prev.s || ''),
    at: Date.now(),
  };
  await kvPut('topics:' + chatId, JSON.stringify(cur), 60 * 60 * 24 * 90);
}

// Admin report of the support group's forum topics: what the bot has seen,
// what is only configured, and what Telegram will never let a bot remove.
async function adminTopics(chatId) {
  let seen = {};
  try { seen = JSON.parse((await kvGet('topics:' + SUPPORT_GROUP)) || '{}'); } catch (e) { seen = {}; }
  if (!seen || typeof seen !== 'object') seen = {};

  const rows = {};
  const slot = (id) => (rows[id] = rows[id] || { name: '', state: '', cfg: '' });
  slot('1').name = 'General — all chat';
  for (const key in GROUP_TOPICS) slot(String(GROUP_TOPICS[key])).cfg = key;
  for (const id in seen) {
    const r = seen[id] || {};
    const s = slot(String(id));
    if (r.n) s.name = r.n;
    s.state = r.s === 'closed' ? '🔒 closed to new posts' : r.s === 'open' ? '👁 reopened' : '👂 seen';
  }

  const ids = Object.keys(rows).sort((a, b) => Number(a) - Number(b));
  const unheard = ids.filter((id) => id !== '1' && !rows[id].state && !rows[id].name);
  const out = ids.map((id) => {
    const r = rows[id];
    const note = id === '1'
      ? '⛔ Telegram always keeps this one — a bot cannot delete it, only close or rename it'
      : (r.state || '❔ never heard from by the bot') + (r.cfg ? ` · configured as <code>${esc(r.cfg)}</code>` : '');
    return `<b>${esc(id)}</b> · ${esc(r.name || '(name unknown)')}\n   <i>${note}</i>`;
  });

  await sendText(chatId,
    '🗂 <b>Forum topics</b> — support group\n\n' +
    '<i>Telegram gives bots no API to list a group\'s topics. This is only what the bot has been told: ' +
    'service messages it received, plus the ids in AMH_GROUP_TOPICS. A topic nobody has posted in since ' +
    'the last deploy cannot appear here.</i>\n\n' +
    out.join('\n\n') +
    (unheard.length ? `\n\n❔ Configured, never heard from: ${unheard.map((i) => '<code>' + esc(i) + '</code>').join(', ')}` : '') +
    '\n\n<b>To clear the “all chat” section</b> — it cannot be deleted, but it can be closed so nobody ' +
    'can post there and everyone is pushed into a topic. <i>The button needs the bot to be an admin ' +
    'with “Manage Topics”; it is reversible.</i>',
    [[(seen['1'] && seen['1'].s === 'closed')
      ? { text: '👁 Reopen “all chat”', callback_data: 'admin:topics-open' }
      : { text: '🔒 Close “all chat”', callback_data: 'admin:topics-close' }],
    [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
}

// Close or reopen the support group's General topic. Telegram will not let a
// bot delete thread 1, so this is the practical equivalent of removing the
// "all chat" section: nobody can post there and everyone is pushed into a
// topic. Fully reversible, and audited like every other admin change.
async function adminTopicsGeneral(chatId, cbId, fromUid, close) {
  const gid = SUPPORT_GROUP;
  if (!gid) { await answerCb(cbId, 'AMH_SUPPORT_GROUP is not set'); return; }
  const method = close ? 'closeForumTopic' : 'reopenForumTopic';
  const r = await safeSend(tg(TOKEN, method, { chat_id: gid, message_thread_id: 1 }));
  if (!r || !r.ok) {
    const why = String((r && r.description) || 'unknown error');
    log('error', 'topic_toggle_failed', { method, err: why });
    await answerCb(cbId, '⚠️ ' + (close ? 'Could not close' : 'Could not reopen') + ': ' + why.slice(0, 140));
    return;
  }
  await audit(fromUid, close ? 'topics-close' : 'topics-open', String(gid) + ':1');
  await noteTopic(gid, 1, { s: close ? 'closed' : 'open' });
  await answerCb(cbId, close ? '🔒 “All chat” closed' : '👁 “All chat” reopened');
  await adminTopics(chatId);
}

// ── support-group membership ──────────────────────────────────────────────────
// The bot could only ever ASK for a join before (a static invite-link button),
// never check one. Telegram has no API to force membership — no bot can compel
// anyone into a group — so the strongest honest lever is to detect the gap and
// gate on it, rather than ask once and hope.
//
// Deliberate rule: every path here fails OPEN. If the API call fails, or the
// table is missing, we do nothing. Nudging a customer who is already inside the
// group is a much worse bug than staying quiet.

// Live membership. Returns true / false, or null when we genuinely cannot tell
// (API error, bot not an admin, rate limited) — callers must treat null as
// "leave them alone". `restricted` still counts as inside: the person is a
// member who happens to be under some restriction.
async function isGroupMember(uid) {
  if (!SUPPORT_GROUP) return null;
  const r = await safeSend(tg(TOKEN, 'getChatMember', {
    chat_id: SUPPORT_GROUP, user_id: uid,
  }));
  if (!r || !r.ok || !r.result) {
    log('warn', 'group_member_unknown', { uid: String(uid), err: r && r.description });
    return null;
  }
  const s = String(r.result.status || '');
  return s === 'member' || s === 'administrator' || s === 'creator' || s === 'restricted';
}

// A private supergroup id looks like -1003962455059; Telegram's public link
// form drops the -100. Only usable once the person is already a member.
function groupTopicLink(topicId) {
  if (!SUPPORT_GROUP || !topicId) return SUPPORT_INVITE;
  return `https://t.me/c${String(SUPPORT_GROUP).replace(/^-100/, '')}/${Number(topicId)}`;
}

async function markGroupPrompt(uid) {
  try {
    await DB.prepare(
      `INSERT INTO group_members (uid, prompted_at) VALUES (?, datetime('now'))
       ON CONFLICT(uid) DO UPDATE SET prompted_at = datetime('now')`
    ).bind(String(uid)).run();
  } catch (e) {
    log('error', 'group_prompt_failed', { uid: String(uid), message: String((e && e.message) || e) });
  }
}

// joined_at is written once and never rewritten, so it answers "did they ever
// join"; left_at is cleared on re-join so a lapsed member is distinguishable
// from a never-member.
async function markGroupJoined(uid) {
  try {
    await DB.prepare(
      `INSERT INTO group_members (uid, joined_at) VALUES (?, datetime('now'))
       ON CONFLICT(uid) DO UPDATE SET
         joined_at = COALESCE(group_members.joined_at, datetime('now')),
         left_at   = NULL`
    ).bind(String(uid)).run();
  } catch (e) {
    log('error', 'group_joined_failed', { uid: String(uid), message: String((e && e.message) || e) });
  }
}

async function markGroupLeft(uid) {
  try {
    await DB.prepare(
      `INSERT INTO group_members (uid, left_at) VALUES (?, datetime('now'))
       ON CONFLICT(uid) DO UPDATE SET left_at = datetime('now')`
    ).bind(String(uid)).run();
  } catch (e) {
    log('error', 'group_left_failed', { uid: String(uid), message: String((e && e.message) || e) });
  }
}

const JOIN_PROMPT_KB = [
  [{ text: '👥 ግሩን ይግቡ · Join the group', url: SUPPORT_INVITE }],
  [{ text: '✅ ተግባርላለሁ · I have joined', callback_data: 'grp-check' }],
];

const JOIN_PROMPT_TEXT =
  '👥 <b>ግሩን ይግቡ — የማስተካከሪያ ስራዎች እዚህ ይገኛሉ</b>\n' +
  '<i>Join the group to get every editing job as it is posted.</i>\n\n' +
  'ስራዎቹ ነፃ ናቸው። ሁሉም የሚያዩት በግሩኑ የ<b>ስራዎች</b> ርዕስ ውስጥ ብቻ ነው።\n' +
  '<i>Free, and only there.</i>';

const JOINED_TEXT =
  '✅ <b>እንኳን ወደ ግሩኑ ተመጡ!</b>\n' +
  '<i>You are in — the editing jobs are in the Jobs topic.</i>\n\n' +
  'እንኳን ወደ ግሩኑ ተመጡ! የማስተካከሪያ ስራዎች በ<b>ስራዎች</b> ርዕስ ውስጥ ናቸው።';

// Ask a buyer, once, to join the group — but only if we can positively confirm
// they are not already in it. Returns true when a prompt was sent.
async function nudgeGroupJoin(uid) {
  if (!SUPPORT_GROUP || !SUPPORT_INVITE) return false;
  const member = await isGroupMember(uid);
  if (member === true) { await markGroupJoined(uid); return false; }
  if (member === null) return false;      // cannot tell: stay quiet
  await markGroupPrompt(uid);
  const sent = await sendText(uid, JOIN_PROMPT_TEXT, JOIN_PROMPT_KB);
  log('info', sent && sent.ok ? 'group_prompt_sent' : 'group_prompt_failed_send', { uid: String(uid) });
  return !!(sent && sent.ok);
}

function groupWelcomeNew(names, chatId) {
  const who = names.length ? ' ' + names.map((n) => '<b>' + esc(n) + '</b>').join(', ') : '';
  const t = (key, label) => topicRef(chatId, key, label);
  return (
    `👋 እንኳን ወደ <b>አማርኛ ካፕሽን ፕሮ</b> ግሩፕ በደህና መጡ${who}!\n` +
    '<i>Welcome to the Amharic Captions Pro group!</i>\n\n' +
    `💬 ጥያቄ፣ ችግር ወይም ሀሳብ → ${t('discussion', 'Discussion')}\n` +
    '<i>Questions, problems or ideas → Discussion (the only topic where members write).</i>\n' +
    `🪟 ${t('windows', 'Window guide')} · 🍎 ${t('mac', 'Macos guide')} · 💳 ${t('payment', 'Payment')}\n` +
    (GROUP_TOPICS.jobs ? `💼 የኤዲቲንግ ስራዎች → ${t('jobs', 'Editing Jobs')}\n` : '') +
    (Object.keys(GROUP_TOPICS).length ? '<i>Tap a name to open that topic.</i>\n\n' : '\n') +
    '⚠️ ክፍያ በ @AmharicCaptionsBot ብቻ — Key ወይም Machine ID በግሩፑ አይለጥፉ።\n' +
    '<i>Pay only through @AmharicCaptionsBot. Never post your key or Machine ID here.</i>'
  );
}

const GROUP_FAQ = {
  price: () => `💰 <b>${PRICE}</b> — አንድ ጊዜ ብቻ፣ ወርሃዊ ክፍያ የለም። ዝማኔዎች በነጻ።\n` +
    '<i>One payment, no monthly fee, free updates.</i>\n\n' +
    `🏦 ክፍያ በ @AmharicCaptionsBot ብቻ — ለ <b>${ACCT_NAME}</b>።\n` +
    `<i>Pay only through @AmharicCaptionsBot, to ${ACCT_NAME}.</i>`,
  trial: () => '🎁 ፓነሉን ይጫኑ — <b>2 ካፕሽን በነጻ</b> ይሰራሉ፤ ክፍያም ምዝገባም አያስፈልግም።\n' +
    '<i>Install the panel and make 2 captions free — no payment, no sign-up.</i>',
  install: (chatId) => '📲 <b>①</b> ያውርዱ · <i>download</i>  <b>②</b> Premiere / After Effects ይዝጉ፣ <b>Install</b> ን ያስኪዱ · <i>close them, run Install</i>\n' +
    '<b>③</b> Premiere ይክፈቱ → <b>Window → Extensions → Amharic Captions Pro</b>\n' +
    '✂️ CapCut / DaVinci፦ ዴስክቶፕ ላይ <b>Make Amharic Captions</b> ን ይክፈቱ · <i>open Make Amharic Captions on your desktop</i>\n\n' +
    `🪟 / 🍎 ሙሉ መመሪያ፦ ${topicRef(chatId, 'windows', 'Window guide')} · ${topicRef(chatId, 'mac', 'Macos guide')} <i>(full steps in the guide topics)</i>`,
};
const GROUP_FAQ_KB = {
  price: () => [[OPEN_BOT_BTN]],
  trial: () => [[INSTALL_BTN]],
  install: () => [[INSTALL_BTN]],
};

// ── editing jobs feed ───────────────────────────────────────────────────────
// Public job channels (AMH_JOB_CHANNELS) are read from their public web page
// (t.me/s/<channel>, the page anyone can open in a browser — a bot cannot
// join other people's channels). Only video-editing jobs are kept, posted as
// a short card with a link to the original post, into the support group's
// jobs topic (AMH_SUPPORT_GROUP + "jobs:<id>" in AMH_GROUP_TOPICS). A job seen
// in two channels is posted once. Off until the owner turns it on in the admin
// dashboard. Two channels per minute, so each is checked every few minutes.
let SUPPORT_GROUP = '';
let JOB_CHANNELS = [];
const JOBS_PER_TICK = 2;
const JOBS_MAX_POSTS_PER_TICK = 5;
const JOB_SEED_HOURS = 24;
// (JOB_SEEN_TTL is gone: the dedupe markers moved from KV to the jobs_seen
// table in migration 0022, where the same 30-day window is applied by
// pruneOld() instead of by a KV TTL.)
// Strong: clearly video work. Weak: "editor" / "editing" — kept only when
// nothing says it is about text (copy editor, editor-in-chief…).
const JOB_STRONG = /video\s*-?\s*edit|film\s*edit|premiere|after\s*effects|motion\s*graphic|videograph|capcut|davinci|post[- ]?production|colou?rist|reels?\s*edit|youtube\s*edit|ቪዲዮ|ቪድዮ|ኤዲተር|ኢዲተር|ኤዲቲንግ/i;
const JOB_WEAK = /\bedit(or|ors|ing)\b/i;
const JOB_TEXT_EDITOR = /copy\s*-?\s*edit|editor[- ]?in[- ]?chief|news\s*editor|text\s*editor|code\s*editor|proof\s*-?read|language\s*editor|journal|content\s*writer/i;

const jobsEnabled = async () => (await getSettings()).jobs_feed === '1';

function htmlToText(h) {
  return String(h || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// Posts on a t.me/s/<channel> page: [{ id, text, at }], oldest first.
function parseJobPage(html) {
  const out = [];
  for (const p of String(html || '').split('data-post="').slice(1)) {
    const id = /^[^/"]+\/(\d+)"/.exec(p);
    const body = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(p);
    if (!id || !body) continue;
    const time = /<time datetime="([^"]+)"/.exec(p);
    out.push({ id: Number(id[1]), text: htmlToText(body[1]).trim(), at: time ? Date.parse(time[1]) : NaN });
  }
  return out.sort((a, b) => a.id - b.id);
}

const cleanJobLine = (s) => String(s || '')
  .replace(/^[\s\d.)\-–•*#:]+/, '')
  .replace(/^(job\s*(?:title|position)|position(\s*\d+)?|title|vacancy|role|የ[ሥስ]ራው?\s*(?:መደብ|መጠሪያ|ርዕስ))\s*[:：\-–]\s*/i, '')
  .replace(/\s+/g, ' ').trim();

// Lines that only list acceptable fields/requirements. A job's role is named in
// its title and bullets; "Film Production" inside a qualification list must not
// make a Commercial Nominative Officer post look like an editing job.
const JOB_NON_ROLE = /^(?:qualification|qualifications|requirement|requirements|field of study|discipline|experience)\b|^(?:ቅምቆል|የሚፈቀዳቸው|የሚጠበቀው|የልምድ)/i;
const stripLead = (l) => String(l).replace(/^[^\p{L}\p{N}]+/u, '');
// Where a post names its role: "Job Title: …", "Job Position: …", "Position 2: …",
// Afriwork's "የስራው መጠሪያ: …".
const JOB_TITLE_LABEL = /^(?:job\s*(?:title|position)|position(?:\s*\d+)?|title|vacancy|role|የ[ሥስ]ራው?\s*(?:መደብ|መጠሪያ|ርዕስ))\s*[:：]/i;
// Video roles without the word "edit" — editing jobs in practice. (TikTok /
// YouTube alone are not: "TikTok live ልብስ አስተዋዋቂ" is a live seller.)
const JOB_VIDEO_ROLE = /content\s*creator|videograph|camera\s*(?:man|operator|person)|multimedia|\bmotion\b/i;
const isVideoRole = (l) => JOB_STRONG.test(l) || JOB_VIDEO_ROLE.test(l) || (JOB_WEAK.test(l) && !JOB_TEXT_EDITOR.test(l));

// A video-editing job in this post? → { title, company, location, deadline, salary, type } or null.
function jobFromText(text) {
  const t = String(text || '');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  // The role is what the post is TITLED, not what it asks for. A Content
  // Creator post whose requirements said "Basic video editing or graphic
  // design skills." went out with that line as its title, and a Graphic
  // Designer asking for Premiere looked like an editing job. Title lines are
  // the labelled ones if the post has any, else its first two lines.
  const labelled = lines.filter((l) => JOB_TITLE_LABEL.test(stripLead(l)));
  const heads = labelled.length ? labelled : lines.filter((l) => !JOB_NON_ROLE.test(stripLead(l))).slice(0, 2);
  const titleLine = heads.find((l) => l.length < 140 && isVideoRole(cleanJobLine(stripLead(l))));
  if (!titleLine) return null;
  const field = (re) => {
    for (const l of lines) {
      const m = re.exec(l);
      // "Addis Ababa, Ethiopia Position Type: Freelance": stop at the next label.
      if (m && m[1].trim()) {
        return m[1].replace(/\s+(?:position\s*type|job\s*type|salary|deadline|experience)\s*[:：].*$/i, '').trim().slice(0, 60);
      }
    }
    return '';
  };
  const title = cleanJobLine(stripLead(titleLine)).slice(0, 90);
  if (!title) return null;
  return {
    title,
    // English labels, Afriwork's Amharic labels, and Ethiojobs' "at COMPANY" line.
    company: field(/^(?:company(?:\s*name)?|employer|organi[sz]ation|hiring\s*company|ድርጅት|የድርጅቱ\s*ስም|ቀጣሪ)\s*[:：]\s*(.+)$/i) ||
      field(/^at\s+([A-Z0-9][A-Z0-9&.,'()\- ]{2,59})$/),
    location: field(/^(?:work\s*location|job\s*location|location|place\s*of\s*work|city|የ[ሥስ]ራው?\s*ቦታ)\s*[:：]\s*(.+)$/i),
    deadline: field(/^(?:application\s*deadline|deadline(?:\s*date)?|apply\s*before|closing\s*date|የማመልከቻ\s*ማብቂያ\s*ቀን)\s*[:：]\s*(.+)$/i),
    salary: field(/^(?:salary(?:\s*\/\s*compensation)?|compensation|ደሞዝ(?:\s*\/\s*ክፍያ)?|ደመወዝ)\s*[:：]\s*(.+)$/i),
    type: field(/^(?:job\s*type|employment(?:\s*type)?|የ[ሥስ]ራው?\s*አይነት)\s*[:：]\s*(.+)$/i),
  };
}

// Same title at the same company = the same job, whichever channel posted it.
// Posts that name no company (Afriwork) use the deadline's digits instead, so
// its English and Amharic copies of one job match ("October 7th, 2026" → 72026).
async function jobKey(j) {
  const who = j.company || String(j.deadline || '').replace(/\D+/g, '');
  const norm = (j.title + '|' + who).toLowerCase()
    .replace(/&amp;|&|\band\b|እና/g, ' ').replace(/[^\p{L}\p{N}|]+/gu, '');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One job card. Compact labelled rows read best on a phone; fields the post
// did not mention are omitted rather than left blank, so a sparse vacancy
// renders cleanly. The chip is a label, not a link — the tappable button
// under the card does the acting.
function jobMessage(j, channel) {
  const rows = [
    j.company && `🏢 ${esc(j.company)}`,
    j.location && `📍 ${esc(j.location)}`,
    j.type && `🕒 ${esc(j.type)}`,
    j.deadline && `⏰ ${esc(j.deadline)}`,
    j.salary && `💰 ${esc(j.salary)}`,
  ].filter(Boolean);
  const body = rows.length ? `\n\n${rows.join('\n')}\n` : '';
  return (
    `🎬 <b>${esc(j.title)}</b>${body}\n` +
    `━━━━ [ ዝርዝር እና ማመልከቻ ] ━━━━\n` +
    `<i>Source: @${esc(channel)}</i>\n\n` +
    '⚠️ ለስራ ማመልከቻ ገንዘብ አይክፈሉ። <i>Never pay to apply for a job.</i>'
  );
}

// The same card in the public jobs channel, with a way into the group. A
// failure here never blocks the group post or the "seen" mark.
async function postJobToPublicChannel(job, channel, postId) {
  if (!JOBS_PUBLIC) return;
  const r = await safeSend(tg(TOKEN, 'sendMessage', {
    chat_id: JOBS_PUBLIC, text: jobMessage(job, channel), parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [
      [{ text: '👆 Details & how to apply', url: `https://t.me/${channel}/${postId}` }],
      [{ text: '💬 ግሩፑን ይቀላቀሉ · Discuss in the group', url: topicUrl('discussion') || SUPPORT_INVITE }],
      // Jobs bring editors in; the tool is one quiet tap away, never the post.
      [{ text: '🎬 ነጻ የአማርኛ ካፕሽን · Free Amharic captions', url: BOT_URL + '?start=jobs' }],
    ] },
  }));
  if (!(r && r.ok)) log('warn', 'jobs_public_post_failed', { channel, id: postId, err: r && r.description });
}

// One-time fill (admin: /postjobs) of the public jobs channel, or — with no
// channel — of the group's Editing Jobs topic (e.g. after it was emptied). The
// jobs sent in the last 10 days are re-read from their source post and
// re-checked with today's rules — the title decides, English/Amharic copies
// merge — so the duplicates and mistakes of the feed's first days never come
// back. Oldest first. Runs once; '/postjobs force' repeats it.
async function backfillJobsChannel(chatId, force) {
  const toTopic = !JOBS_PUBLIC;
  if (toTopic && (!SUPPORT_GROUP || !GROUP_TOPICS.jobs)) {
    await sendText(chatId, 'ℹ️ No Editing Jobs topic is set (AMH_SUPPORT_GROUP / AMH_GROUP_TOPICS jobs:ID).');
    return;
  }
  const doneKey = toTopic ? 'jobs_backfill_topic_done' : 'jobs_backfill_done';
  const done = (await getSettings())[doneKey];
  if (done && !force) {
    await sendText(chatId, `ℹ️ Already done (${esc(done)}). Send <code>/postjobs force</code> to post them again.`);
    return;
  }
  // 20 rows max: each one is a fetch + a send, inside the Worker's subrequest budget.
  const { results } = await DB.prepare(
    "SELECT source FROM jobs_seen WHERE seen_at >= datetime('now', '-10 days') ORDER BY seen_at ASC LIMIT 20").all();
  const keys = new Set();
  let posted = 0;
  let skipped = 0;
  for (const r of results || []) {
    const m = /^([A-Za-z0-9_]{4,40})\/(\d+)$/.exec(String(r.source || ''));
    let html = '';
    if (m) {
      try {
        const res = await fetch(`https://t.me/${m[1]}/${m[2]}?embed=1&mode=tme`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmharicCaptionsBot job feed)', 'Accept-Language': 'en' },
        });
        if (res.ok) html = await res.text();
      } catch (e) { /* unreadable: skipped */ }
    }
    const body = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    const job = body ? jobFromText(htmlToText(body[1]).trim()) : null;
    const k = job ? await jobKey(job) : '';
    if (!job || keys.has(k)) { skipped++; continue; }
    keys.add(k);
    if (toTopic) {
      const res = await safeSend(tg(TOKEN, 'sendMessage', {
        chat_id: SUPPORT_GROUP, message_thread_id: Number(GROUP_TOPICS.jobs), text: jobMessage(job, m[1]),
        parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '👆 Details & how to apply', url: `https://t.me/${m[1]}/${m[2]}` }]] },
      }));
      if (!(res && res.ok)) { skipped++; log('warn', 'jobs_backfill_post_failed', { source: r.source, err: res && res.description }); continue; }
    } else {
      await postJobToPublicChannel(job, m[1], Number(m[2]));
    }
    posted++;
  }
  await setSetting(doneKey, new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '));
  await sendText(chatId, `📢 Posted <b>${posted}</b> job(s) to ${toTopic ? 'the Editing Jobs topic' : esc(JOBS_PUBLIC)}.\n` +
    `Skipped ${skipped}: duplicates (e.g. the Amharic copy of an Afriwork job), not editing jobs, or unreadable.`);
  log('info', 'jobs_backfill', { posted, skipped });
}

// Monday morning (Ethiopian time) once a week: how many editing jobs went out
// in the last 7 days — the post people forward. Counts the jobs feed's own
// ledger (jobs_seen), so it needs nothing new stored.
async function postWeeklyJobsDigest() {
  if (!SUPPORT_GROUP || !GROUP_TOPICS.jobs) return false;
  if (!(await jobsEnabled())) return false;
  const eat = new Date(Date.now() + 3 * 3600 * 1000);
  if (eat.getUTCDay() !== 1 || eat.getUTCHours() < 8 || eat.getUTCHours() >= 14) return false;
  const week = eat.toISOString().slice(0, 10);
  if ((await getSettings()).jobs_digest_week === week) return false;
  const row = await DB.prepare(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT substr(source, 1, instr(source, '/') - 1)) AS ch " +
    "FROM jobs_seen WHERE seen_at >= datetime('now', '-7 days')").first();
  const n = row ? Number(row.n) || 0 : 0;
  const ch = row ? Number(row.ch) || 0 : 0;
  await setSetting('jobs_digest_week', week);   // once, even if nothing to say
  if (!n) return false;
  const jobsUrl = topicUrl('jobs') || SUPPORT_INVITE;
  // Share the jobs themselves: the public channel when there is one, else the
  // Editing Jobs topic (t.me/<group>/<topic> opens for non-members too).
  const jobsHome = /^@[A-Za-z0-9_]{4,}$/.test(JOBS_PUBLIC) ? 'https://t.me/' + JOBS_PUBLIC.slice(1) : jobsUrl;
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(jobsHome) +
    '&text=' + encodeURIComponent('Every video editing job in Ethiopia, in one place — free.');
  const text =
    '📊 <b>የዚህ ሳምንት የኤዲቲንግ ስራዎች · This week in editing jobs</b>\n\n' +
    `💼 <b>${n}</b> ስራዎች ከ <b>${ch}</b> የስራ ቻናሎች ተለጥፈዋል።\n` +
    `<i>${n} video editing jobs from ${ch} job channels, posted as they appeared.</i>\n\n` +
    'አዳዲሶቹ በደቂቃዎች ውስጥ ይለጠፋሉ። ኤዲተር ጓደኛዎን ይጋብዙ!\n' +
    '<i>New ones appear within minutes. Know an editor? Share it.</i>\n\n' +
    '🎬 ለቪዲዮዎችዎ የአማርኛ ካፕሽን? <b>Amharic Captions Pro</b> — 2 ካፕሽን በነጻ፣ ያለ ኢንተርኔት። @AmharicCaptionsBot\n' +
    '<i>Amharic captions for your videos? Amharic Captions Pro — 2 free, works offline.</i>';
  const kb = [[{ text: '💼 ስራዎቹን ይመልከቱ · See the jobs', url: jobsUrl }],
              [{ text: '📣 ለጓደኛ ያጋሩ · Share with a friend', url: share }]];
  await safeSend(tg(TOKEN, 'sendMessage', { chat_id: SUPPORT_GROUP, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: kb } }));
  if (JOBS_PUBLIC) {
    await safeSend(tg(TOKEN, 'sendMessage', { chat_id: JOBS_PUBLIC, text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '💬 ግሩፑን ይቀላቀሉ · Join the group', url: SUPPORT_INVITE }], kb[1]] } }));
  }
  log('info', 'jobs_digest_posted', { n, channels: ch });
  return true;
}

async function scanJobChannel(channel, budget) {
  let html = '';
  try {
    const r = await fetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmharicCaptionsBot job feed)', 'Accept-Language': 'en' },
    });
    if (!r.ok) { log('warn', 'jobs_fetch_failed', { channel, status: r.status }); return 0; }
    html = await r.text();
  } catch (e) {
    log('warn', 'jobs_fetch_failed', { channel, err: String((e && e.message) || e) });
    return 0;
  }
  const posts = parseJobPage(html);
  if (!posts.length) return 0;
  // High-water mark in D1, not KV. See migration 0022: when this write used to
  // fail (KV over quota answers 429 and kvPut swallows it) `last` stayed 0, so
  // every tick treated every post as new and re-sent the whole batch to the
  // group once a minute. This read can no longer silently return nothing.
  const chKey = channel.toLowerCase();
  const st = await DB.prepare('SELECT last_id FROM jobs_state WHERE channel = ?').bind(chKey).first();
  const first = !st;
  const last = st ? Number(st.last_id) || 0 : 0;
  const now = Date.now();
  let sent = 0;
  let upTo = last;
  for (const p of posts) {
    if (p.id <= last) continue;
    // Only today's jobs, never a channel's whole history — including the very
    // first look. (The old `!first ||` short-circuited the age check, so adding
    // a channel dumped its last 20 posts, old ones included, into the topic.)
    const fresh = Number.isFinite(p.at) && now - p.at < JOB_SEED_HOURS * 3600 * 1000;
    const job = fresh ? jobFromText(p.text) : null;
    if (job) {
      if (sent >= budget) break; // pick it up on the next pass
      const jk = await jobKey(job);
      const seen = await DB.prepare('SELECT 1 FROM jobs_seen WHERE k = ?').bind(jk).first();
      if (!seen) {
        const r = await safeSend(tg(TOKEN, 'sendMessage', {
          chat_id: SUPPORT_GROUP, message_thread_id: Number(GROUP_TOPICS.jobs), text: jobMessage(job, channel),
          parse_mode: 'HTML', disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: '👆 Details & how to apply', url: `https://t.me/${channel}/${p.id}` }]] },
        }));
        if (!(r && r.ok)) { log('warn', 'jobs_post_failed', { channel, id: p.id, err: r && r.description }); break; }
        await postJobToPublicChannel(job, channel, p.id);
        await DB.prepare(
          `INSERT INTO jobs_seen (k, source) VALUES (?, ?)
           ON CONFLICT(k) DO UPDATE SET source = excluded.source, seen_at = datetime('now')`
        ).bind(jk, channel + '/' + p.id).run();
        sent++;
      }
    }
    upTo = p.id;
  }
  if (first) upTo = Math.max(upTo, posts[posts.length - 1].id);
  if (upTo > last) {
    await DB.prepare(
      `INSERT INTO jobs_state (channel, last_id, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(channel) DO UPDATE SET last_id = excluded.last_id, updated_at = datetime('now')`
    ).bind(chKey, upTo).run();
  }
  if (sent) log('info', 'jobs_posted', { channel, sent });
  return sent;
}

// Every minute (cron): the next two channels in turn.
async function scanJobs() {
  if (!SUPPORT_GROUP || !GROUP_TOPICS.jobs || !JOB_CHANNELS.length) return 0;
  if (!(await jobsEnabled())) return 0;
  const rr = (Math.floor(Date.now() / 60000) * JOBS_PER_TICK) % JOB_CHANNELS.length;
  let sent = 0;
  for (let i = 0; i < Math.min(JOBS_PER_TICK, JOB_CHANNELS.length); i++) {
    sent += await scanJobChannel(JOB_CHANNELS[(rr + i) % JOB_CHANNELS.length], JOBS_MAX_POSTS_PER_TICK - sent);
    if (sent >= JOBS_MAX_POSTS_PER_TICK) break;
  }
  // No cursor write here any more. It was an unconditional KV put with no TTL,
  // rewritten on every one of the 1,440 daily cron ticks: 1,440 puts/day by
  // itself, which exceeds the 1,000/day free-tier limit before any user
  // traffic, and it re-broke the quota every day. It only had to remember
  // "which channels to check next", which the clock above now answers.
  // (minute * JOBS_PER_TICK) steps by exactly JOBS_PER_TICK per tick, as the
  // stored counter did, so coverage is unchanged; a missed or delayed tick just
  // shifts the sweep phase, which costs nothing because every channel keeps its
  // own jobs:last high-water mark and skips posts it has already seen.
  return sent;
}

async function handleGroupMessage(msg, text) {
  const chatId = msg.chat.id;
  const user = msg.from || {};

  // Forum topics: remember ids and names as Telegram reports them. There is no
  // listing API, so these service messages are the only inventory /topics has.
  if (msg.message_thread_id) {
    const patch = {};
    const named = msg.forum_topic_created || msg.forum_topic_edited;
    if (named && named.name) patch.n = String(named.name);
    if (msg.forum_topic_closed) patch.s = 'closed';
    else if (msg.forum_topic_reopened) patch.s = 'open';
    await noteTopic(chatId, msg.message_thread_id, patch);
  }

  // Joins: drop the service line, replace the previous welcome with a new one.
  if (msg.new_chat_members) {
    await groupDelete(chatId, msg.message_id);
    const people = msg.new_chat_members.filter((m) => !m.is_bot);
    if (!people.length) return;
    // Membership we are being told about anyway — record it, so "did they join"
    // is answerable later without asking the API for every customer.
    for (const m of people) await markGroupJoined(m.id);
    const wkey = 'grp:welcome:' + chatId;
    const prev = await kvGet(wkey);
    if (prev) await groupDelete(chatId, Number(prev));
    const names = people.slice(0, 3).map((m) => m.first_name || m.username || '');
    const r = await safeSend(tg(TOKEN, 'sendMessage', {
      chat_id: chatId, text: groupWelcomeNew(names.filter(Boolean), chatId), parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: { inline_keyboard: [[INSTALL_BTN], [OPEN_BOT_BTN]] },
    }));
    if (r && r.ok && r.result) await kvPut(wkey, r.result.message_id, 60 * 60 * 24 * 30);
    return;
  }
  if (msg.left_chat_member) {
    await groupDelete(chatId, msg.message_id);
    await markGroupLeft(msg.left_chat_member.id);
    return;
  }

  // A key / Machine ID / code posted in the open: take it down, say why.
  const body = text || String(msg.caption || '');
  const secret = groupSecretKind(body);
  if (secret) {
    await groupDelete(chatId, msg.message_id);
    const name = esc(user.first_name || user.username || '');
    const what = secret === 'key' ? 'license key' : secret === 'code' ? 'activation code' : 'Machine ID';
    await groupSend(msg,
      `🔒 ${name ? name + '፣ ' : ''}መልዕክትዎን አጥፍቼዋለሁ — ${what} ነበረበት። ይህን በግል ለ @AmharicCaptionsBot ብቻ ይላኩ።\n` +
      `<i>I removed your message because it contained a ${what}. Send it only to @AmharicCaptionsBot in a private chat.</i>`,
      [[OPEN_BOT_BTN]]);
    log('info', 'group_secret_removed', { kind: secret });
    return;
  }

  // /start or /help in the group: a short guide, never prices or accounts.
  const lower = text.toLowerCase();
  if (/^\/(start|help|menu)(@amhariccaptionsbot)?\b/.test(lower)) {
    await groupSend(msg, groupWelcomeNew([], chatId), [[INSTALL_BTN], [OPEN_BOT_BTN]]);
    return;
  }

  // Common questions from members (admins answer themselves; replies to a
  // person are a conversation, not a question for the bot).
  if (!text || isAdmin(user.id) || msg.sender_chat || msg.reply_to_message && !msg.reply_to_message.forum_topic_created) return;
  if (!looksLikeQuestion(text)) return;
  const intent = intentOf(text);
  if (!GROUP_FAQ[intent]) return;
  const ckey = `grp:faq:${chatId}:${intent}`;
  if (await kvGet(ckey)) return;
  await kvPut(ckey, '1', GROUP_FAQ_COOLDOWN);
  await groupSend(msg, GROUP_FAQ[intent](chatId), GROUP_FAQ_KB[intent](), true);
}

// ── Buyer FSM flow (port of handle_buyer_message) ───────────────────────────
const MACHINE_ID_RE = /\b(?:[0-9a-f]{16}|[0-9a-f]{8})\b/i;
function suspiciousMid(mid) {
  mid = mid.toLowerCase();
  if (mid.length !== 8 && mid.length !== 16) return true;
  if (new Set(mid).size === 1) return true;
  if (['00000000', '11111111', '12345678', 'abcdef01', 'deadbeef', 'feedface', 'cafebabe'].includes(mid)) return true;
  if (mid.length === 16 && mid === mid.slice(0, 8).repeat(2)) return true;
  const seq = '0123456789abcdef';
  for (let i = 0; i <= seq.length - 8; i++) {
    if (mid === seq.slice(i, i + 8) || mid === [...seq.slice(i, i + 8)].reverse().join('')) return true;
  }
  return false;
}

// ── the customer's home screen, FAQ and plain-language answers ──────────────
// The home screen depends on where the customer is: a newcomer sees the offer,
// someone who paid sees their place in line, an owner sees their key — never
// the sales pitch again.
async function customerState(uid) {
  let pend = null;
  try {
    pend = await DB.prepare("SELECT id FROM orders WHERE uid=? AND status='pending' ORDER BY id DESC LIMIT 1")
      .bind(String(uid)).first();
  } catch (e) { /* fall through */ }
  if (pend) {
    const pos = await DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending' AND id<=?").bind(pend.id).first();
    return { kind: 'pending', id: pend.id, pos: (pos && pos.n) || 1 };
  }
  if (await isBuyer(uid)) return { kind: 'owner' };
  return { kind: 'new' };
}

const INSTALL_BTN = { text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` };
const SUPPORT_BTN = { text: '💬 ሰው ያናግሩ · Ask a person', url: SUPPORT_URL };
const MENU_BTN = { text: '⬅ ወደ ዋና ገጽ · Menu', callback_data: 'menu:home' };

function pendingText(st, first = '') {
  const name = first ? `${esc(first)}, ` : '';
  return `⏳ ${name}<b>ትዕዛዝ #${st.id} እየተረጋገጠ ነው</b> — በተራ <b>#${st.pos}</b>\n` +
    `<i>Order #${st.id} is being checked — #${st.pos} in line.</i>\n\n` +
    '🔑 ሲረጋገጥ እዚሁ ቻት እናሳውቅዎታለን — ሌላ ምንም ማድረግ አያስፈልግም።\n' +
    '<i>We will tell you right here once it is confirmed — nothing else to do.</i>\n\n' +
    '⏱ አብዛኛውን ጊዜ በጥቂት ሰዓታት ውስጥ (በኢትዮጵያ የስራ ሰዓት)።\n' +
    '<i>Usually within a few hours (Ethiopian working hours).</i>\n\n' +
    '📲 እስከዚያው መተግበሪያውን ይጫኑ። <i>Meanwhile, install the app.</i>';
}

async function homeScreen(uid, first = '', offer = null) {
  const st = await customerState(uid);
  if (st.kind === 'pending') {
    return { text: pendingText(st, first), kb: [[INSTALL_BTN], [FAQ_BTN], [SUPPORT_BTN]] };
  }
  if (st.kind === 'owner') {
    const name = first ? `${esc(first)}, ` : '';
    const kb = (await menuKeyboardFor(uid)).filter((r) => !(r[0] && r[0].callback_data === 'menu:pay'));
    return {
      text: `✅ ${name}<b>አማርኛ ካፕሽን ፕሮ አለዎት።</b>\n<i>You own Amharic Captions Pro.</i>\n\n` +
        '🔑 ቁልፍዎ ወይም ኮድዎ «ቁልፌ» ውስጥ ነው።\n<i>Your key or code is under My Key.</i>\n\n' +
        '🖥 ኮምፒውተር ቀየሩ ወይም ቁልፉ አልሰራም? «ጥያቄዎች»ን ይመልከቱ።\n' +
        '<i>New computer, or the key does not work? See Questions.</i>',
      kb,
    };
  }
  return { text: heroText(first, offer), kb: await menuKeyboardFor(uid) };
}

const FAQ = {
  price: {
    btn: '💰 ዋጋው ስንት ነው? · Price',
    text: () => `💰 <b>ዋጋ / Price</b>\n\n<b>${PRICE}</b> — አንድ ጊዜ ብቻ፣ ወርሃዊ ክፍያ የለም። (<s>ETB 3,500</s> — የመግቢያ ዋጋ)\n` +
      '<i>One payment — no monthly fee (launch price).</i>\n\n' +
      '✅ ለአንድ ኮምፒውተር · ዝማኔዎች በነጻ\n<i>For one computer · updates are free.</i>\n\n' +
      '🏦 ክፍያ በባንክ ዝውውር (CBE፣ አቢሲኒያ፣ ዘመን) — «ክፍያ» ይንኩ።\n<i>Bank transfer (CBE, Abyssinia, Zemen) — tap Pay.</i>',
    kb: () => [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]],
  },
  trial: {
    btn: '🎁 በነጻ መሞከር እችላለሁ? · Free trial',
    text: () => '🎁 <b>በነጻ መሞከር / Free trial</b>\n\n' +
      'ፓነሉን ይጫኑ — <b>2 ካፕሽን በነጻ</b> ይሰራሉ፤ ክፍያም ምዝገባም አያስፈልግም። ከወደዱት በኋላ ብቻ ይክፈሉ።\n' +
      '<i>Install the panel and make 2 captions free — no payment, no sign-up. Pay only if you like it.</i>',
    kb: () => [[INSTALL_BTN]],
  },
  need: {
    btn: '🖥 ምን ያስፈልገኛል? · Requirements',
    text: () => '🖥 <b>ምን ያስፈልጋል? / What do I need?</b>\n\n' +
      '• Windows (64-bit) ወይም Mac (Intel ወይም M1/M2/M3)\n<i>  Windows (64-bit) or Mac (Intel or Apple silicon)</i>\n' +
      '• <b>Premiere Pro</b> ወይም <b>After Effects</b> 2022+ — ካፕሽኑ በቀጥታ ታይምላይኑ ላይ ይገባል\n<i>  Premiere Pro or After Effects 2022+ — captions go straight onto the timeline</i>\n' +
      '• <b>CapCut</b> ወይም <b>DaVinci Resolve</b> — «Make Amharic Captions» መተግበሪያ፦ ቪዲዮውን እያዩ ያስተካክሉ፣ የ .srt ፋይሉን ያስገቡ\n<i>  CapCut or DaVinci Resolve — the Make Amharic Captions app: fix the captions while watching the video, then import the .srt</i>\n' +
      '• ቪዲዮዎ ከኮምፒውተርዎ አይወጣም — ካፕሽኑ በኮምፒውተርዎ ላይ ይሰራል።\n<i>  Your video never leaves your computer — captions are made on it.</i>',
    kb: () => [[INSTALL_BTN]],
  },
  install: {
    btn: '📲 እንዴት እጭነዋለሁ? · How to install',
    text: () => '📲 <b>አጫጫን / Installing</b>\n\n' +
      '<b>①</b> ከድረ-ገጹ ያውርዱ · <i>download it from the website</i>\n' +
      '<b>②</b> Premiere እና After Effects ይዝጉ፣ ከዚያ <b>Install</b> ን ያስኪዱ · <i>close Premiere / After Effects, then run Install</i>\n' +
      '<b>③</b> Premiere ይክፈቱ → <b>Window → Extensions → Amharic Captions Pro</b>\n' +
      '✂️ CapCut / DaVinci፦ ዴስክቶፕ ላይ <b>Make Amharic Captions</b> ን ይክፈቱ · <i>open Make Amharic Captions on your desktop</i>\n\n' +
      'ሙሉ መመሪያው ከታች ነው። <i>The full guide is below.</i>',
    kb: () => [[INSTALL_BTN]],
  },
  when: {
    btn: '⏱ ቁልፌ መቼ ይደርሳል? · When do I get my key?',
    text: () => '⏱ <b>ቁልፌ መቼ ይደርሳል? / When do I get my key?</b>\n\n' +
      'ስክሪንሾቱን ከላኩ በኋላ በጥቂት ሰዓታት ውስጥ (በኢትዮጵያ የስራ ሰዓት) — እዚሁ ቻት ውስጥ።\n' +
      '<i>A few hours after you send the screenshot (Ethiopian working hours) — right here in this chat.</i>\n\n' +
      '🖥 ከፓነሉ «ፈቃድ ይግዙ» ከገዙ ፓነሉ በራሱ ይነቃል። 📱 ከስልክ ከገዙ አጭር ኮድ ይደርስዎታል።\n' +
      '<i>Bought with the panel’s Buy button? It activates itself. From your phone? You get a short code.</i>',
    kb: () => [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]],
  },
  newpc: {
    btn: '🔁 ኮምፒውተር ቀየርኩ · New computer',
    text: () => '🔁 <b>ኮምፒውተር ቀየሩ? / New computer?</b>\n\n' +
      'አንድ ፈቃድ ለአንድ ኮምፒውተር ነው — ኮምፒውተር ከቀየሩ ወይም Windows እንደገና ከጫኑ ግን <b>በነጻ እናዛውርልዎታለን</b>።\n' +
      '<i>One license = one computer — but if you change computer or reinstall Windows, we move it for free.</i>\n\n' +
      'በአዲሱ ኮምፒውተር ፓነሉን ይክፈቱ፣ ከግርጌ ያለውን <b>Machine ID</b> ቀድተው «ሰው ያናግሩ» ላይ ይላኩ።\n' +
      '<i>Open the panel on the new computer, copy the Machine ID at the bottom and send it via “Ask a person”.</i>',
    kb: () => [[MID_HELP_BTN], [SUPPORT_BTN]],
  },
  key: {
    btn: '🔑 ቁልፉ አልሰራም · Key not working',
    text: () => '🔑 <b>ቁልፉ አልሰራም? / Key not working?</b>\n\n' +
      '<b>①</b> ከ«ቁልፌ» ሙሉውን ይቅዱ — ፊደል ሳይቀንሱ · <i>copy all of it from My Key</i>\n' +
      '<b>②</b> የሚሰራው ለተሰራለት ኮምፒውተር ብቻ ነው · <i>it only works on the computer it was made for</i>\n' +
      '<b>③</b> ለማግበር ኢንተርኔት ያስፈልጋል · <i>activating needs internet</i>\n\n' +
      'አሁንም ካልሰራ የስህተቱን ስክሪንሾት ይላኩልን — እናስተካክላለን።\n<i>Still not working? Send us a screenshot of the error — we will fix it.</i>',
    kb: () => [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'menu:mykey' }], [SUPPORT_BTN]],
  },
  // Typed only (not one of the seven buttons): the customer asks about their
  // phone in their own words — "capcut phone lay yiseral", "ስልኬ ላይ ይሰራል".
  phone: {
    btn: '📱 በስልክ ይሰራል? · On my phone?',
    text: () => '📱 <b>በስልክ ይሰራል? / Does it work on my phone?</b>\n\n' +
      '🛠 መሣሪያው <b>በኮምፒውተር ላይ ይሰራል</b> — Windows ወይም Mac።\n' +
      '<i>The tool runs on a computer — Windows or Mac.</i>\n\n' +
      '📱 የCapCut የስልክ መተግበሪያው .srt ፋይል አይገባውም።\n' +
      '<i>The CapCut phone app cannot import .srt files.</i>\n\n' +
      '💻 ኮምፒውተር ካለዎት፦ በ«Make Amharic Captions» ካፕሽኖችን ይሥራሉ፤ ከዚያ በኮምፒውተሩ ላይ በCapCut ያስገቡ (Text → Captions → Import)።\n' +
      '<i>If you have a computer: make the captions in “Make Amharic Captions”, then use CapCut on the computer (Text → Captions → Import).</i>\n\n' +
      '🎁 በነጻ ይሞክሩ፦ <b>2 ካፕሽን በነጻ</b> — መጫን ብቻ ይበቃል።\n' +
      '<i>Try 2 captions free — tap Install to start.</i>',
    kb: () => [[INSTALL_BTN]],
  },
};
const FAQ_ORDER = ['price', 'trial', 'need', 'install', 'when', 'newpc', 'key'];

async function showFaq(chatId, messageId, topic) {
  let text;
  let kb;
  if (FAQ[topic]) {
    text = FAQ[topic].text();
    kb = FAQ[topic].kb().concat([[{ text: '❓ ሌላ ጥያቄ · Other questions', callback_data: 'faq:home' }], [MENU_BTN]]);
  } else {
    text = '❓ <b>ጥያቄዎች / Questions</b>\n\nጥያቄዎን ይምረጡ — ወይም በራስዎ ቃላት ይጻፉልኝ።\n' +
      '<i>Pick a question — or just type it in your own words.</i>';
    kb = FAQ_ORDER.map((k) => [{ text: FAQ[k].btn, callback_data: 'faq:' + k }]).concat([[SUPPORT_BTN], [MENU_BTN]]);
  }
  if (messageId) {
    const r = await editText(chatId, messageId, text, kb);
    if (r && r.ok) return;
  }
  await sendText(chatId, text, kb);
}

// What a typed message is about. Amharic, English and Amharic typed in Latin
// letters ("waga sint", "eske meche", "aysera"), because that is how people
// actually write in Telegram. Order matters: the first match wins.
const INTENTS = [
  ['when', ['መቼ', 'meche', 'mechee', 'how long', 'when will', 'when do', 'status', 'ከፈልኩ', 'ከፍያለሁ', 'ከፍዬ', 'kefelku', 'kefeyalehu', 'kefye', 'i paid', 'i have paid', 'already paid', 'still waiting', 'ቆየ', 'koye', 'እስካሁን', 'eskahun']],
  ['newpc', ['new computer', 'new laptop', 'new pc', 'another computer', 'other computer', 'reinstall', 'format', 'ፎርማት', 'ቀየርኩ', 'ቀይሬ', 'ሌላ ኮምፒውተር', 'አዲስ ኮምፒውተር', 'keyerku', 'change computer', 'changed computer']],
  ['key', ['not work', 'doesnt work', "doesn't work", 'not activ', 'invalid', 'error', 'አይሰራም', 'አልሰራም', 'አልሰራ', 'aysera', 'alsera', 'ችግር', 'chigir', 'problem', 'wrong key', 'activation fail']],
  ['price', ['ዋጋ', 'ስንት', 'waga', 'sint', 'price', 'cost', 'how much', 'birr', 'ብር', 'discount', 'ቅናሽ']],
  ['trial', ['ነጻ', 'ነፃ', 'free', 'trial', 'try', 'ሙከራ', 'ልሞክር', 'mokir', 'demo']],
  ['install', ['install', 'setup', 'set up', 'download', 'ጫን', 'ልጫን', 'አጫጫን', 'ማውረድ', 'አውርድ', 'chan', 'how to use', 'how do i use', 'እንዴት ልጠቀም', 'extension', 'window → ext']],
  ['need', ['mac', 'windows', 'premiere', 'after effect', 'version', 'ቨርሽን', 'capcut', 'davinci', 'requirement', 'laptop', 'ram', 'offline', 'internet', 'ኢንተርኔት']],
  ['thanks', ['thank', 'thx', 'አመሰግናለሁ', 'እናመሰግናለን', 'amesegnalehu', 'amesegnalew', 'ተባረክ', 'tebarek', 'god bless']],
  ['hello', ['selam', 'ሰላም', 'hello', 'hi', 'hey', 'ጤና', 'tena', 'good morning', 'endet']],
];
// "Does it work on my phone?" needs BOTH word groups in one message: a phone
// word AND an editing word ("capcut phone lay yiseral", "ስልኬ ላይ ይሰራል").
// Either group alone is a different question — "I paid from my phone" is about
// payment, "ስልክ ቁጥሬ 0911" is no question at all — so it is checked before
// INTENTS, and the "doesn't work" words ("alsera") cannot claim it either.
const PHONE_Q_WORDS = [
  ['phone', 'mobile', 'android', 'iphone', 'ስልክ', 'ስልኬ', 'silk'],
  ['capcut', 'edit', 'caption', 'ካፕሽን', 'app', 'ይሰራል', 'yiseral'],
];

function intentOf(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[?!.,።፣፤]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  // Short Latin words must be whole words ("hi" is not in "this").
  const has = (w) => (/^[a-z]{1,4}$/.test(w) ? t.includes(' ' + w + ' ') : t.includes(w));
  if (PHONE_Q_WORDS.every((group) => group.some(has))) return 'phone';
  for (const [name, words] of INTENTS) {
    for (const w of words) {
      if (has(w)) return name;
    }
  }
  return null;
}

// Answer a typed question. `waiting` = the buyer is in the middle of paying:
// answer, then remind them the screenshot is the only thing left.
async function answerQuestion(uid, chatId, text, waiting, first = '') {
  const intent = intentOf(text);
  if (!intent) return false;
  if (waiting && (intent === 'hello' || intent === 'thanks')) return false;
  const tail = waiting
    ? '\n\n📸 <b>ከከፈሉ በኋላ ስክሪንሾቱን እዚሁ ይላኩ።</b>\n<i>Once you have paid, send the screenshot right here.</i>'
    : '';
  if (intent === 'thanks') {
    await sendText(chatId, '🙏 ምንም አይደል! መልካም ስራ። <i>You are welcome — happy editing!</i>', [[MENU_BTN]]);
    return true;
  }
  if (intent === 'hello') {
    const h = await homeScreen(uid, first);
    await sendText(chatId, '👋 ' + h.text, h.kb);
    return true;
  }
  const st = await customerState(uid);
  if (intent === 'when' && st.kind === 'pending') {
    await sendText(chatId, pendingText(st, first), [[INSTALL_BTN], [SUPPORT_BTN]]);
    return true;
  }
  if (intent === 'when' && st.kind === 'owner') {
    await sendText(chatId, '✅ <b>ክፍያዎ ተረጋግጧል</b> — ቁልፍዎ ወይም ኮድዎ «ቁልፌ» ውስጥ ነው።\n' +
      '<i>Your payment is confirmed — your key or code is under My Key.</i>',
      [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'menu:mykey' }], [FAQ_BTN]]);
    return true;
  }
  const f = FAQ[intent];
  if (!f) return false;
  const kb = waiting
    ? [[{ text: '💳 የባንክ አካውንቶች · Bank accounts', callback_data: 'menu:pay' }], [FAQ_BTN]]
    : f.kb().concat([[FAQ_BTN], [MENU_BTN]]);
  await sendText(chatId, f.text() + tail, kb);
  try { await addFunnel(uid, 'faq_' + intent); } catch (e) { /* stats only */ }
  return true;
}

// One friendly follow-up for someone who opened the payment page and then went
// quiet: at most once a month, only if they have no order and no license.
const NUDGE_DAYS = 30;
async function nudgeQuietBuyers() {
  let rows = [];
  try {
    rows = (await DB.prepare(
      "SELECT uid FROM fsm WHERE step='photo' AND updated_at <= datetime('now','-3 hours') " +
      "AND updated_at >= datetime('now','-24 hours') LIMIT 40").all()).results || [];
  } catch (e) { return 0; }
  let sent = 0;
  for (const r of rows) {
    const uid = String(r.uid || '');
    if (!uid || isAdmin(uid)) continue;
    if (await kvGet('nudge:' + uid)) continue;
    const o = await DB.prepare('SELECT 1 AS x FROM orders WHERE uid=? LIMIT 1').bind(uid).first();
    if (o || (await isBuyer(uid))) continue;
    await kvPut('nudge:' + uid, '1', NUDGE_DAYS * 86400);
    const res = await sendText(uid,
      '👋 ቀደም ብለው የክፍያ ገጹን ከፍተው ነበር — ጥያቄ አለዎት? መልሶቹ ከታች ናቸው።\n' +
      '<i>You opened the payment page earlier — any questions? The answers are below.</i>\n\n' +
      '🎁 መጀመሪያ <b>2 ካፕሽን በነጻ</b> መሞከር ይችላሉ።\n<i>You can try 2 captions free first.</i>\n\n' +
      '📸 ከፍለው ከሆነ ስክሪንሾቱን እዚሁ ብቻ ይላኩ።\n<i>Already paid? Just send the screenshot here.</i>',
      [[FAQ_BTN], [{ text: '💳 የባንክ አካውንቶች · Bank accounts', callback_data: 'menu:pay' }],
       [{ text: '🎁 በነጻ ልሞክር · Try 2 free', url: `${SITE_URL}/install` }], [SUPPORT_BTN]]);
    if (res && res.ok) { sent++; try { await addFunnel(uid, 'nudge'); } catch (e) { /* stats only */ } }
  }
  if (sent) log('info', 'buyer_nudges_sent', { sent });
  return sent;
}

async function handleBuyerMessage(msg, uid, chatId, privateChat, text) {
  if (!privateChat) {
    await sendText(chatId, '🔒 ለግላዊነትዎ በግል ቻት ይቀጥሉ።\n<i>Please continue in a private chat with this bot so your Machine ID and payment stay private.</i>');
    return;
  }
  const s = await getFsm(uid);
  const step = s ? s.step : null;

  // referral payout account (bank + number + name, one message)
  if (step === 'payout') {
    await savePayoutAccount(uid, chatId, text);
    return;
  }

  // reply-keyboard hint tapped → show where to find the Machine ID
  if (text === MACHINE_ID_HINT_KEY) {
    await sendText(chatId, midHelpText());
    return;
  }

  // Waiting for the screenshot (step 'mid' is the old flow's name for it).
  if (step === 'photo' || step === 'mid' || step === 'proof_ask') {
    const mm = text.match(MACHINE_ID_RE);
    if (mm && !suspiciousMid(mm[0].toLowerCase()) && (await findKey(mm[0].toLowerCase()))) {
      await setFsm(uid, null);
      await sendText(chatId,
        `🔑 ይህ ኮምፒውተር (<code>${mm[0].toLowerCase()}</code>) ቀድሞውኑ ቁልፍ አለው — ሁለተኛ ጊዜ አይክፈሉ።\n` +
        '<i>This computer already has a key — do not pay twice.</i>',
        [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'proof:mykey' }], [{ text: '💬 ድጋፍ · Support', url: SUPPORT_URL }]]);
      return;
    }
    if (mm && !suspiciousMid(mm[0].toLowerCase())) {
      // They typed their Machine ID anyway: keep it, still one step left.
      await setFsm(uid, { ...s, step: 'photo', mid: mm[0].toLowerCase() });
      await addFunnel(uid, 'mid_sent');
      await sendText(chatId,
        `✅ ኮምፒውተርዎ ተመዝግቧል (<code>${mm[0].toLowerCase()}</code>)።\n` +
        '📸 አሁን የክፍያውን ስክሪንሾት ብቻ ይላኩ።\n' +
        '<i>Got your computer. Now just send the payment screenshot.</i>',
        [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
      return;
    }
    if (await answerQuestion(uid, chatId, text, true, (msg.from && msg.from.first_name) || '')) return;
    await sendText(chatId,
      '📸 የክፍያውን <b>ስክሪንሾት</b> እየጠበቅሁ ነው — እዚሁ ይላኩት (ፎቶ ወይም ፋይል)።\n' +
      '<i>Waiting for the payment screenshot — send it right here (photo or file).</i>',
      [[{ text: '💳 የባንክ አካውንቶች · Bank accounts', callback_data: 'menu:pay' }],
       [FAQ_BTN],
       [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
    return;
  }

  // step confirm: a stray text while reviewing -> resend the review
  if (step === 'confirm') {
    await reviewConfirm(uid, chatId);
    return;
  }

  // A partner code typed in the chat — TikTok/YouTube videos cannot carry a
  // clickable link, so "EDITGROUP" works like opening r_EDITGROUP.
  if (/^[A-Za-z0-9]{3,20}$/.test(text) && !MACHINE_ID_RE.test(text)) {
    const typed = await partnerByCode(text);
    if (typed && typed.active) {
      const reason = await attachReferral(uid, typed.code);
      const offer = await referralOffer(uid);
      await sendText(chatId, heroText((msg.from && msg.from.first_name) || '', offer) + (offer ? '' : linkNote(reason)),
        await menuKeyboardFor(uid));
      return;
    }
  }

  // Not in FSM: a bare Machine ID
  const m = text.match(MACHINE_ID_RE);
  if (!m) {
    // A connected partner writing to the bot: forward it to the owner.
    const asPartner = privateChat ? await partnerByUid(uid) : null;
    if (asPartner && text) {
      await forwardFromPartner(asPartner, chatId, text, msg.from && msg.from.username);
      return;
    }
    // A question in their own words → a real answer.
    const buyerName = (msg.from && msg.from.first_name) || '';
    if (privateChat && (await answerQuestion(uid, chatId, text, false, buyerName))) return;
    // unknown input
    if (privateChat) await sendText(chatId,
      `😊 ${esc(buyerName)}, ይቅርታ — ይህን አልተረዳሁም። ከጥያቄዎቹ ይምረጡ ወይም ሰው ያናግሩ።\n` +
      '<i>Sorry, I did not get that — pick a question below, or ask a person.</i>',
      [[FAQ_BTN], [SUPPORT_BTN], [MENU_BTN]]);
    else await sendText(chatId, MENU, MENU_KEYBOARD);
    return;
  }
  // Remember it. The panel's Buy button opens this chat with the Machine ID
  // already in the message, and we used to acknowledge it and then ask for it
  // again later — throwing away the one thing the panel had just prefilled and
  // making the buyer hand-copy a 16-character id after all. Stash it now and
  // the proof flow skips straight to the screenshot.
  const seen = m[0].toLowerCase();
  if (!suspiciousMid(seen)) {
    await startPanelPurchase(uid, chatId, seen, null);
    return;
  }
  await sendText(chatId,
    '👋 ይህ Machine ID ይመስላል። ለመክፈል ከታች ይጀምሩ።\n' +
    '<i>That looks like a Machine ID — tap Pay to start.</i>',
    [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]]);
}

// ── simple buying: no Machine ID for the customer ───────────────────────────
// Two ways in, one step each:
//  • From the panel's Buy button (/start m_<mid>_<secret>): the bot already
//    knows the computer. Pay, send the screenshot — after approval the panel
//    asks /api/license with its secret and activates ITSELF.
//  • From the phone (a group post, TikTok, a partner link): no Machine ID at
//    all. Pay, send the screenshot — approval sends a short activation code
//    (K7QD-3MXP) that the panel redeems once (/api/redeem), binding it there.
// Until redeemed, a phone order carries a placeholder "machine id"
// code-<code> (never a valid Machine ID); redeeming rewrites it everywhere to
// the real one, so revoke / find / sales keep working exactly as before.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
function newActivationCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}
// "k7qd 3mxp", "K7QD3MXP", "k7qd-3mxp" → "K7QD-3MXP" (or null).
function normActivationCode(c) {
  const s = String(c || '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4) : null;
}
const isCodePlaceholder = (mid) => /^code-[a-z2-9]{8}$/.test(String(mid || ''));
const placeholderCode = (mid) => {
  const s = String(mid).slice(5).toUpperCase();
  return s.slice(0, 4) + '-' + s.slice(4);
};
// What the admin sees where a Machine ID would be.
const midLabel = (mid) => (isCodePlaceholder(mid) ? '📱 phone order (activation code)' : String(mid || ''));

// The Machine ID is known (panel Buy button, or typed): straight to paying.
async function startPanelPurchase(uid, chatId, mid, nonce) {
  const have = await DB.prepare('SELECT revoked FROM customers WHERE machine_id=?').bind(mid).first();
  if (have && !have.revoked) {
    await setFsm(uid, null);
    await sendText(chatId,
      '🔑 <b>ይህ ኮምፒውተር ቀድሞውኑ ፈቃድ አለው።</b>\n<i>This computer already has a license.</i>\n\n' +
      'ፓነሉ ካልነቃ ቁልፍዎን ከ«ቁልፌ» ይቅዱና ይለጥፉ፣ ወይም ይጻፉልን።\n' +
      '<i>If the panel is not activated, copy your key from My Key and paste it — or message us.</i>',
      [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'proof:mykey' }], [{ text: '💬 ድጋፍ · Support', url: SUPPORT_URL }]]);
    return;
  }
  // Paid already and waiting: attach this computer to that order.
  const pend = await DB.prepare(
    "SELECT id, machine_id FROM orders WHERE uid=? AND status='pending' ORDER BY id DESC LIMIT 1").bind(uid).first();
  if (pend) {
    let linked = false;
    if (isCodePlaceholder(pend.machine_id) || pend.machine_id === mid) {
      try {
        await DB.prepare("UPDATE orders SET machine_id=? WHERE id=? AND status='pending'").bind(mid, pend.id).run();
        linked = true;
        if (nonce) await DB.prepare('UPDATE orders SET nonce=? WHERE id=?').bind(nonce, pend.id).run();
      } catch (e) { /* another pending order already holds this machine, or 0019 missing */ }
    }
    await sendText(chatId,
      `⏳ <b>ትዕዛዝ #${pend.id} እየተረጋገጠ ነው</b> — ሌላ ምንም አያስፈልግም።\n<i>Order #${pend.id} is being confirmed — nothing else needed.</i>` +
      (linked
        ? (nonce
          ? '\n\n🖥 ይህ ኮምፒውተር ከትዕዛዙ ጋር ተገናኝቷል — ሲረጋገጥ ፓነሉ በራሱ ይነቃል።\n<i>This computer is linked — the panel activates itself once confirmed.</i>'
          : '\n\n🖥 ይህ ኮምፒውተር ከትዕዛዙ ጋር ተገናኝቷል — ሲረጋገጥ ቁልፍዎ እዚህ ይደርሳል።\n<i>This computer is linked — your key arrives here once confirmed.</i>')
        : ''));
    return;
  }
  const prior = await getFsm(uid);
  await setFsm(uid, { step: 'photo', mid, nonce: nonce || (prior && prior.mid === mid ? prior.nonce : null), photo_key: null, hint: 1 });
  await addFunnel(uid, nonce ? 'panel_buy' : 'mid_sent');
  const offer = await referralOffer(uid, mid);
  await quoteOffer(uid, offer);
  await sendText(chatId,
    '🖥 <b>ኮምፒውተርዎ ተገናኝቷል ✅</b> — ምንም መጻፍ አያስፈልግም።\n<i>Your computer is connected — nothing to type.</i>\n\n' +
    payText(offer), payKeyboard(true));
}

// ── payment-screenshot fraud signals ────────────────────────────────────────
// Bank transfers are checked by eye, so the cheap frauds are an OLD genuine
// receipt used again (by the same or another person) and someone else's
// receipt forwarded in. Telegram's file_unique_id is the same for the same
// image from every user and every re-send, and `proofs` keeps it forever.
async function proofSignals(fileUid, forwarded, uid, orderId) {
  const flags = [];
  if (forwarded) flags.push('⚠️ Forwarded screenshot — the buyer did not take it themselves.');
  if (fileUid) {
    try {
      const prev = await DB.prepare('SELECT order_id, uid, created_at FROM proofs WHERE file_unique_id=?').bind(fileUid).first();
      if (prev && prev.order_id !== orderId) {
        flags.push(`🚨 SAME screenshot was already used for order #${prev.order_id} ` +
          `(${prev.uid === String(uid) ? 'same buyer' : 'a DIFFERENT buyer'}, ${String(prev.created_at).slice(0, 10)}).`);
      }
    } catch (e) { /* 0020 not applied */ }
  }
  return flags.length ? flags.join('\n') : null;
}
async function recordProof(fileUid, orderId, uid, flag) {
  try {
    if (fileUid) {
      await DB.prepare('INSERT OR IGNORE INTO proofs (file_unique_id, order_id, uid) VALUES (?, ?, ?)')
        .bind(fileUid, orderId, String(uid)).run();
    }
    await DB.prepare('UPDATE orders SET proof_flag=? WHERE id=?').bind(flag, orderId).run();
  } catch (e) { /* 0020 not applied: the order itself is unaffected */ }
}

// A new screenshot while an order waits replaces it (wrong / clearer photo).
async function replaceProof(o, fileId, chatId, meta = {}) {
  await DB.prepare("UPDATE orders SET photo_key=? WHERE id=? AND status='pending'").bind(fileId, o.id).run();
  const flag = await proofSignals(meta.fileUid, meta.forwarded, o.uid, o.id);
  await recordProof(meta.fileUid, o.id, o.uid, flag);
  await sendText(chatId,
    `🔄 የትዕዛዝ #${o.id} ስክሪንሾት ተቀይሯል — አዲሱን እንመለከታለን።\n<i>Screenshot for order #${o.id} updated — we will check the new one.</i>`);
  for (const adm of adminUids()) {
    await sendPhoto(adm, fileId,
      `🔄 <b>New screenshot for #${o.id}</b> · @${esc(o.username)}\n${esc(midLabel(o.machine_id))}\n` +
      (flag ? `\n${esc(flag)}\n` : '') + '\nCheck it, then Approve or Decline:',
      adminKeyboardPend(o.id));
    await sleep(90);
  }
}

// ── screenshots (photo/document) ────────────────────────────────────────────
async function handlePhoto(msg, uid, chatId, privateChat, text) {
  const s = await getFsm(uid);
  const step = s ? s.step : null;
  const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id
    : (msg.document && msg.document.file_id) || '';
  const isDocument = !msg.photo && !!msg.document;
  const mime = (msg.document && msg.document.mime_type) || '';

  if (!fileId) return;
  if (isDocument && !mime.startsWith('image/')) {
    await sendText(chatId,
      '📁 ይህን ፋይል ማንበብ አንችልም — የክፍያውን ማረጋገጫ እንደ <b>ፎቶ</b> ወይም ምስል ይላኩ።\n' +
      '<i>We cannot read that file — send the payment screenshot as a photo or image.</i>');
    return;
  }
  const from = msg.from || {};
  const uname = from.username || from.first_name || '';
  // Fraud signals: the image's permanent fingerprint, and whether it was
  // forwarded from someone else's chat rather than sent by the buyer.
  const meta = {
    fileUid: msg.photo ? msg.photo[msg.photo.length - 1].file_unique_id : (msg.document && msg.document.file_unique_id) || null,
    forwarded: !!(msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat),
  };

  // An order is already waiting: this screenshot replaces its proof.
  const pend = await DB.prepare(
    "SELECT * FROM orders WHERE uid=? AND status='pending' ORDER BY id DESC LIMIT 1").bind(uid).first();
  if (pend) { await replaceProof(pend, fileId, chatId, meta); return; }

  // Inside a purchase (they opened Pay, came from the panel, or typed their
  // Machine ID): the screenshot IS the order — no review step, no Confirm.
  const inPurchase = s && ['photo', 'mid', 'have_mid', 'confirm', 'proof_ask'].includes(step);
  if (!inPurchase) {
    // A picture out of the blue may be something else (an error screenshot):
    // one tap to say it is the payment.
    await setFsm(uid, { step: 'proof_ask', mid: s && s.mid, nonce: s && s.nonce, photo_key: fileId, hint: 1 });
    await kvPut('proofmeta:' + uid, JSON.stringify(meta), 86400);
    await sendText(chatId,
      '📸 <b>ይህ የክፍያ ማረጋገጫ ነው?</b>\n<i>Is this your payment screenshot?</i>',
      [[{ text: '✅ አዎ — የከፈልኩበት ነው · Yes, my payment', callback_data: 'proof:yes' }],
       [{ text: '✖ አይደለም · No', callback_data: 'proof:cancel' }]]);
    return;
  }
  await addFunnel(uid, 'screenshot_sent');
  await placeOrder(uid, chatId, uname, privateChat, { ...s, photo_key: await storeProof(fileId), meta });
}

async function storeProof(fileId) {
  // A file_id that arrived inside a real Telegram update is always valid to
  // re-send via sendPhoto. We deliberately do NOT round-trip through getFile:
  // that extra network call is the only place a screenshot could get dropped.
  return fileId || null;
}

// ── review + confirm ────────────────────────────────────────────────────────
async function reviewConfirm(uid, chatId, lead = '') {
  const s = await getFsm(uid);
  if (!s) return;
  const offer = await orderOffer(uid, s.mid);
  const amount = offer && offer.discount > 0
    ? `<b>ETB ${money(offer.price)}</b> (የጓደኛ ቅናሽ / friend discount)`
    : `<b>${PRICE}</b>`;
  const text = lead +
    '🧾 <b>ትዕዛዝዎን ያረጋግጡ / Review your order</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 ዋጋ / Amount: ${amount}\n` +
    `🏦 የተከፈለው ለ / Paid to: <b>${ACCT_NAME}</b>\n\n` +
    '🔑 ከተረጋገጠ በኋላ ቁልፍዎ በዚሁ ቻት ይደርስዎታል።\n' +
    '<i>Once approved, your key arrives right here.</i>\n\n' +
    'ትክክል ከሆነ <b>አረጋግጥ</b> ይንኩ።\n<i>If this looks right, tap Confirm.</i>';
  const kb = [
    [{ text: '✅ ትዕዛዙን አረጋግጥ · Confirm', callback_data: 'proof:confirm' }],
    [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
  ];
  const r = await sendText(chatId, text, kb);
  if (r && r.ok) await setFsm(uid, { ...s, status_msg_id: r.result.message_id });
}

// ── the order ───────────────────────────────────────────────────────────────
// Legacy: a buyer who was on the old "Review your order → Confirm" screen
// when this version was deployed can still finish with Confirm.
async function completeProof(uid, chatId, uname, privateChat) {
  const s = await getFsm(uid);
  if (!s || !s.photo_key) return;
  await placeOrder(uid, chatId, uname, privateChat, s);
}

// The screenshot arrived: book the order at once. s = { mid?, nonce?, photo_key }.
async function placeOrder(uid, chatId, uname, privateChat, s) {
  if (!s || !s.photo_key) return;
  const mid = s.mid && isValidMid(s.mid) && !suspiciousMid(s.mid) ? String(s.mid).toLowerCase() : null;
  if (mid && (await findKey(mid))) {
    await setFsm(uid, null);
    await sendText(chatId,
      `🔑 ይህ ኮምፒውተር (<code>${mid}</code>) ቀድሞውኑ ቁልፍ አለው — ሁለተኛ ጊዜ አይክፈሉ።\n` +
      '<i>This computer already has a key — do not pay twice.</i>\n\n' +
      'ለማየት <b>ቁልፌ</b> ይንኩ፣ ወይም ይጻፉልን።\n<i>Tap My Key to see it, or message us.</i>',
      [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'proof:mykey' }], [{ text: '💬 ድጋፍ · Support', url: SUPPORT_URL }]]);
    return;
  }
  // No Machine ID (paid from the phone): a placeholder that later becomes the
  // activation code — see "simple buying" above.
  const machineId = mid || ('code-' + newActivationCode().replace('-', '').toLowerCase());

  // Atomically insert + claim: the unique partial index on
  // (machine_id WHERE status='pending') blocks duplicate pending orders
  // for the same machine.
  let orderId;
  try {
    const order = await DB.prepare(
      `INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb)
       VALUES (?, ?, ?, '', ?, ?, 'pending', ?)`
    ).bind(uid, uname || 'anon', machineId, s.photo_key, String(chatId), PRICE_ETB).run();
    orderId = order.meta.last_row_id;
  } catch (err) {
    const isDupe = /UNIQUE/i.test(String(err));
    await setFsm(uid, null);
    await sendText(chatId, isDupe
      ? '⏳ ለዚህ ኮምፒውተር ትዕዛዝ ቀድሞውኑ በመጠባበቅ ላይ ነው — ቁልፍዎ በዚሁ ቻት ይደርሳል።\n' +
        '<i>An order for this computer is already waiting for approval — your key will arrive here.</i>'
      : '⚠️ ትዕዛዝዎን ማስቀመጥ አልተቻለም። እባክዎ እንደገና ይሞክሩ፣ ወይም @sumpak6 ን ያግኙ።\n' +
        '<i>We could not save your order. Please try again, or message @sumpak6.</i>');
    return;
  }
  const meta = s.meta || {};
  const flag = await proofSignals(meta.fileUid, meta.forwarded, uid, orderId);
  await recordProof(meta.fileUid, orderId, uid, flag);
  if (flag) log('warn', 'proof_flagged', { orderId, uid, flag });
  if (mid && s.nonce) {
    try { await DB.prepare('UPDATE orders SET nonce=? WHERE id=?').bind(s.nonce, orderId).run(); }
    catch (e) { /* 0019 not applied: the key is still sent in the chat */ }
  }

  // Referral terms are locked onto the order now (price, discount, reward), so
  // changing the amounts or switching the programme off later never changes an
  // order in flight.
  const offer = await orderOffer(uid, mid);
  let amountEtb = PRICE_ETB;
  if (offer) {
    try {
      await DB.prepare(
        'UPDATE orders SET referrer_uid=?, discount_etb=?, reward_etb=?, amount_etb=? WHERE id=?'
      ).bind(offer.referrer, offer.discount, offer.reward, offer.price, orderId).run();
      amountEtb = offer.price;
    } catch (e) {
      log('error', 'referral_order_tag_failed', { orderId, err: String((e && e.message) || e) });
    }
  }

  await setFsm(uid, null);
  await kvDel('pending:count');
  await addFunnel(uid, 'order_confirmed');
  log('info', 'order_created', { orderId, mid: machineId, uid, amount_etb: amountEtb, referred: !!offer, panel: !!s.nonce, source: privateChat ? 'DM' : 'Group' });

  // What happens next, in the customer's words — no Machine ID, no key talk
  // for someone who has not installed yet.
  const pos = await pendingCount();
  const next = mid && s.nonce
    ? '🖥 ሲረጋገጥ <b>ፓነሉ በራሱ ይነቃል</b> — ምንም መለጠፍ አያስፈልግም።\n' +
      '<i>Once confirmed, the panel on your computer activates by itself — nothing to paste.</i>'
    : mid
      ? '🔑 ሲረጋገጥ ቁልፍዎ እዚሁ ይደርሳል።\n<i>Once confirmed, your key arrives right here.</i>'
      : '🔑 ሲረጋገጥ <b>አጭር የማግበሪያ ኮድ</b> እዚሁ ይደርስዎታል።\n' +
        '<i>Once confirmed, you get a short activation code right here.</i>\n\n' +
        '📲 እስከዚያው መተግበሪያውን ይጫኑ (ከታች «አጫጫን»)።\n<i>Meanwhile, install the app (Install guide below).</i>';
  const statusText =
    '✅ <b>ደርሶናል! / Received!</b>\n\n' +
    `💵 ETB ${money(amountEtb)} · ⏳ በተራ / in line: <b>#${pos}</b>\n\n` +
    next + '\n\n' +
    '⏱ አብዛኛውን ጊዜ በጥቂት ሰዓታት ውስጥ (በኢትዮጵያ የስራ ሰዓት)።\n<i>Usually within a few hours (Ethiopian working hours).</i>\n' +
    '🔄 የተሳሳተ ስክሪንሾት ከሆነ ትክክለኛውን ብቻ ይላኩ።\n<i>Wrong screenshot? Just send the right one.</i>';
  const r = await sendText(chatId, statusText,
    mid ? null : [[{ text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` }]]);
  const statusMsgId = r && r.ok ? r.result.message_id : null;
  if (statusMsgId) await DB.prepare('UPDATE orders SET status_msg_id=? WHERE id=?').bind(statusMsgId, orderId).run();

  // notify admin (throttled so a queue of cards doesn't hit Telegram 429)
  for (const adm of adminUids()) {
    const caption =
      '🧾 <b>New order — payment proof</b>\n\n' +
      (mid
        ? `Machine ID: <code>${esc(mid)}</code>${s.nonce ? ' · 🖥 from the panel (activates itself)' : ''}\n`
        : '📱 <b>Paid from the phone</b> — no Machine ID; approving sends an activation code.\n') +
      `User: @${esc(uname)} (id ${esc(uid)})\nSource: ${privateChat ? 'DM' : 'Group'}\n` +
      (offer ? `👥 <b>Referred${offer.partner ? ` via partner ${esc(offer.partner)}` : ''}</b> — expect <b>ETB ${money(amountEtb)}</b> (discount ${money(offer.discount)})\n` : '') +
      (flag ? `\n${esc(flag)}\n` : '') + '\n' +
      `✔ Check your bank app shows <b>ETB ${money(amountEtb)}</b> received, then Approve or Decline:`;
    await sendPhoto(adm, s.photo_key, caption, adminKeyboardPend(orderId));
    await sleep(90); // ~11 msg/s — admin cards have 1 photo each; calm under 30/s
  }
}

// multi-admin support (comma-separated AMH_ADMIN_ID)
async function adminList() {
  return adminUids();
}

// ── show my key ─────────────────────────────────────────────────────────────
// Paid from the phone: a short code, typed once into the panel.
function activationCodeMessage(code) {
  return (
    '✅ <b>ክፍያዎ ተረጋግጧል!</b>\n<i>Payment confirmed!</i>\n\n' +
    '🔑 የማግበሪያ ኮድዎ / Your activation code:\n' +
    `<code>${esc(code)}</code>\n\n` +
    '<b>①</b> አማርኛ ካፕሽን ፕሮን ይጫኑ (ከታች «አጫጫን») · <i>install the app (Install guide below)</i>\n' +
    '<b>②</b> ፓነሉን (Premiere / After Effects) ወይም <b>Make Amharic Captions</b> ን (CapCut / DaVinci) ይክፈቱ፣ ኮዱን <b>«የፈቃድ ቁልፍ»</b> ላይ ይጻፉ · <i>open the panel or Make Amharic Captions and type the code into “License key”</i>\n' +
    '<b>③</b> <b>«አግብር»</b> ይጫኑ — ተጠናቋል! · <i>press Activate — done!</i>\n\n' +
    '🖥 ኮዱ ለአንድ ኮምፒውተር ብቻ ነው። <i>One code = one computer.</i>\n' +
    'እናመሰግናለን! 🙏 ችግር ካጋጠመዎት ይጻፉልን። <i>Thank you — message us if anything goes wrong.</i>'
  );
}

function keyDeliveryMessage(key, expiry, chatType, selfActivating = false) {
  expiry = String(expiry || '00000000');
  if (chatType !== 'private') {
    return '🔒 ቁልፍዎ የሚላከው በግል ቻት ብቻ ነው።\n' +
      '<i>For your security, the key is only sent in a private chat — open a DM with this bot and tap My Key.</i>';
  }
  if (selfActivating) {
    // Bought with the panel's Buy button: the panel turns itself on. The key
    // is here only as a fallback.
    return [
      '✅ <b>ክፍያዎ ተረጋግጧል!</b>', '<i>Payment confirmed!</i>', '',
      '🖥 <b>ፓነሉ በራሱ ይነቃል</b> — ክፍት ከሆነ በአንድ ደቂቃ ውስጥ፣ ካልሆነ ሲከፍቱት።',
      '<i>Your panel activates by itself — within a minute if it is open, otherwise the next time you open it.</i>', '',
      'ካልነቃ ብቻ ይህን ቁልፍ ይንኩ (ይቀዳል)፣ በፓነሉ «የፈቃድ ቁልፍ» ላይ ይለጥፉና «አግብር» ይጫኑ፦',
      '<i>Only if it does not: tap this key to copy it, paste it into “License key” and press Activate:</i>',
      `<code>${esc(key)}</code>`, '',
      'እናመሰግናለን! 🙏 <i>Thank you!</i>',
    ].join('\n');
  }
  const lines = [
    '✅ <b>ክፍያዎ ተረጋግጧል — ቁልፍዎ ደርሷል!</b>',
    '<i>Payment confirmed — your license key is ready.</i>',
    '', `<code>${esc(key)}</code>`, '',
    '<b>①</b> ቁልፉን ይንኩት — ይቀዳል · <i>tap the key to copy it</i>',
    '<b>②</b> ፓነሉን ይክፈቱ (Premiere ወይም After Effects)፣ ከግርጌ <b>«የፈቃድ ቁልፍ»</b> ላይ ይለጥፉ · <i>open the panel and paste it into “License key” at the bottom</i>',
    '<b>③</b> <b>«አግብር»</b> ይጫኑ · <i>press Activate</i>',
    '',
    '✂️ <b>CapCut / DaVinci</b>፦ በ «Make Amharic Captions» ውስጥም «የፈቃድ ቁልፍ» ላይ ይለጥፉ።',
    '<i>CapCut / DaVinci: paste it into “License key” in Make Amharic Captions too.</i>',
  ];
  if (expiry !== '00000000') lines.push('', `⏰ የሚያበቃበት / Expires: ${esc(expiry)}`);
  lines.push('', 'እናመሰግናለን! 🙏 ችግር ካጋጠመዎት ይጻፉልን።\n<i>Thank you — message us if anything goes wrong.</i>');
  return lines.join('\n');
}

const MY_KEY_KB = [[{ text: '⬅ ወደ ዋና ገጽ · Menu', callback_data: 'menu:home' }]];
async function showMyKey(msg, chatId, messageId) {
  const chat = (msg && msg.chat) || (msg && msg.message && msg.message.chat);
  if (!chat || chat.type !== 'private') {
    await sendText(chatId, '🔒 ቁልፍዎ የሚታየው በግል ቻት ብቻ ነው።\n<i>Your key is only shown in a private chat — open a DM with this bot and tap My Key.</i>');
    return;
  }
  const user = msg.from || {};
  const uid = String(user.id || '');
  // Customers.uid is stamped at approve time — read directly so buyers
  // retain "My Key" access even after the 30-day orders prune deletes
  // the linking order row.  (Previously this JOINed orders — which broke
  // after pruning.)
  const rows = await DB.prepare(
    `SELECT machine_id, key, expiry FROM customers
     WHERE uid = ? ORDER BY machine_id LIMIT 50`
  ).bind(uid).all();
  const list = rows.results || [];
  // Activation codes bought from the phone and not typed into a panel yet.
  let codes = [];
  try {
    codes = (await DB.prepare(
      'SELECT code FROM activation_codes WHERE uid = ? AND redeemed_mid IS NULL AND revoked = 0 ORDER BY created_at LIMIT 20'
    ).bind(uid).all()).results || [];
  } catch (e) { /* 0019 not applied */ }
  if (!list.length && !codes.length) {
    const text =
      '🔑 <b>ቁልፌ / My Key</b>\n\n' +
      'በዚህ የቴሌግራም አካውንት የተመዘገበ ቁልፍ እስካሁን የለም።\n' +
      '<i>No key is linked to this Telegram account yet.</i>\n\n' +
      'ክፍያዎ ሲረጋገጥ እዚህ ይታያል። ከፍለው ካላገኙት @sumpak6 ን ያግኙ።\n' +
      '<i>It appears here once your payment is approved. Paid but nothing here? Message @sumpak6.</i>';
    const r = messageId ? await editText(chatId, messageId, text, MY_KEY_KB) : null;
    if (!r || !r.ok) await sendText(chatId, text, MY_KEY_KB);
    return;
  }
  const text =
    '🔑 <b>ቁልፍዎ / Your key</b>\n\n' +
    (codes.length
      ? '📱 <b>የማግበሪያ ኮድ / Activation code</b> (ገና ያልተጠቀሙበት · not used yet):\n' +
        codes.map((c) => `🔑 <code>${esc(c.code)}</code>`).join('\n') +
        '\n<i>ፓነሉን ይክፈቱ፣ ኮዱን «የፈቃድ ቁልፍ» ላይ ይጻፉና «አግብር» ይጫኑ። · Type it into “License key” in the panel and press Activate.</i>\n' +
        '<i>CapCut / DaVinci፦ «Make Amharic Captions» ቪዲዮ ሲጥሉበት ቁልፍ ሲጠይቅ ኮዱን ይለጥፉ። · CapCut / DaVinci: paste it when “Make Amharic Captions” asks for a key (version 1.8.13 or newer).</i>\n\n'
      : '') +
    list.map((r) => `🖥 <code>${esc(r.machine_id)}</code>\n🔑 <code>${esc(r.key)}</code>\n`).join('\n') +
    (list.length
      ? '\nቁልፉን ይንኩት — ይቀዳል። በፓነሉ <b>«የፈቃድ ቁልፍ»</b> ላይ ይለጥፉና <b>«አግብር»</b> ይጫኑ።\n' +
        '<i>Tap to copy, paste into “License key” in the panel, then press Activate.</i>'
      : '');
  const r = messageId ? await editText(chatId, messageId, text, MY_KEY_KB) : null;
  if (!r || !r.ok) await sendText(chatId, text, MY_KEY_KB);
}

// ── admin panel (modern dashboard + queue + audit) ─────────────────────────
const money = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const shortTs = (s) => (s ? String(s).slice(5, 16).replace(' ', ' ') : '—');
const orderSummary = (o) =>
  `${o.proof_flag ? '🚨 ' : ''}<b>#${o.id}</b> · ${o.username ? '@' + esc(o.username) : 'anon'} · ${isCodePlaceholder(o.machine_id) ? '📱 phone order' : `<code>${esc(o.machine_id)}</code>`} · ${shortTs(o.created_at)}` +
  (o.referrer_uid ? ` · 👥 ETB ${money(o.amount_etb || 0)}` : '');

// The last 30 admin actions (who / what / when), newest first.
async function adminAudit(chatId) {
  let rows = [];
  try {
    rows = (await DB.prepare('SELECT ts, admin_uid, action, detail FROM admin_audit ORDER BY id DESC LIMIT 30').all()).results || [];
  } catch (e) {
    await sendText(chatId, '⚠️ The audit log needs migration 0020 — run <code>npm run migrate</code>, then deploy.');
    return;
  }
  const multi = adminUids().length > 1;
  const lines = rows.map((r) =>
    `<code>${esc(eatTs(r.ts))}</code> ${esc(r.action)}${r.detail ? ' · ' + esc(r.detail) : ''}${multi ? ' · ' + esc(r.admin_uid) : ''}`);
  await sendText(chatId,
    '🧾 <b>Audit log</b> — latest 30 admin actions (Ethiopia time)\n\n' +
    (lines.length ? lines.join('\n') : 'Nothing yet.') +
    '\n\n<i>Anything you do not recognise? Telegram → Settings → Devices → end other sessions, then change your PIN.</i>',
    [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
}

function adminKeyboardPend(orderId) {
  return [[
    { text: '✅ Approve', callback_data: `approve:${orderId}` },
    { text: '❌ Decline', callback_data: `reject:${orderId}` },
    { text: '👁 Details', callback_data: `admin:detail:${orderId}` },
  ]];
}

// How many buyers we asked to join actually joined. This is the number that was
// impossible to get before: the old flow only ever handed out an invite link,
// so there was nothing to count. "Asked but not joined" is also the actionable
// list — those are the customers who may not know the jobs feed exists.
async function adminGroup(chatId, messageId, cbId) {
  await answerCb(cbId, '');
  let row = { prompted: 0, joined: 0, joinedPrompted: 0 };
  try {
    row = await DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN prompted_at IS NOT NULL THEN 1 ELSE 0 END),0) AS prompted,
         COALESCE(SUM(CASE WHEN joined_at   IS NOT NULL THEN 1 ELSE 0 END),0) AS joined,
         COALESCE(SUM(CASE WHEN joined_at IS NOT NULL AND prompted_at IS NOT NULL THEN 1 ELSE 0 END),0) AS joinedPrompted
       FROM group_members`
    ).first() || row;
  } catch (e) {
    await sendText(chatId, '⚠️ <i>group_members table is missing — run <code>npm run migrate</code>.</i>');
    return;
  }
  const prompts = row.prompted || 0;
  const converted = row.joinedPrompted || 0;
  const pct = prompts ? Math.round((converted / prompts) * 100) : 0;
  const missing = prompts - converted;

  let lines =
    `👥 <b>Support group</b>\n\n` +
    `📣 Asked to join: <b>${prompts}</b>\n` +
    `✅ Of those, joined: <b>${converted}</b> (${pct}%)\n` +
    `⬜ Did not join yet: <b>${missing}</b>\n` +
    `👤 Ever joined (any path): <b>${row.joined || 0}</b>\n`;

  if (missing > 0) {
    const laggards = await DB.prepare(
      `SELECT gm.uid, gm.prompted_at FROM group_members gm
       WHERE gm.prompted_at IS NOT NULL AND gm.joined_at IS NULL
       ORDER BY gm.prompted_at DESC LIMIT 15`
    ).all();
    const names = (laggards.results || []).map((r) =>
      `${esc(String(r.uid))} <i>(${String(r.prompted_at || '').slice(0, 16)})</i>`).join('\n');
    lines += `\n\n📋 <b>Not joined yet (latest 15):</b>\n${names}\n` +
      `<i>Send them: /broadcast — the jobs feed only lives in the group.</i>`;
  }
  const back = [[{ text: '⬅ ተመለስ · Back', callback_data: 'admin:panel' }]];
  if (messageId) {
    const r = await editText(chatId, messageId, lines, back);
    if (r && r.ok) return;
  }
  await sendText(chatId, lines, back);
}

async function adminPanel(chatId, messageId) {
  await pruneOld();
  const pend = await pendingCount();
  const todayRow = await DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS ap, " +
    "COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rj, " +
    "COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pd " +
    "FROM orders WHERE date(created_at, '+3 hours')=date('now', '+3 hours')").first();
  const sold30 = await DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount_etb), 0) AS revenue " +
    "FROM sales WHERE status='sold' AND sold_at >= datetime('now','-30 days')"
  ).first();
  const soldCount = sold30 ? sold30.n : 0;
  const revenue = sold30 ? sold30.revenue : 0;
  const refOn = refTerms(await getSettings()).on;

  const text =
    `🛠 <b>Admin · Dashboard</b>\n\n` +
    `📥 <b>New requests:</b> ${pend}\n` +
    `   ├ ✅ Approved today: ${todayRow.ap}\n` +
    `   ├ ❌ Declined today: ${todayRow.rj}\n` +
    `   └ ⏳ Pending today:  ${todayRow.pd}\n\n` +
    `💵 <b>Revenue (30d):</b> ${soldCount} sale(s) = <b>ETB ${money(revenue)}</b>\n\n` +
    `🔍 Support: tap <b>Find a customer</b> and send their Machine ID — move, revoke or restore from there.\n` +
    (ADMIN_PIN
      ? `🔐 Security: PIN on · ${(await adminUnlocked(chatId)) ? '🔓 unlocked' : '🔒 locked — /unlock PIN for money &amp; exports'}`
      : '⚠️ <b>Security: no admin PIN.</b> Anyone in your Telegram could broadcast or export keys. ' +
        'Set one: <code>npx wrangler secret put AMH_ADMIN_PIN</code>');
  const kb = [
    [{ text: `📥 Requests (${pend})`, callback_data: 'admin:queue' }],
    [{ text: '🧾 History (30 days)', callback_data: 'admin:history' }],
    [{ text: '📈 Sales & funnel', callback_data: 'admin:sales' }, { text: '🎁 Trial users', callback_data: 'admin:trials' }],
    [{ text: '🧭 In the program (before buying)', callback_data: 'admin:usage:7' }],
    [{ text: '📣 Broadcast', callback_data: 'admin:broadcast' }, { text: '📤 Export customers', callback_data: 'admin:export' }],
    [{ text: '🔍 Find a customer', callback_data: 'admin:findask' }, { text: '🤝 Partners', callback_data: 'admin:partners' }],
    [{ text: `🎁 Referrals · ${refOn ? '🟢 ON' : '⚪ OFF'}`, callback_data: 'admin:ref' }],
    [{ text: `💼 Jobs feed · ${(await jobsEnabled()) ? '🟢 ON' : '⚪ OFF'}`, callback_data: 'admin:jobs-toggle' }],
    [{ text: '👥 Group members', callback_data: 'admin:group' }],
    [{ text: '🔐 Audit log', callback_data: 'admin:audit' }, { text: '📖 Commands', callback_data: 'admin:help' }],
  ];
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

const QUEUE_PAGE = 10;
async function adminQueue(chatId, messageId, cbId, offset = 0) {
  await pruneOld();
  const totalRow = await DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending'").first();
  const total = totalRow ? totalRow.n : 0;
  if (!total) {
    await answerCb(cbId, 'Queue empty');
    await editText(chatId, messageId,
      '📥 <b>No pending requests.</b>\n\nNew orders appear here the moment a buyer submits proof.',
      [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  const { results } = await DB.prepare(
    "SELECT * FROM orders WHERE status='pending' ORDER BY id DESC LIMIT ? OFFSET ?")
    .bind(QUEUE_PAGE + 1, offset).all();
  const page = results.slice(0, QUEUE_PAGE);
  const hasMore = results.length > QUEUE_PAGE;
  // Send each pending order as its own card (newest first) with inline actions.
  for (const o of page) {
    const cap = `${orderSummary(o)}\n`;
    if (o.photo_key) await sendPhoto(chatId, o.photo_key, cap, adminKeyboardPend(o.id));
    else await sendText(chatId, cap, adminKeyboardPend(o.id));
    await sleep(90); // throttle: stay well under Telegram's 30 msg/s per chat
  }
  await answerCb(cbId, `${total} pending`);
  const shown = `${offset + 1}–${offset + page.length}`;
  const kb = [
    hasMore ? [{ text: '▶ More', callback_data: 'admin:queuep:' + (offset + QUEUE_PAGE) }] : [],
    [{ text: '🛠 Admin', callback_data: 'admin:panel' }],
  ].filter((r) => r.length);
  const msg = hasMore
    ? `📥 <b>${total} pending</b> — showing <b>${shown}</b> of ${total}. Newest first.`
    : `📥 <b>${total} pending</b> — newest first. Approve, decline, or view details on each card.`;
  await sendText(chatId, msg, kb);
}

async function adminExport(chatId, messageId, cbId) {
  const { results: licensed } = await DB.prepare(
    'SELECT machine_id, name, expiry, key, status, revoked, uid FROM customers ORDER BY machine_id').all();
  // Paid from the phone, code not typed into a panel yet: still a customer.
  let codes = [];
  try {
    codes = (await DB.prepare(
      "SELECT a.code, a.expiry, a.revoked, a.uid, o.username FROM activation_codes a LEFT JOIN orders o ON o.id = a.order_id WHERE a.redeemed_mid IS NULL ORDER BY a.created_at"
    ).all()).results || [];
  } catch (e) { /* 0019 not applied */ }
  const results = licensed.concat(codes.map((c) => ({
    machine_id: '(code)', name: c.username ? '@' + c.username : '', expiry: c.expiry, key: c.code,
    status: 'code-not-used', revoked: c.revoked, uid: c.uid,
  })));
  if (!results.length) { await answerCb(cbId, 'No customers'); return; }
  const lines = results.map((c) =>
    esc(`${c.machine_id}\t${c.name || ''}\t${c.expiry || '00000000'}\t${String(c.key || '').replace('AMH-', '')}\t${c.revoked ? 'revoked' : c.status}\t${c.uid || ''}`));
  const header = `📤 <b>Customers (${results.length})</b> — machine | name | expiry | key | status | uid\n\n<pre>machine\tname\texpiry\tkey\tstatus\tuid\n`;
  const prefix = '<pre>';
  const suffix = '</pre>';
  let sent = 0;
  let chunk = header;
  let count = 0;
  const flush = async () => {
    if (!count) return;
    const r = await sendText(chatId, chunk + suffix);
    if (r && r.ok) sent += count;
    chunk = prefix;
    count = 0;
  };
  for (const line of lines) {
    if (count && chunk.length + line.length + 1 > 3500) await flush();
    chunk += line + '\n';
    count += 1;
  }
  await flush();
  if (sent !== results.length) log('error', 'admin_export_incomplete', { sent, expected: results.length });
  await answerCb(cbId, sent === results.length ? `${sent} customers exported` : `exported ${sent}/${results.length}`);
}

// ── broadcast: preview → confirm → batched sending ──────────────────────────
// Two audiences, minus the admins:
//   'all'    — everyone who ever started an order or holds a key (promotions)
//   'buyers' — only people holding an active (not revoked) key (update news)
function broadcastAudienceSql(kind = 'all') {
  const admins = adminUids();
  const not = admins.length ? ` AND uid NOT IN (${admins.map(() => '?').join(',')})` : '';
  const src = kind === 'buyers'
    ? "SELECT uid FROM customers WHERE uid <> '' AND revoked = 0"
    : "SELECT uid FROM customers WHERE uid <> '' UNION SELECT uid FROM orders WHERE uid <> ''";
  return {
    sql: `SELECT DISTINCT uid FROM (${src}) WHERE 1=1${not}`,
    args: admins,
  };
}

async function audienceCount(kind) {
  const aud = broadcastAudienceSql(kind);
  const r = await DB.prepare(`SELECT COUNT(*) AS n FROM (${aud.sql})`).bind(...aud.args).first();
  return r ? r.n : 0;
}

async function cancelBroadcastCompose(uid) {
  await kvDel('bcast:await:' + uid);
  await kvDel('pmsg:await:' + uid);
  await kvDel('move:await:' + uid);
  await kvDel('find:await:' + uid);
  // Runs before EVERY admin command. It must never be able to break them: a
  // missing table (a deploy whose migration was not applied yet) once made
  // /start, /admin and /find all fail silently for the owner.
  try {
    await DB.prepare("UPDATE broadcasts SET status='cancelled' WHERE admin_chat=? AND status='draft'")
      .bind(String(uid)).run();
  } catch (e) {
    log('error', 'broadcast_cancel_failed', { err: String((e && e.message) || e) });
  }
}

async function draftBroadcast(chatId, text) {
  const n = await audienceCount('all');
  const buyers = await audienceCount('buyers');
  if (!n) {
    await sendText(chatId, '📣 No customers to send to yet — nothing was sent.');
    return;
  }
  const ins = await DB.prepare("INSERT INTO broadcasts (admin_chat, text, status) VALUES (?, ?, 'draft')")
    .bind(String(chatId), text).run();
  const id = ins.meta.last_row_id;
  // The preview IS the message, exactly as customers will receive it.
  const shown = await sendText(chatId, text);
  if (!shown || !shown.ok) {
    await DB.prepare("UPDATE broadcasts SET status='cancelled' WHERE id=?").bind(id).run();
    await sendText(chatId,
      '⚠️ Telegram could not display that message, so it was not sent to anyone.\n' +
      'Check for stray &lt; &gt; &amp; characters, then tap 📣 Broadcast again.');
    return;
  }
  const others = n - buyers;
  const choices = [];
  if (buyers > 0 && others > 0) {
    choices.push([{ text: `✅ Buyers only (${buyers})`, callback_data: `admin:bcast-send:${id}:buyers` }]);
    choices.push([{ text: `✅ Everyone (${n})`, callback_data: `admin:bcast-send:${id}:all` }]);
  } else {
    choices.push([{ text: `✅ Send to ${n}`, callback_data: `admin:bcast-send:${id}:all` }]);
  }
  choices.push([{ text: '✖ Cancel', callback_data: `admin:bcast-cancel:${id}` }]);
  await sendText(chatId,
    '📣 <b>Preview above.</b> Who should get it?\n\n' +
    `👤 <b>${buyers}</b> buyer(s) with an active key\n` +
    `👥 <b>${others}</b> other(s) who started an order but have no key\n\n` +
    '<i>Nothing has been sent yet.</i>',
    choices);
}

async function startBroadcast(chatId, messageId, cbId, id, kind = 'all') {
  // Claim the draft: a double tap or a Telegram retry cannot send it twice,
  // and a draft older than 30 minutes is no longer trusted.
  const claim = await DB.prepare(
    "UPDATE broadcasts SET status='sending' WHERE id=? AND status='draft' AND created_at >= datetime('now','-30 minutes')"
  ).bind(id).run();
  if (!claim || !claim.meta || claim.meta.changes < 1) {
    await answerCb(cbId, 'Already sent, cancelled or expired');
    return;
  }
  const aud = broadcastAudienceSql(kind === 'buyers' ? 'buyers' : 'all');
  const q = await DB.prepare(
    `INSERT OR IGNORE INTO broadcast_queue (broadcast_id, uid) SELECT ?, uid FROM (${aud.sql})`
  ).bind(id, ...aud.args).run();
  const total = q && q.meta ? q.meta.changes : 0;
  await DB.prepare('UPDATE broadcasts SET total=? WHERE id=?').bind(total, id).run();
  await answerCb(cbId, 'Sending…');
  await editText(chatId, messageId,
    `📣 <b>Sending to ${total} ${kind === 'buyers' ? 'buyer(s)' : 'people'}…</b>\n<i>Large lists go out in batches, about 40 a minute. You will get a report when it is done.</i>`);
  log('info', 'broadcast_started', { id, total });
  await processBroadcast(BCAST_BATCH_TAP);
}

async function cancelBroadcast(chatId, messageId, cbId, id) {
  const r = await DB.prepare("UPDATE broadcasts SET status='cancelled' WHERE id=? AND status='draft'").bind(id).run();
  await answerCb(cbId, r && r.meta && r.meta.changes ? 'Cancelled' : 'Already sent or cancelled');
  if (r && r.meta && r.meta.changes) {
    await editText(chatId, messageId, '✖ <b>Broadcast cancelled</b> — nothing was sent.');
  }
}

// Sends one batch of the oldest running broadcast. Kept to a fixed, small
// number of D1 queries plus one Telegram call per recipient, so it fits the
// free plan's 50 subrequests / 50 D1 queries per invocation.
const BCAST_BATCH_TAP = 20;   // inside the admin's confirm tap
const BCAST_BATCH_CRON = 40;  // each every-minute cron run
async function processBroadcast(limit) {
  const b = await DB.prepare("SELECT * FROM broadcasts WHERE status='sending' ORDER BY id LIMIT 1").first();
  if (!b) return 0;
  // A run that crashed mid-batch leaves rows in 'sending': retry them later.
  await DB.prepare(
    "UPDATE broadcast_queue SET status='queued', claimed_at=NULL " +
    "WHERE broadcast_id=? AND status='sending' AND claimed_at < datetime('now','-10 minutes')"
  ).bind(b.id).run();
  const { results } = await DB.prepare(
    `UPDATE broadcast_queue SET status='sending', claimed_at=datetime('now')
     WHERE broadcast_id=? AND uid IN (
       SELECT uid FROM broadcast_queue WHERE broadcast_id=? AND status='queued' ORDER BY uid LIMIT ?)
     RETURNING uid`
  ).bind(b.id, b.id, limit).all();
  const ok = [];
  const bad = [];
  for (const r of results || []) {
    const res = await sendText(r.uid, b.text);
    (res && res.ok ? ok : bad).push(r.uid);
    await sleep(40); // ~25 msg/s, under Telegram's 30/s bulk limit
  }
  const mark = async (list, st) => {
    if (!list.length) return;
    await DB.prepare(
      `UPDATE broadcast_queue SET status='${st}' WHERE broadcast_id=? AND uid IN (${list.map(() => '?').join(',')})`
    ).bind(b.id, ...list).run();
  };
  await mark(ok, 'sent');
  await mark(bad, 'failed');
  if (ok.length || bad.length) {
    await DB.prepare('UPDATE broadcasts SET sent=sent+?, failed=failed+? WHERE id=?')
      .bind(ok.length, bad.length, b.id).run();
  }
  const left = await DB.prepare(
    "SELECT COUNT(*) AS n FROM broadcast_queue WHERE broadcast_id=? AND status IN ('queued','sending')"
  ).bind(b.id).first();
  if (!left || left.n === 0) {
    const fin = await DB.prepare(
      "UPDATE broadcasts SET status='done', finished_at=datetime('now') WHERE id=? AND status='sending' " +
      'RETURNING sent, failed, total, admin_chat'
    ).bind(b.id).all();
    const f = fin && fin.results && fin.results[0];
    if (f) {
      await sendText(f.admin_chat,
        `📣 Broadcast delivered to <b>${f.sent}</b> of <b>${f.total}</b> customer(s).` +
        (f.failed ? `\n<i>${f.failed} could not be reached (they blocked the bot or never opened it).</i>` : ''));
      log('info', 'broadcast_sent', { id: b.id, recipients: f.total, delivered: f.sent, failed: f.failed });
    }
  }
  return ok.length + bad.length;
}

// ── revoke / unrevoke a sold license ────────────────────────────────────────
async function setCustomerRevoked(machineId, revoke) {
  const mid = String(machineId || '').toLowerCase();
  let cust = null;
  if (isCodePlaceholder(mid)) {
    // A phone order: its activation code, or the computer it was used on.
    const code = placeholderCode(mid);
    let ac = null;
    try { ac = await DB.prepare('SELECT redeemed_mid FROM activation_codes WHERE code=?').bind(code).first(); } catch (e) {}
    if (!ac) return { ok: false, error: 'activation code not issued yet' };
    if (ac.redeemed_mid) return setCustomerRevoked(ac.redeemed_mid, revoke);
    await DB.prepare('UPDATE activation_codes SET revoked=? WHERE code=?').bind(revoke ? 1 : 0, code).run();
    cust = { key: code };
  } else {
    if (!isValidMid(mid)) return { ok: false, error: 'invalid mid' };
    cust = await DB.prepare('SELECT key FROM customers WHERE machine_id=?').bind(mid).first();
    if (!cust) return { ok: false, error: 'customer not found' };
    await DB.prepare('UPDATE customers SET revoked=? WHERE machine_id=?').bind(revoke ? 1 : 0, mid).run();
  }
  // A revoked sale (fraud, refund) no longer counts as revenue; restoring it does.
  await DB.prepare('UPDATE sales SET status=? WHERE machine_id=?').bind(revoke ? 'revoked' : 'sold', mid).run();
  // A refunded / revoked friend's sale cancels the referrer's unpaid reward.
  try {
    await DB.prepare(revoke
      ? "UPDATE referral_rewards SET status='cancelled' WHERE friend_mid=? AND status='earned'"
      : "UPDATE referral_rewards SET status='earned' WHERE friend_mid=? AND status='cancelled'").bind(mid).run();
  } catch (e) { /* referral tables not migrated yet */ }
  // Keep order/admin views consistent with the authoritative customer flag.
  // Pending/rejected orders are never silently turned into sales by a MID-wide
  // revoke; only an already-issued approval changes state.
  await DB.prepare(
    revoke
      ? "UPDATE orders SET status='revoked' WHERE machine_id=? AND status='approved'"
      : "UPDATE orders SET status='approved' WHERE machine_id=? AND status='revoked'"
  ).bind(mid).run();
  const canonical = canonicalLicenseKey(cust.key);
  const cacheKey = 'val:' + mid + ':' + canonical;
  let cacheDeleted = await kvDel(cacheKey);
  if (String(cust.key).toLowerCase() !== canonical) {
    cacheDeleted = (await kvDel('val:' + mid + ':' + String(cust.key))) && cacheDeleted;
  }
  // Validation also checks D1 on a positive cache hit, so a failed KV delete
  // cannot leave a revoked key usable.
  return { ok: true, mid, key: cust.key, cacheDeleted };
}

async function revokeMid(chatId, mid, revoke) {
  const result = await setCustomerRevoked(mid, revoke);
  if (!result.ok) {
    await sendText(chatId, `⚠️ Cannot ${revoke ? 'revoke' : 'restore'} <code>${String(mid).toLowerCase()}</code>: ${result.error}.`);
    return result;
  }
  const word = revoke ? '⛔' : '✅';
  await sendText(chatId, `${word} License for Machine ID <code>${result.mid}</code> ${revoke ? 'revoked' : 'restored'}.`);
  if (!result.cacheDeleted) log('warn', 'revocation_cache_delete_failed', { mid: result.mid });
  log('info', revoke ? 'mid_revoke' : 'mid_restore', { machine_id: result.mid });
  return result;
}

async function revokeOrder(chatId, orderId, revoke) {
  const o = await DB.prepare('SELECT machine_id, chat_id, status_msg_id FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await sendText(chatId, `⚠️ Order <b>#${orderId}</b> not found.`); return; }
  const result = await setCustomerRevoked(o.machine_id, revoke);
  if (!result.ok) {
    await sendText(chatId, `⚠️ No customer row for order <b>#${orderId}</b>.`);
    return;
  }
  if (!result.cacheDeleted) log('warn', 'revocation_cache_delete_failed', { orderId, machine_id: o.machine_id });

  const targetStatus = revoke ? 'revoked' : 'approved';
  await DB.prepare('UPDATE orders SET status=? WHERE id=?').bind(targetStatus, orderId).run();
  if (o.chat_id) {
    const msg = revoke
      ? '⚠️ <b>ፈቃድዎ ተሰርዟል።</b> ለእገዛ @sumpak6 ን በቴሌግራም ያግኙ።\n<i>Your license was revoked. Contact @sumpak6 on Telegram for help.</i>'
      : '✅ <b>ፈቃድዎ ተመልሷል።</b>\n<i>Your license has been restored.</i>';
    if (o.status_msg_id) {
      try { await editText(o.chat_id, o.status_msg_id, msg); } catch (e) {}
    } else {
      await sendText(o.chat_id, msg);
    }
  }
  const word = revoke ? '⛔' : '✅';
  await sendText(chatId, `${word} Order <b>#${orderId}</b> → ${targetStatus}.`);
  log('info', 'order_revoke', { orderId, machine_id: o.machine_id, revoke });
}

// ── support: find a customer, move a license, give a free key ──────────────
// Ethiopian time (UTC+3, no daylight saving) for everything the owner reads.
function eatTs(ts) {
  const d = new Date(String(ts || '').replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return shortTs(ts);
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

async function moveCount(uid, mid) {
  try {
    const r = await DB.prepare(
      "SELECT COUNT(*) AS n FROM admin_audit WHERE action='move' AND (detail LIKE ? OR detail LIKE ?)"
    ).bind('%uid:' + (uid || '-') + '%', '%' + mid + '%').first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

async function adminFind(chatId, mid) {
  const c = await DB.prepare('SELECT * FROM customers WHERE machine_id=?').bind(mid).first();
  const o = await DB.prepare(
    'SELECT * FROM orders WHERE machine_id=? ORDER BY id DESC LIMIT 1').bind(mid).first();
  const t = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id=?').bind(mid).first();
  let moved = null;
  try {
    moved = await DB.prepare(
      "SELECT ts, detail FROM admin_audit WHERE action='move' AND detail LIKE ? ORDER BY id DESC LIMIT 1"
    ).bind(mid + ' -> %').first();
  } catch (e) { /* 0020 not applied */ }
  if (!c && !o && !t) {
    await sendText(chatId,
      `🔍 Nothing found for <code>${mid}</code>.\n\n` +
      'They may have typed it wrong, or never opened the panel on this machine.',
      [[{ text: '🎁 Give a free key to this computer', callback_data: `admin:gift:${mid}` }],
       [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  const lines = [`🔍 <b>Machine</b> <code>${mid}</code>`, ''];
  if (c) {
    const kind = c.status === 'gift' ? ' · 🎁 free key' : '';
    lines.push(
      `🔑 <b>Licensed</b>${c.revoked ? ' — <b>REVOKED</b> 🚫' : ' ✅'}${kind}`,
      `Key: <code>${esc(c.key)}</code>`,
      `Expiry: ${c.expiry === '00000000' ? 'perpetual' : esc(c.expiry)}`,
      `Buyer: ${esc(c.name || 'unknown')}${c.uid ? ' · Telegram id ' + esc(c.uid) : ''}`,
      '', await activationLine(mid));
    if (moved) {
      const to = String(moved.detail).split(' -> ')[1] || '';
      lines.push('', `🔁 Moved to <code>${esc(to.split(' ')[0])}</code> on ${eatTs(moved.ts)}`);
    }
    const n = await moveCount(c.uid, mid);
    if (n) lines.push(`🔁 This buyer's license was moved ${n} time(s).`);
  } else {
    lines.push('🔑 <b>No license</b> on this machine.');
  }
  if (t) lines.push('', `🎁 Trial: ${t.used}/${t.max_free} used`);
  if (o) lines.push('', `🧾 Last order <b>#${o.id}</b> · ${o.status} · ${eatTs(o.created_at)}`);
  const kb = [];
  if (c && !c.revoked) kb.push([{ text: '🔁 Move to a new computer', callback_data: `admin:move:${mid}` }]);
  if (o) kb.push([{ text: `🧾 Open order #${o.id}`, callback_data: `admin:detail:${o.id}` }]);
  if (c && o) {
    kb.push([c.revoked
      ? { text: '♻ Restore key', callback_data: `admin:unrevoke:${o.id}` }
      : { text: '🚫 Revoke key', callback_data: `admin:revoke:${o.id}` }]);
  } else if (c) {
    kb.push([{ text: c.revoked ? '♻ Restore key' : '🚫 Revoke key', callback_data: `admin:${c.revoked ? 'unrevoke' : 'revoke'}-mid:${mid}` }]);
  }
  if (!c) kb.push([{ text: '🎁 Give a free key to this computer', callback_data: `admin:gift:${mid}` }]);
  kb.push([{ text: '🛠 Admin', callback_data: 'admin:panel' }]);
  await sendText(chatId, lines.join('\n'), kb);
}

// Was the key ever accepted on this computer? Every server-confirmed
// /api/validate (panel or SRT maker) stamps key_activations, kept 30 days.
async function activationLine(mid) {
  let a = null;
  try {
    a = await DB.prepare(
      'SELECT SUM(n) AS n, MIN(first_seen) AS first, MAX(last_seen) AS last, COUNT(DISTINCT ip) AS places FROM key_activations WHERE mid=?'
    ).bind(mid).first();
  } catch (e) { /* 0006 not applied */ }
  if (!a || !a.n) return '⏳ <b>Not activated yet</b> — the key was never entered on this computer (last 30 days).';
  return `✅ <b>Activated</b> — first ${eatTs(a.first)}, last check ${eatTs(a.last)} (Ethiopia time)\n` +
    `   ${a.n} check(s) from ${a.places} internet connection(s)`;
}

// /active MACHINE-ID | XXXX-XXXX — the short answer to "did it work for them?"
async function adminActive(chatId, arg) {
  const raw = String(arg || '').trim();
  let mid = raw.toLowerCase();
  // A dash, or letters a Machine ID never has, means an activation code.
  const code = (raw.includes('-') || !isValidMid(mid)) ? normActivationCode(raw) : null;
  if (code) {
    let ac = null;
    try { ac = await DB.prepare('SELECT * FROM activation_codes WHERE code=?').bind(code).first(); } catch (e) { /* 0019 */ }
    if (!ac) { await sendText(chatId, `🔍 No activation code <code>${code}</code>.`); return; }
    const ord = ac.order_id ? await DB.prepare('SELECT id, username FROM orders WHERE id=?').bind(ac.order_id).first() : null;
    const who = ord ? `order <b>#${ord.id}</b>${ord.username ? ' · @' + esc(ord.username) : ''}` : 'no order';
    if (!ac.redeemed_mid) {
      await sendText(chatId,
        `📱 Code <code>${code}</code> · ${who}\n\n` +
        (ac.revoked ? '🚫 <b>Revoked</b>.' :
          '⏳ <b>Not used yet</b> — not typed into any panel or SRT maker.\n' +
          '<i>CapCut / DaVinci buyers need version 1.8.13 or newer to paste it.</i>'),
        [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
      return;
    }
    mid = ac.redeemed_mid;
    await sendText(chatId,
      `📱 Code <code>${code}</code> · ${who}\nUsed on <code>${esc(mid)}</code> · ${eatTs(ac.redeemed_at)}\n\n` +
      await activationLine(mid),
      [[{ text: '🔍 Open this computer', callback_data: `admin:find:${mid}` }], [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  if (!isValidMid(mid)) {
    await sendText(chatId, '⚠️ Send a Machine ID (8 or 16 letters/numbers) or an activation code like <code>TKSL-4EYX</code>.');
    return;
  }
  const c = await DB.prepare('SELECT revoked, name FROM customers WHERE machine_id=?').bind(mid).first();
  const lic = !c ? '🔑 <b>No license</b> on this computer (free trial only).'
    : c.revoked ? '🔑 License <b>REVOKED</b> 🚫'
      : `🔑 Licensed ✅ · ${esc(c.name || 'unknown')}`;
  await sendText(chatId, `🖥 <code>${mid}</code>\n${lic}\n` + (c ? await activationLine(mid) : ''),
    [[{ text: '🔍 Open this computer', callback_data: `admin:find:${mid}` }], [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
}

// Changed computer / reinstalled Windows: the buyer's license follows them.
// The old computer's key is revoked, a key for the new Machine ID is minted
// with the same expiry, and the sale, order and referral records move along
// (revenue is unchanged — it is still one sale). The buyer gets the new key.
async function moveLicense(chatId, adminUid, oldMid, newMid) {
  oldMid = String(oldMid || '').trim().toLowerCase();
  newMid = String(newMid || '').trim().toLowerCase();
  if (!isValidMid(oldMid) || !isValidMid(newMid)) {
    await sendText(chatId, '⚠️ Both Machine IDs must be 8 or 16 letters/numbers.');
    return false;
  }
  if (oldMid === newMid) {
    await sendText(chatId, '⚠️ That is the same computer — nothing to move. If the key does not work there, check /find.');
    return false;
  }
  if (!(await requireUnlock(adminUid, chatId, null, 'Move a license'))) return false;
  const c = await DB.prepare('SELECT * FROM customers WHERE machine_id=?').bind(oldMid).first();
  if (!c) {
    await sendText(chatId, `⚠️ No license on <code>${oldMid}</code>. /find it first — maybe the buyer sent the new ID instead of the old one.`);
    return false;
  }
  if (c.revoked) {
    await sendText(chatId, `⚠️ The license on <code>${oldMid}</code> is revoked. Restore it first if the buyer should keep it.`);
    return false;
  }
  const have = await DB.prepare('SELECT revoked, name FROM customers WHERE machine_id=?').bind(newMid).first();
  if (have && !have.revoked) {
    await sendText(chatId, `⚠️ <code>${newMid}</code> already has its own license (${esc(have.name || 'unknown')}). Nothing moved.`);
    return false;
  }
  if (!(await licenseServicesReady())) {
    await sendText(chatId, '⚠️ License signing is not ready (secrets missing?) — nothing was changed.');
    return false;
  }
  const expiry = c.expiry || '00000000';
  const key = await keyFor(newMid, expiry);
  await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status, uid)
    VALUES (?,?,?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET
      key=excluded.key, name=excluded.name, expiry=excluded.expiry, status=excluded.status, uid=excluded.uid, revoked=0`)
    .bind(newMid, c.name || '', expiry, key, c.status || 'sold', c.uid || '').run();
  await DB.prepare('UPDATE customers SET revoked=1 WHERE machine_id=?').bind(oldMid).run();
  await DB.prepare('UPDATE sales SET machine_id=? WHERE machine_id=?').bind(newMid, oldMid).run();
  await DB.prepare('UPDATE orders SET machine_id=? WHERE machine_id=?').bind(newMid, oldMid).run();
  try { await DB.prepare('UPDATE referral_rewards SET friend_mid=? WHERE friend_mid=?').bind(newMid, oldMid).run(); } catch (e) {}
  const canonical = canonicalLicenseKey(c.key);
  await kvDel('val:' + oldMid + ':' + canonical);
  if (String(c.key).toLowerCase() !== canonical) await kvDel('val:' + oldMid + ':' + String(c.key));
  await audit(adminUid, 'move', `${oldMid} -> ${newMid} uid:${c.uid || '-'}`);
  log('info', 'license_moved', { from: oldMid, to: newMid });
  let told = false;
  if (c.uid) {
    const r = await sendText(c.uid,
      '🔁 <b>ፈቃድዎ ወደ አዲሱ ኮምፒውተር ተዛውሯል!</b>\n<i>Your license has moved to your new computer.</i>\n\n' +
      `<code>${esc(key)}</code>\n\n` +
      '<b>①</b> ቁልፉን ይንኩት — ይቀዳል · <i>tap the key to copy it</i>\n' +
      '<b>②</b> በአዲሱ ኮምፒውተር ፓነሉን ይክፈቱ፣ <b>«የፈቃድ ቁልፍ»</b> ላይ ይለጥፉ · <i>on the new computer, paste it into “License key”</i>\n' +
      '<b>③</b> <b>«አግብር»</b> ይጫኑ · <i>press Activate</i>\n\n' +
      '<i>የቀድሞው ኮምፒውተር ቁልፍ ከእንግዲህ አይሰራም። The old computer\'s key no longer works.</i>');
    told = !!(r && r.ok);
  }
  const n = await moveCount(c.uid, newMid);
  await sendText(chatId,
    `✅ <b>License moved</b>\n<code>${oldMid}</code> → <code>${newMid}</code>\n\n` +
    `New key: <code>${esc(key)}</code>\n` +
    (told ? '📨 The buyer got the new key in the bot.' : '⚠️ Could not message the buyer — copy the key above and send it to them.') +
    (n > 2 ? `\n\n⚠️ This license has now been moved <b>${n}</b> times — if that seems a lot, it may be being shared.` : ''),
    [[{ text: '🔍 Open the new computer', callback_data: `admin:find:${newMid}` }],
     [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
  return true;
}

// A free license (partner, tester, reviewer, a friend helping with videos).
// Status 'gift': never counted as a sale or as revenue; revocable like any key.
async function giveKey(chatId, adminUid, mid, name) {
  mid = String(mid || '').trim().toLowerCase();
  if (!isValidMid(mid)) {
    await sendText(chatId, '⚠️ A Machine ID is 8 or 16 letters/numbers — they copy it from the bottom of the panel.');
    return false;
  }
  if (!(await requireUnlock(adminUid, chatId, null, 'Give a free key'))) return false;
  const have = await DB.prepare('SELECT key, revoked, status FROM customers WHERE machine_id=?').bind(mid).first();
  if (have && !have.revoked) {
    await sendText(chatId, `ℹ️ <code>${mid}</code> already has a license (${esc(have.status)}):\n<code>${esc(have.key)}</code>`);
    return false;
  }
  if (!(await licenseServicesReady())) {
    await sendText(chatId, '⚠️ License signing is not ready (secrets missing?) — no key was made.');
    return false;
  }
  const key = await keyFor(mid, '00000000');
  const who = String(name || '').trim().slice(0, 60) || 'free key';
  await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status, uid)
    VALUES (?,?,'00000000',?,'gift','') ON CONFLICT(machine_id) DO UPDATE SET
      key=excluded.key, name=excluded.name, expiry='00000000', status='gift', uid='', revoked=0`)
    .bind(mid, who, key).run();
  await audit(adminUid, 'givekey', `${mid} ${who}`);
  log('info', 'gift_key', { mid });
  await sendText(chatId,
    `🎁 <b>Free key for ${esc(who)}</b> · <code>${mid}</code>\n\n` +
    `<code>${esc(key)}</code>\n\n` +
    'Tap the key to copy it and send it to them: panel → «የፈቃድ ቁልፍ» → paste → «አግብር».\n' +
    '<i>Not counted as a sale. Revoke any time from /find.</i>',
    [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
  return true;
}

async function adminHelp(chatId) {
  await sendText(chatId,
    '📖 <b>Admin commands</b>\n\n' +
    '<b>Customers</b>\n' +
    '<code>/find MACHINE-ID</code> — everything about a computer, with buttons\n' +
    '<code>/move OLD-ID NEW-ID</code> — new computer / reinstalled Windows\n' +
    '<code>/givekey MACHINE-ID name</code> — free key (not a sale)\n' +
    '<code>/active MACHINE-ID</code> or <code>/active CODE</code> — did the customer activate?\n' +
    '<code>/funnel</code> or <code>/funnel 30</code> — what happens in the program before people buy\n' +
    '<code>/revoke-mid ID</code> · <code>/unrevoke-mid ID</code> — kill / restore a key\n' +
    '<code>/revoke ORDER</code> · <code>/unrevoke ORDER</code> — same, by order number\n' +
    '<code>/setexpiry ORDER YYYYMMDD</code> — time-limited key (before approving)\n\n' +
    '<b>Partners</b>\n' +
    '<code>/partner CODE name</code> — new partner · <code>/partners</code> — list\n' +
    '<code>/partnerterms CODE reward discount</code> — their amounts\n' +
    '<code>/partnerinfo CODE</code> · <code>/pmsg CODE text</code>\n\n' +
    '<b>Group</b>\n' +
    '<code>/topics</code> — the support group\'s forum topics, and which ones the bot has seen\n\n' +
    '<b>Security</b>\n' +
    '<code>/unlock PIN</code> · <code>/lock</code> · <code>/audit</code>\n\n' +
    '<i>Buyers see the normal /help — you get this one because you are the admin.</i>',
    [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
}

// ── anti-piracy: which COMPUTERS use a key ───────────────────────────────────
// A key only validates against the machine_id embedded in it, so sharing
// means copying the license + machine record to another PC. That PC sends a
// different computer fingerprint (`hf`: sha256 of username|home|platform, 8
// hex) — whatever the network. Source IPs are NOT a share signal here:
// Ethio Telecom gives one computer a new address all the time, and the old
// 3-IP rule refused the owner's own key and two customers (2026-10-07).
//   SHARE_ALERT_HOSTS (2) computers in 30 days -> one admin alert per key/day
//   SHARE_HOSTS (3) computers in 30 days + AMH_BLOCK_SHARED=1 -> refused
// Clients that send no fingerprint (panels before 1.10.1) are never refused.
// IPs are still stamped in key_activations, for support only (/find).
function validHostFp(hf) {
  return typeof hf === 'string' && /^[0-9a-f]{8}$/.test(hf);
}

async function recordKeyActivation(key, mid, ip, hf) {
  try {
    await DB.prepare(
      `INSERT INTO key_activations (key, ip, mid) VALUES (?, ?, ?)
       ON CONFLICT(key, ip) DO UPDATE SET
         n = n + 1, mid = excluded.mid, last_seen = datetime('now')`
    ).bind(key, ip, mid).run();
    if (!validHostFp(hf)) return true;
    await DB.prepare(
      `INSERT INTO key_hosts (key, hf, mid) VALUES (?, ?, ?)
       ON CONFLICT(key, hf) DO UPDATE SET
         n = n + 1, mid = excluded.mid, last_seen = datetime('now')`
    ).bind(key, hf, mid).run();
    const row = await DB.prepare(
      "SELECT COUNT(*) AS n FROM key_hosts WHERE key = ? AND last_seen >= datetime('now', '-30 days')"
    ).bind(key).first();
    const hosts = row ? row.n : 1;
    if (hosts >= SHARE_ALERT_HOSTS) {
      log('warn', 'key_shared_hosts', { key: key.slice(0, 12) + '…', mid, hosts });
      await alertKeySpread(key, mid, ip, hosts);
    }
    if (BLOCK_SHARED && hosts >= SHARE_HOSTS) {
      // Only a computer this key has NOT been used on before is refused; the
      // first ones (the buyer's) keep working.
      // (insertion order: first_seen only has 1-second precision)
      const older = await DB.prepare(
        "SELECT COUNT(*) AS n FROM key_hosts WHERE key = ? AND last_seen >= datetime('now', '-30 days') " +
        "AND rowid < (SELECT rowid FROM key_hosts WHERE key = ? AND hf = ?)"
      ).bind(key, key, hf).first();
      if ((older ? older.n : 0) >= SHARE_HOSTS - 1) return false;
    }
  } catch (e) {
    // Telemetry must never break the money path.
    log('error', 'key_activation_record_failed', { err: String((e && e.message) || e) });
  }
  return true;
}

async function alertKeySpread(key, mid, ip, hosts) {
  const seen = await kvGet('alert:keyspread:' + key);
  if (seen) return;
  await kvPut('alert:keyspread:' + key, '1', 86400);
  const text =
    '🚨 <b>License on more than one computer</b>\n\n' +
    `Machine <code>${mid}</code>: its key was used on <b>${hosts}</b> different computers in 30 days.\n\n` +
    'One buyer who reinstalled Windows or made a new user account shows 2. Three or more usually means the license files were copied to friends. ' +
    `Check with /find ${mid}` + (BLOCK_SHARED ? '' : ' (nothing is blocked: AMH_BLOCK_SHARED is off).');
  for (const adm of adminUids()) { await sendText(adm, text); await sleep(90); }
}

// ── anti-trial-abuse: fresh-machine flood per IP ─────────────────────────────
// /api/trial/use referencing a mid never seen in D1 trials is "fresh" — the
// classic clearing-localStorage reset. Cap fresh mids per IP per 24h
// (AMH_FRESH_MID_DAY, default 5).
async function recordFreshTrialUse(ip, mid) {
  const existing = await DB.prepare('SELECT 1 FROM trials WHERE machine_id = ?').bind(mid).first();
  if (existing) return 0;
  // Per-IP daily counter in SQL — atomic increment (a KV read-then-write
  // could double count under eventual consistency).
  const bucket = 'fresh:' + new Date().toISOString().slice(0, 10);
  await DB.prepare(
    `INSERT INTO ip_counters (ip, bucket, n) VALUES (?, ?, 1)
     ON CONFLICT(ip, bucket) DO UPDATE SET n = n + 1, updated_at = datetime('now')`
  ).bind(ip, bucket).run();
  const row = await DB.prepare('SELECT n FROM ip_counters WHERE ip = ? AND bucket = ?').bind(ip, bucket).first();
  const n = row ? row.n : 1;
  if (n > FRESH_MID_LIMIT && !(await kvGet('alert:fresh:' + ip + ':' + bucket))) {
    await kvPut('alert:fresh:' + ip + ':' + bucket, '1', 86400);
    log('warn', 'trial_fresh_flood', { ip, fresh: n });
  }
  return n;
}

async function adminDetail(chatId, messageId, cbId, orderId) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await answerCb(cbId, 'Order not found'); return; }
  const cap =
    `🧾 <b>Order #${o.id} · ${o.status.toUpperCase()}</b>\n\n` +
    `${orderSummary(o)}\n` +
    `UID: <code>${o.uid}</code>\n` +
    (isCodePlaceholder(o.machine_id) ? `${esc(midLabel(o.machine_id))}\n` : `Machine ID: <code>${esc(o.machine_id)}</code>\n`) +
    `Amount: ${o.amount_etb ? `ETB ${money(o.amount_etb)}` : esc(PRICE)}` +
    (o.referrer_uid ? ` (👥 referred · discount ${money(o.discount_etb || 0)} · reward ${money(o.reward_etb || 0)})` : '') + '\n' +
    `Expiry: ${o.expiry === '00000000' ? 'perpetual' : esc(o.expiry)}\n` +
    `Received: ${shortTs(o.created_at)}` +
    (o.proof_flag ? `\n\n${esc(o.proof_flag)}` : '');
  // A decided order used to offer NO actions at all — so an order approved to
  // the wrong person, or declined by mistake, could not be corrected through
  // the interface. revokeOrder() already existed and was reachable only by
  // typing "/revoke 42" from memory; it is a button now.
  let actions;
  if (o.status === 'pending') {
    actions = [
      { text: '✅ Approve', callback_data: `approve:${o.id}` },
      { text: '❌ Decline', callback_data: `reject:${o.id}` },
    ];
  } else if (o.status === 'approved') {
    // Kills the key on the next panel check (revokeOrder busts the KV cache).
    actions = [];
    if (o.delivery_status === 'pending' || o.delivery_status === 'failed' || o.delivery_status === 'sending') {
      actions.push({ text: '📨 Retry key delivery', callback_data: `admin:retry-delivery:${o.id}` });
    }
    actions.push({ text: '🚫 Revoke key', callback_data: `admin:revoke:${o.id}` });
  } else if (o.status === 'revoked') {
    actions = [{ text: '♻ Restore key', callback_data: `admin:unrevoke:${o.id}` }];
  } else if (o.status === 'rejected') {
    // Declined by mistake, or the buyer sorted out whatever was wrong — approve
    // without making them resubmit everything.
    actions = [{ text: '✅ Approve anyway', callback_data: `approve:${o.id}` }];
  } else {
    actions = [];
  }
  const kb = [
    ...(actions.length ? [actions] : []),
    [{ text: '🧾 History', callback_data: 'admin:history' },
     { text: '🛠 Admin', callback_data: 'admin:panel' }],
  ];
  await answerCb(cbId, '');
  if (o.photo_key) await sendPhoto(chatId, o.photo_key, cap, kb);
  else await sendText(chatId, cap, kb);
}

const HISTORY_PAGE = 8;

// History is browsable, not a dead list. It used to print 25 orders as plain
// text with no button on any of them, "+N more" for the rest, and a footer
// telling the admin to "tap any order in the queue" — but the queue only holds
// PENDING orders, so anything already decided was unreachable through the
// interface at all.
async function adminHistory(chatId, messageId, cbId, offset = 0) {
  await pruneOld();
  const totalRow = await DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE created_at >= datetime('now','-30 days')").first();
  const total = totalRow ? totalRow.n : 0;
  if (!total) {
    await editText(chatId, messageId,
      '🧾 <b>No orders in the last 30 days.</b>',
      [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }

  const sums = await DB.prepare(
    "SELECT COALESCE(SUM(status='approved'),0) AS ap, " +
    "COALESCE(SUM(status='rejected'),0) AS rj, " +
    "COALESCE(SUM(status='pending'),0) AS pd, " +
    "COALESCE(SUM(status='revoked'),0) AS rv, " +
    "COALESCE(SUM(CASE WHEN status='approved' THEN (CASE WHEN amount_etb > 0 THEN amount_etb ELSE ? END) ELSE 0 END),0) AS revenue " +
    "FROM orders WHERE created_at >= datetime('now','-30 days')"
  ).bind(PRICE_ETB).first();
  const revenue = sums.revenue || 0;

  const { results } = await DB.prepare(
    "SELECT * FROM orders WHERE created_at >= datetime('now','-30 days') " +
    "ORDER BY id DESC LIMIT ? OFFSET ?").bind(HISTORY_PAGE, offset).all();

  const statusEmoji = { approved: '✅', rejected: '❌', pending: '📥', revoked: '🚫' };
  const lines = results.map((o) =>
    `${statusEmoji[o.status] || '·'} <b>#${o.id}</b> · ${o.username ? '@' + esc(o.username) : 'anon'} · ` +
    `${isCodePlaceholder(o.machine_id) ? '📱' : `<code>${esc(o.machine_id)}</code>`} · ETB ${money(o.amount_etb || PRICE_ETB)} · ${shortTs(o.created_at)}`
  ).join('\n');

  const from = offset + 1;
  const to = offset + results.length;
  const text =
    '🧾 <b>History · last 30 days</b>\n\n' +
    `✅ ${sums.ap} approved · ❌ ${sums.rj} declined · 📥 ${sums.pd} pending` +
    `${sums.rv ? ` · 🚫 ${sums.rv} revoked` : ''}\n` +
    `💵 Revenue: <b>ETB ${money(revenue)}</b>\n\n` +
    `${lines}\n\n` +
    `Showing <b>${from}–${to}</b> of <b>${total}</b> · tap an order below to open it.`;

  // One button per order — this is the part that was missing.
  const kb = results.map((o) => ([{
    text: `${statusEmoji[o.status] || '·'} #${o.id} · ${isCodePlaceholder(o.machine_id) ? '📱 phone order' : o.machine_id}`,
    callback_data: `admin:detail:${o.id}`,
  }]));
  const nav = [];
  if (offset > 0) nav.push({ text: '◀ Newer', callback_data: 'admin:histp:' + Math.max(0, offset - HISTORY_PAGE) });
  if (to < total) nav.push({ text: 'Older ▶', callback_data: 'admin:histp:' + (offset + HISTORY_PAGE) });
  if (nav.length) kb.push(nav);
  kb.push([
    { text: '📥 Requests', callback_data: 'admin:queue' },
    { text: '🛠 Admin', callback_data: 'admin:panel' },
  ]);

  if (cbId) await answerCb(cbId, `${total} in 30 days`);
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}


async function adminSales(chatId, messageId) {
  // Money comes from the permanent sales ledger, so it is really all-time.
  const all = await DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount_etb), 0) AS etb FROM sales WHERE status='sold'").first();
  const revoked = await DB.prepare("SELECT COUNT(*) AS n FROM sales WHERE status='revoked'").first();
  const months = (await DB.prepare(
    "SELECT strftime('%Y-%m', sold_at) AS m, COUNT(*) AS n, SUM(amount_etb) AS etb " +
    "FROM sales WHERE status='sold' GROUP BY m ORDER BY m DESC LIMIT 6").all()).results || [];
  const counts = {};
  const events = ['proof_start', 'mid_sent', 'screenshot_sent', 'order_confirmed', 'approved', 'rejected'];
  for (const ev of events) {
    const r = await DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM funnel WHERE event=?').bind(ev).first();
    counts[ev] = r ? r.n : 0;
  }
  const pct = (a, b) => (a ? Math.round(100 * b / a) + '%' : '–');
  const started = counts.proof_start;
  let refLine = '';
  try {
    const rr = await DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount_etb ELSE 0 END),0) AS paid, " +
      "COALESCE(SUM(CASE WHEN status='earned' THEN amount_etb ELSE 0 END),0) AS owed, " +
      "COALESCE(SUM(CASE WHEN status IN ('earned','paid') THEN 1 ELSE 0 END),0) AS n FROM referral_rewards").first();
    if (rr && rr.n) refLine = `\n🎁 Referral sales: ${rr.n} · rewards paid ETB ${money(rr.paid)} · owed ETB ${money(rr.owed)}`;
  } catch (e) { /* referral tables not migrated yet */ }
  const monthLines = months.length
    ? months.map((r) => `   ${r.m}: ${r.n} · ETB ${money(r.etb || 0)}`).join('\n')
    : '   (no sales yet)';
  const text =
    '📈 <b>Sales &amp; Funnel</b>\n\n' +
    `💵 <b>All time:</b> ${all ? all.n : 0} sale(s) = <b>ETB ${money(all ? all.etb : 0)}</b>` +
    `${revoked && revoked.n ? `\n🚫 Revoked / refunded: ${revoked.n}` : ''}${refLine}\n\n` +
    '<b>By month:</b>\n' + monthLines + '\n\n' +
    '<b>Funnel — last 30 days:</b>\n' +
    `🟦 Started: ${started}\n` +
    `🟩 Machine ID: ${counts.mid_sent} (${pct(started, counts.mid_sent)} of started)\n` +
    `🟨 Screenshot: ${counts.screenshot_sent} (${pct(counts.mid_sent, counts.screenshot_sent)} of mid)\n` +
    `🟧 Confirmed: ${counts.order_confirmed} (${pct(counts.screenshot_sent, counts.order_confirmed)} of screenshot)\n` +
    `🟥 Approved: ${counts.approved} (${pct(counts.order_confirmed, counts.approved)} of confirmed)\n\n` +
    '<i>The biggest drop-off step = your sales opportunity.</i>';
  const kb = [
    [{ text: '📄 Sales list', callback_data: 'admin:sales-export' }],
    [{ text: '🧭 In the program (before buying)', callback_data: 'admin:usage:7' }],
    [{ text: '🛠 Admin', callback_data: 'admin:panel' }],
  ];
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

// ── 🧭 In the program: what happens before anyone buys ─────────────────────
// Anonymous daily counts the panel / desktop app send (/api/event, migration
// 0025): each step at most once per computer per day, no Machine ID or IP.
// Only Ethiopia is shown by default — GitHub's test Macs open the product
// abroad on every release check.
const EVENT_NAMES = new Set([
  'open', 'model_needed', 'model_dl_start', 'model_dl_ok', 'model_dl_fail',
  'run_click', 'blocked_model', 'blocked_trial', 'blocked_runtime', 'run_ok', 'placed',
  'buy_click', 'activate_ok', 'activate_fail',
  'err_av_blocked', 'err_too_short', 'err_no_speech', 'err_no_clips', 'err_no_clip', 'err_no_media',
  'err_media_unreadable', 'err_disk_full', 'err_engine', 'err_runtime', 'err_other',
]);
const ERROR_LABELS = {
  err_no_clip: 'no clip selected', err_no_clips: 'no clips in range', err_no_media: 'item has no media file',
  err_media_unreadable: 'media file unreadable', err_no_speech: 'no speech found', err_too_short: 'clip too short',
  err_engine: 'engine stopped', err_runtime: 'runtime missing', err_av_blocked: 'antivirus blocked',
  err_disk_full: 'disk full', err_other: 'other',
};

async function usageCounts(days, cc) {
  const where = "day >= date('now', ?) " + (cc ? 'AND cc = ?' : "AND cc != 'ET'");
  const binds = cc ? ['-' + (days - 1) + ' days', cc] : ['-' + (days - 1) + ' days'];
  const { results } = await DB.prepare(
    `SELECT e, host, SUM(n) AS n FROM events_daily WHERE ${where} GROUP BY e, host`).bind(...binds).all();
  const by = {}, hosts = {};
  for (const r of results || []) {
    by[r.e] = (by[r.e] || 0) + r.n;
    if (r.e === 'open') hosts[r.host] = (hosts[r.host] || 0) + r.n;
  }
  return { by, hosts };
}

async function adminUsage(chatId, messageId, days = 7) {
  days = days === 30 ? 30 : 7;
  let et, other;
  try {
    et = await usageCounts(days, 'ET');
    other = await usageCounts(days, null);
  } catch (e) {
    await sendText(chatId, 'ℹ️ No program steps yet — run <code>npm run migrate</code> (0025) and update the panel to 1.10.2+.');
    return;
  }
  const c = (k) => et.by[k] || 0;
  const pct = (a, b) => (a ? Math.round(100 * b / a) + '%' : '–');
  const errs = Object.keys(ERROR_LABELS)
    .filter((k) => c(k))
    .sort((a, b) => c(b) - c(a))
    .map((k) => `   • ${ERROR_LABELS[k]}: ${c(k)}`);
  const hostLine = Object.keys(et.hosts).length
    ? ' (' + Object.entries(et.hosts).map(([h, n]) => ({ PPRO: 'Premiere', AEFT: 'After Effects', APP: 'CapCut/DaVinci app' }[h] || h) + ' ' + n).join(' · ') + ')'
    : '';
  const otherOpen = other.by.open || 0;
  const text =
    `🧭 <b>In the program — last ${days} days</b> · Ethiopia\n` +
    '<i>Each computer counts once per day per step.</i>\n\n' +
    `💻 Opened: <b>${c('open')}</b>${hostLine}\n` +
    (c('model_needed')
      ? `📦 Needed the model download: ${c('model_needed')}\n` +
        `   ├ started: ${c('model_dl_start')}\n` +
        `   ├ ✅ finished: ${c('model_dl_ok')}\n` +
        `   └ ❌ failed: ${c('model_dl_fail')}\n`
      : '') +
    `▶️ Pressed “Make captions”: <b>${c('run_click')}</b> (${pct(c('open'), c('run_click'))} of opened)\n` +
    ((c('blocked_model') + c('blocked_trial') + c('blocked_runtime'))
      ? `⛔ Stopped before starting: no model ${c('blocked_model')} · trial used up ${c('blocked_trial')} · runtime ${c('blocked_runtime')}\n`
      : '') +
    (errs.length ? '❌ Errors:\n' + errs.join('\n') + '\n' : '') +
    `✅ Captions made: <b>${c('run_ok')}</b> (${pct(c('run_click'), c('run_ok'))} of pressed)\n` +
    `🎬 Placed / saved: ${c('placed')}\n` +
    `💳 Pressed Buy: ${c('buy_click')} · 🔑 Activated: ${c('activate_ok')}` +
    (c('activate_fail') ? ` · activation failed: ${c('activate_fail')}` : '') + '\n\n' +
    `<i>Outside Ethiopia (mostly our test machines): opened ${otherOpen}.</i>`;
  const kb = [
    [{ text: days === 7 ? '📅 Last 30 days' : '📅 Last 7 days', callback_data: 'admin:usage:' + (days === 7 ? 30 : 7) }],
    [{ text: '📈 Sales & funnel', callback_data: 'admin:sales' }, { text: '🛠 Admin', callback_data: 'admin:panel' }],
  ];
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

// Computers that used the free trial but never got a license — the people
// most likely to buy. Newest activity first; when the same Machine ID also
// opened Pay / ordered in the bot, the Telegram account is linked.
const TRIALS_PAGE = 10;
async function adminTrials(chatId, messageId, offset = 0) {
  const notLicensed = 't.used > 0 AND lower(t.machine_id) NOT IN (SELECT lower(machine_id) FROM customers)';
  const tot = await DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.used >= t.max_free THEN 1 ELSE 0 END), 0) AS done ` +
    `FROM trials t WHERE ${notLicensed}`).first();
  const total = tot ? tot.n : 0;
  const { results } = await DB.prepare(
    'SELECT t.machine_id AS mid, t.used, t.max_free, t.created_at, ' +
    '(SELECT MAX(used_at) FROM trial_uses u WHERE u.machine_id = t.machine_id) AS last_at, ' +
    'COALESCE((SELECT uid FROM orders o WHERE lower(o.machine_id) = lower(t.machine_id) ORDER BY o.id DESC LIMIT 1), ' +
    '         (SELECT uid FROM fsm f WHERE lower(f.mid) = lower(t.machine_id) LIMIT 1)) AS uid, ' +
    '(SELECT status FROM orders o WHERE lower(o.machine_id) = lower(t.machine_id) ORDER BY o.id DESC LIMIT 1) AS ostatus ' +
    `FROM trials t WHERE ${notLicensed} ` +
    'ORDER BY COALESCE((SELECT MAX(used_at) FROM trial_uses u WHERE u.machine_id = t.machine_id), t.created_at) DESC ' +
    'LIMIT ? OFFSET ?').bind(TRIALS_PAGE, offset).all();
  const rows = results || [];
  const linked = rows.filter((r) => r.uid).length;
  const lines = rows.map((r, i) => {
    const who = r.uid
      ? `\n   👤 <a href="tg://user?id=${esc(r.uid)}">Telegram ${esc(r.uid)}</a>` +
        (r.ostatus ? ` · order ${esc(r.ostatus)}` : ' · opened Pay')
      : '';
    return `${offset + i + 1}. <code>${esc(r.mid)}</code> · ${r.used}/${r.max_free} free · ${eatTs(r.last_at || r.created_at)}${who}`;
  });
  const text =
    '🎁 <b>Trial users — not licensed</b>\n\n' +
    `💻 Tried the free captions: <b>${total}</b> computer(s)\n` +
    `   ├ Used both free captions: ${tot ? tot.done : 0}\n` +
    `   └ Still have a free caption left: ${total - (tot ? tot.done : 0)}\n\n` +
    (lines.length ? lines.join('\n') : '<i>No one yet — trial users show up here after their first free caption.</i>') +
    (linked ? '\n\n<i>👤 = also opened the bot; tap to message them.</i>' : '') +
    '\n<i>Times are Ethiopian time. Machine IDs without 👤 never opened the bot.</i>';
  const kb = [];
  if (offset + TRIALS_PAGE < total) kb.push([{ text: '⬇ Load more', callback_data: `admin:trials:${offset + TRIALS_PAGE}` }]);
  kb.push([{ text: '🛠 Admin', callback_data: 'admin:panel' }]);
  if (messageId && !offset) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

// Every sale ever recorded, for bookkeeping: order | date | Machine ID | ETB | status.
async function adminSalesExport(chatId, cbId) {
  const { results } = await DB.prepare(
    'SELECT order_id, sold_at, machine_id, amount_etb, status FROM sales ORDER BY order_id').all();
  if (!results.length) { await answerCb(cbId, 'No sales yet'); return; }
  const lines = results.map((r) =>
    esc(`${r.order_id}\t${String(r.sold_at).slice(0, 10)}\t${r.machine_id}\t${r.amount_etb}\t${r.status}`));
  let chunk = `📄 <b>Sales (${results.length})</b>\n\n<pre>order\tdate\tmachine\tETB\tstatus\n`;
  let count = 0;
  let sent = 0;
  for (const line of lines) {
    if (count && chunk.length + line.length + 1 > 3500) {
      const r = await sendText(chatId, chunk + '</pre>');
      if (r && r.ok) sent += count;
      chunk = '<pre>';
      count = 0;
    }
    chunk += line + '\n';
    count += 1;
  }
  const r = await sendText(chatId, chunk + '</pre>');
  if (r && r.ok) sent += count;
  await answerCb(cbId, sent === results.length ? `${sent} sales` : `sent ${sent}/${results.length}`);
}

// ── approve / reject (admin callbacks) ─────────────────────────────────────
async function approve(chatId, messageId, orderId, cbId) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await answerCb(cbId, 'Order not found.'); return; }
  if (!(await licenseServicesReady())) {
    await answerCb(cbId, 'License service is not ready; order was not changed.');
    log('error', 'approval_blocked_unready', { orderId });
    return;
  }

  // Paid from the phone (no Machine ID yet): approval issues an activation code.
  const codeOrder = isCodePlaceholder(o.machine_id);
  let customer = codeOrder ? null
    : await DB.prepare('SELECT key, expiry FROM customers WHERE machine_id=?').bind(o.machine_id).first();
  let key = customer && customer.key;
  let issuedNow = false;

  // A completed delivery is idempotent: a duplicate Telegram callback must not
  // send a second copy of the key. Failed deliveries remain retryable.
  if (o.status === 'approved' && o.delivery_status === 'delivered') {
    await answerCb(cbId, 'Already delivered');
    return;
  }

  if (!codeOrder && (!customer || !key)) {
    try {
      key = await keyFor(o.machine_id, o.expiry);
    } catch (e) {
      log('error', 'key_generation_failed', { orderId, err: String(e && e.message || e) });
      await answerCb(cbId, 'Could not generate key; order remains pending.');
      return;
    }
  }

  // Claim only pending/rejected orders. An already-approved order with a
  // missing customer row is repaired below, which covers a crash between the
  // status update and the D1 upsert.
  if (o.status !== 'approved') {
    const claim = await DB.prepare(
      `UPDATE orders
       SET status='approved', key_issued_at=COALESCE(key_issued_at, datetime('now')),
           delivery_status=CASE WHEN delivery_status='delivered' THEN 'delivered' ELSE 'pending' END
       WHERE id=? AND status IN ('pending','rejected')`
    ).bind(orderId).run();
    if (!claim || !claim.meta || claim.meta.changes < 1) {
      await answerCb(cbId, 'Already handled');
      return;
    }
    issuedNow = true;
    await kvDel('pending:count');
  } else if (!o.key_issued_at) {
    issuedNow = true;
  }

  if (codeOrder) {
    // The code IS the placeholder's suffix, so it is stable across retries.
    key = placeholderCode(o.machine_id);
    try {
      await DB.prepare(
        'INSERT OR IGNORE INTO activation_codes (code, order_id, uid, expiry) VALUES (?, ?, ?, ?)'
      ).bind(key, o.id, o.uid || '', o.expiry || '00000000').run();
      await DB.prepare('UPDATE activation_codes SET revoked=0 WHERE code=?').bind(key).run();
    } catch (e) {
      log('error', 'activation_code_failed', { orderId, err: String((e && e.message) || e) });
      await DB.prepare("UPDATE orders SET status='pending' WHERE id=? AND status='approved'").bind(orderId).run();
      await answerCb(cbId, 'Run npm run migrate (0019) first — order kept pending.');
      return;
    }
    if (issuedNow && !o.key_issued_at) await addFunnel(o.uid, 'approved');
  }
  // Record/repair the customer before attempting delivery. If Telegram is down,
  // the key remains available for a later redelivery instead of being lost.
  if (!codeOrder && (!customer || !customer.key || issuedNow)) {
    await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status, uid)
      VALUES (?,?,?,?, 'sold', ?) ON CONFLICT(machine_id) DO UPDATE SET
        key=excluded.key, name=excluded.name, expiry=excluded.expiry,
        status='sold', uid=excluded.uid`)
      .bind(o.machine_id, '@' + (o.username || 'anon'), o.expiry, key, o.uid || '').run();
    await DB.prepare(
      `UPDATE orders SET key_issued_at=COALESCE(key_issued_at, datetime('now')),
       delivery_status=CASE WHEN delivery_status='delivered' THEN 'delivered' ELSE 'pending' END
       WHERE id=?`
    ).bind(orderId).run();
    if (issuedNow && !o.key_issued_at) await addFunnel(o.uid, 'approved');
  }
  // Permanent sales record (orders are pruned after 30 days). INSERT OR IGNORE
  // keeps it one row per order however many times approve is retried.
  await DB.prepare(
    "INSERT OR IGNORE INTO sales (order_id, machine_id, amount_etb, status) VALUES (?, ?, ?, 'sold')"
  ).bind(o.id, o.machine_id, o.amount_etb > 0 ? o.amount_etb : PRICE_ETB).run();

  // Referred order: one reward for the referrer (terms locked on the order).
  let rewardNew = false;
  if (o.referrer_uid && o.reward_etb > 0) {
    try {
      const rw = await DB.prepare(
        'INSERT OR IGNORE INTO referral_rewards (order_id, referrer_uid, friend_uid, friend_mid, amount_etb) VALUES (?, ?, ?, ?, ?)'
      ).bind(o.id, o.referrer_uid, o.uid, o.machine_id, o.reward_etb).run();
      rewardNew = !!(rw && rw.meta && rw.meta.changes);
    } catch (e) {
      log('error', 'referral_reward_failed', { orderId, err: String((e && e.message) || e) });
    }
  }

  // Claim the delivery itself, not just the order status. A second admin tap
  // or Telegram retry cannot send the bearer key concurrently. A crashed send
  // becomes retryable after the five-minute lease.
  const deliveryClaim = await DB.prepare(
    `UPDATE orders
     SET delivery_status='sending', delivery_lease_until=datetime('now','+5 minutes')
     WHERE id=? AND status='approved'
       AND (
         delivery_status IN ('pending','failed')
         OR (delivery_status='sending'
             AND (delivery_lease_until IS NULL OR delivery_lease_until='' OR delivery_lease_until < datetime('now')))
       )
       AND (delivery_lease_until IS NULL OR delivery_lease_until='' OR delivery_lease_until < datetime('now'))`
  ).bind(orderId).run();
  if (!deliveryClaim || !deliveryClaim.meta || deliveryClaim.meta.changes < 1) {
    await answerCb(cbId, 'Delivery is already in progress.');
    return;
  }
  await DB.prepare(
    'UPDATE orders SET delivery_attempts=COALESCE(delivery_attempts, 0)+1 WHERE id=?'
  ).bind(orderId).run();
  const delivery = codeOrder
    ? await sendText(o.uid, activationCodeMessage(key),
      [[{ text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` }]])
    : await sendText(o.uid, keyDeliveryMessage(key, o.expiry, 'private', !!o.nonce));
  const delivered = !!(delivery && delivery.ok);
  await DB.prepare(
    delivered
      ? "UPDATE orders SET delivery_status='delivered', delivered_at=datetime('now'), delivery_lease_until=NULL WHERE id=?"
      : "UPDATE orders SET delivery_status='failed', delivery_lease_until=NULL WHERE id=?"
  ).bind(orderId).run();

  const buyerStatusMsg = o.status_msg_id;
  const what = codeOrder
    ? { am: 'የማግበሪያ ኮድዎ', en: 'your activation code' }
    : { am: 'ቁልፍዎ', en: 'your key' };
  if (buyerStatusMsg) {
    await editText(o.chat_id || o.uid, buyerStatusMsg, delivered
      ? (`✅ <b>ትዕዛዝዎ ተረጋግጧል — ${what.am} ከታች ባለው መልዕክት ነው።</b>\n` +
         `<i>Order approved — ${what.en} is in the message below.</i>` +
         (codeOrder ? '' : `\n\n🖥 <code>${esc(o.machine_id)}</code>`))
      : (`⚠️ <b>ትዕዛዝዎ ተረጋግጧል፣ ግን ${what.am}ን መላክ አልተሳካም።</b> በቅርቡ እንደገና እንልካለን።\n` +
         `<i>Order approved, but sending ${what.en} failed. We will send it again shortly.</i>`));
  }

  // The key has already gone out — this never withholds what they paid for.
  // It only checks, and if they are not in the group yet, offers the jobs feed
  // once, at the point of highest intent, with a one-tap way to confirm.
  if (delivered) await nudgeGroupJoin(o.uid);

  const left = await pendingCount();
  const sentWhat = codeOrder ? `activation code <code>${esc(key)}</code>` : 'key';
  await editText(chatId, messageId, delivered
    ? (`✅ <b>Approved #${orderId}</b> — ${sentWhat} delivered and logged.\n` +
       `${esc(midLabel(o.machine_id))} · @${esc(o.username)} · DM: ✅\n` +
       `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`)
    : (`⚠️ <b>Approved #${orderId}</b> — ${sentWhat} stored, delivery failed.\n` +
       `${esc(midLabel(o.machine_id))}\n` +
       `Retry approval to send it again.`));
  await answerCb(cbId, delivered ? '✅ Approved & key sent' : '⚠️ Approved; delivery failed — retry');

  const rewardTo = rewardNew ? await recipientOf(o.referrer_uid) : null;
  if (rewardNew && !rewardTo) {
    for (const adm of adminUids()) {
      await sendText(adm,
        `🤝 Sale #${o.id} credited to <b>${esc(String(o.referrer_uid).slice('partner:'.length))}</b> ` +
        `(${money(o.reward_etb)} ብር) — the partner has not connected yet. Send them the private link: /partners → 📨 Links.`);
    }
  }
  if (rewardNew && rewardTo) {
    const t = refTerms(await getSettings());
    const acct = await DB.prepare('SELECT 1 AS x FROM payout_accounts WHERE uid = ?').bind(rewardTo).first();
    await sendText(rewardTo,
      `🎉 <b>በሊንክዎ ሽያጭ ተፈጽሟል!</b> <b>${money(o.reward_etb)} ብር</b> አግኝተዋል።\n` +
      `<i>Someone bought with your link — you earned ${money(o.reward_etb)} ብር.</i>\n\n` +
      `💸 ሽልማቱ ከ${t.hold} ቀን በኋላ በወሩ ክፍያ ይላካል።\n<i>It is sent in the monthly payout after ${t.hold} days.</i>` +
      (acct ? '' : '\n\n🏦 ሽልማትዎ እንዲደርስ የባንክ አካውንትዎን ያስመዝግቡ።\n<i>Add your bank account so we can send it.</i>'),
      [[{ text: acct ? '🎁 ጓደኛ ይጋብዙ · Invite friends' : '🏦 የክፍያ አካውንት · Payout account', callback_data: acct ? 'ref:invite' : 'ref:payout' }]]);
  }
  // First delivery to a new buyer while the programme is ON: offer their own link.
  if (delivered && o.delivery_status !== 'delivered') {
    const t = refTerms(await getSettings());
    if (t.on && t.reward > 0) {
      await sendText(o.uid,
        `🎁 ጓደኛ ይጋብዙ፦ ጓደኛዎ በሊንክዎ ሲገዛ <b>${money(t.reward)} ብር</b> ያገኛሉ።\n` +
        `<i>Invite friends: earn ${money(t.reward)} ብር for each friend who buys with your link.</i>`,
        [[{ text: '🎁 ሊንኬን አሳየኝ · My invite link', callback_data: 'ref:invite' }]]);
    }
  }
  log('info', delivered ? 'order_approved' : 'order_delivery_failed', {
    orderId, mid: o.machine_id, uid: o.uid, amount_etb: o.amount_etb,
    delivery_attempt: true,
  });
}

// Decline reasons. The admin used to have one ❌ and the buyer got a generic
// list of everything that MIGHT have been wrong, so they guessed — and often
// guessed wrong and were declined twice. One extra tap here removes a support
// conversation: the buyer is told exactly what to fix.
const REJECT_REASONS = {
  photo: {
    admin: '📷 Unclear photo',
    buyer: 'ፎቶው ግልጽ አይደለም — የክፍያውን ማረጋገጫ በግልጽ የሚያሳይ ፎቶ ይላኩ።\n' +
           '<i>The screenshot was unclear. Send one that clearly shows the transfer.</i>',
  },
  amount: {
    admin: '💵 Wrong amount',
    buyer: 'የተላከው መጠን ትክክል አይደለም።\n' +
           '<i>The amount did not match. Please send exactly the price shown, then try again.</i>',
  },
  account: {
    admin: '🏦 Wrong account',
    buyer: 'ክፍያው ወደ ሌላ አካውንት ተልኳል — ከታች ካሉት አካውንቶች ወደ አንዱ ብቻ ይላኩ።\n' +
           '<i>The payment went to a different account. Use only the accounts listed under Pay.</i>',
  },
  other: {
    admin: '❔ Other',
    buyer: 'ማረጋገጫው ሊረጋገጥ አልቻለም።\n<i>We could not verify the payment proof.</i>',
  },
};

function rejectReasonKeyboard(orderId) {
  return [
    [{ text: REJECT_REASONS.photo.admin, callback_data: `rej:photo:${orderId}` },
     { text: REJECT_REASONS.amount.admin, callback_data: `rej:amount:${orderId}` }],
    [{ text: REJECT_REASONS.account.admin, callback_data: `rej:account:${orderId}` },
     { text: REJECT_REASONS.other.admin, callback_data: `rej:other:${orderId}` }],
    [{ text: '↩ Back', callback_data: `admin:detail:${orderId}` }],
  ];
}

async function reject(chatId, messageId, orderId, cbId, reasonKey) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) return;
  const claim = await DB.prepare(
    "UPDATE orders SET status='rejected' WHERE id=? AND status='pending'"
  ).bind(orderId).run();
  if (!claim || !claim.meta || claim.meta.changes < 1) {
    await answerCb(cbId, 'Already handled'); return;
  }
  await kvDel('pending:count');
  await addFunnel(o.uid, 'rejected');
  const left = await pendingCount();
  await editText(chatId, messageId,
    `❌ <b>Declined #${orderId}</b> — ${(REJECT_REASONS[reasonKey] || REJECT_REASONS.other).admin}\n` +
    `@${esc(o.username)} ${esc(midLabel(o.machine_id))}\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  // The buyer was watching a live status message that said "Pending — you're
  // #N in line". approve() edits it; reject() never did, so a declined buyer
  // was left with two contradictory messages in the same chat: a pending
  // status that never resolves, and a refusal underneath it.
  if (o.status_msg_id) {
    await editText(o.chat_id || o.uid, o.status_msg_id,
      '🔴 <b>ትዕዛዝ አልተሳካም / Order declined</b>\n\n' +
      '🔴 <b>ሁኔታ / Status: Declined</b>');
  }
  // And it was a dead end: no reason, no way to retry, no way to reach a human
  // — at the single worst moment in the product, where someone believes they
  // have paid. Give the usual causes and two buttons out.
  if (o.chat_id) {
    const reason = REJECT_REASONS[reasonKey] || REJECT_REASONS.other;
    await sendText(o.chat_id,
      '❌ <b>የክፍያ ማረጋገጫው አልተረጋገጠም</b>\n' +
      '<i>We could not verify your payment proof. No key was sent.</i>\n\n' +
      '<b>ምክንያት / Reason</b>\n' + reason.buyer + '\n\n' +
      'ችግሩን አስተካክለው እንደገና መሞከር ይችላሉ።\n' +
      '<i>Fix that and try again — or message us if you are stuck.</i>',
      [[{ text: '🔄 እንደገና ልሞክር · Try again', callback_data: 'pay:proof' }],
       [{ text: '💬 ድጋፍ · Contact support', url: SUPPORT_URL }]]);
  }
  await answerCb(cbId, '❌ Declined');
  log('warn', 'order_rejected', { orderId, mid: o.machine_id, uid: o.uid });
}

// ── callback handler ────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const data = cb.data || '';
  const cbId = cb.id;
  const fromUser = cb.from || {};
  const fromUid = String(fromUser.id || '');
  const chat = cb.message || { chat: {} };
  const chatId = chat.chat && chat.chat.id;
  const messageId = chat.message_id;

  // admin-only gates
  if (data.startsWith('approve:') || data.startsWith('approvef:') || data.startsWith('reject:') || data.startsWith('rej:') || data.startsWith('admin:')) {
    if (!isAdmin(fromUid)) { await answerCb(cbId, '🔒 Admin only'); return; }
    // Admin cards, exports, and revoke actions can contain full bearer keys or
    // buyer data; never render them into a group chat.
    if (!isPrivateChat(chatId, fromUid)) {
      await answerCb(cbId, '🔒 Admin actions are private-chat only.');
      return;
    }
  }

  if (data === 'help:mid') {
    await answerCb(cbId, '');
    await sendText(chatId, midHelpText());
    return;
  }

  // referral (buyer side): private chat only
  if (data.startsWith('ref:')) {
    if (!isPrivateChat(chatId, fromUid)) {
      await answerCb(cbId, '🔒 በግል ቻት ይቀጥሉ · Continue in a private chat');
      return;
    }
    await handleRefCallback(data, cbId, fromUid, chatId, messageId);
    return;
  }

  // menu navigation
  if (data.startsWith('faq:')) {
    await answerCb(cbId, '');
    const topic = data.split(':')[1];
    await showFaq(chatId, messageId, topic);
    if (FAQ[topic]) { try { await addFunnel(fromUid, 'faq_' + topic); } catch (e) { /* stats only */ } }
    return;
  }

  if (data.startsWith('menu:')) {
    await answerCb(cbId, '');
    const kind = data.split(':')[1];
    if (kind === 'home') await showMenu(chatId, messageId);
    else if (kind === 'pay') {
      // Opening Pay starts the purchase: the next screenshot is the order
      // (keeping a Machine ID / panel secret the bot already has).
      const known = isPrivateChat(chatId, fromUid) ? await getFsm(fromUid) : null;
      if (isPrivateChat(chatId, fromUid) && !(known && known.step === 'payout')) {
        await setFsm(fromUid, { step: 'photo', mid: known && known.mid, nonce: known && known.nonce, hint: 1 });
      }
      const payOffer = await referralOffer(fromUid, known && known.mid);
      await quoteOffer(fromUid, payOffer);
      const pt = payText(payOffer);
      const kb = payKeyboard(!!(known && known.nonce));
      const r = await editText(chatId, messageId, pt, kb);
      // Same fallback as showMenu: an edit that fails must not leave the buyer
      // staring at an unchanged screen after tapping Pay.
      if (!r || !r.ok) await sendText(chatId, pt, kb);
    } else if (kind === 'mykey') await showMyKey(cb, chatId, messageId);
    return;
  }

  // Payment-flow callbacks are private-chat only. A stale group button must
  // never advance an FSM or attach a screenshot/order to a public chat.
  if (data.startsWith('pay:') && !isPrivateChat(chatId, fromUid)) {
    await answerCb(cbId, '🔒 በግል ቻት ይቀጥሉ · Continue in a private chat');
    await sendText(chatId, '🔒 ለግላዊነትዎ በግል ቻት ይቀጥሉ።\n<i>Please continue in a private chat so your payment details stay private.</i>');
    return;
  }

  // pay:proof start
  if (data.startsWith('pay:')) {
    await answerCb(cbId, '');
    const action = data.split(':')[1];
    if (action === 'proof') {
      // ONE message. This used to edit the tapped message AND send a second
      // one saying the same thing ("Send proof — Step 1/2" followed by "Send
      // your Machine ID (16 characters)"), so tapping "I've paid" produced two
      // near-identical prompts at once — and the second was English with no
      // way back. Editing the tapped message keeps the chat to a single
      // screen the buyer is already looking at.
      // ONE step, whoever they are: send the screenshot. No Machine ID —
      // a phone buyer gets an activation code; a panel buyer is already known.
      const known = await getFsm(fromUid);
      await setFsm(fromUid, { step: 'photo', mid: known && known.mid, nonce: known && known.nonce, photo_key: null, hint: 1 });
      await addFunnel(fromUid, 'proof_start');
      const t =
        '📸 <b>የክፍያውን ስክሪንሾት እዚሁ ይላኩ</b> — ፎቶ ወይም ፋይል፣ ያ ብቻ ነው።\n' +
        '<i>Send the payment screenshot right here — photo or file, that is all.</i>' +
        (known && known.mid && !suspiciousMid(known.mid) ? '\n\n🖥 ኮምፒውተርዎ ተገናኝቷል ✅ <i>Your computer is connected.</i>' : '');
      const kb = [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]];
      const r = await editText(chatId, messageId, t, kb);
      if (!r || !r.ok) await sendText(chatId, t, kb);
    }
    return;
  }

  // proof: callbacks
  if (data.startsWith('proof:')) {
    const action = data.split(':')[1];
    if (action === 'cancel') {
      // Answer FIRST. Telegram spins the button until the callback query is
      // answered; none of the buyer-facing branches did this, so every buyer
      // button sat "loading" for ~30s even when it had worked.
      await answerCb(cbId, '⬅');
      await setFsm(fromUid, null);
      await showMenu(chatId, messageId);
      return;
    }
    if (action === 'mykey') { await answerCb(cbId, ''); await showMyKey(cb, chatId, messageId); return; }
    // "I have joined" on the post-purchase prompt. Re-checks live rather than
    // trusting the button press — joining takes a second, and people do tap
    // before it lands, so an instant re-read would produce a false "no".
    if (action === 'grp-check') {
      const member = await isGroupMember(fromUid);
      if (member === true) {
        await markGroupJoined(fromUid);
        const jobsLink = groupTopicLink(GROUP_TOPICS.jobs);
        const kb = GROUP_TOPICS.jobs
          ? [[{ text: '🎬 ስራዎች · Open the Jobs topic', url: jobsLink }]]
          : null;
        await answerCb(cbId, '✅ ተግባርላለሁ · Confirmed');
        await editText(chatId, messageId, JOINED_TEXT, kb);
      } else if (member === false) {
        await answerCb(cbId, '👥 ግሩን አልገቡም · Not in the group yet');
        await sendText(chatId,
          '👥 እስካሁን በግሩኑ አይወሉም። ከላይ ያለውን አዝና ይግቡ፣ ከዚያ እነገራለሁ።\n' +
          '<i>Not in the group yet. Tap the button above, join, then press it again.</i>',
          JOIN_PROMPT_KB);
      } else {
        await answerCb(cbId, '⚠️ ማረጋገጥ አልተቻለም · Could not verify');
      }
      return;
    }
    if (action === 'yes') {
      // "Yes, this picture is my payment" (it arrived outside a purchase).
      await answerCb(cbId, '');
      if (!isPrivateChat(chatId, fromUid)) return;
      const s = await getFsm(fromUid);
      if (s && s.step === 'proof_ask' && s.photo_key) {
        await addFunnel(fromUid, 'screenshot_sent');
        let meta = {};
        try { meta = JSON.parse((await kvGet('proofmeta:' + fromUid)) || '{}'); } catch (e) { /* none */ }
        await placeOrder(fromUid, chatId, fromUser.username || fromUser.first_name || '', true, { ...s, meta });
      }
      return;
    }
    if (action === 'confirm') {
      if (!isPrivateChat(chatId, fromUid)) {
        await answerCb(cbId, '🔒 በግል ቻት ይቀጥሉ · Continue in a private chat');
        await sendText(chatId, '🔒 ትዕዛዙን በግል ቻት ያረጋግጡ።\n<i>Please confirm the order in a private chat.</i>');
        return;
      }
      await answerCb(cbId, '');
      const s = await getFsm(fromUid);
      if (s && s.step === 'confirm' && s.mid) {
        await completeProof(fromUid, chatId, fromUser.username || fromUser.first_name || '', isPrivateChat(chatId, fromUid));
      }
      return;
    }
    return;
  }

  // admin:
  if (data.startsWith('admin:')) {
    const parts = data.split(':');
    const action = parts[1];
    // Money, broadcast, export and license-killing buttons need the PIN (when
    // one is set) and are always written to the audit log.
    const SENSITIVE = {
      export: 'Export customers (all keys)', 'sales-export': 'Export sales',
      'bcast-send': 'Send a broadcast', 'ref-toggle': 'Referral ON/OFF',
      'ref-paid': 'Mark a reward paid', 'partner-paid': 'Mark a partner paid',
      'partner-del-yes': 'Delete a partner', 'partner-reset-yes': 'Move a partner to a new account',
      revoke: 'Revoke a license', unrevoke: 'Restore a license',
      'revoke-mid': 'Revoke a license', 'unrevoke-mid': 'Restore a license',
    };
    if (SENSITIVE[action]) {
      if (!(await requireUnlock(fromUid, chatId, cbId, SENSITIVE[action]))) return;
      await audit(fromUid, action, parts.slice(2).join(':'));
    }
    if (action === 'panel') await adminPanel(chatId, messageId);
    else if (action === 'audit') await adminAudit(chatId);
    else if (action === 'queue' || action === 'pending') await adminQueue(chatId, messageId, cbId, 0);
    else if (action === 'queuep') await adminQueue(chatId, messageId, cbId, parseInt(parts[2] || '0', 10));
    else if (action === 'history') await adminHistory(chatId, messageId, cbId, 0);
    else if (action === 'histp') await adminHistory(chatId, messageId, cbId, parseInt(parts[2] || '0', 10));
    else if (action === 'revoke' || action === 'unrevoke') {
      await revokeOrder(chatId, parts[2], action === 'revoke');
      await answerCb(cbId, action === 'revoke' ? '🚫 Key revoked' : '♻ Key restored');
      // Redraw the card. Without this the order still reads APPROVED with a
      // Revoke button under it after a successful revoke, so the action looks
      // like it did nothing even though the key is already dead.
      await adminDetail(chatId, null, null, parts[2]);
    }
    else if (action === 'revoke-mid' || action === 'unrevoke-mid') {
      await revokeMid(chatId, parts[2], action === 'revoke-mid');
      await answerCb(cbId, action === 'revoke-mid' ? '🚫 Key revoked' : '♻ Key restored');
    }
    else if (action === 'detail') await adminDetail(chatId, messageId, cbId, parts[2]);
    else if (action === 'find' && isValidMid(parts[2])) { await answerCb(cbId, ''); await adminFind(chatId, parts[2].toLowerCase()); }
    else if (action === 'findask') {
      await kvDel('move:await:' + fromUid);
      await kvPut('find:await:' + fromUid, '1', 900);
      await answerCb(cbId, 'Send the Machine ID');
      await sendText(chatId, '🔍 <b>Find a customer</b>\n\nSend me their Machine ID (they copy it from the bottom of the panel). <i>/start to cancel.</i>');
    }
    else if (action === 'move' && isValidMid(parts[2])) {
      if (!(await requireUnlock(fromUid, chatId, cbId, 'Move a license'))) return;
      await kvDel('find:await:' + fromUid);
      await kvPut('move:await:' + fromUid, parts[2].toLowerCase(), 900);
      await answerCb(cbId, 'Send the new Machine ID');
      await sendText(chatId,
        `🔁 <b>Move the license from</b> <code>${esc(parts[2].toLowerCase())}</code>\n\n` +
        'Send me the NEW computer\'s Machine ID. The old key stops working and the buyer gets the new key here in the bot.\n' +
        '<i>/start to cancel.</i>');
    }
    else if (action === 'gift' && isValidMid(parts[2])) { await answerCb(cbId, ''); await giveKey(chatId, fromUid, parts[2], ''); }
    else if (action === 'help') { await answerCb(cbId, ''); await adminHelp(chatId); }
    else if (action === 'retry-delivery') {
      await approve(chatId, messageId, parts[2], cbId);
      await adminDetail(chatId, null, null, parts[2]);
    }
    else if (action === 'sales') await adminSales(chatId, messageId);
    else if (action === 'usage') await adminUsage(chatId, messageId, parseInt(parts[2] || '7', 10));
    else if (action === 'trials') await adminTrials(chatId, messageId, Math.max(0, parseInt(parts[2] || '0', 10) || 0));
    else if (action === 'export') await adminExport(chatId, messageId, cbId);
    else if (action === 'broadcast') {
      await kvPut('bcast:await:' + fromUid, '1', 900);
      await answerCb(cbId, 'Compose broadcast');
      await sendText(chatId,
        '📣 <b>Broadcast</b>\n\nSend me the <b>exact message</b> for every customer (their DM with this bot).\n' +
        'You will see a <b>preview</b> with Send / Cancel before anything goes out.\n\n' +
        '<i>Only buyers receive it — admins are skipped. Changed your mind? Send /start.</i>');
    }
    else if (action === 'bcast-send') await startBroadcast(chatId, messageId, cbId, parseInt(parts[2] || '0', 10), parts[3] || 'all');
    else if (action === 'bcast-cancel') await cancelBroadcast(chatId, messageId, cbId, parseInt(parts[2] || '0', 10));
    else if (action === 'sales-export') await adminSalesExport(chatId, cbId);
    else if (action === 'ref') await adminReferrals(chatId, messageId);
    else if (action === 'group') await adminGroup(chatId, messageId, cbId);
    else if (action === 'jobs-toggle') {
      const on = await jobsEnabled();
      if (!on && (!SUPPORT_GROUP || !GROUP_TOPICS.jobs || !JOB_CHANNELS.length)) {
        await answerCb(cbId, 'Set AMH_SUPPORT_GROUP, jobs:<topic id> in AMH_GROUP_TOPICS and AMH_JOB_CHANNELS first');
      } else {
        await setSetting('jobs_feed', on ? '0' : '1');
        await answerCb(cbId, on ? '⚪ Jobs feed OFF' : '🟢 Jobs feed ON');
        await adminPanel(chatId, messageId);
      }
    }
    else if (action === 'topics-close') await adminTopicsGeneral(chatId, cbId, fromUid, true);
    else if (action === 'topics-open') await adminTopicsGeneral(chatId, cbId, fromUid, false);
    else if (action === 'ref-toggle') {
      const on = refTerms(await getSettings()).on;
      try {
        await setSetting('referral_enabled', on ? '0' : '1');
        await answerCb(cbId, on ? '⚪ Referrals OFF' : '🟢 Referrals ON');
      } catch (e) {
        await answerCb(cbId, '⚠️ Run npm run migrate first');
      }
      await adminReferrals(chatId, messageId);
    }
    else if (action === 'ref-pay') await adminRefPayList(chatId, messageId);
    else if (action === 'ref-paid') await adminRefMarkPaid(chatId, messageId, cbId, parts.slice(2).join(':'));
    else if (action === 'ref-ask') {
      const askTo = await recipientOf(parts.slice(2).join(':'));
      if (!askTo) {
        await answerCb(cbId, 'Not connected yet — send them the private link (📨 Links)');
        return;
      }
      await sendText(askTo,
        '🎁 <b>ሽልማት አለዎት!</b> እንድንልክልዎ የባንክ አካውንትዎን ያስመዝግቡ።\n' +
        '<i>You have a referral reward waiting — add your bank account so we can send it.</i>',
        [[{ text: '🏦 የክፍያ አካውንት · Payout account', callback_data: 'ref:payout' }]]);
      await answerCb(cbId, '📩 Asked for their account');
    }
    else if (action === 'partners') await adminPartners(chatId, messageId, parseInt(parts[2] || '0', 10) || 0);
    else if (action === 'partner-toggle') {
      const pp = await partnerByCode(parts[2]);
      if (pp) {
        await DB.prepare('UPDATE partners SET active = ? WHERE code = ?').bind(pp.active ? 0 : 1, pp.code).run();
        await answerCb(cbId, pp.active ? `⏸ ${pp.code} paused` : `▶ ${pp.code} resumed`);
        if (parts[4] === 'tell' && pp.uid) {
          await sendText(pp.uid, pp.active
            ? '⏸ የአጋር ሊንክዎ ለጊዜው ቆሟል — አዲስ ገዢዎች ቅናሽ አያገኙም። ያገኙት ሽልማት አይጠፋም።\n' +
              '<i>Your partner link is paused for now — new buyers get no discount. Rewards you already earned are kept.</i>'
            : '▶ የአጋር ሊንክዎ እንደገና ይሰራል! ማጋራት ይችላሉ።\n<i>Your partner link is active again — you can share it.</i>',
          [[{ text: '🤝 የአጋር ገጽ · Partner page', callback_data: 'ref:invite' }]]);
        }
      }
      if (parts[3] === 'card' && pp) await adminPartnerCard(chatId, messageId, pp.code);
      else await adminPartners(chatId, messageId);
    }
    else if (action === 'partner-pause') {
      const c = parts[2];
      await sendText(chatId,
        `⏸ <b>Pause ${esc(c)}?</b>\n\nNew people get no discount through the link and no new sales are credited. ` +
        'Rewards already earned stay owed. Anyone who saw the price in the last 48 h still gets it.',
        [[{ text: '⏸ Pause & tell them', callback_data: `admin:partner-toggle:${c}:card:tell` }],
          [{ text: '⏸ Pause quietly', callback_data: `admin:partner-toggle:${c}:card` }],
          [{ text: '✖ Cancel', callback_data: `admin:partner:${c}` }]]);
    }
    else if (action === 'partner') await adminPartnerCard(chatId, messageId, parts[2]);
    else if (action === 'partner-pay') await adminPartnerPay(chatId, messageId, cbId, parts[2], null);
    else if (action === 'partner-paid') await adminPartnerPay(chatId, messageId, cbId, parts[2], parseInt(parts[3] || '-1', 10));
    else if (action === 'partner-del') await adminPartnerDelete(chatId, messageId, parts[2], false);
    else if (action === 'partner-del-yes') await adminPartnerDelete(chatId, messageId, parts[2], true);
    else if (action === 'partner-msg') {
      const pp = await partnerByCode(parts[2]);
      if (pp && !pp.uid) {
        await answerCb(cbId, 'Not connected yet — send the private link first');
      } else if (pp) {
        await kvPut('pmsg:await:' + fromUid, pp.code, 900);
        await answerCb(cbId, 'Write the message');
        await sendText(chatId,
          `✉️ <b>Message to ${esc(pp.code)}</b>${pp.tg_username ? ' (' + esc(pp.tg_username) + ')' : ''}\n\n` +
          'Send me the text now — it goes to them from the bot. <i>Changed your mind? Send /start.</i>\n' +
          `<i>Shortcut: /pmsg ${esc(pp.code)} your text</i>`);
      }
    }
    else if (action === 'partner-report') {
      const pp = await partnerByCode(parts[2]);
      const sent = pp ? await sendPartnerStatement(pp, new Date().toISOString().slice(0, 7)) : false;
      await answerCb(cbId, sent ? '📊 Report sent to the partner' : 'Not connected yet — nothing sent');
    }
    else if (action === 'partner-sales') await adminPartnerSales(chatId, parts[2]);
    else if (action === 'partner-help') {
      const c = esc(parts[2]);
      await sendText(chatId,
        `⚙ <b>${c}</b> — commands\n\n` +
        `📝 Private note: <code>/partnernote ${c} your note</code> (<code>-</code> clears it)\n` +
        `📋 Terms: <code>/partnerterms ${c} 300 200 20 400</code>\n` +
        `✏️ Rename: <code>/partnername ${c} New name</code>\n` +
        `🏦 Bank for them: <code>/partnerbank ${c} CBE 1000123456789 Name</code> (<code>-</code> clears it)\n` +
        `✉️ Message: <code>/pmsg ${c} your text</code>\n` +
        `📋 This card: <code>/partnerinfo ${c}</code>`,
        [[{ text: `📋 ${parts[2]}`, callback_data: `admin:partner:${parts[2]}` }]]);
    }
    else if (action === 'partner-reset') {
      await sendText(chatId,
        `♻ <b>Move ${esc(parts[2])} to a new phone/account?</b>\n\n` +
        'Their current Telegram account is disconnected and you get a NEW private link to send them. ' +
        'Sales and money owed are kept.',
        [[{ text: '✅ Yes, new private link', callback_data: `admin:partner-reset-yes:${parts[2]}` },
          { text: '✖ Cancel', callback_data: `admin:partner:${parts[2]}` }]]);
    }
    else if (action === 'partner-reset-yes') await adminPartnerReset(chatId, parts[2]);
    else if (action === 'partner-links') {
      const pp = await partnerByCode(parts[2]);
      if (pp) await sendPartnerLinks(chatId, pp, false);
    }
    else if (action === 'ref-announce') {
      await answerCb(cbId, 'Preview below');
      await draftBroadcast(chatId, referralAnnouncement(refTerms(await getSettings())));
    }
    // Stop the loading spinner for screens that did not answer themselves (a
    // second answer is rejected by Telegram and ignored by safeSend).
    await answerCb(cbId, '');
    return;
  }

  // approve:id / reject:id. A flagged order (reused or forwarded screenshot)
  // needs a second, deliberate tap: "the money is in my bank".
  if (data.startsWith('approve:') || data.startsWith('approvef:')) {
    const forced = data.startsWith('approvef:');
    const orderId = data.split(':')[1];
    if (!forced) {
      let flag = null;
      try {
        const f = await DB.prepare('SELECT proof_flag FROM orders WHERE id=?').bind(orderId).first();
        flag = f && f.proof_flag;
      } catch (e) { /* 0020 not applied */ }
      if (flag) {
        await answerCb(cbId, '⚠️ Flagged order — check below');
        await sendText(chatId,
          `🚨 <b>Order #${esc(orderId)} is flagged</b>\n${esc(flag)}\n\n` +
          '👉 Open your <b>bank app</b> and check the money really arrived before approving.',
          [[{ text: '✅ The money is in my bank — approve', callback_data: `approvef:${orderId}` }],
           [{ text: '❌ Decline', callback_data: `reject:${orderId}` }]]);
        return;
      }
    }
    await audit(fromUid, forced ? 'approve_flagged' : 'approve', '#' + orderId);
    await approve(chatId, messageId, orderId, cbId);
    return;
  }
  if (data.startsWith('reject:')) {
    // Ask WHY before declining — the buyer needs it more than we do.
    const orderId = data.split(':')[1];
    await editKeyboard(chatId, messageId, rejectReasonKeyboard(orderId));
    await answerCb(cbId, 'Pick a reason');
    return;
  }
  if (data.startsWith('rej:')) {
    const [, reasonKey, orderId] = data.split(':');
    await audit(fromUid, 'decline', '#' + orderId + ' ' + reasonKey);
    await reject(chatId, messageId, orderId, cbId, reasonKey);
    return;
  }

  await answerCb(cbId, '');
}

function isPrivateChat(chatId, uid) {
  return String(chatId) === String(uid);
}

// ── newest published release (update-available notice) ─────────────────────
// One cached answer for every customer: 'latest:release' (1 h) is what callers
// get; 'latest:last' (no expiry) is the last good answer, served when GitHub is
// unreachable; 'latest:fail' (5 min) stops a GitHub outage turning into a
// request per customer. Only a plain x.y.z version and our own install page are
// ever returned, never text taken from the release body.
const RELEASES_API = 'https://api.github.com/repos/kaleb21-19/amharic_caption/releases/latest';
async function latestRelease() {
  const cached = await kvGet('latest:release');
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  let out = null;
  if (!(await kvGet('latest:fail'))) {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { 'User-Agent': 'amharic-captions-worker', Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const rel = await res.json();
        const v = String((rel && rel.tag_name) || '').replace(/^v/, '');
        if (/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v)) out = { version: v, url: SITE_URL + '/install/' };
      }
    } catch (e) {
      log('warn', 'latest_release_fetch_failed', { err: String((e && e.message) || e) });
    }
  }
  if (out) {
    await kvPut('latest:release', JSON.stringify(out), 3600);
    await kvPut('latest:last', JSON.stringify(out));
    return out;
  }
  await kvPut('latest:fail', '1', 300);
  const last = await kvGet('latest:last');
  if (last) { try { return JSON.parse(last); } catch (e) {} }
  return null;
}

// ── CORS allow-list ─────────────────────────────────────────────────────────
// ALLOWED_ORIGIN (env AMH_ALLOWED_ORIGIN, comma-separated). DEFAULT IS
// FAIL-CLOSED: unset => no Access-Control-Allow-Origin header, so browser
// callers cannot read cross-origin responses. CEP panels should use the
// explicit `null` origin in AMH_ALLOWED_ORIGIN.
function corsFor(request) {
  const base = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  };
  const list = (ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return base; // no allow-origin → browser blocks reads
  const origin = request.headers.get('Origin') || '';
  if (list.includes('*')) return { ...base, 'Access-Control-Allow-Origin': '*' };
  if (origin && list.includes(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return base; // no allow-origin header → the browser blocks cross-origin reads
}

// ── entry point: webhook ────────────────────────────────────────────────────
// ── the "/" command menu ────────────────────────────────────────────────────
// The list behind the Menu button and "/" used to live only in @BotFather and
// had drifted to a single "invite" entry — customers tapping Menu saw nothing
// else (and invite is off while referrals are off). The bot now owns the list:
// a cron tick compares it with what was last sent and calls setMyCommands only
// when it changed, so a deploy or the referral switch updates it within a minute.
async function botCommands() {
  const cmds = [
    { command: 'start', description: 'ዋና ገጽ · Menu' },
    { command: 'buy', description: 'ፈቃድ ይግዙ · Buy a license' },
    { command: 'mykey', description: 'ቁልፌ · My key' },
    { command: 'help', description: 'እገዛ · Help' },
    { command: 'support', description: 'ድጋፍ · Support' },
  ];
  try {
    if (refTerms(await getSettings()).on) cmds.push({ command: 'invite', description: 'ጓደኛ ይጋብዙ · Invite friends' });
  } catch (e) { /* settings unavailable: base list */ }
  return cmds;
}
async function syncBotCommands() {
  const cmds = await botCommands();
  const sig = cmds.map((c) => c.command + '=' + c.description).join('|');
  let have = '';
  try { have = (await getSettings()).bot_commands || ''; } catch (e) { return; }
  if (have === sig) return;
  const r = await safeSend(tg(TOKEN, 'setMyCommands', { commands: cmds }));
  if (!(r && r.ok)) { log('warn', 'set_commands_failed', { err: r && r.description }); return; }
  await safeSend(tg(TOKEN, 'setChatMenuButton', { menu_button: { type: 'commands' } }));
  try { await setSetting('bot_commands', sig); } catch (e) { /* retried next tick */ }
  log('info', 'bot_commands_synced', { commands: cmds.map((c) => c.command).join(',') });
}

export default {
  async fetch(request, env) {
    initEnv(env);
    const url = new URL(request.url);

    // GET /setwebhook?url=... helper (also acts as health check)
    if (request.method === 'GET' && url.pathname === '/ok') {
      return new Response('ok', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/ready') {
      const missing = [];
      if (!TOKEN) missing.push('AMH_TG_TOKEN');
      if (!ADMIN_ID) missing.push('AMH_ADMIN_ID');
      if (!WEBHOOK_SECRET) missing.push('AMH_WEBHOOK_SECRET');
      if (API_KEY_REQUIRED && !API_KEY) missing.push('AMH_API_KEY');
      if (!SECRET) missing.push('AMH_SECRET');
      if (!SIGN_KEY) missing.push('AMH_LICENSE_SIGNING_KEY');
      if (!DB) missing.push('DB');
      if (!CACHE) missing.push('AMH_KV');
      if (!missing.length && !(await licenseServicesReady())) {
        missing.push('license crypto preflight');
      }
      if (missing.length) {
        return new Response(JSON.stringify({ ok: false, missing }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Extension API ──────────────────────────────────────────────────────
    // CORS for extension calls. CEP panels run from file:// origins, which the
    // browser exposes as "Origin: null"; deployments should explicitly include
    // that origin in AMH_ALLOWED_ORIGIN.
    const corsHeaders = corsFor(request);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders },
    });
    // Rate limiting: at most `max` hits per `ttl`-second fixed window.
    //
    // This is backed by D1, not KV. The KV version wrote a marker on every
    // request that PASSED the check (not only the ones it blocked), so ordinary
    // panel polling — ping/trial/validate, 4 markers at 60 s each — is what
    // actually burned the 1,000 puts/day free-tier allowance, not abuse. It
    // also failed CLOSED on write failure, so while KV was over quota and
    // returning 429 these endpoints rejected EVERY caller, not just abusers.
    // And it never really enforced anything: KV is eventually consistent
    // (~60 s), so parallel requests read the same stale marker and all got
    // through anyway. Migration 0007 moved the analogous trial counter into
    // SQL for exactly that reason; see migration 0021.
    const rlHit = async (k, max, ttl) => {
      const now = Math.floor(Date.now() / 1000);
      const end = now + ttl;
      try {
        // One atomic upsert: an expired window resets n to 1 and rolls the
        // deadline forward in the same statement, so concurrent callers cannot
        // race a read-then-write the way the KV version did.
        await DB.prepare(
          `INSERT INTO rl_counters (k, n, window_end) VALUES (?, 1, ?)
           ON CONFLICT(k) DO UPDATE SET
             n          = CASE WHEN rl_counters.window_end <= ? THEN 1 ELSE rl_counters.n + 1 END,
             window_end = CASE WHEN rl_counters.window_end <= ? THEN ? ELSE rl_counters.window_end END`
        ).bind(k, end, now, now, end).run();
        const row = await DB.prepare('SELECT n FROM rl_counters WHERE k = ?').bind(k).first();
        return (row ? row.n : 1) > max;
      } catch (e) {
        // Still fail closed, but this can now only happen if D1 itself is
        // unreachable, and the log says so instead of blaming a KV quota.
        log('error', 'rate_limit_db_failed', { key: String(k), message: String((e && e.message) || e) });
        return true;
      }
    };
    // Marker-style limiter (one hit per window) is exactly a max of 1.
    const rateLimited = (k, ttl) => rlHit(k, 1, ttl);
    const clientIp = () => request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    // The extension API is intentionally public at the transport layer: a
    // desktop client cannot hold a meaningful shared secret. License checks
    // are protected by the HMAC + D1 row; optional API-key gating is only for
    // deployments that put the Worker behind an additional network policy.
    if (url.pathname.startsWith('/api/')) {
      if (API_KEY_REQUIRED && !API_KEY) {
        log('error', 'api_key_missing');
        return json({ error: 'server not configured' }, 503);
      }
      if (!CACHE) {
        log('error', 'api_kv_missing');
        return json({ error: 'server not configured' }, 503);
      }
      if (API_KEY_REQUIRED) {
        const givenKey = request.headers.get('X-Api-Key') || '';
        if (!safeEqual(givenKey, API_KEY)) {
          log('warn', 'api_unauthorized', { ip: clientIp() });
          return json({ error: 'unauthorized' }, 401);
        }
      }
    }
    // Telemetry for /api calls (used once to lock down CORS:
    // the Origin header a real CEP panel sends is what AMH_ALLOWED_ORIGIN
    // must whitelist).
    if (url.pathname.startsWith('/api/')) {
      log('info', 'api_call', {
        route: request.method + ' ' + url.pathname,
        origin: request.headers.get('Origin') || '(none)',
        ip: clientIp(),
      });
    }

    // POST /api/ping → {v?} → {ok:true}. Version + Origin telemetry fired once
    // per machine per day from the panel boot — shows which build is in the
    // field (support triage) and what Origin a real CEP panel sends (used to
    // lock AMH_ALLOWED_ORIGIN).
    // POST /api/event {e, h, os, v} — one anonymous step from the panel /
    // desktop app ("opened", "model download failed", "pressed Make
    // captions", "error: no clip selected" …). Counted per day; nothing that
    // identifies the computer or the person is stored (see 0025).
    if (request.method === 'POST' && url.pathname === '/api/event') {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      const e = String((b && b.e) || '');
      const host = ['PPRO', 'AEFT', 'APP'].includes(b && b.h) ? b.h : '';
      const os = ['win', 'mac'].includes(b && b.os) ? b.os : '';
      const v = String((b && b.v) || '');
      if (!EVENT_NAMES.has(e) || !host || !os || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) {
        return json({ error: 'bad event' }, 400);
      }
      // A panel sends each step at most once a day; this only stops a loop or
      // a flood from inflating the counts.
      if (await rateLimited('rl:ip:' + clientIp() + ':ev:' + e, 20)) return json({ ok: true, dropped: true });
      const cc = /^[A-Z]{2}$/.test(String((request.cf && request.cf.country) || '')) ? request.cf.country : '??';
      try {
        await DB.prepare(
          `INSERT INTO events_daily (day, e, host, os, v, cc, n) VALUES (date('now'), ?, ?, ?, ?, ?, 1)
           ON CONFLICT(day, e, host, os, v, cc) DO UPDATE SET n = n + 1`
        ).bind(e, host, os, v, cc).run();
      } catch (err) {
        log('warn', 'event_store_failed', { err: String((err && err.message) || err) });
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/api/ping') {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      const mid = String((b && b.mid) || '').toLowerCase();
      const v = String((b && b.v) || '');
      if (!isValidMid(mid) || !v || v.length > 32) {
        return json({ error: 'bad ping payload' }, 400);
      }
      // Telemetry must not become an unbounded KV-cost write endpoint for
      // arbitrary Machine IDs. A normal panel pings once per day; one request
      // per source IP per minute is ample and still allows multiple installs
      // behind a shared NAT to report eventually.
      if (await rateLimited('rl:ip:' + clientIp() + ':ping', 60)) {
        return json({ error: 'throttled', retry: true }, 429);
      }
      const throttleKey = 'ping:' + mid;
      if (!(await kvGet(throttleKey))) {
        const origin = (request.headers.get('Origin') || '(none)').slice(0, 128);
        log('info', 'panel_ping', { v, mid, origin, ip: clientIp() });
        await kvPut(throttleKey, '1', 86400);
        await kvPut('beacon:' + mid, JSON.stringify({ v, mid, origin, ip: clientIp(), ts: new Date().toISOString() }), 30 * 86400);
      }
      return json({ ok: true });
    }

    // GET /api/latest → {version, url}: the newest published release, for the
    // panel's and SRT maker's "update available" notice. Answered from KV, so
    // GitHub is asked at most about once an hour for ALL customers together.
    if (request.method === 'GET' && url.pathname === '/api/latest') {
      const out = await latestRelease();
      return out ? json(out) : json({ error: 'unavailable' }, 503);
    }

    // GET /api/trial?mid=XXXX → {used, max, remaining}
    if (request.method === 'GET' && url.pathname === '/api/trial') {
      const mid = (url.searchParams.get('mid') || '').trim().toLowerCase();
      if (!mid || !isValidMid(mid)) {
        return json({ error: 'bad mid' }, 400);
      }
      const cacheKey = 'trial:' + mid;
      const cached = await kvGet(cacheKey);
      if (cached) { try { return json(JSON.parse(cached)); } catch (e) {} }
      // Per-IP throttle so a scraper spraying many machine IDs can't burn
      // D1 reads. A legit user only ever queries their own mid (cache hit).
      if (await rateLimited('rl:ip:' + clientIp() + ':trial', 60)) {
        return json({ error: 'throttled' }, 429);
      }
      const row = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
      const used = row ? row.used : 0;
      const maxFree = row ? row.max_free : 2;
      const out = { used, max: maxFree, remaining: Math.max(0, maxFree - used) };
      await kvPut(cacheKey, JSON.stringify(out), 60);
      return json(out);
    }

    // POST /api/trial/use → {mid, run_id} → idempotent charge; return
    // {used, remaining, charged}. charged=false must block placement.
    if (request.method === 'POST' && url.pathname === '/api/trial/use') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const mid = String((body && body.mid) || '').trim().toLowerCase();
      const runId = body && body.run_id != null ? String(body.run_id) : '';
      if (!isValidMid(mid) || (runId && !/^[A-Za-z0-9._:-]{8,96}$/.test(runId))) {
        return json({ error: 'bad mid or run_id' }, 400);
      }
      // A run ID makes retries idempotent and is bound to the MID that created
      // it. Pending rows are leases: a crashed worker can be reclaimed after a
      // short timeout instead of acknowledging a lost update forever.
      const trialState = async (machineId) => {
        const prior = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(machineId).first();
        const priorUsed = prior ? prior.used : 0;
        const priorMax = prior ? prior.max_free : 2;
        return { used: priorUsed, max: priorMax, remaining: Math.max(0, priorMax - priorUsed) };
      };
      const finishReservation = async (out) => {
        if (runId) {
          await DB.prepare(
            `UPDATE trial_uses SET completed_at=datetime('now'), result_json=?
             WHERE run_id=? AND machine_id=?`
          ).bind(JSON.stringify(out), runId, mid).run();
        }
        await kvPut('trial:' + mid, JSON.stringify(out), 60);
        return json(out);
      };
      if (runId) {
        const claim = await DB.prepare(
          `INSERT OR IGNORE INTO trial_uses
             (run_id, machine_id, claimed_at, completed_at, result_json)
           VALUES (?, ?, datetime('now'), NULL, NULL)`
        ).bind(runId, mid).run();
        if (!claim || !claim.meta || claim.meta.changes < 1) {
          const prior = await DB.prepare(
            'SELECT machine_id, completed_at, result_json FROM trial_uses WHERE run_id=?'
          ).bind(runId).first();
          if (!prior || prior.machine_id !== mid) {
            // Fail closed for clients that otherwise fall back to a local
            // counter on non-2xx responses.
            return json({ error: 'run_id_conflict', used: 2, max: 2, remaining: 0, charged: false });
          }
          if (prior.completed_at) {
            const state = await trialState(mid);
            if (prior.result_json) {
              try { return json(Object.assign(JSON.parse(prior.result_json), { duplicate: true })); } catch (e) {}
            }
            return json(Object.assign(state, { duplicate: true, charged: false }));
          }
          const reclaimed = await DB.prepare(
            `UPDATE trial_uses SET claimed_at=datetime('now')
             WHERE run_id=? AND machine_id=? AND completed_at IS NULL
               AND (claimed_at IS NULL OR claimed_at='' OR claimed_at < datetime('now','-30 seconds'))`
          ).bind(runId, mid).run();
          if (!reclaimed || !reclaimed.meta || reclaimed.meta.changes < 1) {
            return json(Object.assign(await trialState(mid), { duplicate: true, pending: true, charged: false }));
          }
        }
      }
      // Fresh-machine flood guard: a mid with no prior trial row is the classic
      // clearing-localStorage reset. Cap fresh mids per IP per day — SATURATE at
      // the cap instead of 429 so the panel syncs to remaining:0 and its trial
      // gate actually blocks, rather than dipping into the local fallback.
      if (await recordFreshTrialUse(clientIp(), mid) > FRESH_MID_LIMIT) {
        return finishReservation({ used: 2, remaining: 0, charged: false });
      }
      await DB.prepare('INSERT OR IGNORE INTO trials (machine_id, used, max_free) VALUES (?, 0, 2)').bind(mid).run();
      const updateTrial = runId
        ? `UPDATE trials SET used = used + 1, last_at = datetime('now')
           WHERE machine_id = ? AND used < max_free`
        : `UPDATE trials SET used = used + 1, last_at = datetime('now')
           WHERE machine_id = ? AND used < max_free
             AND (last_at = '' OR last_at IS NULL OR last_at < datetime('now', '-2 seconds'))`;
      let charged = false;
      if (runId && typeof DB.batch === 'function') {
        // D1 batch is transactional: the credit and the completed reservation
        // commit together, so a crash cannot charge twice on reclaim.
        const batchResults = await DB.batch([
          DB.prepare(updateTrial).bind(mid),
          DB.prepare(
            `UPDATE trial_uses SET completed_at=datetime('now'), result_json=?
             WHERE run_id=? AND machine_id=?`
          ).bind(null, runId, mid),
        ]);
        const credit = batchResults && batchResults[0];
        charged = !!(credit && credit.meta && credit.meta.changes >= 1);
      } else {
        const credit = await DB.prepare(updateTrial).bind(mid).run();
        charged = !!(credit && credit.meta && credit.meta.changes >= 1);
        if (runId) {
          await DB.prepare(
            `UPDATE trial_uses SET completed_at=datetime('now')
             WHERE run_id=? AND machine_id=?`
          ).bind(runId, mid).run();
        }
      }
      const out = Object.assign(await trialState(mid), { charged });
      if (runId) {
        // Store the actual post-charge result for duplicate retries.
        await DB.prepare('UPDATE trial_uses SET result_json=? WHERE run_id=? AND machine_id=?')
          .bind(JSON.stringify(out), runId, mid).run();
      }
      return finishReservation(out);

    }

    // Up to `max` requests per `ttl` seconds. D1-backed — see rlHit() above.
    const tooMany = (k, max, ttl) => rlHit(k, max, ttl);

    // POST /api/redeem → {mid, code} → {ok:true, key} | {ok:false, reason}
    // A phone buyer's activation code, typed once into the panel: binds the
    // license to THIS computer. The panel then activates with the key through
    // /api/validate as usual (signed lease). One code = one computer.
    if (request.method === 'POST' && url.pathname === '/api/redeem') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const mid = String((body && body.mid) || '').trim().toLowerCase();
      const code = normActivationCode(body && body.code);
      if (!isValidMid(mid) || !code) return json({ ok: false, reason: 'bad_code' });
      // 32^8 codes; 10 tries per IP per 10 minutes keeps guessing hopeless.
      if (await tooMany('rl:redeem:' + clientIp(), 10, 600)) return json({ ok: false, reason: 'throttled' }, 429);
      let ac = null;
      try { ac = await DB.prepare('SELECT * FROM activation_codes WHERE code=?').bind(code).first(); }
      catch (e) { return json({ ok: false, reason: 'unavailable' }, 503); }
      if (!ac) return json({ ok: false, reason: 'not_found' });
      if (ac.revoked) return json({ ok: false, reason: 'revoked' });
      if (ac.redeemed_mid && ac.redeemed_mid !== mid) return json({ ok: false, reason: 'used' });
      if (!SECRET) return json({ ok: false, reason: 'unavailable' }, 503);
      if (ac.redeemed_mid === mid) {
        const c = await DB.prepare('SELECT key, revoked FROM customers WHERE machine_id=?').bind(mid).first();
        if (c && !c.revoked) return json({ ok: true, key: c.key });
        return json({ ok: false, reason: c ? 'revoked' : 'not_found' });
      }
      const have = await DB.prepare('SELECT revoked FROM customers WHERE machine_id=?').bind(mid).first();
      if (have && !have.revoked) return json({ ok: false, reason: 'already_licensed' });
      const key = await keyFor(mid, ac.expiry || '00000000');
      // Claim the code first (race-safe: two panels typing it at once).
      const claim = await DB.prepare(
        "UPDATE activation_codes SET redeemed_mid=?, redeemed_at=datetime('now') WHERE code=? AND redeemed_mid IS NULL AND revoked=0"
      ).bind(mid, code).run();
      if (!claim || !claim.meta || claim.meta.changes < 1) return json({ ok: false, reason: 'used' });
      const ord = await DB.prepare('SELECT username FROM orders WHERE id=?').bind(ac.order_id).first();
      await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status, uid)
        VALUES (?,?,?,?, 'sold', ?) ON CONFLICT(machine_id) DO UPDATE SET
          key=excluded.key, name=excluded.name, expiry=excluded.expiry, status='sold', uid=excluded.uid, revoked=0`)
        .bind(mid, '@' + ((ord && ord.username) || 'buyer'), ac.expiry || '00000000', key, ac.uid || '').run();
      // From now on this is an ordinary sale of this computer: orders, the
      // sales ledger and referral rewards carry the real Machine ID.
      const ph = 'code-' + code.replace('-', '').toLowerCase();
      await DB.prepare('UPDATE orders SET machine_id=? WHERE machine_id=?').bind(mid, ph).run();
      await DB.prepare('UPDATE sales SET machine_id=? WHERE machine_id=?').bind(mid, ph).run();
      try { await DB.prepare('UPDATE referral_rewards SET friend_mid=? WHERE friend_mid=?').bind(mid, ph).run(); } catch (e) {}
      log('info', 'activation_code_redeemed', { code, mid, orderId: ac.order_id });
      if (ac.uid) {
        await sendText(ac.uid,
          '🎉 <b>አማርኛ ካፕሽን ፕሮ በኮምፒውተርዎ ላይ ነቅቷል!</b>\n<i>Amharic Captions Pro is now activated on your computer.</i>\n\n' +
          'እርስዎ ካልሆኑ ወዲያውኑ ይጻፉልን። <i>If this was not you, message us right away.</i>');
      }
      return json({ ok: true, key });
    }

    // POST /api/license → {mid, nonce} → {status: none|pending|rejected|revoked|approved, key?}
    // The panel that pressed Buy keeps a random secret (nonce) that only it and
    // this order know. Once the order is approved, the panel fetches its key
    // with it and activates itself — nothing for the customer to paste.
    if (request.method === 'POST' && url.pathname === '/api/license') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const mid = String((body && body.mid) || '').trim().toLowerCase();
      const nonce = String((body && body.nonce) || '');
      if (!isValidMid(mid) || !/^[A-Za-z0-9]{12,32}$/.test(nonce)) return json({ error: 'bad request' }, 400);
      if (await tooMany('rl:lic:' + clientIp(), 12, 60)) return json({ status: 'wait', retry: true }, 429);
      let o = null;
      try {
        o = await DB.prepare(
          'SELECT status FROM orders WHERE machine_id=? AND nonce=? ORDER BY id DESC LIMIT 1').bind(mid, nonce).first();
      } catch (e) { return json({ status: 'none' }); }
      if (!o) return json({ status: 'none' });
      if (o.status === 'pending') return json({ status: 'pending' });
      if (o.status !== 'approved') return json({ status: o.status === 'revoked' ? 'revoked' : 'rejected' });
      const c = await DB.prepare('SELECT key, revoked FROM customers WHERE machine_id=?').bind(mid).first();
      if (!c || c.revoked) return json({ status: c ? 'revoked' : 'pending' });
      return json({ status: 'approved', key: c.key });
    }

    // POST /api/validate → {mid, key} → {valid, expiry?}
    if (request.method === 'POST' && url.pathname === '/api/validate') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const { mid, key } = body || {};
      const hf = validHostFp(body && body.hf) ? body.hf : '';
      if (!mid || !key || !isValidMid(mid) || typeof key !== 'string' || key.length > 256) {
        return json({ error: 'missing mid or key' }, 400);
      }
      if (!SECRET) {
        log('error', 'license_hmac_secret_missing');
        return json({ error: 'license validation unavailable' }, 503);
      }
      if (!SIGN_KEY) {
        log('error', 'lease_signing_key_missing');
        return json({ error: 'lease signing unavailable' }, 503);
      }
      const midKey = String(mid).trim().toLowerCase();
      const clean = canonicalLicenseKey(key);
      const keyMidLength = clean.length === 32 ? 8 : (clean.length === 40 ? 16 : 0);
      const hasValidKeyShape = keyMidLength > 0 && /^[0-9a-f]+$/.test(clean);
      // Do not cache malformed input: a later correctly-formatted key with the
      // same Machine ID must not inherit the malformed request's result.
      const cacheKey = hasValidKeyShape ? ('val:' + midKey + ':' + clean) : null;
      let out = null;
      if (cacheKey) {
        const cached = await kvGet(cacheKey);
        if (cached) { try { out = JSON.parse(cached); } catch (e) {} }
      }
      // A positive KV hit is only a performance hint. Re-check the authoritative
      // customer row so revocation/expiry cannot remain live for an hour when a
      // cache invalidation request fails or races with a deploy.
      if (out && out.valid) {
        const row = await DB.prepare('SELECT expiry, revoked, key FROM customers WHERE machine_id=?').bind(midKey).first();
        let rowReason = '';
        if (!row || canonicalLicenseKey(row.key) !== clean) rowReason = 'not_found';
        else if (row.revoked) rowReason = 'revoked';
        else {
          const cachedMid = clean.slice(0, keyMidLength);
          const cachedExp = clean.slice(keyMidLength, keyMidLength + 8);
          const cachedSig = clean.slice(keyMidLength + 8, keyMidLength + 24).toLowerCase();
          const primarySig = await hmacHex(SECRET, `${cachedMid}|${cachedExp}`);
          const previousSig = SECRET_PREV ? await hmacHex(SECRET_PREV, `${cachedMid}|${cachedExp}`) : '';
          if (!safeEqual(cachedSig, primarySig.slice(0, 16)) && !safeEqual(cachedSig, previousSig.slice(0, 16))) {
            rowReason = 'bad_signature';
          }
        }
        if (!rowReason && row.expiry && row.expiry !== '00000000') {
          const expDate = new Date(row.expiry.slice(0, 4) + '-' + row.expiry.slice(4, 6) + '-' + row.expiry.slice(6, 8));
          if (isNaN(expDate.getTime()) || expDate < new Date()) rowReason = 'expired';
        }
        if (rowReason) {
          out = { valid: false, reason: rowReason };
          await kvDel(cacheKey);
        }
      }
      if (!out) {
        // Brute-force/throttle guards cover EVERY cache miss (malformed keys
        // included) — a spray of random keys must be cooled per IP before it
        // even reaches signature checks, let alone D1.
        if (await rateLimited('rl:ip:' + clientIp() + ':validate', 60)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        if (await rateLimited('rl:val:' + midKey, 60)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        if (!hasValidKeyShape) {
          out = { valid: false, retry: true };
        } else {
          const kmid = clean.slice(0, keyMidLength);
          const kexp = clean.slice(keyMidLength, keyMidLength + 8);
          const ksig = clean.slice(keyMidLength + 8, keyMidLength + 24);
          // Cryptographic gate (the row check alone is NOT an auth boundary: a
          // key leaked from logs/exports must not validate). Re-derive the HMAC
          // over mid|expiry exactly like keygen.py / keyFor() does at mint time.
          if (!SECRET) {
            log('error', 'validate_missing_secret');
            return json({ error: 'server not configured' }, 503);
          }
          const expected = await hmacHex(SECRET, `${kmid}|${kexp}`);
          let sigOk = safeEqual(expected.slice(0, 16), ksig);
          // Rotation grace: a key minted under the previous secret is still
          // honoured. Checked ONLY after the current secret fails, and never
          // used for minting, so rotating still takes effect for new keys.
          if (!sigOk && SECRET_PREV) {
            const prev = await hmacHex(SECRET_PREV, `${kmid}|${kexp}`);
            sigOk = safeEqual(prev.slice(0, 16), ksig);
            if (sigOk) {
              // Tells you whether the old secret is still load-bearing, i.e.
              // whether it is safe to clear AMH_SECRET_PREV yet.
              log('warn', 'key_validated_with_previous_secret', { mid: String(mid) });
            }
          }
          if (kmid !== String(mid).trim().toLowerCase()) {
            out = { valid: false, reason: 'machine_mismatch' };
          } else if (!sigOk) {
            out = { valid: false, reason: 'bad_signature', retry: true };
          } else {
            // Signature is authentic → fall through to the authoritative DB row
            // (revoked / expiry / shared-spread logic unchanged).
            // Read by the unique Machine ID, then compare canonical key bodies
            // in JS. This supports both legacy formatted rows and the new
            // canonical representation without trusting presentation format.
            const row = await DB.prepare('SELECT expiry, revoked, key FROM customers WHERE machine_id = ?').bind(midKey).first();
            if (!row || canonicalLicenseKey(row.key) !== clean) {
              out = { valid: false };
            } else if (row.revoked) {
              out = { valid: false, reason: 'revoked' };
            } else if (row.expiry && row.expiry !== '00000000') {
              const expDate = new Date(row.expiry.slice(0, 4) + '-' + row.expiry.slice(4, 6) + '-' + row.expiry.slice(6, 8));
              out = (isNaN(expDate.getTime()) || expDate < new Date())
                ? { valid: false, reason: 'expired' }
                : { valid: true, expiry: row.expiry };
            } else {
              out = { valid: true, expiry: row.expiry };
            }
          }
        }
        if (cacheKey) await kvPut(cacheKey, JSON.stringify(out), out.valid ? 3600 : 60);
      }
      // A known-good key is served from cache for an hour — but every VALID
      // response still records the activation (IP for support, computer
      // fingerprint for sharing), not just the first one.
      if (out.valid) {
        const okActivation = await recordKeyActivation(clean, midKey, clientIp(), hf);
        if (!okActivation) {
          // Not cached: the answer depends on WHICH computer asks — the
          // buyer's own one must keep working.
          out = { valid: false, reason: 'shared' };
        }
      }
      if (out.valid) {
        try {
          // A valid license without a signed lease is not activatable by the
          // current panel. Never return a boolean-only success to a client
          // that is required to verify a lease.
          out.token = await signLease(midKey, out.expiry || '00000000');
        } catch (e) {
          log('error', 'lease_sign_failed', { err: String(e && e.message || e) });
          return json({ error: 'lease signing unavailable' }, 503);
        }
      }
      return json(out);
    }

    // Telegram POSTs updates here
    if (request.method === 'POST') {
      // Webhook authenticity: Telegram sends X-Telegram-Bot-Api-Secret-Token
      // when setWebhook registers a secret_token. Without it, a stranger
      // could forge updates (admin callbacks) and approve/decline orders.
      // FAIL CLOSED: if the secret is not configured the worker refuses
      // updates entirely (Telegram will surface this as a webhook error).
      if (!WEBHOOK_SECRET) {
        log('error', 'webhook_secret_missing');
        return new Response('webhook secret not configured', { status: 500 });
      }
      if (!TOKEN || !ADMIN_ID) {
        log('error', 'telegram_config_missing');
        return new Response('telegram configuration incomplete', { status: 503 });
      }
      const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!safeEqual(given, WEBHOOK_SECRET)) {
        log('warn', 'webhook_auth_failed');
        return new Response('unauthorized', { status: 401 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('bad', { status: 400 }); }
      const updateId = Number(update && update.update_id);
      if (!Number.isSafeInteger(updateId) || updateId < 0) {
        return new Response('missing update_id', { status: 400 });
      }

      // Claim the Telegram update before doing any work. Completed retries are
      // acknowledged; a still-running claim returns 5xx so Telegram retries,
      // and an abandoned claim older than the lease is reclaimed atomically.
      try {
        const claim = await DB.prepare(
          `INSERT OR IGNORE INTO webhook_updates
             (update_id, completed_at, claimed_at)
           VALUES (?, NULL, datetime('now'))`
        ).bind(updateId).run();
        if (!claim || !claim.meta || claim.meta.changes < 1) {
          const prior = await DB.prepare(
            'SELECT completed_at, claimed_at FROM webhook_updates WHERE update_id=?'
          ).bind(updateId).first();
          if (prior && prior.completed_at) return new Response('duplicate', { status: 200 });
          const reclaimed = await DB.prepare(
            `UPDATE webhook_updates SET claimed_at=datetime('now')
             WHERE update_id=? AND completed_at IS NULL
               AND (claimed_at IS NULL OR claimed_at='' OR claimed_at < datetime('now','-10 minutes'))`
          ).bind(updateId).run();
          if (!reclaimed || !reclaimed.meta || reclaimed.meta.changes < 1) {
            return new Response('update already processing', { status: 503 });
          }
        }
      } catch (e) {
        log('error', 'webhook_claim_failed', { update_id: updateId, err: String(e && e.message || e) });
        return new Response('webhook storage unavailable', { status: 503 });
      }

      try {
        if (update.message) await handleMessage(update.message, env);
        else if (update.callback_query) await handleCallback(update.callback_query);
        await DB.prepare(
          'UPDATE webhook_updates SET completed_at = datetime(\'now\'), claimed_at = NULL WHERE update_id = ?'
        ).bind(updateId).run();
        return new Response('ok', { status: 200 });
      } catch (e) {
        try {
          await DB.prepare('DELETE FROM webhook_updates WHERE update_id = ?').bind(updateId).run();
        } catch (cleanupError) {
          log('error', 'webhook_claim_release_failed', { update_id: updateId });
        }
        log('error', 'handler_error', { update_id: updateId, err: String(e && e.message || e) });
        return new Response('handler error', { status: 500 });
      }
    }

    return new Response('method not allowed', { status: 405 });
  },

  // Cron trigger: prune the 30-day window on a schedule so unmetered admin
  // activity is never depended on (see wrangler.toml [triggers] crons).
  async scheduled(event, env) {
    initEnv(env);
    // Every minute: send the next batch of a running broadcast (one cheap
    // query when there is none). Every 6 hours: housekeeping.
    if (event && event.cron === '* * * * *') {
      await processBroadcast(BCAST_BATCH_CRON);
      try { await syncBotCommands(); } catch (e) { log('error', 'commands_sync_failed', { err: String((e && e.message) || e) }); }
      try { await scanJobs(); } catch (e) { log('error', 'jobs_scan_failed', { err: String((e && e.message) || e) }); }
      return;
    }
    try { await postWeeklyJobsDigest(); } catch (e) { log('error', 'jobs_digest_failed', { err: String((e && e.message) || e) }); }
    await nudgeQuietBuyers();
    await pruneOld();
    await remindReferralPayouts();
    await sendMonthlyPartnerReports();
  },
};
