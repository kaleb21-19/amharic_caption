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
let ADMIN_ID = '';
let GROUP_ID = '';
let PRICE = 'ETB 2,500';
let ACCT_NAME = 'KALEB TEGEGEN';
let PAY_ACCOUNTS = 'CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015';
const SUPPORT_URL = 'https://t.me/sumpak6';

// ── config / env ────────────────────────────────────────────────────────────
function initEnv(env) {
  TOKEN = env.AMH_TG_TOKEN || '';
  ADMIN_ID = (env.AMH_ADMIN_ID || '1887247213').toString();
  GROUP_ID = env.AMH_GROUP_ID || '';
  PRICE = env.AMH_PRICE || 'ETB 2,500';
  ACCT_NAME = env.AMH_ACCT_NAME || ACCT_NAME;
  PAY_ACCOUNTS = env.AMH_PAY_ACCOUNTS || PAY_ACCOUNTS;
  SECRET = env.AMH_SECRET || '';
  globalThis.DB = env.DB;
}

// ── menu text (port from bot.py) ────────────────────────────────────────────
function heroText(first = '') {
  const name = first ? `${first}, ` : '';
  return (
    `${name}Welcome to <b>Amharic Captions</b> 👋\n\n` +
    '🚫🔌 <b>NO INTERNET NEEDED.</b>\n' +
    'This runs <b>100% OFFLINE</b> on your own computer — after install, you don’t need Wi-Fi or mobile data to make captions. Everything happens right on your machine.\n\n' +
    '🎁 <b>Try BEFORE you pay</b> — your first <b>2 captions are free</b>.\n\n' +
    '📌 <b>How it works</b> (simple, 3 steps):\n' +
    '1️⃣ <b>Install</b> the plugin\n' +
    `2️⃣ <b>Pay</b> once — <s>ETB 3,500</s> now <b>${PRICE}</b> (forever key)` + '\n' +
    '3️⃣ <b>Make captions</b> forever, offline\n\n' +
    '🤝 <b>Buy with confidence</b>\n' +
    '\u2022 You keep your captions offline on your own machine \u2014 nothing is shared\n' +
    '\u2022 Your license key is delivered <b>right in this chat</b> after we confirm your bank-transfer payment\n' +
    '\u2022 Real support via DM \u2014 get unstuck fast\n\n' +
    '👇 Tap <b>1️⃣ Install</b> to taste it free first:'
  );
}
const heroKeyboard = () => [
  [{ text: '1️⃣ Install', callback_data: 'menu:install' }],
  [{ text: '2️⃣ Pay', callback_data: 'menu:pay' }],
  [{ text: '3️⃣ Machine ID', callback_data: 'menu:guide' }],
  [{ text: '4️⃣ Help', callback_data: 'menu:help' }],
  [{ text: '🔑 My Key', callback_data: 'menu:mykey' }],
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
    '🎁 <b>Did you try your 2 free captions first?</b>\n' +
    'Install → make 2 free captions → come back and pay. No risk.\n\n' +
    `<b>Before you send — here's the deal:</b>\n` +
    `💵 Amount: <s>ETB 3,500</s> → <b>${PRICE}</b> — one-time, forever license, no extra fees\n` +
    `🏦 Paid to: <b>${ACCT_NAME}</b> (bank transfer)\n` +
    `🏛 Account: <b>${PAY_ACCOUNTS}</b>\n` +
    '🔑 You get: your license key <b>in this chat</b>\n' +
    '⏰ <b>Introductory price</b> — lock it in now.\n\n' +
    '👇 Tap below <b>only after</b> you sent the money.'
  );
}
const payKeyboard = () => [
  [{ text: '✅ I’ve paid — send proof', callback_data: 'pay:proof' }],
  [{ text: '🎁 Try free first (2 captions)', callback_data: 'menu:install' }],
];

const MENU = 'Hello! 👋 What would you like to do? Choose below:';
const MENU_KEYBOARD = [
  [{ text: '1️⃣ Install', callback_data: 'menu:install' }],
  [{ text: '2️⃣ Pay', callback_data: 'menu:pay' }],
  [{ text: '3️⃣ Machine ID', callback_data: 'menu:guide' }],
  [{ text: '4️⃣ Help', callback_data: 'menu:help' }],
  [{ text: '🔑 My Key', callback_data: 'menu:mykey' }],
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
  const r = await DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending'").first();
  return r ? r.n : 0;
}
// Auto-prune: keep only the last 30 days of orders + funnel events. Called on
// every admin action so history stays small without a scheduled job.
async function pruneOld() {
  await DB.prepare("DELETE FROM orders WHERE created_at < datetime('now', '-30 days')").run();
  await DB.prepare("DELETE FROM funnel WHERE ts < datetime('now', '-30 days')").run();
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
    `INSERT INTO fsm (uid, step, mid, photo_key, ref, hint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       step=excluded.step, mid=excluded.mid, photo_key=excluded.photo_key,
       ref=excluded.ref, hint=excluded.hint, updated_at=datetime('now')`
  ).bind(uid, s.step, s.mid || null, s.photo_key || null, s.ref || '', s.hint ? 1 : 0).run();
}
async function addFunnel(uid, event) {
  await DB.prepare('INSERT INTO funnel (uid, event) VALUES (?, ?)').bind(uid, event).run();
}

// ── message senders ─────────────────────────────────────────────────────────
function sendText(chatId, text, kb) {
  const params = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return tg(TOKEN, 'sendMessage', params);
}
function editText(chatId, messageId, text, kb) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return tg(TOKEN, 'editMessageText', params);
}
function sendPhoto(chatId, photo, caption, kb) {
  const params = { chat_id: chatId, photo, caption, parse_mode: 'HTML' };
  if (kb) params.reply_markup = { inline_keyboard: kb };
  return tg(TOKEN, 'sendPhoto', params);
}
function answerCb(id, text) {
  return tg(TOKEN, 'answerCallbackQuery', { callback_query_id: id, text: text || '' });
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
      if (String(user.id) === ADMIN_ID) {
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
    if (privateChat && String(user.id) === ADMIN_ID) await adminPanel(chatId, null);
    else await sendText(chatId, '🔒 Admin only.');
    return;
  }

  // photos / documents (payment screenshot)
  if (msg.photo || msg.document) {
    await handlePhoto(msg, uid, chatId, privateChat, text);
    return;
  }

  // helper-button tap -> guide
  const g = lower.replace(/^📍/,'').trim().toLowerCase();
  if (['where is my machine id?', 'machine id', 'machine_id', 'help'].includes(g)) {
    await sendText(chatId, guideText(), undefined);
    return;
  }

  // generic buy-flow commands
  if (['/buy', '/buy@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId, heroText(first), heroKeyboard());
    return;
  }
  if (['/install', '/install@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId, installText() + '\n\n🔘 Use the buttons below to continue:', [
      [{ text: '🎁 Try free (2 captions)', callback_data: 'menu:home' }],
      [{ text: '2️⃣ Pay', callback_data: 'menu:pay' }],
    ]);
    return;
  }
  if (['/help', '/faq', '/faq@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId, faqText(), undefined);
    return;
  }
  if (['/support', '/support@amhariccaptionsbot'].includes(lower)) {
    await sendText(chatId, faqText(), [[{ text: '💬 Message support', url: SUPPORT_URL }]]);
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
function installText() {
  const dl = 'https://github.com/kaleb21-19/amharic_caption/releases/latest/download';
  return (
    '1️⃣ <b>Install — 2 FREE captions</b>\n\n' +
    '🔒 <b>Runs 100% OFFLINE</b> on your computer after install.\n' +
    '⚠️ Needs Premiere Pro <b>2024 (v24)</b> or newer.\n\n' +
    '⬇️ <b>Step 1 — download for your computer:</b>\n' +
    '• <b>Mac (Apple Silicon M1/M2/M3…):</b>\n' +
    `<a href="${dl}/amharic-captions-mac-arm64.zip">⬇️ Download Mac (Apple Silicon)</a>\n\n` +
    '• <b>Windows:</b>\n' +
    `<a href="${dl}/amharic-captions-win-x64.zip">⬇️ Download Windows</a>\n\n` +
    '⬇️ <b>Step 2 — put the plugin in place:</b>\n' +
    'After unzipping, copy the folder named <code>com.amharic.captions</code> into your Adobe Extensions folder:\n\n' +
    '• <b>Windows:</b>\n' +
    '<code>C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions\\</code>\n\n' +
    '• <b>Mac:</b>\n' +
    '<code>~/Library/Application Support/Adobe/CEP/extensions/</code>\n\n' +
    '⬇️ <b>Step 3 — tell Adobe it’s OK to run:</b>\n\n' +
    '• <b>Mac:</b> open <b>Terminal</b> (⌘+Space → type <code>Terminal</code> → Enter), then copy & paste this and press Enter:\n\n' +
    '<code>defaults write com.adobe.CSXS.9 PlayerDebugMode "1"</code>\n\n' +
    '• <b>Windows:</b> open the Registry Editor:\n' +
    '   1. Press <b>Win+R</b> → type <code>regedit</code> → press <b>Enter</b>. Click <b>Yes</b> if asked.\n' +
    '   2. Paste this into the address bar at the top and press Enter:\n' +
    '   <code>HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.11</code>\n' +
    '   3. If you see a <code>PlayerDebugMode</code> entry on the right, double-click it and set the value to <b>1</b>.\n' +
    '   4. If there is <b>no</b> <code>PlayerDebugMode</code> entry: right-click the empty area on the right → <b>New</b> → <b>DWORD (32-bit) Value</b> → name it exactly <code>PlayerDebugMode</code> → double-click it → set the value to <b>1</b> → OK.\n' +
    '   5. Close regedit.\n' +
    '   💡 Using Premiere <b>2025 (v25) or newer?</b> Do the same for <code>HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.12</code> too.\n\n' +
    '<i>⚠️ Change only <code>PlayerDebugMode</code> to 1. Don’t touch anything else.</i>\n\n' +
    '⬇️ <b>Step 4 — use it:</b>\n' +
    'Restart Premiere → Extensions → Amharic Captions → make <b>2 free captions</b>!\n\n' +
    '🖥 <b>Intel Mac?</b> The Intel-Mac build isn’t published yet — contact the seller for it.\n\n' +
    '🎉 Made your 2 free ones and loved it? Tap <b>2️⃣ Pay</b> to buy your forever key:'
  );
}
function faqText() {
  return (
    '❓ <b>FAQ</b>\n\n' +
    '<b>Q: Can I try before buying?</b>\n' +
    'A: Yes! Every new user gets <b>2 free</b> captions. Open the panel → ' +
    '"Generate Captions".\n\n' +
    '<b>Q: Does the key work on multiple computers?</b>\n' +
    'A: No. Each key is tied to <b>one</b> computer (hardware ID). A separate ' +
    'key is needed for a different computer.\n\n' +
    '<b>Q: When does the key expire?</b>\n' +
    'A: It never expires! <b>One-time payment</b> — no subscription.\n\n' +
    '<b>Q: How do I pay?</b>\n' +
    `A: Bank transfer to <b>${ACCT_NAME}</b> — ${PAY_ACCOUNTS}.\n\n` +
    '<b>Q: I changed my computer / lost my key?</b>\n' +
    "A: Contact the seller. With proof of purchase, we'll help transfer " +
    'to your new machine.\n\n' +
    '<b>Q: What computer do I need?</b>\n' +
    'A: Windows or Mac with <b>Premiere Pro 2024 (v24)</b> or newer. ' +
    'The Amharic model runs on your own computer — no internet needed.\n\n' +
    `💰 <b>Price:</b> <s>ETB 3,500</s> → <b>${PRICE}</b> one-time.\n` +
    `🏦 <b>Pay via bank transfer to ${ACCT_NAME}:</b> ${PAY_ACCOUNTS}\n\n` +
    '👤 <b>Need help? Message the seller:</b>\n' +
    `<a href="${SUPPORT_URL}">@sumpak6</a>`
  );
}
function guideText() {
  return (
    '3️⃣ <b>Machine ID</b>\n\n' +
    'Your unique computer number — <b>8 characters</b> (e.g. <code>a1b2c3d4</code>).\n\n' +
    '<b>Where to find it:</b>\n' +
    '1. Open Premiere → Windows > Extensions > "Amharic Captions"\n' +
    '2. In the panel, open the <b>License</b> section\n' +
    '3. Copy the "Your Machine ID" box\n\n' +
    '⚙️ You need it when paying (step 2).'
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
      await sendText(chatId,
        `⚠️ I need your <b>Machine ID</b> — the <b>8-character</b> code from the panel's <b>License</b> section (e.g. <code>a1b2c3d4</code>).`,
        [[{ text: '📍 Where is my Machine ID?', callback_data: 'menu:guide' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      return;
    }
    const mid = m[0].toLowerCase();
    if (suspiciousMid(mid)) {
      await sendText(chatId,
        `⚠️ <code>${mid}</code> doesn’t look like a real <b>Machine ID</b>.\n\nYour Machine ID is the <b>8 characters</b> shown under "Your Machine ID" in the panel’s License section (e.g. <code>a1b2c3d4</code>).`,
        [[{ text: '📍 Where is my Machine ID?', callback_data: 'menu:guide' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      return;
    }
    const existing = await findKey(mid);
    if (existing) {
      await sendText(chatId,
        `🔑 This Machine ID (<code>${mid}</code>) already has a key.\n\nTap <b>My Key</b> below to see it, or contact the seller if it's not working.`,
        [[{ text: '🔑 My Key', callback_data: 'proof:mykey' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
      await setFsm(uid, null);
      return;
    }
    // valid new machine -> ask for screenshot
    await setFsm(uid, { step: 'photo', mid, photo_key: null, ref: '', hint: 1 });
    await addFunnel(uid, 'mid_sent');
    await sendText(chatId,
      '✅ Machine ID received!\n\n📤 <b>Step 2/3</b> — now send your <b>bank-transfer screenshot</b> as a <b>photo</b> (the "payment success" screen).',
      [[{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
    return;
  }

  // step ref: waiting for reference number
  if (step === 'ref') {
    await setFsm(uid, { ...s, ref: (text || '').slice(0, 80), step: 'confirm' });
    await addFunnel(uid, 'ref_typed');
    await reviewConfirm(uid, chatId);
    return;
  }
  // step confirm: new text updates the ref
  if (step === 'confirm' && text) {
    await setFsm(uid, { ...s, ref: text.slice(0, 80) });
    await reviewConfirm(uid, chatId);
    return;
  }

  // Not in FSM: a bare Machine ID
  const m = text.match(MACHINE_ID_RE);
  if (!m) {
    // unknown input
    if (privateChat) await sendText(chatId, `😊 ${first}, I didn't understand that. What would you like to do? Choose below:`, MENU_KEYBOARD);
    else await sendText(chatId, MENU, MENU_KEYBOARD);
    return;
  }
  await sendText(chatId,
    '👋 Got it — that looks like a Machine ID. To pay, use the guided flow:\n\n1️⃣ Tap <b>2️⃣ Pay</b>\n2️⃣ Tap <b>I’ve paid — send proof</b>',
    [[{ text: '2️⃣ Pay', callback_data: 'menu:pay' }]]);
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
    await setFsm(uid, { ...s, photo_key: objectKey, step: 'ref' });
    await addFunnel(uid, 'screenshot_sent');
    await sendText(chatId,
      '✅ Screenshot received!\n\n📤 <b>Step 3/3</b> — type the payment <b>reference number</b> from your transfer receipt (the long number under the amount).\n\nThis helps us match your payment instantly 🎯\n\n<i>Don\'t have it handy? Tap skip — we\'ll verify manually.</i>',
      [[{ text: '↪ Skip — confirm anyway', callback_data: 'proof:skipref' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
    return;
  }
  if (step === 'ref' || step === 'confirm') {
    await sendText(chatId,
      '✅ We already have your screenshot! Just type the <b>reference number</b> from your transfer receipt — or tap one of the buttons below.',
      [[{ text: '↪ Skip — confirm anyway', callback_data: 'proof:skipref' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
    return;
  }
  if (step === 'mid') {
    const objectKey = await storeProof(fileId);
    await setFsm(uid, { ...s, photo_key: objectKey });
    await sendText(chatId, '📸 Screenshot saved! Now send your <b>Machine ID</b> (8 characters from the panel\'s License section).',
      [[{ text: '📍 Where is my Machine ID?', callback_data: 'menu:guide' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }]]);
    return;
  }
  await sendText(chatId,
    '🖼 Thanks — but to place an order please start the guided flow and send your <b>Machine ID</b> first:\n\n1️⃣ Tap <b>2️⃣ Pay</b>\n2️⃣ Tap <b>I\'ve paid — send proof</b>',
    [[{ text: '2️⃣ Pay', callback_data: 'menu:pay' }]]);
}

async function storeProof(fileId) {
  // A Telegram file_id can be passed straight to sendPhoto with no re-download
  // or re-upload. We store it as-is per order (far more reliable than base64
  // re-uploads). Verify it exists via getFile, then return it.
  try {
    const info = await tg(TOKEN, 'getFile', { file_id: fileId });
    if (info && info.ok) return fileId;
    return null;
  } catch (e) {
    return null;
  }
}

// ── review + confirm ────────────────────────────────────────────────────────
async function reviewConfirm(uid, chatId) {
  const s = await getFsm(uid);
  if (!s) return;
  const ref = (s.ref || '').trim();
  const refLine = ref ? `<code>${ref}</code>` : '<i>not provided</i>';
  const text =
    '🧾 <b>Review your order</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 Amount: <b>${PRICE}</b> (one-time, +0 fees)\n` +
    `🏦 Paid to: <b>${ACCT_NAME}</b>\n` +
    `🧾 Reference: ${refLine}\n\n` +
    '🔑 On approval, your key arrives <b>right here</b>.\nLook right? Tap <b>Confirm</b>.';
  const kb = [
    [{ text: '✅ Confirm order', callback_data: 'proof:confirm' }],
    [{ text: '↩ Re-enter reference', callback_data: 'proof:reref' }],
    [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
  ];
  const r = await sendText(chatId, text, kb);
  if (r && r.ok) await setFsm(uid, { ...s, status_msg_id: r.result.message_id });
}

// ── complete proof -> create pending order + notify admin ───────────────────
async function completeProof(uid, chatId, uname, privateChat) {
  const s = await getFsm(uid);
  if (!s || !s.mid) return;
  const ref = (s.ref || '').trim();

  const order = await DB.prepare(
    `INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(uid, uname, s.mid, ref, s.photo_key || null, String(chatId)).run();

  const orderId = order.meta.last_row_id;
  await setFsm(uid, null);
  await addFunnel(uid, 'order_confirmed');

  // status + ETA to buyer
  const pos = await pendingCount();
  const statusText =
    '📦 <b>Order received — now pending</b>\n\n' +
    `🤖 Machine ID: <code>${s.mid}</code>\n` +
    `💵 Amount: <b>${PRICE}</b>\n` +
    `🧾 Reference: ${ref ? `<code>${ref}</code>` : '<i>skipped</i>'}\n\n` +
    `⏳ <b>Status: Pending</b> — you’re <b>#${pos}</b> in line.\n` +
    'Keys are usually issued within a few hours (Ethiopian working hours). We’ll send it right here. 🙏';
  const r = await sendText(chatId, statusText);
  const statusMsgId = r && r.ok ? r.result.message_id : null;
  if (statusMsgId) await DB.prepare('UPDATE orders SET status_msg_id=? WHERE id=?').bind(statusMsgId, orderId).run();

  // notify admin
  const admins = await adminList();
  for (const adm of admins) {
    const caption =
      '🧾 <b>New order — payment proof</b>\n\n' +
      `Machine ID: <code>${s.mid}</code>\nUser: @${uname} (id ${uid})\nSource: ${privateChat ? 'DM' : 'Group'}\n` +
      `Payment ref: ${ref ? `<code>${ref}</code>` : '<i>not provided</i>'}\n\n` +
      'Check the screenshot + reference, then Approve or Reject:';
    if (s.photo_key) await sendPhoto(adm, s.photo_key, caption, adminKeyboardPend(orderId));
    else await sendText(adm, caption, adminKeyboardPend(orderId));
  }
}

// single admin for now
async function adminList() {
  return ADMIN_ID ? [ADMIN_ID] : [];
}

// ── show my key ─────────────────────────────────────────────────────────────
function keyDeliveryMessage(key, expiry, chatType, ref) {
  const lines = [
    '✅ <b>Payment confirmed — your license key is ready!</b>',
    '', `<code>${key}</code>`, '',
    '<b>①</b> Copy the key',
    '<b>②</b> Premiere Pro → open the panel → License',
    '<b>③</b> Paste it → tap <b>Activate</b>',
  ];
  if (ref) lines.push('', '🧾 <b>Receipt</b>', `• Amount: <b>${PRICE}</b>`, `• Paid to: ${ACCT_NAME}`, `• Reference: <code>${ref}</code>`);
  if (expiry !== '00000000') lines.push('', `⏰ Expires: ${expiry}`);
  if (chatType !== 'private') lines.push('', '🔒 For privacy, ask for your key in a private DM.');
  lines.push('', 'Thank you! 🙏 If you have any trouble, message the seller.');
  return lines.join('\n');
}

async function showMyKey(msg, chatId, messageId) {
  const user = msg.from || {};
  const uid = String(user.id || '');
  // find this user's approved machines (link customers by order.uid)
  const rows = await DB.prepare(
    `SELECT c.machine_id, c.key, c.expiry FROM customers c
     JOIN orders o ON o.machine_id = c.machine_id AND o.status='approved'
     WHERE o.uid = ? LIMIT 5`
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
  const revenue = (sold30 ? sold30.n : 0) * parseInt(PRICE.replace(/[^\d]/g, ''), 10);

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
  ];
  if (messageId) await editText(chatId, messageId, text, kb);
  else await sendText(chatId, text, kb);
}

async function adminQueue(chatId, messageId, cbId) {
  await pruneOld();
  const { results } = await DB.prepare(
    "SELECT * FROM orders WHERE status='pending' ORDER BY id DESC").all();
  if (!results.length) {
    await editText(chatId, messageId,
      '📥 <b>No pending requests.</b>\n\nNew orders appear here the moment a buyer submits proof.',
      [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
    return;
  }
  // Send each pending order as its own card (newest first) with inline actions.
  for (const o of results) {
    const cap =
      `${orderSummary(o)}\n` +
      `🧾 Ref: ${o.ref ? `<code>${o.ref}</code>` : '<i>skipped</i>'}`;
    if (o.photo_key) await sendPhoto(chatId, o.photo_key, cap, adminKeyboardPend(o.id));
    else await sendText(chatId, cap, adminKeyboardPend(o.id));
  }
  await answerCb(cbId, `${results.length} pending`);
  await editText(chatId, messageId,
    `📥 <b>${results.length} pending request(s)</b> — newest first. Approve, decline, or view details on each card.`,
    [[{ text: '🛠 Admin', callback_data: 'admin:panel' }]]);
}

async function adminDetail(chatId, messageId, cbId, orderId) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) { await answerCb(cbId, 'Order not found'); return; }
  const cap =
    `🧾 <b>Order #${o.id} · ${o.status.toUpperCase()}</b>\n\n` +
    `${orderSummary(o)}\n` +
    `UID: <code>${o.uid}</code>\n` +
    `Machine ID: <code>${o.machine_id}</code>\n` +
    `Amount: ${PRICE}\n` +
    `Ref: ${o.ref ? `<code>${o.ref}</code>` : '<i>skipped</i>'}\n` +
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
  const revenue = sold30 * parseInt(PRICE.replace(/[^\d]/g, ''), 10);

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
  const rev = nSold * parseInt(PRICE.replace(/,/g, '').replace('ETB ', ''), 10);
  const counts = {};
  const events = ['proof_start', 'mid_sent', 'screenshot_sent', 'ref_typed', 'ref_skipped', 'order_confirmed', 'approved', 'rejected'];
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
    `🔳 Ref: ${counts.ref_typed} given · ${counts.ref_skipped} skipped\n` +
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
  if (o.status !== 'pending') { await answerCb(cbId, 'Already handled'); return; }

  // generate the key (async because HMAC)
  const key = await keyFor(o.machine_id, o.expiry);

  // record in customers
  await DB.prepare(`INSERT INTO customers (machine_id, name, expiry, key, status)
    VALUES (?,?,?,?, 'sold') ON CONFLICT(machine_id) DO UPDATE SET key=excluded.key, name=excluded.name, status='sold'`)
    .bind(o.machine_id, '@' + o.username, o.expiry, key).run();

  // mark order approved
  await DB.prepare("UPDATE orders SET status='approved' WHERE id=?").bind(orderId).run();
  await addFunnel(o.uid, 'approved');

  // edit buyer status to Approved
  const buyerStatusMsg = o.status_msg_id;
  if (buyerStatusMsg) {
    await editText(o.chat_id || o.uid, buyerStatusMsg,
      '✅ <b>Order approved \u2014 key on the way!</b>\n\n' +
      `🤖 Machine ID: <code>${o.machine_id}</code>\n🟢 <b>Status: Approved</b> ✓`);
  }

  // deliver key + receipt to buyer's DM
  await sendText(o.uid, keyDeliveryMessage(key, o.expiry, 'private', o.ref || ''));
  // confirm to admin (with remaining queue count)
  const left = await pendingCount();
  await editText(chatId, messageId,
    `✅ <b>Approved #${orderId}</b> — key delivered & logged.\n` +
    `Machine ID: <code>${o.machine_id}</code> · @${o.username} · DM: ✅\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  await answerCb(cbId, '✅ Approved & key sent');
}

async function reject(chatId, messageId, orderId, cbId) {
  const o = await DB.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!o) return;
  if (o.status !== 'pending') { await answerCb(cbId, 'Already handled'); return; }
  await DB.prepare("UPDATE orders SET status='rejected' WHERE id=?").bind(orderId).run();
  await addFunnel(o.uid, 'rejected');
  const left = await pendingCount();
  await editText(chatId, messageId,
    `❌ <b>Declined #${orderId}</b> — @${o.username} <code>${o.machine_id}</code>\n` +
    `${left ? `📥 ${left} request(s) left in queue.` : '🎉 Queue is clear.'}`);
  if (o.chat_id) await sendText(o.chat_id, 'Sorry \u2014 payment proof not verified. No key was sent. If you believe this is an error, contact the seller.');
  await answerCb(cbId, '❌ Declined');
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
    if (fromUid !== ADMIN_ID) { await answerCb(cbId, '🔒 Admin only'); return; }
  }

  // menu navigation
  if (data.startsWith('menu:')) {
    const kind = data.split(':')[1];
    if (kind === 'home') await editText(chatId, messageId, MENU, MENU_KEYBOARD);
    else if (kind === 'pay') {
      await editText(chatId, messageId, payText(), payKeyboard());
    } else if (kind === 'install') await editText(chatId, messageId, installText() + '\n\n🔘 Use the buttons below to continue:', [
      [{ text: '🎁 Try free (2 captions)', callback_data: 'menu:home' }],
      [{ text: '2️⃣ Pay', callback_data: 'menu:pay' }],
    ]);
    else if (kind === 'guide') await editText(chatId, messageId, guideText(), undefined);
    else if (kind === 'help') await editText(chatId, messageId, faqText(), [
      [{ text: '💬 Message support', url: SUPPORT_URL }],
    ]);
    else if (kind === 'mykey') await showMyKey(cb, chatId, messageId);
    return;
  }

  // pay:proof start
  if (data.startsWith('pay:')) {
    const action = data.split(':')[1];
    if (action === 'proof') {
      const s = await getFsm(fromUid);
      if (s && s.step === 'mid' && s.hint) {
        await editText(chatId, messageId, '📤 <b>Send proof</b>\n\nAlmost done — three short steps:\n\n1️⃣ <b>Machine ID</b> (8 characters)\n2️⃣ Payment <b>screenshot</b>\n3️⃣ Payment <b>reference</b> number\n\n→ Start with <b>Step 1/3</b>: send your <b>Machine ID</b>.', [
          [{ text: '📍 Where is my Machine ID?', callback_data: 'menu:guide' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
        ]);
        return;
      }
      await setFsm(fromUid, { step: 'mid', mid: null, photo_key: null, ref: '', hint: 1 });
      await addFunnel(fromUid, 'proof_start');
      await sendText(chatId, '📤 Send your <b>Machine ID</b> (8 characters).', undefined);
      // also edit the tapped button
      await editText(chatId, messageId, '📤 <b>Send proof</b>\n\nStart with <b>Step 1/3</b>: send your <b>Machine ID</b>.', [
        [{ text: '📍 Where is my Machine ID?', callback_data: 'menu:guide' }], [{ text: '✖ Cancel', callback_data: 'proof:cancel' }],
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
    if (action === 'skipref') {
      const s = await getFsm(fromUid);
      if (s) { await setFsm(fromUid, { ...s, ref: s.ref || '', step: 'confirm' }); await addFunnel(fromUid, 'ref_skipped'); await reviewConfirm(fromUid, chatId); }
      return;
    }
    if (action === 'reref') {
      const s = await getFsm(fromUid);
      if (s) { await setFsm(fromUid, { ...s, step: 'ref' }); await sendText(chatId, '📤 Type your <b>reference number</b> (or tap skip).', [[{ text: '↪ Skip \u2014 confirm anyway', callback_data: 'proof:skipref' }]]); }
      return;
    }
    if (action === 'confirm') {
      const s = await getFsm(fromUid);
      if (s && ['ref', 'confirm'].includes(s.step) && s.mid) {
        await completeProof(fromUid, chatId, fromUser.username || fromUser.first_name || '', genrePrivate(chatId, fromUid));
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
    else if (action === 'queue' || action === 'pending') await adminQueue(chatId, messageId, cbId);
    else if (action === 'history') await adminHistory(chatId, messageId);
    else if (action === 'detail') await adminDetail(chatId, messageId, cbId, parts[2]);
    else if (action === 'sales') await adminSales(chatId, messageId);
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

function genrePrivate(chatId, uid) {
  return String(chatId) === String(uid);
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

    // GET /debug  → report the admin id the worker resolves (for verification only)
    if (request.method === 'GET' && url.pathname === '/debug') {
      return new Response(JSON.stringify({ admin_id: ADMIN_ID, token_set: !!TOKEN, db: !!DB }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    // ── Extension API ──────────────────────────────────────────────────────
    // CORS headers for extension calls (CEP panels run from file:// origins)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET /api/trial?mid=XXXX → {used, max, remaining}
    if (request.method === 'GET' && url.pathname === '/api/trial') {
      const mid = url.searchParams.get('mid');
      if (!mid || !/^[0-9a-f]{8}$/.test(mid)) {
        return new Response(JSON.stringify({ error: 'bad mid' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      const row = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
      const used = row ? row.used : 0;
      const maxFree = row ? row.max_free : 2;
      return new Response(JSON.stringify({ used, max: maxFree, remaining: Math.max(0, maxFree - used) }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // POST /api/trial/use → {mid} → increment trial usage, return {used, remaining}
    if (request.method === 'POST' && url.pathname === '/api/trial/use') {
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }); }
      const mid = body && body.mid;
      if (!mid || !/^[0-9a-f]{8}$/.test(mid)) {
        return new Response(JSON.stringify({ error: 'bad mid' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // Upsert: insert if not exists, then increment — but never past the cap
      await DB.prepare('INSERT OR IGNORE INTO trials (machine_id, used, max_free) VALUES (?, 0, 2)').bind(mid).run();
      await DB.prepare('UPDATE trials SET used = CASE WHEN used < max_free THEN used + 1 ELSE used END WHERE machine_id = ?').bind(mid).run();
      const row = await DB.prepare('SELECT used, max_free FROM trials WHERE machine_id = ?').bind(mid).first();
      return new Response(JSON.stringify({ used: row.used, remaining: Math.max(0, row.max_free - row.used) }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // POST /api/validate → {mid, key} → {valid, expiry?}
    if (request.method === 'POST' && url.pathname === '/api/validate') {
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }); }
      const { mid, key } = body || {};
      if (!mid || !key) {
        return new Response(JSON.stringify({ error: 'missing mid or key' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // Check D1: key must be in customers table
      const row = await DB.prepare('SELECT expiry FROM customers WHERE machine_id = ? AND key = ?').bind(mid, key).first();
      if (!row) {
        return new Response(JSON.stringify({ valid: false }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      // Check expiry
      if (row.expiry && row.expiry !== '00000000') {
        const expDate = new Date(row.expiry.slice(0, 4) + '-' + row.expiry.slice(4, 6) + '-' + row.expiry.slice(6, 8));
        if (expDate < new Date()) {
          return new Response(JSON.stringify({ valid: false, reason: 'expired' }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
      }
      return new Response(JSON.stringify({ valid: true, expiry: row.expiry }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Telegram POSTs updates here
    if (request.method === 'POST') {
      let update;
      try { update = await request.json(); } catch { return new Response('bad', { status: 400 }); }

      // fire-and-forget (return 200 immediately so Telegram doesn't retry together)
      // but we want reliability, so we await then return — Telegram retries if we fail.
      try {
        if (update.message) await handleMessage(update.message, env);
        else if (update.callback_query) await handleCallback(update.callback_query);
      } catch (e) {
        console.error('handler error', e);
        return new Response('handler error', { status: 500 });
      }
      return new Response('ok', { status: 200 });
    }

    return new Response('method not allowed', { status: 405 });
  },
};
