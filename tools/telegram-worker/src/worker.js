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
  const mid = String(machineId).toLowerCase();
  if (mid.length !== 8 || !/^[0-9a-f]{8}$/.test(mid)) throw new Error('Invalid Machine ID');
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

// ── signed install lease (verify side: panel/js/core.js verifyLicenseToken) ─
// The panel ships only LICENSE_TOKEN_PUBKEY_PEM — the public half of the key
// below — so a stored localStorage license can be verified LOCALLY, and a
// hand-written {valid:true} cannot unlock the panel once the lease scheme is
// live. The private half lives only in this worker: env secret
// AMH_LICENSE_SIGNING_KEY (PKCS8 PEM). While that secret is unset, /api/validate
// simply returns no `token` and the current panel keeps its legacy accept path,
// so the scheme can be enabled progressively (set secret -> redeploy panel).
async function signLease(machineId, expiry) {
  const mid = String(machineId).toLowerCase();
  const exp = String(expiry || '00000000');
  const der = pemToDer(SIGN_KEY);
  if (!der) throw new Error('AMH_LICENSE_SIGNING_KEY not set');
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const msg = new TextEncoder().encode(mid + '|' + exp);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg));
  const sigHex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'v1.' + mid + exp + '.' + sigHex; // matches licenseTokenParse() in core.js
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
let API_KEY = ''; // shared secret for /api/* (panel). Enforcement on when set.
let SIGN_KEY = ''; // PKCS8 PEM (ECDSA P-256) for signing install leases. Optional.
let CACHE = null; // optional KV namespace (AMH_KV). Absent => graceful fallback.
let BLOCK_SHARED = false;  // when '1', /api/validate refuses a key seen from too many IPs
let SPREAD_THRESHOLD = 3;  // distinct source IPs per key before we alert/flag a spread
let FRESH_MID_LIMIT = 5;   // max new (never-before-seen) mids per IP per day before /api/trial/use 429s

// ── config / env ────────────────────────────────────────────────────────────
function initEnv(env) {
  TOKEN = env.AMH_TG_TOKEN || '';
  // Fail-safe: never fall back to a hardcoded admin. Without AMH_ADMIN_ID
  // nobody is admin (approve/reject/broadcast all refuse), which is better than
  // silently granting an arbitrary Telegram user admin rights by default.
  ADMIN_ID = (env.AMH_ADMIN_ID || '').toString();
  if (!ADMIN_ID) log('warn', 'admin_id_missing', { hint: 'set AMH_ADMIN_ID (comma-separated chat ids) via wrangler secret put' });
  GROUP_ID = env.AMH_GROUP_ID || '';
  PRICE = env.AMH_PRICE || 'ETB 2,500';
  ACCT_NAME = env.AMH_ACCT_NAME || ACCT_NAME;
  PAY_ACCOUNTS = env.AMH_PAY_ACCOUNTS || PAY_ACCOUNTS;
  SECRET = env.AMH_SECRET || '';
  SECRET_PREV = env.AMH_SECRET_PREV || '';
  WEBHOOK_SECRET = env.AMH_WEBHOOK_SECRET || '';
  API_KEY = env.AMH_API_KEY || '';
  SIGN_KEY = env.AMH_LICENSE_SIGNING_KEY || '';
  ALLOWED_ORIGIN = env.AMH_ALLOWED_ORIGIN || '';
  PRICE_ETB = parseInt(env.AMH_PRICE_ETB, 10) || parseInt(PRICE.replace(/[^\d]/g, ''), 10) || 2500;
  BLOCK_SHARED = String(env.AMH_BLOCK_SHARED || '').toLowerCase() === '1';
  SPREAD_THRESHOLD = parseInt(env.AMH_SPREAD_THRESHOLD, 10) || 3;
  FRESH_MID_LIMIT = parseInt(env.AMH_FRESH_MID_DAY, 10) || 5;
  CACHE = env.AMH_KV || null;
  globalThis.DB = env.DB;
}

// ── tiny shared helpers (KV cache, rate-limit marker, throttle) ─────────────
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function kvGet(key) { try { return CACHE ? await CACHE.get(key) : null; } catch (e) { return null; } }
async function kvPut(key, val, ttl) { try { if (CACHE) await CACHE.put(key, String(val), { expirationTtl: ttl }); } catch (e) {} }
async function kvDel(key) { try { if (CACHE) await CACHE.delete(key); } catch (e) {} }
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── menu text (port from bot.py) ────────────────────────────────────────────
function heroText(first = '') {
  const name = first ? `${first}, ` : '';
  return (
    `${name}ወደ <b>አማርኛ ካፕሽን</b> እንኳን በደህና መጡ 👋\n` +
    '<i>Welcome to Amharic Captions</i>\n\n' +
    '💯 ሙሉ በሙሉ <b>በኮምፒውተርዎ ላይ</b> ይሰራል — ኢንተርኔት አያስፈልግም።\n' +
    '<i>100% offline — no internet needed, nothing is uploaded.</i>\n\n' +
    '🎁 <b>2 ካፕሽን በነጻ</b> ይሞክሩ — ከወደዱት በኋላ ብቻ ይክፈሉ።\n' +
    '<i>Try 2 captions free — pay only if you like it.</i>\n\n' +
    `💰 <s>ETB 3,500</s> → <b>${PRICE}</b> — አንድ ጊዜ ብቻ፣ ለዘላለም።\n` +
    '<i>One-time payment, lifetime license.</i>'
  );
}
// One button per row on purpose: Amharic labels are longer than their English
// equivalents, and two per row truncates them with an ellipsis on a phone.
const heroKeyboard = () => [
  [{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }],
  [{ text: '🔑 ቁልፌ · My Key', callback_data: 'menu:mykey' }],
  [{ text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` }],
  [{ text: '💬 ድጋፍ · Support', url: 'https://t.me/+L-bMfmIRyEo3MDg0' }],
];

// Admin-only keyboard (no buyer buttons). Tapped on /start by the shop owner.
const adminKeyboard = () => [
  [{ text: '📥 Requests', callback_data: 'admin:queue' }],
  [{ text: '🧾 History (30 days)', callback_data: 'admin:history' }],
  [{ text: '📈 Sales & funnel', callback_data: 'admin:sales' }],
];
function adminGreeting() {
  return (
    '🛠 <b>Admin</b>\n\n' +
    'Welcome back, boss 👋\n' +
    '📥 Open <b>Requests</b> to review the queue (newest first) — approve, decline, or view details on each.\n' +
    '🧾 <b>History</b> shows the last 30 days of activity.'
  );
}

// Amharic first, English under it. This is the screen where someone parts with
// ETB 2,500, and it was English-only — the panel and the website both speak
// Amharic, but the one moment that involves their money did not.
function payText() {
  return (
    '💰 <b>ክፍያ / Pay</b>\n\n' +
    `💵 ዋጋ: <s>ETB 3,500</s> → <b>${PRICE}</b> — አንድ ጊዜ ብቻ (one-time, forever)\n\n` +
    `🏦 የሚከፈለው ለ: <b>${ACCT_NAME}</b>\n` +
    'ባንክ ዝውውር (bank transfer) — ቁጥሩን ለመቅዳት ይንኩት:\n' +
    accountLines() + '\n\n' +
    '🔑 ክፍያዎ ከተረጋገጠ በኋላ ቁልፍዎ (license key) <b>በዚሁ ቻት</b> ይላክልዎታል።\n' +
    'Your key arrives <b>in this chat</b> once we confirm the payment.\n\n' +
    '⚠️ <b>ጥንቃቄ / Important</b>\n' +
    `ከላይ ካሉት አካውንቶች ውጭ ለማንም አይክፈሉ። ስም <b>${ACCT_NAME}</b> ብቻ ነው።\n` +
    'We will never ask you to pay a different name or account, and never for an ' +
    'extra fee. If someone does, they are not us.\n\n' +
    '👇 ከከፈሉ በኋላ ከታች ይንኩ / Tap below once you have paid.'
  );
}
const payKeyboard = () => [
  [{ text: '✅ ከፍያለሁ — ማረጋገጫ ልላክ · I’ve paid', callback_data: 'pay:proof' }],
  [{ text: '🎁 መጀመሪያ በነጻ ልሞክር · Try 2 free', url: `${SITE_URL}/install` }],
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
  await kvPut('pending:count', n, 5);
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
  const c = await DB.prepare("DELETE FROM ip_counters WHERE updated_at < datetime('now', '-30 days')").run();
  log('info', 'prune_run', {
    orders: o && o.meta ? o.meta.changes : 0,
    funnel: f && f.meta ? f.meta.changes : 0,
    key_activations: k && k.meta ? k.meta.changes : 0,
    ip_counters: c && c.meta ? c.meta.changes : 0,
  });
}
async function getFsm(uid) {
  const r = await DB.prepare('SELECT * FROM fsm WHERE uid = ?').bind(uid).first();
  return r || null;
}
async function setFsm(uid, s) {
  if (!s) {
    await DB.prepare('DELETE FROM fsm WHERE uid = ?').bind(uid).run();
    return;
  }
  await DB.prepare(
    `INSERT INTO fsm (uid, step, mid, photo_key, ref, hint, status_msg_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       step=excluded.step, mid=excluded.mid, photo_key=excluded.photo_key,
       ref=excluded.ref, hint=excluded.hint, status_msg_id=excluded.status_msg_id,
       updated_at=datetime('now')`
  ).bind(
    uid, s.step, s.mid || null, s.photo_key || null, s.ref || '', s.hint ? 1 : 0,
    s.status_msg_id != null ? s.status_msg_id : null
  ).run();
}
async function addFunnel(uid, event) {
  await DB.prepare('INSERT INTO funnel (uid, event) VALUES (?, ?)').bind(uid, event).run();
}

// ── message senders (never throw: an outbound failure must not abort the
// ─────────────────── handler or bubble up into a Telegram 500 retry loop) ──
function safeSend(promise) { return promise.catch(() => ({ ok: false })); }
function sendText(chatId, text, kb) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return safeSend(tg(TOKEN, 'sendMessage', params));
}
function editText(chatId, messageId, text, kb) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return safeSend(tg(TOKEN, 'editMessageText', params));
}
// Swap only the buttons on an existing message. The order card can be a PHOTO
// (the payment screenshot) as well as text, and editMessageText fails on a
// photo message — editMessageReplyMarkup works for both, which matters because
// the decline-reason picker replaces the buttons under whichever it is.
function editKeyboard(chatId, messageId, kb) {
  return safeSend(tg(TOKEN, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId,
    reply_markup: { inline_keyboard: kb },
  }));
}

function sendPhoto(chatId, photo, caption, kb) {
  const params = { chat_id: chatId, photo, caption, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return safeSend(tg(TOKEN, 'sendPhoto', params));
}
function answerCb(id, text) {
  return safeSend(tg(TOKEN, 'answerCallbackQuery', { callback_query_id: id, text: text || '' }));
}

// One-time reply keyboard hint for the Machine ID prompt (a cheap affordance —
// the keyboard vanishes after the first tap thanks to one_time_keyboard).
// Kept only so the old reply-keyboard button still works for anyone who has
// one stuck in their chat from a previous version.
const MACHINE_ID_HINT_KEY = '📍 Show me where to find my Machine ID';

// The Machine ID prompt used to carry a REPLY keyboard (the bar pinned to the
// bottom of the chat). Telegram leaves those on screen until something removes
// them, and Cancel never did — so "Send your Machine ID (8 characters)" stayed
// visible after the buyer had abandoned the flow. It also duplicated an inline
// "Where is it?" button that was already on the same message. Inline only now,
// so nothing can get stuck.
const MID_HELP_KB = [
  [{ text: '📍 Machine ID የት ነው? · Where is it?', url: `${SITE_URL}/install` }],
  [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
];
function sendHintKb(chatId, text) {
  return sendText(chatId, text, MID_HELP_KB);
}

// Clears a reply keyboard left over from an older version of the bot. Telegram
// has no way to remove one except by sending a message, so this rides along
// with something the buyer wanted anyway.
function sendClearingKb(chatId, text) {
  return safeSend(tg(TOKEN, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  }));
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

  // Group welcome for new members
  if (msg.new_chat_members) {
    await sendText(chatId, groupWelcome(), MENU_KEYBOARD);
    return;
  }

  // /start etc.
  const lower = text.toLowerCase();
  if (['/start', '/start@amhariccaptionsbot', '/menu', 'menu'].includes(lower)) {
    if (privateChat) {
      if (isAdmin(user.id)) {
        await sendText(chatId, adminGreeting(), adminKeyboard());
      } else {
        await sendText(chatId, heroText(first), heroKeyboard());
      }
    } else await sendText(chatId, groupWelcome(), MENU_KEYBOARD);
    return;
  }
  if (lower === '/mykey' || lower === '/mykey@amhariccaptionsbot') {
    if (privateChat) await showMyKey(msg, chatId, null);
    return;
  }
  if (lower === '/admin' || lower === '/admin@amhariccaptionsbot') {
    if (privateChat && isAdmin(user.id)) await adminPanel(chatId, null);
    else await sendText(chatId, '🔒 Admin only.');
    return;
  }

  // admin: custom expiry for a pending/approved order → /setexpiry ORDERID YYYYMMDD
  if (privateChat && isAdmin(user.id)) {
    const ex = text.match(/^\/(?:setexpiry|expiry)\s+(\d+)\s+(\d{4})(\d{2})(\d{2})$/i);
    if (ex) {
      const id = ex[1];
      const exp = ex[2] + ex[3] + ex[4];
      const r = await DB.prepare('UPDATE orders SET expiry=? WHERE id=?').bind(exp, id).run();
      const n = r && r.meta ? r.meta.changes : 0;
      await sendText(chatId, n
        ? `⏰ Order <b>#${id}</b> → expiry <code>${exp}</code>. Approve it and the key will embed this date.`
        : `⚠️ Order <b>#${id}</b> not found.`);
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
  }

  // admin: broadcast draft pending → next free-text message goes to all buyers
  if (isAdmin(user.id)) {
    const bd = await kvGet('bcast:await:' + uid);
    if (bd && !lower.startsWith('/')) {
      await kvDel('bcast:await:' + uid);
      await broadcastText(chatId, text);
      return;
    }
  }

  // photos / documents (payment screenshot)
  if (msg.photo || msg.document) {
    await handlePhoto(msg, uid, chatId, privateChat, text);
    return;
  }

  // generic buy-flow commands
  if (['/buy', '/buy@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId, heroText(first), heroKeyboard());
    return;
  }

  // FSM buy flow
  await handleBuyerMessage(msg, uid, chatId, privateChat, text);
}

function groupWelcome() {
  return (
    'ሰላም! ወደ <b>አማርኛ ካፕሽን</b> እንኳን በደህና መጡ 👋\n\n' +
    '🎁 <b>2 ነጻ (free) ካፕሽን በመጀመሪያ ይሞክሩ</b> — እወደው ከሆነ ብቻ ነው ' +
    'የሚከፍሉት።\n\n' +
    'ይህ ሶፍትዌር፣ Premiere Pro ላይ ቪዲዮዎን በራስ-ሰር በ<b>አማርኛ ንዑስ ርዕስ</b> ' +
    '(subtitle) ያስቀምጥልዎታል። ሙሉ በሙሉ በኮምፒውተርዎ ላይ ነው የሚሰራው (offline)።\n\n' +
    `💰 ዋጋ: <s>ETB 3,500</s> → <b>${PRICE}</b> (አንድ ጊዜ)\n` +
    `🏦 የሚከፈለው: ባንክ ዝውውር (bank transfer) ወደ <b>${ACCT_NAME}</b>\n` +
    accountLines() + '\n' +
    '🖥 Windows & Mac\n' +
    '⏰ <b>መግቢያ ዋጋ</b> — አሁኑኑ ይጠቀሙ!'
  );
}

// ── Buyer FSM flow (port of handle_buyer_message) ───────────────────────────
const MACHINE_ID_RE = /\b[0-9a-f]{8}\b/;
function suspiciousMid(mid) {
  mid = mid.toLowerCase();
  if (mid.length !== 8) return true;
  if (new Set(mid).size === 1) return true;
  if (['00000000', '11111111', '12345678', 'abcdef01', 'deadbeef', 'feedface', 'cafebabe'].includes(mid)) return true;
  const seq = '0123456789abcdef';
  for (let i = 0; i <= seq.length - 8; i++) {
    if (mid === seq.slice(i, i + 8) || mid === [...seq.slice(i, i + 8)].reverse().join('')) return true;
  }
  return false;
}

async function handleBuyerMessage(msg, uid, chatId, privateChat, text) {
  const s = await getFsm(uid);
  const step = s ? s.step : null;

  // reply-keyboard hint tapped → show where to find the Machine ID
  if (text === MACHINE_ID_HINT_KEY) {
    await sendText(chatId,
      '📲 <b>Where is my Machine ID?</b>\n\nOpen the <b>Amharic Captions panel</b> in Premiere Pro → <b>License</b> tab → your ID is the <b>8-character code</b> under <i>“Your Machine ID”</i> (e.g. <code>a1b2c3d4</code>).\n\nThen send it here.',
      [[{ text: '📲 አጫጫን · Install guide', url: `${SITE_URL}/install` }]]);
    return;
  }

  // step photo: waiting for screenshot
  if (step === 'photo') {
    await sendText(chatId,
      '📸 የክፍያ ማረጋገጫ <b>ፎቶ</b> እየጠበቅሁ ነው — የባንክ ዝውውሩን screenshot ይላኩ።\n' +
      '<i>Waiting for your screenshot — send the bank-transfer confirmation as a photo.</i>', [
      [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
    ]);
    return;
  }

  // step mid: waiting for Machine ID
  if (step === 'mid') {
    const m = text.match(MACHINE_ID_RE);
    if (!m) {
      await sendHintKb(chatId,
        '⚠️ የእርስዎ <b>Machine ID</b> ያስፈልገኛል — በፓናሉ <b>License</b> ክፍል ውስጥ ያለው <b>8 ፊደል</b> ኮድ ነው።\n' +
        `<i>I need your Machine ID — the 8-character code in the panel's License section (e.g. <code>a1b2c3d4</code>).</i>`);
      return;
    }
    const mid = m[0].toLowerCase();
    const existing = await findKey(mid);
    if (existing) {
      await sendText(chatId,
        `🔑 This Machine ID (<code>${mid}</code>) already has a key.\n\nTap <b>My Key</b> below to see it, or contact the seller if it's not working.`,
        [[{ text: '🔑 ቁልፌ · My Key', callback_data: 'proof:mykey' }], [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
      await setFsm(uid, null);
      return;
    }
    if (suspiciousMid(mid)) {
      await sendText(chatId,
        `⚠️ <code>${mid}</code> ትክክለኛ <b>Machine ID</b> አይመስልም።\n\n` +
        'በፓናሉ <b>License</b> ክፍል ውስጥ "Your Machine ID" ስር ያለውን <b>8 ፊደል</b> ኮድ ይላኩ (ለምሳሌ <code>a1b2c3d4</code>)።\n' +
        '<i>That does not look like a Machine ID — send the 8-character code from the panel.</i>',
        [[{ text: '📍 Machine ID የት ነው? · Where is it?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
      return;
    }
    // valid new machine -> ask for screenshot
    await setFsm(uid, { step: 'photo', mid, photo_key: null, hint: 1 });
    await addFunnel(uid, 'mid_sent');
    await sendText(chatId,
      '✅ Machine ID ደርሶናል!\n\n' +
      '📤 <b>ደረጃ 2/2</b> — አሁን የባንክ ዝውውር ማረጋገጫ <b>ፎቶ</b> (screenshot) ይላኩ።\n' +
      '<i>Step 2 of 2 — now send your bank-transfer screenshot as a photo.</i>',
      [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
    return;
  }

  // step confirm: a stray text while reviewing -> resend the review
  if (step === 'confirm') {
    await reviewConfirm(uid, chatId);
    return;
  }

  // Not in FSM: a bare Machine ID
  const m = text.match(MACHINE_ID_RE);
  if (!m) {
    // unknown input
    const buyerName = (msg.from && msg.from.first_name) || '';
    if (privateChat) await sendText(chatId, `😊 ${buyerName}, I didn't understand that. What would you like to do? Choose below:`, MENU_KEYBOARD);
    else await sendText(chatId, MENU, MENU_KEYBOARD);
    return;
  }
  // Remember it. The panel's Buy button opens this chat with the Machine ID
  // already in the message, and we used to acknowledge it and then ask for it
  // again later — throwing away the one thing the panel had just prefilled and
  // making the buyer hand-copy an 8-character id after all. Stash it now and
  // the proof flow skips straight to the screenshot.
  const seen = m[0].toLowerCase();
  if (!suspiciousMid(seen)) {
    await setFsm(uid, { step: 'have_mid', mid: seen, photo_key: null, ref: '', hint: 1 });
    await sendText(chatId,
      `✅ Machine ID ተቀብያለሁ: <code>${seen}</code>\n` +
      '<i>Got your Machine ID — you will not need to type it again.</i>\n\n' +
      'ክፍያውን ለመፈጸም ከታች ይንኩ።\n<i>Tap below to see the payment details.</i>',
      [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]]);
    return;
  }
  await sendText(chatId,
    '👋 ይህ Machine ID ይመስላል። ለመክፈል ከታች ይጀምሩ።\n' +
    '<i>That looks like a Machine ID — tap Pay to start.</i>',
    [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]]);
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

  if (step === 'photo') {
    if (isDocument && !mime.startsWith('image/')) {
      await sendText(chatId,
        '📁 That came through as a <b>file</b>, not a photo.\n\nSend the payment screenshot as a <b>photo/image</b> so we can verify it.',
        [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
      return;
    }
    const objectKey = await storeProof(fileId);
    await setFsm(uid, { ...s, photo_key: objectKey, step: 'confirm' });
    await addFunnel(uid, 'screenshot_sent');
    await sendText(chatId, '✅ ፎቶው ደርሶናል!\n\n📤 ትዕዛዝዎን በአጭሩ እናረጋግጥ:\n<i>Screenshot received — a quick check of your order:</i>');
    await reviewConfirm(uid, chatId);
    return;
  }
  if (step === 'confirm') {
    await sendText(chatId, '✅ We already have your screenshot! Here’s your order review:');
    await reviewConfirm(uid, chatId);
    return;
  }
  if (step === 'mid') {
    const objectKey = await storeProof(fileId);
    await setFsm(uid, { ...s, photo_key: objectKey });
    await sendText(chatId, '📸 ፎቶው ተቀምጧል! አሁን የእርስዎን <b>Machine ID</b> ይላኩ (በፓናሉ License ክፍል ውስጥ ያለው 8 ፊደል ኮድ)።\n' +
      '<i>Screenshot saved — now send your Machine ID.</i>',
      [[{ text: '📍 Machine ID የት ነው? · Where is it?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
    return;
  }
  await sendText(chatId,
    '🖼 Thanks — but to place an order please start the guided flow and send your <b>Machine ID</b> first:\n\n1️⃣ Tap <b>💳 Pay</b>\n2️⃣ Tap <b>I\'ve paid — send proof</b>',
    [[{ text: '💳 ክፍያ · Pay', callback_data: 'menu:pay' }]]);
}

async function storeProof(fileId) {
  // A file_id that arrived inside a real Telegram update is always valid to
  // re-send via sendPhoto. We deliberately do NOT round-trip through getFile:
  // that extra network call is the only place a screenshot could get dropped.
  return fileId || null;
}

// ── review + confirm ────────────────────────────────────────────────────────
async function reviewConfirm(uid, chatId) {
  const s = await getFsm(uid);
  if (!s) return;
  const text =
    '🧾 <b>ትዕዛዝዎን ያረጋግጡ / Review your order</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 ዋጋ / Amount: <b>${PRICE}</b>\n` +
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

// ── complete proof -> create pending order + notify admin ───────────────────
async function completeProof(uid, chatId, uname, privateChat) {
  const s = await getFsm(uid);
  if (!s || !s.mid) return;

  // Require a payment screenshot before booking. A missing proof means
  // storeProof hiccups or the photo step was somehow skipped — send them
  // back to the photo step rather than creating a proofless order.
  if (!s.photo_key) {
    await setFsm(uid, { ...s, step: 'photo' });
    await sendText(chatId,
      '⚠️ <b>Screenshot missing.</b> Please resend your payment screenshot as a photo.',
      [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
    return;
  }

  // Atomically insert + claim: the unique partial index on
  // (machine_id WHERE status='pending') blocks duplicate pending orders
  // for the same machine. On duplicate (constraint error) we tell the
  // buyer and clean up the FSM safely.
  let orderId;
  try {
    const order = await DB.prepare(
      `INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb)
       VALUES (?, ?, ?, '', ?, ?, 'pending', ?)`
    ).bind(uid, uname || 'anon', s.mid, s.photo_key, String(chatId), PRICE_ETB).run();
    orderId = order.meta.last_row_id;
  } catch (err) {
    const isDupe = /UNIQUE/i.test(String(err));
    await setFsm(uid, null);
    await sendText(chatId, isDupe
      ? '⚠️ A pending order for this Machine ID already exists — please wait for admin approval.'
      : '⚠️ Something went wrong saving your order. Please try again, or contact the seller.');
    return;
  }

  // Claim succeeded — side-effects are safe (runs once).
  await setFsm(uid, null);
  await kvDel('pending:count');
  await addFunnel(uid, 'order_confirmed');
  log('info', 'order_created', { orderId, mid: s.mid, uid, amount_etb: PRICE_ETB, source: privateChat ? 'DM' : 'Group' });

  // status + ETA to buyer
  const pos = await pendingCount();
  const statusText =
    '📦 <b>ትዕዛዝዎ ደርሶናል / Order received</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 ዋጋ / Amount: <b>${PRICE}</b>\n\n` +
    `⏳ <b>በመጠባበቅ ላይ / Pending</b> — በተራ <b>#${pos}</b> ላይ ነዎት።\n` +
    'ቁልፍዎ አብዛኛውን ጊዜ በጥቂት ሰዓታት ውስጥ (በኢትዮጵያ የስራ ሰዓት) በዚሁ ቻት ይላክልዎታል። 🙏\n' +
    '<i>Keys are usually issued within a few hours, Ethiopian working hours. ' +
    "We'll send it right here.</i>";
  const r = await sendText(chatId, statusText);
  const statusMsgId = r && r.ok ? r.result.message_id : null;
  if (statusMsgId) await DB.prepare('UPDATE orders SET status_msg_id=? WHERE id=?').bind(statusMsgId, orderId).run();

  // notify admin (throttled so a queue of cards doesn't hit Telegram 429)
  const admins = await adminList();
  for (const adm of admins) {
    const caption =
      '🧾 <b>New order — payment proof</b>\n\n' +
      `Machine ID: <code>${s.mid}</code>\nUser: @${uname} (id ${uid})\nSource: ${privateChat ? 'DM' : 'Group'}\n\n` +
      'Check the screenshot, then Approve or Reject:';
    if (s.photo_key) await sendPhoto(adm, s.photo_key, caption, adminKeyboardPend(orderId));
    else await sendText(adm, caption, adminKeyboardPend(orderId));
    await sleep(90); // ~11 msg/s — admin cards have 1 photo each; calm under 30/s
  }
}

// multi-admin support (comma-separated AMH_ADMIN_ID)
async function adminList() {
  return adminUids();
}

// ── show my key ─────────────────────────────────────────────────────────────
function keyDeliveryMessage(key, expiry, chatType) {
  const lines = [
    '✅ <b>ክፍያዎ ተረጋግጧል — ቁልፍዎ ደርሷል!</b>',
    '<i>Payment confirmed — your license key is ready.</i>',
    '', `<code>${key}</code>`, '',
    '<b>①</b> ቁልፉን ይቅዱ (ይንኩት) — <i>tap the key to copy</i>',
    '<b>②</b> Premiere Pro → ፓናሉን ይክፈቱ → <b>License</b>',
    '<b>③</b> ይለጥፉ → <b>Activate</b> ይንኩ — <i>paste, then Activate</i>',
  ];
  if (expiry !== '00000000') lines.push('', `⏰ የሚያበቃበት / Expires: ${expiry}`);
  if (chatType !== 'private') {
    lines.push('', '🔒 ለደህንነትዎ ቁልፍዎን በግል መልእክት (DM) ይጠይቁ።\n<i>For privacy, ask for your key in a private DM.</i>');
  }
  lines.push('', 'እናመሰግናለን! 🙏 ችግር ካጋጠመዎት ይጻፉልን።\n<i>Thank you — message us if anything goes wrong.</i>');
  return lines.join('\n');
}

async function showMyKey(msg, chatId, messageId) {
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
  if (!list.length) {
    const text = '🔑 <b>My Key</b>\n\nI couldn\'t find a key linked to <b>this Telegram account</b> yet.\n\nIt will appear here automatically after your purchase is approved. If you paid and don\'t see it, DM the seller with your Machine ID.';
    if (messageId) await editText(chatId, messageId, text, undefined);
    else await sendText(chatId, text, undefined);
    return;
  }
  const text = list.map((r) => `🤖 <code>${r.machine_id}</code>\n🔑 <code>${r.key}</code>\n`).join('\n');
  if (messageId) await editText(chatId, messageId, '🔑 <b>Your key(s)</b>\n\n' + text, undefined);
  else await sendText(chatId, '🔑 <b>Your key(s)</b>\n\n' + text, undefined);
}

// ── admin panel (modern dashboard + queue + audit) ─────────────────────────
const money = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const shortTs = (s) => (s ? String(s).slice(5, 16).replace(' ', ' ') : '—');
const orderSummary = (o) =>
  `<b>#${o.id}</b> · ${o.username ? '@' + o.username : 'anon'} · <code>${o.machine_id}</code> · ${shortTs(o.created_at)}`;

function adminKeyboardPend(orderId) {
  return [[
    { text: '✅ Approve', callback_data: `approve:${orderId}` },
    { text: '❌ Decline', callback_data: `reject:${orderId}` },
    { text: '👁 Details', callback_data: `admin:detail:${orderId}` },
  ]];
}

async function adminPanel(chatId, messageId) {
  await pruneOld();
  const pend = await pendingCount();
  const todayRow = await DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS ap, " +
    "COALESCE(SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END),0) AS rj, " +
    "COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pd " +
    "FROM orders WHERE date(created_at)=date('now')").first();
  const sold30 = await DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE status='approved' AND created_at >= datetime('now','-30 days')").first();
  const revenue = (sold30 ? sold30.n : 0) * PRICE_ETB;

  const text =
    `🛠 <b>Admin · Dashboard</b>\n\n` +
    `📥 <b>New requests:</b> ${pend}\n` +
    `   ├ ✅ Approved today: ${todayRow.ap}\n` +
    `   ├ ❌ Declined today: ${todayRow.rj}\n` +
    `   └ ⏳ Pending today:  ${todayRow.pd}\n\n` +
    `💵 <b>Revenue (30d):</b> ${sold30.n} × ${PRICE} = <b>ETB ${money(revenue)}</b>\n\n` +
    `⬇️ Review the request queue, or check recent activity.`;
  const kb = [
    [{ text: `📥 Requests (${pend})`, callback_data: 'admin:queue' }],
    [{ text: '🧾 History (30 days)', callback_data: 'admin:history' }],
    [{ text: '📈 Sales & funnel', callback_data: 'admin:sales' }],
    [{ text: '📣 Broadcast', callback_data: 'admin:broadcast' }, { text: '📤 Export customers', callback_data: 'admin:export' }],
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
  const { results } = await DB.prepare(
    'SELECT machine_id, name, expiry, key, status, uid FROM customers ORDER BY machine_id').all();
  if (!results.length) { await answerCb(cbId, 'No customers'); return; }
  await answerCb(cbId, `${results.length} customers exported`);
  const lines = results.map((c) =>
    `${c.machine_id}\t${c.name || ''}\t${c.expiry || '00000000'}\t${String(c.key || '').replace('AMH-', '')}\t${c.status}\t${c.uid || ''}`);
  await sendText(chatId,
    `📤 <b>Customers (${results.length})</b> — machine | name | expiry | key | status | uid\n\n<pre>${esc('machine\tname\texpiry\tkey\tstatus\tuid\n' + lines.join('\n'))}</pre>`);
}

async function broadcastText(chatId, text) {
  const seen = new Set();
  const a = await DB.prepare("SELECT uid FROM customers WHERE uid <> ''").all();
  const b = await DB.prepare("SELECT uid FROM orders WHERE uid <> ''").all();
  const admins = adminUids();
  for (const r of [...(a.results || []), ...(b.results || [])]) {
    if (!r.uid || seen.has(r.uid) || admins.includes(String(r.uid))) continue;
    seen.add(r.uid);
    await sendText(r.uid, text);
    await sleep(90);
  }
  log('info', 'broadcast_sent', { recipients: seen.size });
  await sendText(chatId,
    `📣 Broadcast sent to <b>${seen.size}</b> chat(s).${seen.size ? '' : ' (no buyers yet)'}`);
}

// ── revoke / unrevoke a sold license ────────────────────────────────────────
async function revokeOrder(chatId, orderId, revoke) {
  const o = await DB.prepare('SELECT machine_id, chat_id, status_msg_id FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await sendText(chatId, `⚠️ Order <b>#${orderId}</b> not found.`); return; }
  const cust = await DB.prepare('SELECT key FROM customers WHERE machine_id=?').bind(o.machine_id).first();
  if (!cust) { await sendText(chatId, `⚠️ No customer row for order <b>#${orderId}</b>.`); return; }

  await DB.prepare('UPDATE customers SET revoked=? WHERE machine_id=?')
    .bind(revoke ? 1 : 0, o.machine_id).run();

  // Bust the validation cache so the next panel call re-evaluates immediately.
  try { await kvDel('val:' + o.machine_id + ':' + cust.key); } catch (e) {}

  const targetStatus = revoke ? 'revoked' : 'approved';
  await DB.prepare('UPDATE orders SET status=? WHERE id=?').bind(targetStatus, orderId).run();

  // Notify the buyer.
  if (o.chat_id) {
    const msg = revoke
      ? '⚠️ Your license was revoked.\nContact @sumpak6 on Telegram for help.'
      : '✅ Your license has been restored.';
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

// ── anti-piracy: key-usage telemetry + spread alerts ─────────────────────────
// Every server-confirmed /api/validate stamps a (key, source IP). A key can
// only ever validate against the machine_id embedded in it, so the machine_id
// is not a share signal — the honest one is DISTINCT SOURCE IPs per key.
// Reaching AMH_SPREAD_THRESHOLD IPs triggers one admin alert per key per 24h
// (KV-throttled); AMH_BLOCK_SHARED=1 additionally refuses further validation.
async function recordKeyActivation(key, mid, ip) {
  try {
    await DB.prepare(
      `INSERT INTO key_activations (key, ip, mid) VALUES (?, ?, ?)
       ON CONFLICT(key, ip) DO UPDATE SET
         n = n + 1, mid = excluded.mid, last_seen = datetime('now')`
    ).bind(key, ip, mid).run();
    const spreadRow = await DB.prepare('SELECT COUNT(DISTINCT ip) AS n FROM key_activations WHERE key = ?').bind(key).first();
    const distinct = spreadRow ? spreadRow.n : 1;
    if (distinct >= SPREAD_THRESHOLD) {
      log('warn', 'key_spread', { key: key.slice(0, 12) + '…', mid, ip, distinct });
      await alertKeySpread(key, mid, ip, distinct);
      if (BLOCK_SHARED) return false;
    }
  } catch (e) {
    // Telemetry must never break the money path.
    log('error', 'key_activation_record_failed', { err: String((e && e.message) || e) });
  }
  return true;
}

async function alertKeySpread(key, mid, ip, distinct) {
  const seen = await kvGet('alert:keyspread:' + key);
  if (seen) return;
  await kvPut('alert:keyspread:' + key, '1', 86400);
  const text =
    '🚨 <b>Key spread alert</b>\n\n' +
    `Key <code>${key.slice(0, 12)}…</code> has now validated from <b>${distinct}</b> different IPs.\n` +
    `Latest: machine <code>${mid}</code> from IP <code>${ip}</code>\n\n` +
    'Unless the owner moved between internet connections, this is a leaked/shared key. Check /admin → History → Customer record.';
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
    `Machine ID: <code>${o.machine_id}</code>\n` +
    `Amount: ${o.amount_etb ? `ETB ${money(o.amount_etb)}` : PRICE}\n` +
    `Expiry: ${o.expiry === '00000000' ? 'perpetual' : o.expiry}\n` +
    `Received: ${shortTs(o.created_at)}`;
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
    actions = [{ text: '🚫 Revoke key', callback_data: `admin:revoke:${o.id}` }];
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
    "COALESCE(SUM(status='revoked'),0) AS rv " +
    "FROM orders WHERE created_at >= datetime('now','-30 days')").first();
  const revenue = (sums.ap || 0) * PRICE_ETB;

  const { results } = await DB.prepare(
    "SELECT * FROM orders WHERE created_at >= datetime('now','-30 days') " +
    "ORDER BY id DESC LIMIT ? OFFSET ?").bind(HISTORY_PAGE, offset).all();

  const statusEmoji = { approved: '✅', rejected: '❌', pending: '📥', revoked: '🚫' };
  const lines = results.map((o) =>
    `${statusEmoji[o.status] || '·'} <b>#${o.id}</b> · ${o.username ? '@' + o.username : 'anon'} · ` +
    `<code>${o.machine_id}</code> · ETB ${money(o.amount_etb || PRICE_ETB)} · ${shortTs(o.created_at)}`
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
    text: `${statusEmoji[o.status] || '·'} #${o.id} · ${o.machine_id}`,
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
  const sold = await DB.prepare("SELECT COUNT(*) AS n FROM customers WHERE status='sold'").first();
  const nSold = sold ? sold.n : 0;
  const rev = nSold * PRICE_ETB;
  const counts = {};
  const events = ['proof_start', 'mid_sent', 'screenshot_sent', 'order_confirmed', 'approved', 'rejected'];
  for (const ev of events) {
    const r = await DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM funnel WHERE event=?').bind(ev).first();
    counts[ev] = r ? r.n : 0;
  }
  const pct = (a, b) => (a ? Math.round(100 * b / a) + '%' : '–');
  const started = counts.proof_start;
  const text =
    '📈 <b>Sales & Funnel</b>\n\n' +
    `💵 <b>Revenue</b>: ${nSold} keys × ${PRICE} = <b>ETB ${rev.toLocaleString()}</b>\n\n` +
    '<b>Funnel — all-time:</b>\n' +
    `🟦 Started: ${started}\n` +
    `🟩 Machine ID: ${counts.mid_sent} (${pct(started, counts.mid_sent)} of started)\n` +
    `🟨 Screenshot: ${counts.screenshot_sent} (${pct(counts.mid_sent, counts.screenshot_sent)} of mid)\n` +
    `🟧 Confirmed: ${counts.order_confirmed} (${pct(counts.screenshot_sent, counts.order_confirmed)} of screenshot)\n` +
    `🟥 Approved: ${counts.approved} (${pct(counts.order_confirmed, counts.approved)} of confirmed)\n\n` +
    '<i>The biggest drop-off step = your sales opportunity.</i>';
  const kb = [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]];
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

// ── approve / reject (admin callbacks) ─────────────────────────────────────
async function approve(chatId, messageId, orderId, cbId) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await answerCb(cbId, 'Order not found.'); return; }

  // Atomic claim: the first request to flip pending→approved wins; every
  // duplicate tap / Telegram retry after that is a harmless no-op. This
  // keeps keys, funnel events and buyer DMs single-delivery.
  const claim = await DB.prepare(
    "UPDATE orders SET status='approved' WHERE id=? AND status='pending'"
  ).bind(orderId).run();
  if (!claim || !claim.meta || claim.meta.changes < 1) {
    await answerCb(cbId, 'Already handled'); return;
  }
  await kvDel('pending:count');

  // generate the key (async because HMAC)
  const key = await keyFor(o.machine_id, o.expiry);

  // record in customers — stamps the buyer uid so "My Key" still works
  // after orders are pruned.
  await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status, uid)
    VALUES (?,?,?,?, 'sold', ?) ON CONFLICT(machine_id) DO UPDATE SET
      key=excluded.key, name=excluded.name, expiry=excluded.expiry,
      status='sold', uid=excluded.uid`)
    .bind(o.machine_id, '@' + (o.username || 'anon'), o.expiry, key, o.uid || '').run();

  await addFunnel(o.uid, 'approved');

  // edit buyer status to Approved
  const buyerStatusMsg = o.status_msg_id;
  if (buyerStatusMsg) {
    await editText(o.chat_id || o.uid, buyerStatusMsg,
      '✅ <b>Order approved — key on the way!</b>\n\n' +
      `🤖 Machine ID: <code>${o.machine_id}</code>\n🟢 <b>Status: Approved</b> ✓`);
  }

  // deliver key + receipt to buyer's DM
  await sendText(o.uid, keyDeliveryMessage(key, o.expiry, 'private'));
  // confirm to admin (with remaining queue count)
  const left = await pendingCount();
  await editText(chatId, messageId,
    `✅ <b>Approved #${orderId}</b> — key delivered & logged.\n` +
    `Machine ID: <code>${o.machine_id}</code> · @${o.username} · DM: ✅\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  await answerCb(cbId, '✅ Approved & key sent');
  log('info', 'order_approved', { orderId, mid: o.machine_id, uid: o.uid, amount_etb: o.amount_etb });
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
    `@${o.username} <code>${o.machine_id}</code>\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  // The buyer was watching a live status message that said "Pending — you're
  // #N in line". approve() edits it; reject() never did, so a declined buyer
  // was left with two contradictory messages in the same chat: a pending
  // status that never resolves, and a refusal underneath it.
  if (o.status_msg_id) {
    await editText(o.chat_id || o.uid, o.status_msg_id,
      '🔴 <b>ትዕዛዝ አልተሳካም / Order declined</b>\n\n' +
      `🤖 Machine ID: <code>${o.machine_id}</code>\n🔴 <b>ሁኔታ / Status: Declined</b>`);
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
  const adminPrefixes = ['admin:', 'approve:', 'reject:', 'rej:'];
  if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('rej:') || data.startsWith('admin:')) {
    if (!isAdmin(fromUid)) { await answerCb(cbId, '🔒 Admin only'); return; }
  }

  // menu navigation
  if (data.startsWith('menu:')) {
    const kind = data.split(':')[1];
    if (kind === 'home') await editText(chatId, messageId, MENU, MENU_KEYBOARD);
    else if (kind === 'pay') {
      await editText(chatId, messageId, payText(), payKeyboard());
    } else if (kind === 'mykey') await showMyKey(cb, chatId, messageId);
    return;
  }

  // pay:proof start
  if (data.startsWith('pay:')) {
    const action = data.split(':')[1];
    if (action === 'proof') {
      const s = await getFsm(fromUid);
      if (s && s.step === 'mid' && s.hint) {
        await editText(chatId, messageId, '📤 <b>Send proof</b>\n\nAlmost done — two short steps:\n\n1️⃣ <b>Machine ID</b> (8 characters)\n2️⃣ Payment <b>screenshot</b>\n\n→ Start with <b>Step 1/2</b>: send your <b>Machine ID</b>.', [
          [{ text: '📍 Machine ID የት ነው? · Where is it?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
        ]);
        return;
      }
      // Already know the machine id (they arrived from the panel's Buy button)?
      // Then there is only one step left, and asking for it again would be
      // asking for something we are already holding.
      const known = await getFsm(fromUid);
      if (known && known.mid && !suspiciousMid(known.mid)) {
        await setFsm(fromUid, { ...known, step: 'photo' });
        await addFunnel(fromUid, 'proof_start');
        await editText(chatId, messageId,
          '📤 <b>ማረጋገጫ ይላኩ / Send proof</b>\n\n' +
          `🤖 Machine ID: <code>${known.mid}</code> ✅\n\n` +
          'የቀረው አንድ ነገር ብቻ ነው — የክፍያውን <b>ፎቶ</b> (screenshot) ይላኩ።\n' +
          '<i>One thing left: send the payment screenshot as a photo.</i>',
          [[{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }]]);
        return;
      }
      await setFsm(fromUid, { step: 'mid', mid: null, photo_key: null, ref: '', hint: 1 });
      await addFunnel(fromUid, 'proof_start');
      await sendHintKb(chatId, '📤 Send your <b>Machine ID</b> (8 characters).');
      // also edit the tapped button
      await editText(chatId, messageId, '📤 <b>Send proof</b>\n\nStart with <b>Step 1/2</b>: send your <b>Machine ID</b>.', [
        [{ text: '📍 Machine ID የት ነው? · Where is it?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '⬅ ተመለስ · Back', callback_data: 'proof:cancel' }],
      ]);
    }
    return;
  }

  // proof: callbacks
  if (data.startsWith('proof:')) {
    const action = data.split(':')[1];
    if (action === 'cancel') {
      await setFsm(fromUid, null);
      await editText(chatId, messageId, MENU, MENU_KEYBOARD);
      // Sweep away a reply keyboard from an older build, which would otherwise
      // sit at the bottom of the chat forever asking for a Machine ID.
      await sendClearingKb(chatId, '⬅ ወደ ዋና ገጽ ተመልሰዋል። / Back to the menu.');
      return;
    }
    if (action === 'mykey') { await showMyKey(cb, chatId, messageId); return; }
    if (action === 'confirm') {
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
    if (action === 'panel') await adminPanel(chatId, messageId);
    else if (action === 'queue' || action === 'pending') await adminQueue(chatId, messageId, cbId, 0);
    else if (action === 'queuep') await adminQueue(chatId, messageId, cbId, parseInt(parts[2] || '0', 10));
    else if (action === 'history') await adminHistory(chatId, messageId, cbId, 0);
    else if (action === 'histp') await adminHistory(chatId, messageId, cbId, parseInt(parts[2] || '0', 10));
    else if (action === 'revoke' || action === 'unrevoke') {
      await revokeOrder(chatId, parts[2], action === 'revoke');
      await answerCb(cbId, action === 'revoke' ? '🚫 Key revoked' : '♻ Key restored');
    }
    else if (action === 'detail') await adminDetail(chatId, messageId, cbId, parts[2]);
    else if (action === 'sales') await adminSales(chatId, messageId);
    else if (action === 'export') await adminExport(chatId, messageId, cbId);
    else if (action === 'broadcast') {
      await kvPut('bcast:await:' + fromUid, '1', 900);
      await answerCb(cbId, 'Compose broadcast');
      await sendText(chatId,
        '📣 <b>Broadcast</b>\n\nSend me the <b>exact message</b> you want copied to every customer (their DM with this bot).\n\n<i>Only buyers receive it — admins are skipped. Cancel with /start.</i>');
    }
    return;
  }

  // approve:id / reject:id
  if (data.startsWith('approve:')) {
    await approve(chatId, messageId, data.split(':')[1], cbId);
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
    await reject(chatId, messageId, orderId, cbId, reasonKey);
    return;
  }

  await answerCb(cbId, '');
}

function isPrivateChat(chatId, uid) {
  return String(chatId) === String(uid);
}

// ── CORS allow-list ─────────────────────────────────────────────────────────
// ALLOWED_ORIGIN (env AMH_ALLOWED_ORIGIN, comma-separated). DEFAULT IS
// FAIL-CLOSED: unset => NO Access-Control-Allow-Origin header at all, so a
// browser page can never read responses cross-origin. Installed CEP panels
// still work because the panel's CEF is launched with --disable-web-security
// (it does not enforce CORS). To serve browsers explicitly set
// AMH_ALLOWED_ORIGIN='*' (or a comma-separated allow-list including 'null'
// for CEP file:// origins).
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
export default {
  async fetch(request, env) {
    initEnv(env);
    const url = new URL(request.url);

    // GET /setwebhook?url=... helper (also acts as health check)
    if (request.method === 'GET' && url.pathname === '/ok') {
      return new Response('ok', { status: 200 });
    }

    // ── Extension API ──────────────────────────────────────────────────────
    // CORS for extension calls. CEP panels run from file:// origins, which the
    // browser exposes as "Origin: null". By default we stay wide open ('*');
    // set AMH_ALLOWED_ORIGIN to a comma-separated list (include 'null' for
    // CEP panels) once the panel ships a proper Origin header.
    const corsHeaders = corsFor(request);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
    const rateLimited = async (k, ttl) => {
      const v = await kvGet(k);
      if (v) return true;
      await kvPut(k, '1', ttl);
      return false;
    };
    const clientIp = () => request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    // Shared secret for the /api/* endpoints. When the AMH_API_KEY Worker
    // secret is set, every /api call must present it (X-Api-Key). Enforcement
    // is LIVE: the deployed Worker has AMH_API_KEY set and shipped panels
    // (>= v1.4.x) send the matching header — requests without it get 401.
    // Rotate with care: ship the panel carrying the new API_KEY_HINT first,
    // then update the secret (see DEPLOY.md).
    if (url.pathname.startsWith('/api/') && API_KEY) {
      const givenKey = request.headers.get('X-Api-Key') || '';
      if (!safeEqual(givenKey, API_KEY)) {
        log('warn', 'api_unauthorized', { ip: clientIp() });
        return json({ error: 'unauthorized' }, 401);
      }
    }
    // Telemetry for authenticated /api calls (used once to lock down CORS:
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
    if (request.method === 'POST' && url.pathname === '/api/ping') {
      let b = {};
      try { b = await request.json(); } catch (e) {}
      const mid = String((b && b.mid) || '');
      const v = String((b && b.v) || '');
      const throttleKey = 'ping:' + (mid || clientIp());
      if (!(await kvGet(throttleKey))) {
        const origin = request.headers.get('Origin') || '(none)';
        log('info', 'panel_ping', { v, mid: mid || '(none)', origin, ip: clientIp() });
        await kvPut(throttleKey, '1', 86400);
        if (mid) {
          await kvPut('beacon:' + mid, JSON.stringify({ v, mid, origin, ip: clientIp(), ts: new Date().toISOString() }));
        }
      }
      return json({ ok: true });
    }

    // GET /api/trial?mid=XXXX → {used, max, remaining}
    if (request.method === 'GET' && url.pathname === '/api/trial') {
      const mid = url.searchParams.get('mid');
      if (!mid || !/^[0-9a-f]{8}$/.test(mid)) {
        return json({ error: 'bad mid' }, 400);
      }
      const cacheKey = 'trial:' + mid;
      const cached = await kvGet(cacheKey);
      if (cached) { try { return json(JSON.parse(cached)); } catch (e) {} }
      // Per-IP throttle so a scraper spraying many machine IDs can't burn
      // D1 reads. A legit user only ever queries their own mid (cache hit).
      if (await rateLimited('rl:ip:' + clientIp() + ':trial', 5)) {
        return json({ error: 'throttled' }, 429);
      }
      const row = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
      const used = row ? row.used : 0;
      const maxFree = row ? row.max_free : 2;
      const out = { used, max: maxFree, remaining: Math.max(0, maxFree - used) };
      await kvPut(cacheKey, JSON.stringify(out), 45);
      return json(out);
    }

    // POST /api/trial/use → {mid} → increment trial usage, return {used, remaining}
    if (request.method === 'POST' && url.pathname === '/api/trial/use') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const mid = body && body.mid;
      if (!mid || !/^[0-9a-f]{8}$/.test(mid)) {
        return json({ error: 'bad mid' }, 400);
      }
      // Fresh-machine flood guard: a mid with no prior trial row is the classic
      // clearing-localStorage reset. Cap fresh mids per IP per day — SATURATE at
      // the cap instead of 429 so the panel syncs to remaining:0 and its trial
      // gate actually blocks, rather than dipping into the local fallback.
      if (await recordFreshTrialUse(clientIp(), mid) > FRESH_MID_LIMIT) {
        return json({ used: 2, remaining: 0 });
      }
      // Atomic "one credit per 2 s per machine" — done in SQL, NOT via a KV
      // marker, because KV read-after-write across requests is eventual and a
      // double-fire could slip a second increment past. The UPDATE changes rows
      // only when the machine's last increment is older than 2 s and it's under
      // the cap; a fast double-fire simply changes zero rows and we echo state.
      await DB.prepare('INSERT OR IGNORE INTO trials (machine_id, used, max_free) VALUES (?, 0, 2)').bind(mid).run();
      await DB.prepare(
        `UPDATE trials SET used = used + 1, last_at = datetime('now')
         WHERE machine_id = ? AND used < max_free
           AND (last_at = '' OR last_at IS NULL OR last_at < datetime('now', '-2 seconds'))`
      ).bind(mid).run();
      const row = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
      const used = row ? row.used : 0;
      const maxFree = row ? row.max_free : 2;
      const out = { used, remaining: Math.max(0, maxFree - used) };
      await kvPut('trial:' + mid, JSON.stringify(out), 45);
      return json(out);
    }

    // POST /api/validate → {mid, key} → {valid, expiry?}
    if (request.method === 'POST' && url.pathname === '/api/validate') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const { mid, key } = body || {};
      if (!mid || !key || !/^[0-9a-f]{8}$/.test(String(mid)) || typeof key !== 'string') {
        return json({ error: 'missing mid or key' }, 400);
      }
      // Parse the key exactly like the panel/core.js: AMH- prefix, dashes and
      // case are tolerated; the 32-char hex body is mid|expiry|hmac16.
      const cacheKey = 'val:' + String(mid) + ':' + key;
      let out = null;
      const cached = await kvGet(cacheKey);
      if (cached) { try { out = JSON.parse(cached); } catch (e) {} }
      if (!out) {
        // Brute-force/throttle guards cover EVERY cache miss (malformed keys
        // included) — a spray of random keys must be cooled per IP before it
        // even reaches signature checks, let alone D1.
        if (await rateLimited('rl:ip:' + clientIp() + ':validate', 3)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        if (await rateLimited('rl:val:' + String(mid), 3)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        const clean = String(key).replace(/^amh/i, '').replace(/[\s-]+/g, '').toLowerCase();
        if (!/^[0-9a-f]{32}$/.test(clean)) {
          out = { valid: false, retry: true };
        } else {
          const kmid = clean.slice(0, 8);
          const kexp = clean.slice(8, 16);
          const ksig = clean.slice(16, 32);
          // Cryptographic gate (the row check alone is NOT an auth boundary: a
          // key leaked from logs/exports must not validate). Re-derive the HMAC
          // over mid|expiry exactly like keygen.py / keyFor() does at mint time.
          if (!SECRET) {
            log('error', 'validate_missing_secret');
            return json({ error: 'server not configured' }, 500);
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
          if (kmid !== String(mid).toLowerCase()) {
            out = { valid: false, reason: 'machine_mismatch' };
          } else if (!sigOk) {
            out = { valid: false, reason: 'bad_signature', retry: true };
          } else {
            // Signature is authentic → fall through to the authoritative DB row
            // (revoked / expiry / shared-spread logic unchanged).
            const row = await DB.prepare('SELECT expiry, revoked FROM customers WHERE machine_id = ? AND key = ?').bind(String(mid), key).first();
            if (!row) {
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
        await kvPut(cacheKey, JSON.stringify(out), out.valid ? 3600 : 60);
      }
      // A known-good key is served from cache for an hour — but every VALID
      // response still records a (key, source IP) activation so distinct-IP
      // spread detection sees repeat validations, not just the first one.
      if (out.valid) {
        const okActivation = await recordKeyActivation(key, String(mid), clientIp());
        if (!okActivation) {
          out = { valid: false, reason: 'shared' };
          await kvPut(cacheKey, JSON.stringify(out), 60);
        }
      }
      if (out.valid && SIGN_KEY) {
        try {
          // Sign an install lease bound to THIS machine + expiry so the panel
          // can verify offline with its embedded public key (see signLease).
          out.token = await signLease(String(mid).toLowerCase(), out.expiry || '00000000');
        } catch (e) {
          log('error', 'lease_sign_failed', { err: String(e && e.message || e) });
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
      const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!safeEqual(given, WEBHOOK_SECRET)) {
        log('warn', 'webhook_auth_failed');
        return new Response('unauthorized', { status: 401 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response('bad', { status: 400 }); }

      try {
        if (update.message) await handleMessage(update.message, env);
        else if (update.callback_query) await handleCallback(update.callback_query);
      } catch (e) {
        // Internal bug. All outbound calls already swallow their own errors,
        // so an exception here is exceptional. Return 200 anyway: echoing a
        // 500 makes Telegram re-deliver the SAME update forever, which is
        // what produced the stuck 500-loop this hardening fixes.
        log('error', 'handler_error', { err: String(e && e.message || e) });
      }
      return new Response('ok', { status: 200 });
    }

    return new Response('method not allowed', { status: 405 });
  },

  // Cron trigger: prune the 30-day window on a schedule so unmetered admin
  // activity is never depended on (see wrangler.toml [triggers] crons).
  async scheduled(_event, env) {
    initEnv(env);
    await pruneOld();
  },
};
