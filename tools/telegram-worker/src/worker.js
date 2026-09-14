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

// Since generateKey must be sync in places but WebCrypto is async, we cache.
// For simplicity we compute keys lazily with an await in approve (async anyway).
let SECRET = '';
let TOKEN = '';
let ADMIN_ID = ''; // may be comma-separated (multi-admin)
let GROUP_ID = '';
let PRICE = 'ETB 2,500'; // display string
let PRICE_ETB = 2500;    // numeric (source of truth for revenue/orders)
let ACCT_NAME = 'KALEB TEGEGEN';
let PAY_ACCOUNTS = 'CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015';
let ALLOWED_ORIGIN = ''; // comma-separated CORS allow-list ('' => * open)
const SUPPORT_URL = 'https://t.me/sumpak6';
const SITE_URL = 'https://amharic-caption-pro.vercel.app';
let WEBHOOK_SECRET = '';
let API_KEY = ''; // shared secret for /api/* (panel). Enforcement on when set.
let CACHE = null; // optional KV namespace (AMH_KV). Absent => graceful fallback.
let BLOCK_SHARED = false;  // when '1', /api/validate refuses a key seen from too many IPs
let SPREAD_THRESHOLD = 3;  // distinct source IPs per key before we alert/flag a spread
let FRESH_MID_LIMIT = 5;   // max new (never-before-seen) mids per IP per day before /api/trial/use 429s

// ── config / env ────────────────────────────────────────────────────────────
function initEnv(env) {
  TOKEN = env.AMH_TG_TOKEN || '';
  ADMIN_ID = (env.AMH_ADMIN_ID || '1887247213').toString();
  GROUP_ID = env.AMH_GROUP_ID || '';
  PRICE = env.AMH_PRICE || 'ETB 2,500';
  ACCT_NAME = env.AMH_ACCT_NAME || ACCT_NAME;
  PAY_ACCOUNTS = env.AMH_PAY_ACCOUNTS || PAY_ACCOUNTS;
  SECRET = env.AMH_SECRET || '';
  WEBHOOK_SECRET = env.AMH_WEBHOOK_SECRET || '';
  API_KEY = env.AMH_API_KEY || '';
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
    `${name}Welcome to <b>Amharic Captions</b> 👋\n\n` +
    '💯 <b>100% offline</b> — runs on your own computer, no internet needed.\n\n' +
    '🎁 <b>Try it free</b> — your first <b>2 captions are free</b>.\n\n' +
    `💰 One-time <s>ETB 3,500</s> → <b>${PRICE}</b> — <b>forever license</b>.`
  );
}
const heroKeyboard = () => [
  [{ text: '💳 Pay', callback_data: 'menu:pay' }],
  [{ text: '🔑 My Key', callback_data: 'menu:mykey' }],
  [{ text: '📲 Install guide', url: `${SITE_URL}/install` }],
  [{ text: '💬 Support group', url: 'https://t.me/+L-bMfmIRyEo3MDg0' }],
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

function payText() {
  return (
    '💰 <b>Pay</b>\n\n' +
    `💵 Amount: <s>ETB 3,500</s> → <b>${PRICE}</b> — one-time, forever license\n` +
    `🏦 Paid to: <b>${ACCT_NAME}</b> — ${PAY_ACCOUNTS}\n` +
    '🔑 Your license key arrives <b>in this chat</b> after we confirm payment.\n\n' +
    '👇 Tap below after you sent the money.'
  );
}
const payKeyboard = () => [
  [{ text: '✅ I’ve paid — send proof', callback_data: 'pay:proof' }],
  [{ text: '🎁 Try free first (2 captions)', url: `${SITE_URL}/install` }],
];

const MENU = 'Hello! 👋 Choose below:';
const MENU_KEYBOARD = [
  [{ text: '💳 Pay', callback_data: 'menu:pay' }],
  [{ text: '🔑 My Key', callback_data: 'menu:mykey' }],
  [{ text: '📲 Install guide', url: `${SITE_URL}/install` }],
  [{ text: '💬 Support group', url: 'https://t.me/+L-bMfmIRyEo3MDg0' }],
];

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
  log('info', 'prune_run', {
    orders: o && o.meta ? o.meta.changes : 0,
    funnel: f && f.meta ? f.meta.changes : 0,
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
const MACHINE_ID_HINT_KEY = '📍 Show me where to find my Machine ID';
function sendHintKb(chatId, text) {
  const params = {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: {
      keyboard: [[{ text: MACHINE_ID_HINT_KEY }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  };
  return safeSend(tg(TOKEN, 'sendMessage', params));
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
    `🏛 አካውንት: <b>${PAY_ACCOUNTS}</b>\n` +
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
      [[{ text: '📲 Install guide', url: `${SITE_URL}/install` }]]);
    return;
  }

  // step photo: waiting for screenshot
  if (step === 'photo') {
    await sendText(chatId, '📸 I’m waiting for your <b>screenshot</b> — send the bank-transfer payment screenshot as a <b>photo</b>.', [
      [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
    ]);
    return;
  }

  // step mid: waiting for Machine ID
  if (step === 'mid') {
    const m = text.match(MACHINE_ID_RE);
    if (!m) {
      await sendHintKb(chatId,
        `⚠️ I need your <b>Machine ID</b> — the <b>8-character</b> code from the panel's <b>License</b> section (e.g. <code>a1b2c3d4</code>).`);
      return;
    }
    const mid = m[0].toLowerCase();
    const existing = await findKey(mid);
    if (existing) {
      await sendText(chatId,
        `🔑 This Machine ID (<code>${mid}</code>) already has a key.\n\nTap <b>My Key</b> below to see it, or contact the seller if it's not working.`,
        [[{ text: '🔑 My Key', callback_data: 'proof:mykey' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      await setFsm(uid, null);
      return;
    }
    if (suspiciousMid(mid)) {
      await sendText(chatId,
        `⚠️ <code>${mid}</code> doesn’t look like a real <b>Machine ID</b>.\n\nYour Machine ID is the <b>8 characters</b> shown under "Your Machine ID" in the panel’s License section (e.g. <code>a1b2c3d4</code>).`,
        [[{ text: '📍 Where is my Machine ID?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      return;
    }
    // valid new machine -> ask for screenshot
    await setFsm(uid, { step: 'photo', mid, photo_key: null, hint: 1 });
    await addFunnel(uid, 'mid_sent');
    await sendText(chatId,
      '✅ Machine ID received!\n\n📤 <b>Step 2/2</b> — now send your <b>bank-transfer screenshot</b> as a <b>photo</b> (the "payment success" screen).',
      [[{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
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
  await sendText(chatId,
    '👋 Got it — that looks like a Machine ID. To pay, use the guided flow:\n\n1️⃣ Tap <b>💳 Pay</b>\n2️⃣ Tap <b>I’ve paid — send proof</b>',
    [[{ text: '💳 Pay', callback_data: 'menu:pay' }]]);
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
        [[{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      return;
    }
    const objectKey = await storeProof(fileId);
    await setFsm(uid, { ...s, photo_key: objectKey, step: 'confirm' });
    await addFunnel(uid, 'screenshot_sent');
    await sendText(chatId, '✅ Screenshot received!\n\n📤 Let’s do a quick final check of your order:');
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
    await sendText(chatId, '📸 Screenshot saved! Now send your <b>Machine ID</b> (8 characters from the panel\'s License section).',
      [[{ text: '📍 Where is my Machine ID?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
    return;
  }
  await sendText(chatId,
    '🖼 Thanks — but to place an order please start the guided flow and send your <b>Machine ID</b> first:\n\n1️⃣ Tap <b>💳 Pay</b>\n2️⃣ Tap <b>I\'ve paid — send proof</b>',
    [[{ text: '💳 Pay', callback_data: 'menu:pay' }]]);
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
    '🧾 <b>Review your order</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 Amount: <b>${PRICE}</b> (one-time, +0 fees)\n` +
    `🏦 Paid to: <b>${ACCT_NAME}</b>\n\n` +
    '🔑 On approval, your key arrives <b>right here</b>.\nLook right? Tap <b>Confirm</b>.';
  const kb = [
    [{ text: '✅ Confirm order', callback_data: 'proof:confirm' }],
    [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
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
      [[{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
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
    '📦 <b>Order received — now pending</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 Amount: <b>${PRICE}</b>\n\n` +
    `⏳ <b>Status: Pending</b> — you're <b>#${pos}</b> in line.\n` +
    'Keys are usually issued within a few hours (Ethiopian working hours). We’ll send it right here. 🙏';
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
    '✅ <b>Payment confirmed — your license key is ready!</b>',
    '', `<code>${key}</code>`, '',
    '<b>①</b> Copy the key',
    '<b>②</b> Premiere Pro → open the panel → License',
    '<b>③</b> Paste it → tap <b>Activate</b>',
  ];
  if (expiry !== '00000000') lines.push('', `⏰ Expires: ${expiry}`);
  if (chatType !== 'private') lines.push('', '🔒 For privacy, ask for your key in a private DM.');
  lines.push('', 'Thank you! 🙏 If you have any trouble, message the seller.');
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
    `   └ 🌀 Pending today:  ${todayRow.pd}\n\n` +
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
  const k = 'freshmid:' + ip;
  const n = parseInt(await kvGet(k) || '0', 10) + 1;
  await kvPut(k, n, 86400);
  if (n > FRESH_MID_LIMIT && !(await kvGet('alert:fresh:' + ip))) {
    await kvPut('alert:fresh:' + ip, '1', 86400);
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
  const kb = o.status === 'pending'
    ? [[
        { text: '✅ Approve', callback_data: `approve:${o.id}` },
        { text: '❌ Decline', callback_data: `reject:${o.id}` },
      ], [{ text: '🛠 Admin', callback_data: 'admin:panel' }]]
    : [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]];
  await answerCb(cbId, '');
  if (o.photo_key) await sendPhoto(chatId, o.photo_key, cap, kb);
  else await sendText(chatId, cap, kb);
}

async function adminHistory(chatId, messageId) {
  await pruneOld();
  const { results } = await DB.prepare(
    "SELECT * FROM orders WHERE created_at >= datetime('now','-30 days') ORDER BY id DESC").all();
  if (!results.length) {
    await editText(chatId, messageId,
      '🧾 <b>No orders in the last 30 days.</b>',
      [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  const pend = results.filter((r) => r.status === 'pending').length;
  const ap = results.filter((r) => r.status === 'approved').length;
  const rj = results.filter((r) => r.status === 'rejected').length;
  const sold30 = ap;
  const revenue = sold30 * PRICE_ETB;

  const statusEmoji = { approved: '✅', rejected: '❌', pending: '📥' };
  let list = results.slice(0, 25).map((o) =>
    `#${o.id} ${statusEmoji[o.status] || '·'} ${o.username ? '@' + o.username : 'anon'} <code>${o.machine_id}</code> · ${shortTs(o.created_at)}`
  ).join('\n');

  const text =
    `🧾 <b>History · last 30 days</b>\n\n` +
    `✅ ${ap} approved · ❌ ${rj} declined · 📥 ${pend} pending · 💵 <b>ETB ${money(revenue)}</b>\n\n` +
    `${list}${results.length > 25 ? `\n… +${results.length - 25} more` : ''}\n\n` +
    `Tap any order in the queue to open Details → Approve / Decline.`;
  const kb = [[
    { text: '📥 Requests', callback_data: 'admin:queue' },
    { text: '🛠 Admin', callback_data: 'admin:panel' },
  ]];
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

async function reject(chatId, messageId, orderId, cbId) {
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
    `❌ <b>Declined #${orderId}</b> — @${o.username} <code>${o.machine_id}</code>\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  if (o.chat_id) await sendText(o.chat_id, 'Sorry — payment proof not verified. No key was sent. If you believe this is an error, contact the seller.');
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
  const adminPrefixes = ['admin:', 'approve:', 'reject:'];
  if (data.startsWith('approve:') || data.startsWith('reject:') || data.startsWith('admin:')) {
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
          [{ text: '📍 Where is my Machine ID?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
        ]);
        return;
      }
      await setFsm(fromUid, { step: 'mid', mid: null, photo_key: null, ref: '', hint: 1 });
      await addFunnel(fromUid, 'proof_start');
      await sendHintKb(chatId, '📤 Send your <b>Machine ID</b> (8 characters).');
      // also edit the tapped button
      await editText(chatId, messageId, '📤 <b>Send proof</b>\n\nStart with <b>Step 1/2</b>: send your <b>Machine ID</b>.', [
        [{ text: '📍 Where is my Machine ID?', url: 'https://amharic-caption-pro.vercel.app/install' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
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
    else if (action === 'history') await adminHistory(chatId, messageId);
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
    await reject(chatId, messageId, data.split(':')[1], cbId);
    return;
  }

  await answerCb(cbId, '');
}

function isPrivateChat(chatId, uid) {
  return String(chatId) === String(uid);
}

// ── CORS allow-list ─────────────────────────────────────────────────────────
// ALLOWED_ORIGIN (env AMH_ALLOWED_ORIGIN, comma-separated) is empty by default
// → open ('*'), which keeps installed CEP panels working. Once a panel build
// sends a proper Origin header, set it to the value (include 'null' for CEP
// file:// panels) to lock CORS down.
function corsFor(request) {
  const base = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  };
  if (!ALLOWED_ORIGIN) return { ...base, 'Access-Control-Allow-Origin': '*' };
  const origin = request.headers.get('Origin') || '';
  const list = ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
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
    // secret is set, every /api call must present it (X-Api-Key).
    // Transition window: currently OFF so already-installed panels keep
    // working. Enable it in the exact same release as the panel build that
    // sends the header (see DEPLOY.md).
    if (url.pathname.startsWith('/api/') && API_KEY) {
      const givenKey = request.headers.get('X-Api-Key') || '';
      if (!safeEqual(givenKey, API_KEY)) {
        log('warn', 'api_unauthorized', { ip: clientIp() });
        return json({ error: 'unauthorized' }, 401);
      }
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
      // Per-IP guard on the write path (beyond the per-machine collapse below).
      if (await rateLimited('rl:ip:' + clientIp() + ':use', 3)) {
        return json({ error: 'throttled' }, 429);
      }
      // Fresh-machine flood guard: a mid with no prior trial row is the classic
      // clearing-localStorage reset. Cap fresh mids per IP per day.
      if (await recordFreshTrialUse(clientIp(), mid) > FRESH_MID_LIMIT) {
        return json({ error: 'trial_abuse' }, 429);
      }
      // Collapse accidental double-fire (panel retry) + scripted abuse into
      // one increment per machine per 2s. A real transcription takes far
      // longer than that, so legit credits are never lost.
      if (await rateLimited('rl:use:' + mid, 2)) {
        const cur = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
        const used = cur ? cur.used : 0;
        return json({ used, remaining: Math.max(0, (cur ? cur.max_free : 2) - used) });
      }
      // Atomic increment — never past the cap, no lost updates under
      // concurrency.
      await DB.prepare('INSERT OR IGNORE INTO trials (machine_id, used, max_free) VALUES (?, 0, 2)').bind(mid).run();
      await DB.prepare('UPDATE trials SET used = used + 1 WHERE machine_id = ? AND used < max_free').bind(mid).run();
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
      const cacheKey = 'val:' + String(mid) + ':' + key;
      let out = null;
      const cached = await kvGet(cacheKey);
      if (cached) { try { out = JSON.parse(cached); } catch (e) {} }
      if (!out) {
        // Per-IP guard so a brute-forcer can't spray fake keys quickly.
        if (await rateLimited('rl:ip:' + clientIp() + ':validate', 3)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        // Only a genuinely new lookup reaches D1; brute-force bursts of fake
        // keys are throttled per machine.
        if (await rateLimited('rl:val:' + String(mid), 3)) {
          return json({ valid: false, reason: 'throttled', retry: true }, 429);
        }
        // Check D1: key must be in customers table
        const row = await DB.prepare('SELECT expiry FROM customers WHERE machine_id = ? AND key = ?').bind(String(mid), key).first();
        if (!row) {
          out = { valid: false };
        } else if (row.expiry && row.expiry !== '00000000') {
          const expDate = new Date(row.expiry.slice(0, 4) + '-' + row.expiry.slice(4, 6) + '-' + row.expiry.slice(6, 8));
          out = (isNaN(expDate.getTime()) || expDate < new Date())
            ? { valid: false, reason: 'expired' }
            : { valid: true, expiry: row.expiry };
        } else {
          out = { valid: true, expiry: row.expiry };
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
