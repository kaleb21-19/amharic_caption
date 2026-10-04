// End-to-end harness for the Telegram Worker sales bot + extension API.
//
// Runs the REAL src/worker.js, but with an in-memory SQLite (node:sqlite) in
// place of D1, an in-memory KV, and a fake api.telegram.org. Covers the full
// money path: pay flow, screenshot (photo/document), confirm, approve/reject
// idempotency (double-tap + Telegram retries), username changes, group->DM,
// network blips, webhook fail-closed auth, and every /api/* route.
//
// Usage:  node test/e2e.mjs
//
// Requires Node 22+ (global WebCrypto, Request/Response, node:sqlite).

import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

//                                                        Accounts
// Test-only identities. NEVER hardcode production secrets here — the repo is
// public. Defaults are random per-process (self-contained, safe to run), and
// any real admin/webhook values must come from environment variables:
//   AMH_ADMIN_ID_TEST, AMH_SECRET_TEST, AMH_WEBHOOK_SECRET_TEST
const ADMIN_ID = process.env.AMH_ADMIN_ID_TEST || String(randomBytes(4).readUInt32BE(0));
const BUYER = '900000001';
const GROUP = '-1000000000001';
const SECRET = process.env.AMH_SECRET_TEST || randomBytes(32).toString('base64');
const WEBHOOK_SECRET = process.env.AMH_WEBHOOK_SECRET_TEST || randomBytes(16).toString('hex');
const SIGNING_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const TG = 'abcdef:TOKEN';

const WORKER_SRC = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

const envKeys = ['AMH_TG_TOKEN', 'AMH_ADMIN_ID', 'AMH_SECRET', 'AMH_WEBHOOK_SECRET', 'DB', 'AMH_KV'];

// ── isolated D1 stand-in (mirrors migrations 0001-0006) ─────────────────────
class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
    const ddls = [
      `CREATE TABLE customers (machine_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '-',
        expiry TEXT NOT NULL DEFAULT '00000000', key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sold',
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '', machine_id TEXT NOT NULL,
        expiry TEXT NOT NULL DEFAULT '00000000', ref TEXT NOT NULL DEFAULT '',
        photo_key TEXT, chat_id TEXT, status_msg_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        amount_etb INTEGER NOT NULL DEFAULT 0,
        key_issued_at TEXT, delivery_status TEXT NOT NULL DEFAULT 'pending',
        delivery_attempts INTEGER NOT NULL DEFAULT 0, delivered_at TEXT,
        delivery_lease_until TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      `CREATE INDEX idx_orders_status ON orders(status)`,
      `CREATE INDEX idx_orders_uid ON orders(uid)`,
      `CREATE TABLE fsm (uid TEXT PRIMARY KEY, step TEXT NOT NULL, mid TEXT,
        photo_key TEXT, ref TEXT DEFAULT '', hint INTEGER NOT NULL DEFAULT 0,
        status_msg_id INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE funnel (id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')), uid TEXT NOT NULL, event TEXT NOT NULL)`,
      `CREATE INDEX idx_funnel_event ON funnel(event)`,
      `CREATE TABLE trials (machine_id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0,
        max_free INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
      `ALTER TABLE customers ADD COLUMN uid TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE trials ADD COLUMN last_at TEXT NOT NULL DEFAULT ''`,
      `CREATE TABLE ip_counters (ip TEXT NOT NULL, bucket TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (ip, bucket))`,
      `CREATE TABLE key_activations (key TEXT NOT NULL, ip TEXT NOT NULL, mid TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (key, ip))`,
      `CREATE UNIQUE INDEX idx_orders_pending_mid ON orders(machine_id) WHERE status='pending'`,
      `CREATE INDEX idx_orders_mid ON orders(machine_id)`,
      `CREATE INDEX idx_customers_uid ON customers(uid)`,
      `CREATE TABLE webhook_updates (update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT,
        claimed_at TEXT)`,
      `CREATE TABLE trial_uses (run_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT, completed_at TEXT, result_json TEXT)`,
    ];
    for (const ddl of ddls) this.db.exec(ddl);
    // migration 0014: permanent sales ledger + batched broadcasts (real file)
    this.db.exec(readFileSync(new URL('../migrations/0014_sales_broadcasts.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0015_referrals.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0016_partners.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0017_referral_quotes.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0018_partner_profile.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0019_activation_codes.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../migrations/0020_security.sql', import.meta.url), 'utf8'));
    this.db.exec("ALTER TABLE customers ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0"); // migration 0008
  }
  prepare(sql) {
    const stmt = this.db.prepare(sql);
    const w = {
      bind: (...args) => { w.args = args; return w; },
      run: () => { const r = stmt.run(...(w.args || [])); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
      first: () => stmt.get(...(w.args || [])) ?? null,
      all: () => ({ results: stmt.all(...(w.args || [])) }),
    };
    return w;
  }
  batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => s.run());
      this.db.exec('COMMIT');
      return results;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

// ── in-memory KV (TTL-aware) ────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    async get(k) {
      const v = m.get(k);
      if (!v) return null;
      if (v.exp !== null && v.exp <= Date.now() / 1000) { m.delete(k); return null; }
      return v.val;
    },
    async put(k, val, opts) {
      m.set(k, { val: String(val), exp: opts && opts.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : null });
    },
    async delete(k) { m.delete(k); },
    keys() { return [...m.keys()]; },
  };
}

// ── fake api.telegram.org ───────────────────────────────────────────────────
const OUTBOUND = []; // {method, body, id}
let MSG = 0;
let FAIL_NEXT = 0; // N outbound calls fail with {ok:false}
const MEDIA = new Set();   // message ids that are photos/documents (no text to edit)
const REFUSED = [];        // every call the strict fake refused, for the admin audit
const HTML_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'span', 'blockquote']);
// The Bot API's HTML rules: known tags only, balanced, and every & < > escaped.
function htmlError(s) {
  s = String(s);
  const stack = [];
  const re = /<(\/?)([a-zA-Z-]+)([^>]*)>|<|&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);|&/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0] === '<') return "Bad Request: can't parse entities: unexpected '<'";
    if (m[0] === '&') return "Bad Request: can't parse entities: unescaped '&'";
    if (m[0].startsWith('&')) {
      if (!/^(#|lt$|gt$|amp$|quot$)/.test(m[4] || m[0].slice(1, -1))) return `Bad Request: can't parse entities: unsupported entity ${m[0]}`;
      continue;
    }
    const tag = m[2].toLowerCase();
    if (!HTML_TAGS.has(tag)) return `Bad Request: can't parse entities: unsupported start tag "${tag}"`;
    if (m[1]) {
      if (stack.pop() !== tag) return `Bad Request: can't parse entities: can't find end tag corresponding to start tag`;
    } else stack.push(tag);
  }
  return stack.length ? "Bad Request: can't parse entities: can't find end tag" : null;
}
function tgRefusal(method, body) {
  const kb = body.reply_markup && (typeof body.reply_markup === 'string' ? JSON.parse(body.reply_markup) : body.reply_markup);
  for (const r of (kb && kb.inline_keyboard) || []) {
    for (const b of r) {
      if (!b.text) return 'Bad Request: text buttons are unallowed in the inline keyboard';
      if (b.callback_data != null && Buffer.byteLength(String(b.callback_data)) > 64) return 'Bad Request: BUTTON_DATA_INVALID';
    }
  }
  const html = body.parse_mode === 'HTML';
  if (method === 'sendMessage' || method === 'editMessageText') {
    if (!String(body.text || '').trim()) return 'Bad Request: message text is empty';
    if (String(body.text).length > 4096) return 'Bad Request: message is too long';
    if (html) { const e = htmlError(body.text); if (e) return e; }
  }
  if (method === 'editMessageText' && MEDIA.has(`${body.chat_id}:${body.message_id}`)) return 'Bad Request: there is no text in the message to edit';
  if (method === 'sendPhoto' || method === 'sendDocument' || method === 'editMessageCaption') {
    if (String(body.caption || '').length > 1024) return 'Bad Request: message caption is too long';
    if (html && body.caption) { const e = htmlError(body.caption); if (e) return e; }
  }
  if (method === 'sendPhoto' && String(body.photo).startsWith('BQAC')) return "Bad Request: can't use file of type Document as Photo";
  if (method === 'sendDocument' && String(body.document).startsWith('AgAC')) return "Bad Request: can't use file of type Photo as Document";
  return null;
}
// Refusals the bot is BUILT to recover from (asserted where they happen): a
// file sent as a photo → re-sent as a document; a text edit on a photo card →
// redone as a caption edit.
const RECOVERED = (r) => (r.method === 'sendPhoto' && String(r.body.photo).startsWith('BQAC'))
  || (r.method === 'editMessageText' && /no text in the message/.test(r.description));
const realFetch = globalThis.fetch;
const JOB_PAGES = {};
const JOB_FETCHES = [];
// fake api.github.com releases/latest (update-available notice)
const GH = { calls: 0, status: 200, body: { tag_name: 'v1.8.0' } };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://api.github.com/')) {
    GH.calls++;
    return { ok: GH.status === 200, status: GH.status, json: async () => GH.body };
  }
  // fake public channel pages (t.me/s/<channel>) for the jobs feed
  if (url.startsWith('https://t.me/s/')) {
    JOB_FETCHES.push(url);
    const page = JOB_PAGES[decodeURIComponent(url.slice('https://t.me/s/'.length))];
    return { ok: page !== undefined, status: page !== undefined ? 200 : 404, text: async () => page || '' };
  }
  if (!url.startsWith('https://api.telegram.org/bot')) return realFetch(url, init);
  const m = url.match(/\/bot[^/]+\/(\w+)$/);
  const method = m ? m[1] : '';
  let body = {};
  if (typeof init.body === 'string') {
    body = JSON.parse(init.body);
  } else if (init.body && typeof init.body.entries === 'function') {
    for (const [k, v] of init.body.entries()) body[k] = v; // FormData (photo uploads)
  }
  const entry = { method, body, id: null };
  OUTBOUND.push(entry);
  if (FAIL_NEXT > 0) { FAIL_NEXT--; return { ok: false, json: async () => ({ ok: false }) }; }
  // Strict like the real Bot API: these refusals used to pass unnoticed here
  // while production silently showed the admin nothing.
  const refuse = (description) => {
    entry.refused = description;
    REFUSED.push({ method, description, body });
    return { ok: false, json: async () => ({ ok: false, error_code: 400, description }) };
  };
  const bad = tgRefusal(method, body);
  if (bad) return refuse(bad);
  MSG++;
  entry.id = MSG;
  if (method === 'sendPhoto' || method === 'sendDocument') MEDIA.add(`${body.chat_id}:${MSG}`);
  if (method === 'editMessageText' || method === 'editMessageCaption') {
    return { ok: true, json: async () => ({ ok: true, result: { message_id: body.message_id, chat: { id: body.chat_id } } }) };
  }
  if (method === 'answerCallbackQuery') {
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  }
  return { ok: true, json: async () => ({ ok: true, result: { message_id: MSG, chat: { id: body.chat_id } } }) };
};

const worker = (await import('data:text/javascript;base64,' + Buffer.from(WORKER_SRC, 'utf8').toString('base64'))).default;

// ── helpers ─────────────────────────────────────────────────────────────────
function makeEnv(over = {}) {
  const kv = makeKV();
  const db = new D1();
  const env = {
    AMH_TG_TOKEN: TG, AMH_ADMIN_ID: ADMIN_ID, AMH_SECRET: SECRET,
    AMH_WEBHOOK_SECRET: WEBHOOK_SECRET, AMH_LICENSE_SIGNING_KEY: SIGNING_KEY,
    AMH_KV: kv, DB: db,
    ...over,
  };
  for (const k of envKeys) assert.equal(k in env, true, `missing env ${k}`);
  return { env, kv, db };
}
function msg(chat, from, extra = {}) {
  const sender = from || {};
  return {
    message: {
      message_id: MSG + 1000, date: 1755000000,
      chat: { id: chat, type: chat < 0 ? 'group' : 'private' },
      from: { id: chat, first_name: 'Buyer', username: 'buyer_user', ...sender },
      ...extra,
    },
  };
}
let UPDATE_ID = 0;
const UPDATE_IDS = new WeakMap();
function withUpdateId(update) {
  if (update && update.update_id !== undefined) return update;
  let id = UPDATE_IDS.get(update);
  if (!id) { id = ++UPDATE_ID; UPDATE_IDS.set(update, id); }
  return { ...update, update_id: id };
}
async function post(env, update, secret = WEBHOOK_SECRET, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret, ...extraHeaders };
  const req = new Request('https://x.workers.dev/', { method: 'POST', headers, body: JSON.stringify(withUpdateId(update)) });
  return worker.fetch(req, env);
}
async function cb(env, from, data, opts = {}) {
  const chatId = opts.chatId ?? from.id;
  return post(env, {
    callback_query: {
      id: 'q' + MSG,
      from: { id: from.id, first_name: 'A', username: from.username || 'admin' },
      message: { message_id: opts.messageId ?? 500, date: 1755000000, chat: { id: chatId, type: 'private' }, text: 'x' },
      data,
    },
  });
}
const api = async (env, path, { method = 'GET', body, headers = {} } = {}) => {
  const req = new Request('https://x.workers.dev' + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(req, env);
};
function keyForWith(secret, mid, expiry = '00000000') {
  const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${mid}|${expiry}`).digest('hex').slice(0, 16);
  return 'AMH-' + (mid + expiry + sig).match(/.{1,4}/g).join('-');
}
function keyFor(mid, expiry = '00000000') {
  return keyForWith(SECRET, mid, expiry);
}
function canonicalKey(k) {
  return String(k || '').replace(/^amh/i, '').replace(/[\s-]+/g, '').toLowerCase();
}
const rows = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).all().results;
const row = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();

// ── a fresh environment for every scenario ──────────────────────────────────
let st = 0;
function fresh(over = {}) { st++; OUTBOUND.length = 0; MSG = 0; FAIL_NEXT = 0; return makeEnv(over); }

async function startBuyFlow(env, uid = BUYER) {
  // /start in DM
  let res = await post(env, msg(Number(uid), { id: Number(uid), username: 'buyer_user' }, { text: '/start' }));
  assert.equal(res.status, 200);
  // tap 💳 Pay -> I've paid -> proof
  await cb(env, { id: Number(uid) }, 'menu:pay', { chatId: Number(uid) });
  await cb(env, { id: Number(uid) }, 'pay:proof', { chatId: Number(uid) });
}

const PASS = [];
function ok(name) { PASS.push(name); console.log('  PASS  ' + name); }

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1 — happy path, full sale, DM only');

{
  const { env, db, kv } = fresh();
  await startBuyFlow(env);

  let res = await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: 'a1b2c3d4' }));
  assert.equal(res.status, 200);
  // Assert on the state machine, not on prose: the buyer-facing copy is
  // bilingual now and will keep being reworded, but "after a valid Machine ID
  // we are waiting for a photo" is the actual contract.
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'photo',
    'a valid Machine ID advances the flow to awaiting the screenshot');
  assert.ok(JSON.stringify(OUTBOUND).includes('Now just send the payment screenshot'), 'buyer is told only the screenshot is left');

  const m = msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'FA', width: 1, height: 1 }, { file_id: 'FB', width: 2, height: 2 }] });
  res = await post(env, m);
  assert.equal(res.status, 200);

  // The screenshot IS the order: no review screen, no Confirm button.
  assert.ok(!JSON.stringify(OUTBOUND).includes('Review your order'), 'no review step');
  const received = OUTBOUND.filter((o) => o.method === 'sendMessage' && (o.body.text || '').includes('Received')).at(-1);
  assert.ok(received && received.id, '"Received" status message sent');
  ok('the screenshot books the order at once (no review / Confirm step)');

  // An old-style Confirm tap (a buyer mid-flow during the deploy) is harmless.
  res = await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  assert.equal(res.status, 200);
  let orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'one order');
  const o = orders[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.machine_id, 'a1b2c3d4');
  assert.equal(o.uid, BUYER);
  assert.equal(o.photo_key, 'FB');
  assert.equal(o.status_msg_id, received.id, 'buyer status message id stored on order');
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0, 'fsm cleared once the order is booked');
  ok('order booked with proof + status_msg_id');

  const adminNotified = OUTBOUND.filter((o) => o.method === 'sendPhoto').filter((o) => o.body.caption && o.body.caption.includes('New order'));
  assert.equal(adminNotified.length, 1, 'admin notified with screenshot');
  ok('admin notified via sendPhoto');

  // double-tap confirm (Telegram retries the same callback) — must NOT create 2 orders
  res = await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  assert.equal(res.status, 200);
  orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'double confirm -> still one order');
  ok('double-tap confirm -> exactly one pending order');

  // admin approves
  res = await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.equal(res.status, 200);
  const c = row(env, 'SELECT * FROM customers WHERE machine_id=?', 'a1b2c3d4');
  assert.ok(c, 'customer row created');
  assert.equal(c.uid, BUYER, 'uid stamped on customer');
  assert.equal(c.key, keyFor('a1b2c3d4'), 'key matches keygen algorithm: ' + c.key);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'approved');
  ok('approve stamps customer.uid + key matches algorithm');

  // key delivered to buyer DM
  const dm = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === BUYER).find((x) => (x.body.text || '').includes('AMH-'));
  assert.ok(dm, 'key DM sent to buyer');
  assert.ok(dm.body.text.includes(c.key), 'DM contains the stored key');
  // buyer status message edited to approved
  const edited = OUTBOUND.filter((x) => x.method === 'editMessageText' && String(x.body.chat_id) === BUYER).find((x) => (x.body.text || '').includes('Order approved'));
  assert.ok(edited, 'buyer status edited to Approved');
  assert.ok(edited.body.text.includes('ትዕዛዝዎ ተረጋግጧል'), 'approved status is in Amharic too');
  // The panel is Amharic by default: its button reads «አግብር», not "Activate".
  assert.ok(dm.body.text.includes('«አግብር»') && dm.body.text.includes('«የፈቃድ ቁልፍ»'),
    "key message uses the panel's own Amharic labels");
  assert.ok(dm.body.text.includes('Make Amharic Captions'), 'key message covers the SRT maker too');
  ok('key DM + buyer status edit fired');

  // admin seen approval confirmation
  // double-tap approve (same callback retried) -> idempotent
  res = await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.equal(res.status, 200);
  assert.equal(rows(env, 'SELECT * FROM customers').length, 1, 'double approve -> one customer');
  assert.equal(OUTBOUND.filter((x) => x.method === 'sendMessage' && (x.body.text || '').includes('AMH-')).filter((x) => String(x.body.chat_id) === BUYER).length, 1, 'key DM sent exactly once');
  ok('double-tap approve -> idempotent (no dup key/DM)');

  // /api/validate — the real gate
  let r = await api(env, '/api/validate', { method: 'POST', body: { mid: 'a1b2c3d4', key: c.key } });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual({ valid: j.valid, expiry: j.expiry }, { valid: true, expiry: '00000000' });
  assert.match(j.token || '', /^v1\.[0-9a-f]{16}\.[0-9a-f]{128}$/i, 'successful validation returns a signed lease');
  r = await api(env, '/api/validate', { method: 'POST', body: { mid: 'a1b2c3d4', key: 'AMH-' + 'f'.repeat(34) } });
  j = await r.json();
  assert.equal(j.valid, false);
  ok('/api/validate accepts real key, rejects forged');

  // New installations use a 16-hex ID. Presentation normalization (case,
  // spaces, and dashes) must resolve to the same customer row and cache key.
  const mid16 = 'a1b2c3d4e5f60718';
  const key16 = keyFor(mid16);
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?, 'sold16', '00000000', ?, 'sold', '16')")
    .bind(mid16, key16).run();
  const pasted = 'amh ' + key16.slice(4).toLowerCase().replace(/(.{4})/g, '$1-').replace(/-$/, '');
  r = await api(env, '/api/validate', { method: 'POST', body: { mid: mid16.toUpperCase(), key: pasted }, headers: { 'CF-Connecting-IP': '198.51.100.22' } });
  j = await r.json();
  assert.equal(j.valid, true, '16-hex installation key validates after paste normalization');
  assert.match(j.token || '', /^v1\.[0-9a-f]{24}\./i, '16-hex lease payload is signed');
  ok('16-hex machine IDs and normalized key paste validate end-to-end');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1a — failed Telegram delivery is visible and retryable');

{
  const { env } = fresh();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '1a2b3c4d' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'P-DELIVERY' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const order = row(env, 'SELECT * FROM orders');
  FAIL_NEXT = 1; // the key send fails; state must not claim delivery
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${order.id}`);
  let o = row(env, 'SELECT status, delivery_status, delivery_attempts FROM orders WHERE id=?', order.id);
  assert.equal(o.status, 'approved');
  assert.equal(o.delivery_status, 'failed');
  assert.equal(o.delivery_attempts, 1);
  assert.ok(row(env, 'SELECT key FROM customers WHERE machine_id=?', '1a2b3c4d').key, 'key remains stored for retry');

  await Promise.all([
    cb(env, { id: Number(ADMIN_ID) }, `approve:${order.id}`),
    cb(env, { id: Number(ADMIN_ID) }, `approve:${order.id}`),
  ]);
  o = row(env, 'SELECT status, delivery_status, delivery_attempts FROM orders WHERE id=?', order.id);
  assert.equal(o.delivery_status, 'delivered');
  assert.equal(o.delivery_attempts, 2, 'concurrent retries share one delivery lease');
  ok('delivery failure is persisted and admin retry redelivers the key');
}

{
  const { env } = fresh();
  env.DB.prepare("INSERT INTO orders (id, uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb, key_issued_at, delivery_status) VALUES (91, '91', '@pending', '91abcdef', '', '', '91', 'approved', 2500, datetime('now'), 'pending')").run();
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:detail:91');
  const card = OUTBOUND.filter((x) =>
    (x.method === 'editMessageText' || x.method === 'sendMessage') &&
    String(x.body.text || '').includes('Order #91')).at(-1);
  assert.ok(card, 'admin detail card was rendered');
  assert.ok(JSON.stringify(card.body.reply_markup || {}).includes('admin:retry-delivery:91'),
    'approved/pending delivery exposes a recovery action');
  ok('approved orders with pending delivery remain recoverable');
}

{
  const { env } = fresh({ AMH_LICENSE_SIGNING_KEY: '' });
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '2b3c4d5e' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'P-NOSIGN' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const order = row(env, 'SELECT * FROM orders');
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${order.id}`);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', order.id).status, 'pending');
  assert.equal(rows(env, 'SELECT * FROM customers').length, 0, 'unready signer cannot mint/deliver a key');
  ok('approval fails closed when the lease signer is unavailable');
}

// Full purchase flow with a new 16-hex installation ID.
{
  const { env } = fresh();
  const mid = 'a1b2c3d4e5f60718';
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: mid }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'P16' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const order = row(env, 'SELECT * FROM orders');
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${order.id}`);
  const customer = row(env, 'SELECT machine_id, key FROM customers WHERE machine_id=?', mid);
  assert.ok(customer && customer.key, '16-hex ID completes purchase and approval');
  assert.equal(customer.machine_id, mid);
  ok('16-hex Machine IDs work through the complete Telegram sale flow');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1b — rotating AMH_SECRET must not kill existing keys');

{
  // Rotating the HMAC secret used to invalidate EVERY key ever issued: the
  // signature check runs before the database lookup, so every customer got
  // "Key not recognized" and nothing in the logs connected it to the rotation.
  // AMH_SECRET_PREV keeps old keys working through a rotation window.
  const OLD = 'old-secret-value-from-before-the-rotation';
  const NEW = 'brand-new-secret-value';
  const MID = 'a1b2c3d4';

  const oldKey = keyForWith(OLD, MID);
  const newKey = keyForWith(NEW, MID);

  // --- without the fallback: rotation breaks the old key (the bug) ---------
  {
    const { env } = fresh({ AMH_SECRET: NEW });
    env.DB.prepare('INSERT INTO customers (machine_id, key, expiry, revoked) VALUES (?,?,?,0)')
      .bind(MID, oldKey, '00000000').run();
    const r = await api(env, '/api/validate', { method: 'POST', body: { mid: MID, key: oldKey }, headers: { 'CF-Connecting-IP': '203.0.113.11' } });
    const j = await r.json();
    assert.equal(j.valid, false, 'sanity: with no PREV set, a pre-rotation key is rejected');
    assert.equal(j.reason, 'bad_signature', 'and it is rejected for the signature, not the row');
  }

  // --- with the fallback: the old key still works -------------------------
  {
    const { env } = fresh({ AMH_SECRET: NEW, AMH_SECRET_PREV: OLD });
    env.DB.prepare('INSERT INTO customers (machine_id, key, expiry, revoked) VALUES (?,?,?,0)')
      .bind(MID, oldKey, '00000000').run();
    const r = await api(env, '/api/validate', { method: 'POST', body: { mid: MID, key: oldKey }, headers: { 'CF-Connecting-IP': '203.0.113.12' } });
    const j = await r.json();
    assert.equal(j.valid, true, 'a key minted under the PREVIOUS secret still validates');
  }

  // --- new keys work too, and PREV does not weaken anything ---------------
  {
    const { env } = fresh({ AMH_SECRET: NEW, AMH_SECRET_PREV: OLD });
    env.DB.prepare('INSERT INTO customers (machine_id, key, expiry, revoked) VALUES (?,?,?,0)')
      .bind(MID, newKey, '00000000').run();
    let r = await api(env, '/api/validate', { method: 'POST', body: { mid: MID, key: newKey }, headers: { 'CF-Connecting-IP': '203.0.113.13' } });
    assert.equal((await r.json()).valid, true, 'a key minted under the CURRENT secret validates');

    // A key signed with neither secret is still refused. Uses its own machine
    // id: /api/validate rate-limits per mid as well as per IP, and reusing MID
    // here measured the throttle instead of the signature check.
    const MID2 = 'b2c3d4e5';
    const forged = keyForWith('a-third-secret-nobody-has', MID2);
    r = await api(env, '/api/validate', { method: 'POST', body: { mid: MID2, key: forged }, headers: { 'CF-Connecting-IP': '203.0.113.14' } });
    const j = await r.json();
    assert.equal(j.valid, false, 'a key signed with an unrelated secret is still forged');
    assert.equal(j.reason, 'bad_signature', 'and reported as a bad signature');
  }

  ok('AMH_SECRET rotation: old keys survive via AMH_SECRET_PREV, forgeries still fail');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1c — arriving from the panel skips the Machine ID step');

{
  // The panel's Buy button opens this chat with the id already in the message.
  // The bot used to acknowledge it and then ask for it again, making the buyer
  // hand-copy a 16-character installation id the panel had already filled in.
  const { env } = fresh();
  await post(env, msg(Number(BUYER), { id: Number(BUYER) },
    { text: 'Hello! I want to buy Amharic Captions.\nMachine ID: a1b2c3d4' }));

  const st = row(env, 'SELECT * FROM fsm WHERE uid=?', BUYER);
  assert.ok(st, 'arriving with a Machine ID starts a state');
  assert.equal(st.mid, 'a1b2c3d4', 'the Machine ID is remembered, not discarded');

  // tapping "I've paid" must go straight to the screenshot
  OUTBOUND.length = 0;
  await cb(env, { id: Number(BUYER) }, 'pay:proof', { chatId: Number(BUYER) });
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'photo',
    'skips the Machine ID step — goes straight to awaiting the screenshot');
  const said = JSON.stringify(OUTBOUND);
  assert.ok(said.includes('computer is connected') && !said.includes('Machine ID'), 'told the computer is connected — no Machine ID talk');

  // and the screenshot books the order for that computer
  await post(env, msg(Number(BUYER), { id: Number(BUYER) },
    { photo: [{ file_id: 'P1', width: 9, height: 9 }] }));
  assert.equal(row(env, "SELECT machine_id FROM orders WHERE uid=? AND status='pending'", BUYER).machine_id, 'a1b2c3d4',
    'screenshot books the order for the remembered computer');

  ok('panel hand-off: Machine ID carried through, one step removed');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1d — admin history is browsable and decisions are reversible');

{
  const { env } = fresh();
  // three decided orders + one pending
  for (let i = 1; i <= 3; i++) {
    env.DB.prepare("INSERT INTO orders (uid, chat_id, username, machine_id, photo_key, status, expiry, amount_etb, created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
      .bind(String(9000 + i), String(9000 + i), 'buyer' + i, 'aaaaaaa' + i, 'PH' + i,
            ['approved', 'rejected', 'pending'][i - 1], '00000000', 2500).run();
  }

  // history must offer a button per order — it used to be plain text only
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:history');
  const hist = OUTBOUND.filter((o) => o.method === 'editMessageText').at(-1);
  const kb = JSON.stringify(hist.body.reply_markup.inline_keyboard);
  assert.ok(kb.includes('admin:detail:1'), 'history row 1 opens that order');
  assert.ok(kb.includes('admin:detail:3'), 'history row 3 opens that order');
  assert.ok(hist.body.text.includes('of <b>3</b>'), 'history states the total');

  // an APPROVED order must offer revoke — the function existed but was only
  // reachable by typing /revoke from memory
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?,?,?,?, 'sold', ?)")
    .bind('aaaaaaa1', '@buyer1', '00000000', 'AMH-TEST', '9001').run();
  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:detail:1');
  let card = OUTBOUND.filter((o) => o.method === 'sendPhoto' || o.method === 'sendMessage').at(-1);
  assert.ok(JSON.stringify(card.body.reply_markup).includes('admin:revoke:1'),
    'an approved order can be revoked from its detail card');

  // and revoking actually kills the key
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:revoke:1');
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', 'aaaaaaa1').revoked, 1,
    'revoke flips the customer row');

  // Revoking must visibly change the card, not just the database — otherwise
  // the order still reads APPROVED with a Revoke button and looks like the tap
  // did nothing.
  const after = OUTBOUND.filter((o) => o.method === 'sendPhoto' || o.method === 'sendMessage').at(-1);
  assert.ok(String(after.body.caption || after.body.text || '').toUpperCase().includes('REVOKED'),
    'the card is redrawn showing the new status');
  assert.ok(JSON.stringify(after.body.reply_markup).includes('admin:unrevoke:'),
    'and now offers Restore instead of Revoke');

  // a REJECTED order must offer a way back — declining by mistake was final
  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:detail:2');
  card = OUTBOUND.filter((o) => o.method === 'sendPhoto' || o.method === 'sendMessage').at(-1);
  assert.ok(JSON.stringify(card.body.reply_markup).includes('approve:2'),
    'a declined order can still be approved afterwards');

  // AND it must actually work. Asserting the button exists proved nothing:
  // approve() claimed WHERE status='pending', so on a rejected order it
  // changed 0 rows and answered "Already handled" while looking fine.
  await cb(env, { id: Number(ADMIN_ID) }, 'approve:2');
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', 2).status, 'approved',
    'Approve anyway actually approves a previously rejected order');
  assert.ok(row(env, 'SELECT * FROM customers WHERE machine_id=?', 'aaaaaaa2'),
    'and mints the key it owes the buyer');

  ok('history opens any order; approve/decline are reversible from the card');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1e — support lookup, and stale flows expire');

{
  const { env } = fresh();
  env.DB.prepare("INSERT INTO orders (uid, chat_id, username, machine_id, photo_key, status, expiry, amount_etb, created_at) VALUES (?,?,?,?,?, 'approved', '00000000', 2500, datetime('now'))")
    .bind('7001', '7001', 'someone', 'c0ffee11', 'PH').run();
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?,?,?,?, 'sold', ?)")
    .bind('c0ffee11', '@someone', '00000000', 'AMH-FIND-ME', '7001').run();

  // the actual support request: "my key doesn't work", here is my machine id
  OUTBOUND.length = 0;
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: '/find c0ffee11' }));
  const found = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  assert.ok(found.body.text.includes('AMH-FIND-ME'), 'lookup shows the key');
  assert.ok(found.body.text.includes('Licensed'), 'lookup shows licence state');
  const kb = JSON.stringify(found.body.reply_markup);
  assert.ok(kb.includes('admin:detail:'), 'lookup links to the order');
  assert.ok(kb.includes('admin:revoke:'), 'lookup offers revoke directly');

  // unknown machine gets a useful answer, not silence
  OUTBOUND.length = 0;
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: '/find deadbe11' }));
  assert.ok(OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1).body.text.includes('Nothing found'),
    'unknown machine id is reported clearly');

  // buyers must not be able to look each other up
  OUTBOUND.length = 0;
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '/find c0ffee11' }));
  assert.ok(!JSON.stringify(OUTBOUND).includes('AMH-FIND-ME'),
    'a non-admin cannot read someone else\'s key');

  // a purchase flow abandoned long ago must not resurface
  env.DB.prepare("INSERT INTO fsm (uid, step, mid, hint, updated_at) VALUES (?, 'photo', 'c0ffee11', 1, datetime('now','-40 days'))")
    .bind('7002').run();
  const stale = await (async () => {
    OUTBOUND.length = 0;
    await post(env, msg(7002, { id: 7002 }, { text: 'hello?' }));
    return row(env, 'SELECT * FROM fsm WHERE uid=?', '7002');
  })();
  assert.ok(!stale, 'a 40-day-old flow is dropped rather than resumed');

  ok('support lookup by Machine ID (admin only); stale purchase flows expire');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1f — buyer buttons answer, and Back always lands');

{
  // Telegram spins a button until its callback query is ANSWERED. No
  // buyer-facing branch did that, so every buyer tap sat "loading" for ~30s
  // even when it had worked — which is what "Back to menu doesn't work"
  // looked like from the buyer's side.
  const { env } = fresh();

  for (const data of ['menu:pay', 'pay:proof', 'proof:cancel', 'menu:home']) {
    OUTBOUND.length = 0;
    await cb(env, { id: Number(BUYER) }, data, { chatId: Number(BUYER) });
    assert.ok(OUTBOUND.some((o) => o.method === 'answerCallbackQuery'),
      `${data} answers the callback query (button stops spinning)`);
  }

  // Back must leave the buyer on the menu, and clear the flow
  env.DB.prepare("INSERT INTO fsm (uid, step, mid, hint, updated_at) VALUES (?, 'mid', NULL, 1, datetime('now'))")
    .bind(BUYER).run();
  OUTBOUND.length = 0;
  await cb(env, { id: Number(BUYER) }, 'proof:cancel', { chatId: Number(BUYER) });
  assert.ok(!row(env, 'SELECT * FROM fsm WHERE uid=?', BUYER), 'Back clears the purchase flow');
  const showsMenu = OUTBOUND.some((o) =>
    (o.method === 'editMessageText' || o.method === 'sendMessage')
    && JSON.stringify(o.body.reply_markup || {}).includes('menu:pay'));
  assert.ok(showsMenu, 'Back puts the main menu back on screen');

  // and if the edit fails (photo message, or unchanged content — safeSend
  // swallows both), the menu must still be sent rather than nothing happening
  OUTBOUND.length = 0;
  // cancel makes three outbound calls: answerCb, the reply-keyboard sweep, then
  // the edit. Fail all three so the edit is the one that falls over.
  FAIL_NEXT = 3;
  await cb(env, { id: Number(BUYER) }, 'proof:cancel', { chatId: Number(BUYER) });
  FAIL_NEXT = 0;
  const fellBack = OUTBOUND.some((o) => o.method === 'sendMessage'
    && JSON.stringify(o.body.reply_markup || {}).includes('menu:pay'));
  assert.ok(fellBack, 'a failed edit falls back to sending the menu');

  ok('buyer taps are acknowledged; Back always lands on the menu');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1g — every buyer message speaks Amharic; /help answers');

{
  const { env } = fresh();
  const geez = (t) => /[\u1200-\u137F]/.test(t);

  // The whole point: a buyer must never be dropped into English at a moment
  // of confusion. Walk the states a confused buyer actually reaches.
  const probes = [
    ['unknown input', { text: 'asdfghjk' }],
    ['photo sent outside the flow', { photo: [{ file_id: 'X1', width: 4, height: 4 }] }],
    ['a PDF instead of a screenshot', { document: { file_id: 'D1', mime_type: 'application/pdf' } }],
  ];
  for (const [what, payload] of probes) {
    OUTBOUND.length = 0;
    await post(env, msg(Number(BUYER), { id: Number(BUYER) }, payload));
    const said = OUTBOUND.filter((o) => o.method === 'sendMessage').map((o) => o.body.text || '').join(' ');
    assert.ok(geez(said), `${what}: the reply speaks Amharic`);
  }

  // /help must answer rather than fall through to "I didn't understand"
  OUTBOUND.length = 0;
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '/help' }));
  const help = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  assert.ok(geez(help.body.text), '/help answers in Amharic');
  assert.ok(help.body.text.includes('Machine ID'), '/help covers where to find the Machine ID');
  assert.ok(JSON.stringify(help.body.reply_markup).includes('menu:pay'), '/help routes to Pay');

  // /buy goes straight to the payment details, not back to the welcome
  OUTBOUND.length = 0;
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '/buy' }));
  const buy = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  assert.ok(JSON.stringify(buy.body.reply_markup).includes('pay:proof'),
    '/buy opens the payment screen directly');

  ok('confused-buyer paths all answer in Amharic; /help and /buy work');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 1h — "I have paid" sends exactly one prompt');

{
  // Tapping "I've paid" used to edit the tapped message AND send a second one
  // saying the same thing, so two near-identical prompts arrived at once and
  // the second was English with no way back. Reported from real use.
  const { env } = fresh();
  OUTBOUND.length = 0;
  await cb(env, { id: Number(BUYER) }, 'pay:proof', { chatId: Number(BUYER) });

  const shown = OUTBOUND.filter((o) => o.method === 'sendMessage' || o.method === 'editMessageText');
  assert.equal(shown.length, 1, 'exactly one prompt, not two');
  const only = shown[0];
  assert.ok(/[\u1200-\u137F]/.test(only.body.text), 'the prompt speaks Amharic');
  assert.ok(JSON.stringify(only.body.reply_markup).includes('proof:cancel'),
    'and carries a Back button');

  // the same must hold on the panel hand-off path (mid already known)
  const env2 = fresh().env;
  env2.DB.prepare("INSERT INTO fsm (uid, step, mid, hint, updated_at) VALUES (?, 'have_mid', 'a1b2c3d4', 1, datetime('now'))")
    .bind(BUYER).run();
  OUTBOUND.length = 0;
  await cb(env2, { id: Number(BUYER) }, 'pay:proof', { chatId: Number(BUYER) });
  const shown2 = OUTBOUND.filter((o) => o.method === 'sendMessage' || o.method === 'editMessageText');
  assert.equal(shown2.length, 1, 'one prompt on the known-machine path too');
  assert.ok(JSON.stringify(shown2[0].body.reply_markup).includes('proof:cancel'),
    'which also has a Back button');

  ok('"I have paid" shows one Amharic prompt with a way back');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 2 — screenshot as document (pdf rejected, image accepted)');

{
  const { env } = fresh();
  await startBuyFlow(env);
  // a genuinely valid (non-suspicious) machine id
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '0badc0de' }));
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'photo');

  // PDF document -> rejected as "file, not photo", still waiting
  let res = await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { document: { file_id: 'PDF1', mime_type: 'application/pdf' } }));
  assert.equal(res.status, 200);
  // Assert the behaviour, not the sentence: buyer copy is bilingual and keeps
  // being reworded, but "a PDF is refused and we stay on the photo step" is
  // the contract. (The English half is checked loosely so a rewrite of the
  // Amharic does not break the suite.)
  assert.ok(JSON.stringify(OUTBOUND).toLowerCase().includes('cannot read that file'), 'pdf rejected');
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'photo', 'still awaiting photo');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM orders').n, 0, 'no order from a pdf');

  // image mimetype sent as a document -> accepted as proof, order booked
  res = await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { document: { file_id: 'IMG1', mime_type: 'image/png' } }));
  assert.equal(res.status, 200);
  const o = row(env, 'SELECT * FROM orders');
  assert.ok(o, 'order books from an image document');
  assert.equal(o.photo_key, 'IMG1');
  ok('document: pdf rejected, image accepted, order books');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 3 — username change between proof and approve');

{
  const { env } = fresh();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER), username: 'oldname' }, { text: '1a2b3c4d' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER), username: 'oldname' }, { photo: [{ file_id: 'P1' }, { file_id: 'P2' }] }));
  // order username comes from the confirm callback's from.username
  await cb(env, { id: Number(BUYER), username: 'oldname' }, 'proof:confirm', { chatId: Number(BUYER) });
  const o = row(env, 'SELECT * FROM orders');
  assert.equal(o.username, 'oldname');
  // buyer changes username before admin approves (username is not stored in uid)
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  const dm = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === BUYER && (x.body.text || '').includes('AMH-'))[0];
  assert.ok(dm, 'key DM delivered to buyer uid regardless of username');
  assert.equal(row(env, 'SELECT name FROM customers WHERE machine_id=?', '1a2b3c4d').name, '@oldname');
  ok('username change does not break delivery; customer logs the proof-time name');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 4 — group start, DM finish');

{
  const { env } = fresh();
  // /start inside the sales group -> welcome, NO fsm
  let res = await post(env, msg(Number(GROUP), { id: Number(BUYER) }, { text: '/start' }));
  assert.equal(res.status, 200);
  assert.ok(JSON.stringify(OUTBOUND).includes('አማርኛ ካፕሽን'), 'group welcome sent');
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0, 'no fsm from group start');
  await cb(env, { id: Number(BUYER) }, 'pay:proof', { chatId: Number(GROUP) });
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0, 'group payment callback cannot create an FSM');
  ok('group /start only welcomes and payment callbacks stay private');

  // then complete the whole purchase in the DM
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: 'f00dbeef' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'F1' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const o = row(env, 'SELECT * FROM orders');
  assert.ok(o, 'DM-finish order booked');
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.ok(row(env, 'SELECT * FROM customers WHERE machine_id=?', 'f00dbeef'));
  ok('group-start -> DM-finish completes cleanly');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 5 — Telegram retries + network blips');

{
  const { env } = fresh();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: 'c0ffee12' }));

  // blip: the buyer's status message fails to send (the first outbound call
  // after the screenshot books the order).
  const photoUpdate = msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'Z1' }, { file_id: 'Z2' }] });
  FAIL_NEXT = 1;
  let res = await post(env, photoUpdate);
  assert.equal(res.status, 200, 'worker still answers 200 despite blip');
  let orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'order booked despite blip');
  assert.equal(orders[0].status_msg_id, null, 'status_msg_id kept null on send failure');

  // Telegram re-delivers the exact same update (it got a 200, but a mirror/op
  // retry or double-delivery) -> must stay at one order
  res = await post(env, photoUpdate);
  assert.equal(res.status, 200);
  // …and a second screenshot only replaces the proof of the waiting order.
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'Z3' }] }));
  orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'same update replayed / second screenshot -> one order');
  assert.equal(orders[0].photo_key, 'Z3', 'the newer screenshot replaced the proof');
  ok('replayed update + blip -> still exactly one order, 200s');

  // zero coverage: a truly concurrent double-confirm — hit the DB directly to
  // simulate the second IsolRead() seeing the same pending state before the
  // first commit: run completeProof twice in parallel.
  const o = orders[0];
  res = await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.equal(res.status, 200);
  res = await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.equal(res.status, 200);
  assert.equal(rows(env, 'SELECT * FROM customers').length, 1);
  ok('approve retried/parallel -> single key');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 6 — reject path');

{
  const { env } = fresh();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: 'a1b2c3d4' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'R1' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const o = row(env, 'SELECT * FROM orders');
  // Declining is two taps now: ❌ opens a reason picker, the reason declines.
  // The buyer needs to know WHICH thing to fix, so the reason is not optional.
  let res = await cb(env, { id: Number(ADMIN_ID) }, `reject:${o.id}`);
  assert.equal(res.status, 200);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'pending',
    'tapping Decline alone does NOT decline — it asks why first');
  const picker = OUTBOUND.filter((x) => x.method === 'editMessageReplyMarkup');
  assert.ok(picker.length, 'the reason picker replaces the card buttons');
  assert.ok(JSON.stringify(picker[picker.length - 1].body).includes('rej:amount'),
    'picker offers a wrong-amount reason');

  res = await cb(env, { id: Number(ADMIN_ID) }, `rej:amount:${o.id}`);
  assert.equal(res.status, 200);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'rejected');
  assert.equal(rows(env, 'SELECT * FROM customers').length, 0, 'no key minted');
  // Assert the buyer is not left at a dead end, rather than on a phrase: they
  // must be told, AND given a way back. A decline used to send one English
  // sentence with no reason and no buttons, while the live status message they
  // were watching still said "Pending".
  const buyerMsg = OUTBOUND.filter((x) => x.method === 'sendMessage'
    && String(x.body.chat_id) === BUYER
    && (x.body.text || '').includes('could not verify'));
  assert.ok(buyerMsg.length, 'buyer is told the proof was not verified');
  const kb = JSON.stringify(buyerMsg[buyerMsg.length - 1].body.reply_markup || {});
  assert.ok(kb.includes('pay:proof'), 'declined buyer gets a Try again button');
  assert.ok(kb.includes('t.me'), 'declined buyer gets a way to reach support');
  // the specific reason, not a generic list of everything that could be wrong
  assert.ok(buyerMsg[buyerMsg.length - 1].body.text.includes('amount did not match'),
    'buyer is told the specific reason the admin chose');
  // and the pending status they were watching is resolved, not left hanging
  const edited = OUTBOUND.filter((x) => x.method === 'editMessageText'
    && String(x.body.chat_id) === BUYER
    && (x.body.text || '').includes('Declined'));
  assert.ok(edited.length, 'the live status message is updated to Declined');
  // re-declining an already-declined order is a no-op
  res = await cb(env, { id: Number(ADMIN_ID) }, `rej:amount:${o.id}`);
  assert.equal(res.status, 200);
  ok('decline asks why, tells the buyer that reason, offers a way back, idempotent');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 7 — existing customer cannot double-buy a machine');

{
  const { env } = fresh();
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES ('a1b2c3d4','@x','00000000',?,'sold','999')").bind(keyFor('a1b2c3d4')).run();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: 'a1b2c3d4' }));
  assert.ok(JSON.stringify(OUTBOUND).includes('already has a key'), 'buyer told machine already has key');
  assert.equal(rows(env, 'SELECT * FROM orders').length, 0, 'no order created');
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0, 'fsm cleared');
  ok('existing key blocks a second sale on the same machine');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 8 — webhook auth: fail-closed');

{
  const { env } = fresh();
  // health + removed debug
  let r = await api(env, '/ok');
  assert.equal(await r.text(), 'ok');
  r = await api(env, '/ready');
  assert.equal(r.status, 200, 'readiness checks crypto, bindings, and webhook config');
  r = await api(env, '/debug');
  assert.equal(r.status, 405, '/debug removed');
  ok('/ok works, /debug gone');

  // wrong secret -> 401; right secret -> 200
  r = await post(env, msg(Number(BUYER), {}, { text: 'hi' }), 'wrongsecret');
  assert.equal(r.status, 401);
  r = await post(env, msg(Number(BUYER), {}, { text: 'hi' }), WEBHOOK_SECRET);
  assert.equal(r.status, 200);
  ok('webhook secret enforced (401 on wrong, 200 on right)');

  // unconfigured secret -> fail closed (500), stay silently rejected
  const { env: env2 } = fresh({ AMH_WEBHOOK_SECRET: '' });
  r = await post(env2, msg(Number(BUYER), {}, { text: 'hi' }), '');
  assert.equal(r.status, 500, 'no secret configured -> refuse update');
  const upd2 = await post(env2, msg(Number(BUYER), {}, { text: 'hi' }), 'anything');
  assert.equal(upd2.status, 500);
  ok('no webhook secret -> fail closed (500, no processing)');

  // Telegram retries the same update_id: the idempotency ledger acknowledges
  // the retry without sending a second reply.
  const { env: env3 } = fresh();
  const update = msg(Number(BUYER), { id: Number(BUYER) }, { text: '/start' });
  update.update_id = 987654;
  OUTBOUND.length = 0;
  assert.equal((await post(env3, update)).status, 200);
  const firstCount = OUTBOUND.length;
  assert.equal((await post(env3, update)).status, 200);
  assert.equal(OUTBOUND.length, firstCount, 'duplicate update is not replayed');
  // A worker crash leaves a NULL completion; an expired lease is reclaimable.
  env3.DB.prepare("INSERT INTO webhook_updates (update_id, completed_at, claimed_at) VALUES (987655, NULL, datetime('now','-11 minutes'))").run();
  const stale = msg(Number(BUYER), { id: Number(BUYER) }, { text: '/start' });
  stale.update_id = 987655;
  OUTBOUND.length = 0;
  assert.equal((await post(env3, stale)).status, 200);
  assert.ok(OUTBOUND.length > 0, 'expired webhook claim is reclaimed and processed');
  ok('webhook idempotency ledger reclaims abandoned processing leases');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 9 — extension API: trial, rate limits, API key toggle');

{
  const { env, kv } = fresh();
  // trial get
  let r = await api(env, '/api/trial?mid=a1b2c3d4');
  let j = await r.json();
  assert.equal(j.used, 0);
  r = await api(env, '/api/trial?mid=NOTHEX');
  assert.equal(r.status, 400);
  ok('/api/trial baseline');

  // two distinct IPs double-firing use -> per-machine collapse returns used=1
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' } });
  j = await r.json();
  assert.equal(j.used, 1);
  assert.equal(j.charged, true, 'first charge is explicitly accepted');
  // same machine, another IP, immediately -> 2s mid marker collapses to used=1 (200)
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.used, 1, 'double-fire collapses to one increment');
  // same mid again -> SQL 2s collapse (no KV, atomic) returns current, no extra credit
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(r.status, 200, 'rapid reuse returns 200 (never 429)');
  j = await r.json();
  assert.equal(j.used, 1, 'rapid reuse collapse: no blind increment');
  assert.equal(j.charged, false, 'collapsed request is not treated as a new charge');
  ok('trial/use: per-mid SQL collapse is atomic (no KV race, no 429 -> no local-increment exploit)');

  // New panels send a run ID. It is idempotent only for the MID that created it.
  const runId = 'run-idempotency-12345678';
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '13579bdf', run_id: runId }, headers: { 'CF-Connecting-IP': '198.51.100.30' } });
  j = await r.json();
  assert.equal(j.used, 1);
  assert.equal(j.charged, true, 'run-id charge is explicitly accepted');
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '13579bdf', run_id: runId }, headers: { 'CF-Connecting-IP': '198.51.100.31' } });
  j = await r.json();
  assert.equal(j.used, 1, 'same run retry is idempotent');
  assert.equal(j.duplicate, true);
  assert.equal(j.charged, true, 'duplicate run preserves the original charge result');
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '2468ace0', run_id: runId }, headers: { 'CF-Connecting-IP': '198.51.100.32' } });
  assert.equal(r.status, 200, 'run ID conflict fails closed with a blocking state');
  j = await r.json();
  assert.equal(j.remaining, 0);
  assert.equal(j.charged, false, 'conflicting run ID is never charged');
  assert.equal(row(env, 'SELECT used FROM trials WHERE machine_id=?', '2468ace0'), null);
  ok('trial reservations are idempotent and bound to their machine ID');

  // trial caps at max_free
  for (let i = 0; i < 6; i++) {
    const ip = '198.51.100.' + i;
    r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': ip } });
    j = await r.json();
  }
  const used = row(env, 'SELECT used FROM trials WHERE machine_id=?', 'a1b2c3d4').used;
  assert.ok(used <= 2, `trial never exceeds cap (used=${used})`);
  r = await api(env, '/api/trial?mid=A1B2C3D4');
  assert.equal((await r.json()).used, used, 'trial GET canonicalizes Machine ID case');
  ok('trial hard-capped at max_free and case-insensitive');

  // per-IP trial GET throttle: fresh IPs — first pass 200, next mid 429
  r = await api(env, '/api/trial?mid=ffffffff', { headers: { 'CF-Connecting-IP': '203.0.113.50' } });
  assert.equal(r.status, 200);
  r = await api(env, '/api/trial?mid=dddddddd', { headers: { 'CF-Connecting-IP': '203.0.113.50' } });
  assert.equal(r.status, 429, 'trial GET per-IP throttle on cache-miss spray');
  ok('trial GET per-IP throttle');

  // validate per-IP throttle
  r = await api(env, '/api/validate', { method: 'POST', body: { mid: 'eeeeeeee', key: 'x' }, headers: { 'CF-Connecting-IP': '198.51.100.90' } });
  assert.equal(r.status, 200);
  r = await api(env, '/api/validate', { method: 'POST', body: { mid: 'eeeeeeee', key: 'y' }, headers: { 'CF-Connecting-IP': '198.51.100.90' } });
  assert.equal(r.status, 429, 'validate per-IP throttle');
  ok('validate throttling wired');

  // API-key policy: the extension API is public by default; an optional
  // deployment gate can require a header, but it is not license auth.
  const envA = fresh();
  r = await api(envA.env, '/api/trial?mid=b1b2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.60' } });
  assert.equal(r.status, 200, 'public extension API works without a client secret');
  const envMissing = fresh({ AMH_REQUIRE_API_KEY: '1' });
  r = await api(envMissing.env, '/api/trial?mid=b1b2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.60' } });
  assert.equal(r.status, 503, 'optional API gate fails closed when misconfigured');
  const envK = fresh({ AMH_REQUIRE_API_KEY: '1', AMH_API_KEY: 'sekrit' });
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.61' } });
  assert.equal(r.status, 401, 'API_KEY set -> no header => 401');
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.62', 'X-Api-Key': 'sekrit' } });
  assert.equal(r.status, 200, 'API_KEY set + header => allowed');
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.63', 'X-Api-Key': 'nope' } });
  assert.equal(r.status, 401, 'wrong header => 401');
  ok('AMH_API_KEY: public by default; optional deployment gate enforced');

  // panel boot ping: version/Origin telemetry, also key-gated
  r = await api(envK.env, '/api/ping', { method: 'POST', body: { v: '1.4.1', mid: 'c2c2c2c2' }, headers: { 'CF-Connecting-IP': '203.0.113.70', 'X-Api-Key': 'sekrit' } });
  assert.equal(r.status, 200, 'ping allowed with key');
  const pingJ = await r.json();
  assert.equal(pingJ.ok, true, 'ping returns ok');
  r = await api(envK.env, '/api/ping', { method: 'POST', body: { v: '1.4.1', mid: 'c3c3c3c3' }, headers: { 'CF-Connecting-IP': '203.0.113.70', 'X-Api-Key': 'sekrit' } });
  assert.equal(r.status, 429, 'ping per-IP throttle blocks telemetry spray');
  r = await api(envK.env, '/api/ping', { method: 'POST', body: { v: '1.4.1' }, headers: { 'CF-Connecting-IP': '203.0.113.71' } });
  assert.equal(r.status, 401, 'ping without key => 401');
  ok('/api/ping telemetry wired, gated, and rate-limited');

  // update-available notice: one cached GitHub lookup for every customer
  {
    const envU = fresh();
    GH.calls = 0; GH.status = 200; GH.body = { tag_name: 'v1.8.0' };
    let u = await api(envU.env, '/api/latest', { headers: { 'CF-Connecting-IP': '203.0.113.90' } });
    assert.equal(u.status, 200, 'latest ok');
    let uj = await u.json();
    assert.deepEqual(uj, { version: '1.8.0', url: 'https://amharic-caption-pro.vercel.app/install/' });
    for (let i = 0; i < 5; i++) {
      u = await api(envU.env, '/api/latest', { headers: { 'CF-Connecting-IP': '203.0.113.9' + i } });
      assert.equal(u.status, 200, 'many callers, same shared IP or not, never throttled');
    }
    assert.equal(GH.calls, 1, 'GitHub asked once; everyone else served from cache');
    // an hour passes and GitHub is down: the last good answer is still served
    await envU.kv.delete('latest:release');
    GH.status = 500;
    u = await api(envU.env, '/api/latest', { headers: { 'CF-Connecting-IP': '203.0.113.99' } });
    uj = await u.json();
    assert.equal(uj.version, '1.8.0', 'GitHub outage -> last known version');
    const callsDuringOutage = GH.calls;
    await api(envU.env, '/api/latest', { headers: { 'CF-Connecting-IP': '203.0.113.98' } });
    assert.equal(GH.calls, callsDuringOutage, 'outage backoff: no request per customer');
    // never seen a good answer + junk tag => 503, nothing invented
    const envV = fresh();
    GH.status = 200; GH.body = { tag_name: 'nightly-<script>' };
    u = await api(envV.env, '/api/latest', { headers: { 'CF-Connecting-IP': '203.0.113.97' } });
    assert.equal(u.status, 503, 'invalid tag is never served');
    GH.body = { tag_name: 'v1.8.0' };
  }
  ok('/api/latest: cached once for everyone, survives GitHub outages, only clean versions');

  // CORS lock: whitelisted origins echoed, anything else gets no allow header
  const envL = fresh({ AMH_ALLOWED_ORIGIN: 'file://,null' });
  let rl = await api(envL.env, '/api/ping', { method: 'POST', body: { v: '1.4.1' }, headers: { 'CF-Connecting-IP': '203.0.113.72', 'X-Api-Key': 'sekrit', Origin: 'file://' } });
  assert.equal(rl.headers.get('access-control-allow-origin'), 'file://', 'file:// panel origin echoed');
  rl = await api(envL.env, '/api/ping', { method: 'POST', body: { v: '1.4.1' }, headers: { 'CF-Connecting-IP': '203.0.113.73', 'X-Api-Key': 'sekrit', Origin: 'null' } });
  assert.equal(rl.headers.get('access-control-allow-origin'), 'null', 'CEP null origin echoed');
  rl = await api(envL.env, '/api/ping', { method: 'POST', body: { v: '1.4.1' }, headers: { 'CF-Connecting-IP': '203.0.113.74', 'X-Api-Key': 'sekrit', Origin: 'https://evil.example' } });
  assert.equal(rl.headers.get('access-control-allow-origin'), null, 'unknown origin blocked');
  ok('AMH_ALLOWED_ORIGIN whitelist enforced');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 10 — admin dashboard + prune keep 30 days');

{
  const { env } = fresh();
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, created_at) VALUES ('1','@a','aaaaaaaa','','','1','approved',datetime('now','-40 days'))").run();
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, created_at) VALUES ('2','@b','bbbbbbbb','','','2','pending',datetime('now','-2 days'))").run();
  let r = await cb(env, { id: Number(ADMIN_ID) }, 'admin:panel');
  assert.equal(r.status, 200);
  assert.equal(rows(env, "SELECT * FROM orders WHERE machine_id='aaaaaaaa'").length, 0, '>30d pruned');
  assert.equal(rows(env, "SELECT * FROM orders WHERE machine_id='bbbbbbbb'").length, 1, 'recent kept');
  ok('pruneOld removes >30d, keeps recent, admin panel runs');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 11 — amount_etb, queue pagination, multi-admin');

{
  const { env } = fresh({ AMH_PRICE_ETB: '3000' });

  // order stamping uses the numeric price (AMH_PRICE_ETB)
  env.DB.prepare("INSERT INTO fsm (uid, step, mid, photo_key, hint, updated_at) VALUES (?, 'confirm', 'a1b2c3d4', 'FB', 0, datetime('now'))").bind(BUYER).run();
  let r = await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  assert.equal(r.status, 200);
  const stamped = row(env, 'SELECT amount_etb FROM orders WHERE machine_id=?', 'a1b2c3d4');
  assert.equal(stamped.amount_etb, 3000, 'order stamped with numeric AMH_PRICE_ETB');
  ok('completeProof stamps amount_etb from AMH_PRICE_ETB');

  // 12 pending → first page 10, '▶ More' → next page 2
  for (let i = 1; i <= 12; i++) {
    const mid = 'cc0000' + (i < 10 ? '0' + i : i);
    env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status) VALUES (?,?,?, '', '',?, 'pending')").bind(String(10 + i), '@u' + i, mid, String(10 + i)).run();
  }
  OUTBOUND.length = 0; MSG = 0;
  r = await cb(env, { id: Number(ADMIN_ID) }, 'admin:queue');
  assert.equal(r.status, 200);
  const cards1 = OUTBOUND.filter((o) => o.method === 'sendMessage' && (o.body.text || '').includes('#'));
  assert.equal(cards1.length, 10, 'first page shows 10 cards');
  const sum1 = OUTBOUND.find((o) => o.method === 'sendMessage' && String(o.body.chat_id) === ADMIN_ID && JSON.stringify(o.body).includes('▶ More'));
  assert.ok(sum1 && (sum1.body.text || '').includes('1–10'), 'summary indicates first 10 of 12');
  r = await cb(env, { id: Number(ADMIN_ID) }, 'admin:queuep:10');
  const cards2 = OUTBOUND.filter((o) => o.method === 'sendMessage' && (o.body.text || '').includes('#')).length - cards1.length;
  assert.equal(cards2, 2, 'load-more reveals the last 2');
  ok('admin queue paginates 10 + Load more');

  // multi-admin: second admin can approve; a buyer tapping admin:queue is rejected
  const envM = fresh({ AMH_ADMIN_ID: ADMIN_ID + ',999888777' });
  envM.env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status) VALUES ('1','@x','deadbeef','', '', '1','pending')").run();
  const oid = row(envM.env, 'SELECT id FROM orders WHERE machine_id=?', 'deadbeef').id;
  r = await cb(envM.env, { id: 999888777 }, 'admin:queue');
  assert.equal(r.status, 200, 'second admin allowed');
  r = await cb(envM.env, { id: 999888777 }, `approve:${oid}`);
  assert.equal(r.status, 200);
  assert.equal(row(envM.env, 'SELECT status FROM orders WHERE id=?', oid).status, 'approved', 'second admin approved');
  r = await cb(envM.env, { id: Number(BUYER) }, 'admin:queue');
  assert.equal(r.status, 200, 'buyer tap does not crash');
  const blockedMsg = OUTBOUND.filter((o) => o.method === 'answerCallbackQuery').at(-1);
  assert.ok((blockedMsg.body.text || '').includes('Admin only'), 'buyer blocked with "Admin only"');
  ok('multi-admin: comma-separated AMH_ADMIN_ID honored; buyers blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 12 — broadcast, /setexpiry, reply-keyboard hint');

{
  const { env, kv } = fresh();

  // seed buyers so broadcast has recipients
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES ('aaaaaaaa','@a','00000000',?, 'sold', ?)").bind(keyFor('aaaaaaaa'), BUYER).run();
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status) VALUES ('900000002','@b','bbbbbbbb','', '', '900000002','pending')").run();
  const oid = row(env, 'SELECT id FROM orders WHERE machine_id=?', 'bbbbbbbb').id;

  // /setexpiry before approve → key embeds the date
  let r = await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/setexpiry ${oid} 20270101` }));
  assert.equal(r.status, 200);
  assert.equal(row(env, 'SELECT expiry FROM orders WHERE id=?', oid).expiry, '20270101', 'order expiry updated');
  r = await cb(env, { id: Number(ADMIN_ID) }, `approve:${oid}`);
  assert.equal(r.status, 200);
  const cust = row(env, 'SELECT * FROM customers WHERE machine_id=?', 'bbbbbbbb');
  assert.equal(cust.expiry, '20270101');
  const dm2 = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '900000002').find((x) => (x.body.text || '').includes('Expires: 20270101'));
  assert.ok(dm2, 'key DM shows custom expiry');
  ok('/setexpiry embeds a custom expiry in the key');

  OUTBOUND.length = 0; MSG = 0;

  // broadcast: admin taps, sends the text → PREVIEW only, nothing reaches buyers
  const btn = (m, prefix) => {
    for (const row of m.body.reply_markup.inline_keyboard) {
      for (const b of row) if (b.callback_data.startsWith(prefix)) return b.callback_data;
    }
    return null;
  };
  const toBuyers = (needle) => OUTBOUND.filter((x) => x.method === 'sendMessage'
    && [BUYER, '900000002'].includes(String(x.body.chat_id)) && (x.body.text || '').includes(needle));
  r = await cb(env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
  assert.equal(r.status, 200);
  r = await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'Hello buyers! New promo coming.' }));
  assert.equal(r.status, 200);
  assert.equal(toBuyers('Hello buyers!').length, 0, 'typing the message sends nothing to buyers');
  const ask = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID)).at(-1);
  assert.ok(ask.body.text.includes('<b>2</b> buyer(s)'), 'admin sees who would get it: ' + ask.body.text);
  const sendData = btn(ask, 'admin:bcast-send:');
  assert.ok(sendData, 'Send button present');

  // confirm → buyers receive it once; a double tap sends nothing more
  r = await cb(env, { id: Number(ADMIN_ID) }, sendData);
  assert.equal(r.status, 200);
  await cb(env, { id: Number(ADMIN_ID) }, sendData);
  const got = toBuyers('Hello buyers!');
  assert.equal(got.filter((x) => String(x.body.chat_id) === BUYER).length, 1, 'broadcast reaches buyer DM exactly once');
  assert.equal(got.filter((x) => String(x.body.chat_id) === '900000002').length, 1, 'broadcast reaches order-only buyer');
  const confirm = OUTBOUND.find((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID) && (x.body.text || '').includes('Broadcast delivered'));
  assert.ok(confirm, 'admin sees broadcast confirmation');
  assert.equal(await kv.get('bcast:await:' + ADMIN_ID), null, 'broadcast draft cleared');
  ok('broadcast: preview first, Send delivers once to every buyer, admins skipped');

  // /start really cancels: a later "ok" is NOT treated as a broadcast
  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: '/start' }));
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'ok' }));
  assert.equal(toBuyers('ok').length, 0, 'nothing sent to buyers');
  assert.ok(!OUTBOUND.some((x) => JSON.stringify(x.body.reply_markup || {}).includes('bcast-send')),
    'no preview offered after /start cancelled the compose');
  // Cancel on a preview sends nothing
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'Second draft' }));
  const ask2 = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID)).at(-1);
  await cb(env, { id: Number(ADMIN_ID) }, btn(ask2, 'admin:bcast-cancel:'));
  await cb(env, { id: Number(ADMIN_ID) }, btn(ask2, 'admin:bcast-send:'));
  assert.equal(toBuyers('Second draft').length, 0, 'a cancelled draft can never be sent');
  ok('broadcast: /start cancels composing; Cancel kills the draft for good');

  // Large list: first batch in the tap, the rest by the every-minute cron,
  // one report at the end, nobody messaged twice.
  {
    const big = fresh();
    for (let i = 0; i < 95; i++) {
      big.env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?, '@x', '00000000', 'k', 'sold', ?)")
        .bind('c' + String(i).padStart(7, '0'), String(800000000 + i)).run();
    }
    await cb(big.env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
    await post(big.env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'Big news' }));
    const a3 = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID)).at(-1);
    OUTBOUND.length = 0;
    await cb(big.env, { id: Number(ADMIN_ID) }, btn(a3, 'admin:bcast-send:'));
    const firstBatch = OUTBOUND.filter((x) => (x.body.text || '') === 'Big news').length;
    assert.ok(firstBatch > 0 && firstBatch <= 20, 'the tap sends only a first batch: ' + firstBatch);
    const tapCalls = OUTBOUND.length;
    assert.ok(tapCalls <= 45, 'the tap stays under the free-plan subrequest limit: ' + tapCalls);
    for (let i = 0; i < 5; i++) await worker.scheduled({ cron: '* * * * *' }, big.env);
    const all = OUTBOUND.filter((x) => (x.body.text || '') === 'Big news');
    assert.equal(all.length, 95, 'every customer got it: ' + all.length);
    assert.equal(new Set(all.map((x) => String(x.body.chat_id))).size, 95, 'nobody got it twice');
    const reports = OUTBOUND.filter((x) => (x.body.text || '').includes('Broadcast delivered to <b>95</b> of <b>95</b>'));
    assert.equal(reports.length, 1, 'exactly one final report');
    await worker.scheduled({ cron: '0 */6 * * *' }, big.env); // housekeeping still runs on the 6h cron
  }
  ok('broadcast: 95 buyers go out in batches (tap + cron), once each, one report');

  // Buyers only vs everyone: a lead who never bought is skipped by "Buyers only".
  {
    const aud = fresh();
    aud.env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES ('d0d0d0d0', '@buyer', '00000000', 'k', 'sold', '700000001')").run();
    aud.env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid, revoked) VALUES ('e0e0e0e0', '@refunded', '00000000', 'k', 'sold', '700000003', 1)").run();
    aud.env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status) VALUES ('700000002', '@lead', 'f0f0f0f0', '', '', '700000002', 'rejected')").run();
    await cb(aud.env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
    await post(aud.env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'Update news' }));
    const a4 = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID)).at(-1);
    assert.ok(a4.body.text.includes('<b>1</b> buyer(s)') && a4.body.text.includes('<b>2</b> other(s)'),
      'preview splits buyers from others: ' + a4.body.text);
    OUTBOUND.length = 0;
    await cb(aud.env, { id: Number(ADMIN_ID) }, btn(a4, 'admin:bcast-send:') && a4.body.reply_markup.inline_keyboard
      .flat().find((b) => b.callback_data.endsWith(':buyers')).callback_data);
    const got4 = OUTBOUND.filter((x) => (x.body.text || '') === 'Update news').map((x) => String(x.body.chat_id));
    assert.deepEqual(got4, ['700000001'], 'only the active buyer got it (not the lead, not the revoked key): ' + got4);
  }
  ok('broadcast: "Buyers only" skips leads and revoked keys');

  // /start for the admin opens the full dashboard (Broadcast, Export, /find tip).
  OUTBOUND.length = 0;
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: '/start' }));
  const home = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID)).at(-1);
  const homeKb = JSON.stringify(home.body.reply_markup);
  assert.ok(home.body.text.includes('Dashboard') && home.body.text.includes('Find a customer'), 'admin /start = dashboard');
  assert.ok(homeKb.includes('admin:broadcast') && homeKb.includes('admin:export'), 'with every admin button');
  ok('admin /start opens the one admin dashboard');

  // The Machine ID prompt must use an INLINE keyboard, never a reply keyboard.
  // A reply keyboard pins itself to the bottom of the chat until something
  // explicitly removes it, and Back/Cancel did not — so the prompt stayed on
  // screen after the buyer had left the flow. Reported from real use.
  const envH = fresh();
  envH.env.DB.prepare("INSERT INTO fsm (uid, step, mid, hint, updated_at) VALUES (?, 'mid', NULL, 1, datetime('now'))").bind(BUYER).run();
  OUTBOUND.length = 0; MSG = 0;
  r = await post(envH.env, msg(Number(BUYER), {}, { text: 'notamachineid' }));
  assert.equal(r.status, 200);
  const hintMsg = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  const rm = hintMsg.body.reply_markup || {};
  assert.ok(!rm.keyboard, 'no reply keyboard — it cannot be dismissed by Back');
  assert.ok(rm.inline_keyboard, 'help is offered as an inline keyboard instead');
  assert.ok(JSON.stringify(rm.inline_keyboard).includes('proof:cancel'),
    'the prompt offers a way back out of the flow');

  // Back shows the menu ONCE: no extra "Back to the menu" message on top.
  OUTBOUND.length = 0;
  await cb(envH.env, { id: Number(BUYER) }, 'proof:cancel', { chatId: Number(BUYER) });
  const shown = OUTBOUND.filter((o) => (o.method === 'sendMessage' || o.method === 'editMessageText'));
  assert.equal(shown.length, 1, 'Back produces exactly one visible message: ' + shown.length);
  assert.ok(JSON.stringify(shown[0].body.reply_markup || {}).includes('menu:pay'), 'and it is the menu');

  // The waiting prompt asks for the SCREENSHOT only — never for a Machine ID —
  // and offers the bank accounts again.
  const hintJson = JSON.stringify(hintMsg.body.reply_markup);
  assert.ok(!hintJson.includes('help:mid') && hintJson.includes('menu:pay'), 'no Machine ID help; bank accounts offered');
  assert.ok(hintMsg.body.text.includes('screenshot') && !hintMsg.body.text.includes('Machine ID'), 'asks for the screenshot, not a Machine ID');
  // An old "Where is my Machine ID?" button still answers in the chat.
  OUTBOUND.length = 0;
  await cb(envH.env, { id: Number(BUYER) }, 'help:mid', { chatId: Number(BUYER) });
  const help = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  assert.ok(help && help.body.text.includes('«ፈቃድ ይግዙ»') && help.body.text.includes('👇 ይቅዱ'),
    "help names the panel's real Buy button and copy label");
  assert.ok(!/License tab|License<\/b>/.test(help.body.text), 'no reference to a non-existent License tab');
  ok('Machine ID prompt is inline-only; Back shows one menu; Machine ID help matches the panel');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 13 — key spread (per-key distinct IPs) + fresh-mid flood');

{
  // one key, validated from 3 different IPs → distinct reaches threshold → alert; still valid
  const { env } = fresh();
  const mid = 'aabbccdd';
  const key = keyFor(mid);
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?, 'sold', '00000000', ?, 'sold', '1')").bind(mid, key).run();
  for (const ip of ['203.0.113.10', '203.0.113.11', '203.0.113.12']) {
    const r = await api(env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': ip } });
    const j = await r.json();
    assert.equal(j.valid, true, `valid from ${ip}`);
  }
  const alert = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === ADMIN_ID && (x.body.text || '').includes('Key spread alert'));
  assert.equal(alert.length, 1, 'one spread alert after 3rd distinct IP');
  const acts = rows(env, 'SELECT * FROM key_activations WHERE key=?', canonicalKey(key));
  assert.equal(acts.length, 3, 'three (key, ip) rows recorded');
  ok('key spread: distinct-IP telemetry + throttled admin alert');

  // AMH_BLOCK_SHARED=1 → the key stops validating beyond the threshold
  const envB = fresh({ AMH_BLOCK_SHARED: '1' });
  envB.env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?, 'b', '00000000', ?, 'sold', '2')").bind(mid, key).run();
  for (const ip of ['203.0.113.21', '203.0.113.22']) {
    const r = await api(envB.env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': ip } });
    const j = await r.json();
    assert.equal(j.valid, true, `block env valid below threshold (${ip})`);
  }
  const r3 = await api(envB.env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': '203.0.113.23' } });
  assert.equal(r3.status, 200);
  const j3 = await r3.json();
  assert.equal(j3.valid, false);
  assert.equal(j3.reason, 'shared', 'at threshold + BLOCK_SHARED → valid:false reason shared');
  ok('AMH_BLOCK_SHARED caps a key at threshold IPs');
}

{
  // fresh-mid flood: same IP, 3 brand-new mids, limit 2 → 3rd returns trial_abuse
  const { env } = fresh({ AMH_FRESH_MID_DAY: '2' });
  const r1 = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '11aaaaaa' }, headers: { 'CF-Connecting-IP': '203.0.113.77' } });
  assert.equal(r1.status, 200);
  await new Promise((r) => setTimeout(r, 3100));
  const r2 = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '11bbbbbb' }, headers: { 'CF-Connecting-IP': '203.0.113.77' } });
  assert.equal(r2.status, 200);
  await new Promise((r) => setTimeout(r, 3100));
  const r3 = await api(env, '/api/trial/use', { method: 'POST', body: { mid: '11cccccc' }, headers: { 'CF-Connecting-IP': '203.0.113.77' } });
  assert.equal(r3.status, 200, 'flood -> 200, not 429 (no local-increment exploit)');
  const j3 = await r3.json();
  assert.equal(j3.remaining, 0, 'flood saturates to remaining:0');
  assert.equal(j3.used, 2, 'flood saturates to cap');
  const rowSeen = rows(env, "SELECT used FROM trials WHERE machine_id='11cccccc'");
  assert.equal(rowSeen.length, 0, 'flooded mid was not counted');
  ok('fresh-mid flood capped per IP per day (200 + remaining:0)');
}

console.log('\n:: scenario 14 — license revocation kill-switch');

{
const { env, kv } = fresh();
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '9f9e9f9e' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'P1' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const o = row(env, 'SELECT * FROM orders');
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  const c = row(env, 'SELECT * FROM customers WHERE machine_id=?', '9f9e9f9e');
  assert.ok(c.key, 'sale exists with a key');

  let j = await (await api(env, '/api/validate', { method: 'POST', body: { mid: '9f9e9f9e', key: c.key }, headers: { 'CF-Connecting-IP': '198.51.100.21' } })).json();
  assert.equal(j.valid, true, 'valid before revoke');

  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/revoke ${o.id}` }));
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'revoked');
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', '9f9e9f9e').revoked, 1);

  await kv.delete('rl:val:9f9e9f9e');
  j = await (await api(env, '/api/validate', { method: 'POST', body: { mid: '9f9e9f9e', key: c.key }, headers: { 'CF-Connecting-IP': '198.51.100.22' } })).json();
  assert.equal(j.valid, false, 'kill-switch kills validation');
  assert.equal(j.reason, 'revoked', 'revoke reason surfaced to panel');
  const victimDm = OUTBOUND.filter((x) => x.method === 'sendMessage' && (x.body.text || '').includes('revoked'))[0];
  assert.ok(victimDm, 'buyer notified of revocation');

  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/unrevoke ${o.id}` }));
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', '9f9e9f9e').revoked, 0);
  await kv.delete('rl:val:9f9e9f9e');
  j = await (await api(env, '/api/validate', { method: 'POST', body: { mid: '9f9e9f9e', key: c.key }, headers: { 'CF-Connecting-IP': '198.51.100.23' } })).json();
  assert.equal(j.valid, true, 'unrevoke restores validation');
  ok('/revoke + /unrevoke kill/restore a license end-to-end');
}

// A customer can be revoked even after the order history has been pruned.
{
  const { env, kv } = fresh();
  const mid = 'abcdef0123456789';
  const key = keyFor(mid);
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES (?, 'old', '00000000', ?, 'sold', '7')")
    .bind(mid, key).run();
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb) VALUES ('7', '@old', ?, '', '', '7', 'approved', 2500)")
    .bind(mid).run();
  let j = await (await api(env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': '198.51.100.40' } })).json();
  assert.equal(j.valid, true);
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/revoke-mid ${mid}` }));
  assert.equal(row(env, 'SELECT status FROM orders WHERE machine_id=?', mid).status, 'revoked',
    'MID revoke synchronizes order status');
  j = await (await api(env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': '198.51.100.40' } })).json();
  assert.equal(j.valid, false, 'MID revoke survives order pruning/cache hit');
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/unrevoke-mid ${mid}` }));
  assert.equal(row(env, 'SELECT status FROM orders WHERE machine_id=?', mid).status, 'approved',
    'MID restore synchronizes order status');
  await kv.delete('rl:val:' + mid);
  j = await (await api(env, '/api/validate', { method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': '198.51.100.41' } })).json();
  assert.equal(j.valid, true, 'MID restore works without an order row');
  ok('MID-based revoke/restore works after order pruning');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 16 — permanent sales ledger survives the 30-day order prune');

{
  const { env } = fresh();
  const mid = 'feedf00d12345678';
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb) VALUES (?, 'buyer', ?, '', '', ?, 'pending', 2500)")
    .bind(BUYER, mid, BUYER).run();
  const oid = row(env, 'SELECT id FROM orders WHERE machine_id=?', mid).id;
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${oid}`);
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${oid}`); // retried tap
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM sales').n, 1, 'one sale per order, however many taps');
  const sale = row(env, 'SELECT * FROM sales WHERE order_id=?', oid);
  assert.equal(sale.amount_etb, 2500);
  assert.equal(sale.status, 'sold');

  // 40 days later the order row is pruned for privacy — the sale is not.
  env.DB.prepare("UPDATE orders SET created_at=datetime('now','-40 days') WHERE id=?").bind(oid).run();
  env.DB.prepare("UPDATE sales SET sold_at=datetime('now','-40 days') WHERE order_id=?").bind(oid).run();
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM orders').n, 0, 'order pruned after 30 days');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM sales').n, 1, 'sale kept');

  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:sales');
  let salesMsg = OUTBOUND.filter((x) => (x.body.text || '').includes('Sales &amp; Funnel')).at(-1);
  assert.ok(salesMsg.body.text.includes('All time:</b> 1 sale(s) = <b>ETB 2,500'), 'all-time revenue includes old sales: ' + salesMsg.body.text);

  // A revoked (refunded / fraud) sale stops counting as revenue.
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: `/revoke-mid ${mid}` }));
  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:sales');
  salesMsg = OUTBOUND.filter((x) => (x.body.text || '').includes('Sales &amp; Funnel')).at(-1);
  assert.ok(salesMsg.body.text.includes('All time:</b> 0 sale(s)') && salesMsg.body.text.includes('Revoked / refunded: 1'),
    'revoked sale excluded and counted separately');

  OUTBOUND.length = 0;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:sales-export');
  const list = OUTBOUND.find((x) => (x.body.text || '').includes('Sales (1)'));
  assert.ok(list && list.body.text.includes(mid) && list.body.text.includes('revoked'), 'sales list has every sale');

  // Buyers cannot reach any of it.
  OUTBOUND.length = 0;
  await cb(env, { id: Number(BUYER) }, 'admin:sales-export', { chatId: Number(BUYER) });
  assert.ok(!OUTBOUND.some((x) => (x.body.text || '').includes('Sales (')), 'sales list is admin-only');
  ok('sales ledger: one row per order, survives pruning, revoke excluded, admin-only list');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 17 — referral programme (owner-controlled, OFF by default)');

{
  const { env } = fresh();
  const REFERRER = '810000001';
  const FRIEND = '810000002';
  const FRIEND2 = '810000003';
  const say = (uid, text) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid) }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)
    && String(x.body.chat_id) === String(uid));
  const lastTo = (uid) => toUid(uid).at(-1);
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || '').join('\n');
  const kbOf = (m) => JSON.stringify((m && m.body.reply_markup) || {});
  // The referrer is an existing buyer.
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES ('aa11aa11aa11aa11', '@referrer', '00000000', 'k', 'sold', ?)")
    .bind(REFERRER).run();

  // 1. OFF by default: nothing changes for anyone.
  OUTBOUND.length = 0;
  await say(REFERRER, '/start');
  assert.ok(!kbOf(lastTo(REFERRER)).includes('ref:invite'), 'OFF: no invite button');
  await say(REFERRER, '/invite');
  assert.ok(lastTo(REFERRER).body.text.includes('paused'), 'OFF: /invite says paused');
  await say(ADMIN_ID, '/start');
  assert.ok(kbOf(lastTo(ADMIN_ID)).includes('Referrals · ⚪ OFF'), 'dashboard shows OFF');
  ok('referrals: OFF by default — no button, /invite paused, dashboard shows OFF');

  // 2. The owner switches it ON; buyers get a personal link; others do not.
  await tap(ADMIN_ID, 'admin:ref-toggle');
  assert.equal(row(env, "SELECT value FROM settings WHERE key='referral_enabled'").value, '1');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('🟢 ON'), 'admin sees ON');
  OUTBOUND.length = 0;
  await say(REFERRER, '/start');
  assert.ok(kbOf(lastTo(REFERRER)).includes('ref:invite'), 'ON: buyer sees the invite button');
  await tap(REFERRER, 'ref:invite');
  const inviteText = lastTo(REFERRER).body.text;
  const code = /start=r_([A-Z2-9]{7})/.exec(inviteText)[1];
  assert.ok(inviteText.includes('200 ብር ቅናሽ') && inviteText.includes('300 ብር'), 'invite screen shows the terms');
  await tap(REFERRER, 'ref:invite');
  assert.equal(/start=r_([A-Z2-9]{7})/.exec(lastTo(REFERRER).body.text)[1], code, 'the same code every time');
  await say(FRIEND, '/invite');
  assert.ok(lastTo(FRIEND).body.text.includes('ለገዙ ደንበኞች'), 'non-buyer gets no link');
  await say(REFERRER, '/start r_' + code);
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM referrals').n, 0, 'own link ignored');
  ok('referrals: owner turns ON; buyers get one stable link; non-buyers and own links get nothing');

  // 3. A friend opens the link: 2,300 everywhere; terms locked on the order.
  OUTBOUND.length = 0;
  await say(FRIEND, '/start r_' + code);
  assert.equal(row(env, 'SELECT referrer_uid FROM referrals WHERE friend_uid=?', FRIEND).referrer_uid, REFERRER);
  assert.ok(lastTo(FRIEND).body.text.includes('ETB 2,300'), 'welcome shows the friend price');
  await say(FRIEND, '/start r_ZZZZZZZ');
  assert.equal(row(env, 'SELECT referrer_uid FROM referrals WHERE friend_uid=?', FRIEND).referrer_uid, REFERRER, 'first link wins');
  await tap(FRIEND, 'menu:pay');
  const payScreen = lastTo(FRIEND).body.text;
  assert.ok(payScreen.includes('ETB 2,300') && payScreen.includes('<s>ETB 2,500</s>'), 'pay screen: 2,300 instead of 2,500');
  await tap(FRIEND, 'pay:proof');
  await say(FRIEND, '3f9a1c7e5b2d4086');
  await post(env, msg(Number(FRIEND), { id: Number(FRIEND) }, { photo: [{ file_id: 'P-REF' }] }));
  assert.ok(allTo(FRIEND).includes('Received') && allTo(FRIEND).includes('ETB 2,300'), 'received message shows the friend price');
  const o = row(env, 'SELECT * FROM orders WHERE uid=?', FRIEND);
  assert.deepEqual([o.amount_etb, o.discount_etb, o.reward_etb, o.referrer_uid], [2300, 200, 300, REFERRER], 'terms locked on the order');
  assert.ok(allTo(FRIEND).includes('ETB 2,300'), 'order-received message shows 2,300');
  const card = OUTBOUND.find((x) => x.method === 'sendPhoto' && String(x.body.chat_id) === String(ADMIN_ID));
  assert.ok(card && card.body.caption.includes('Referred') && card.body.caption.includes('ETB 2,300'), 'admin card: expect 2,300');
  ok('referrals: invited friend sees and pays 2,300; first link wins; admin card says "expect ETB 2,300"');

  // 4. Changing the amounts never changes an order already placed.
  await say(ADMIN_ID, '/refreward 500');
  assert.equal(row(env, "SELECT value FROM settings WHERE key='referral_reward_etb'").value, '500');
  await say(ADMIN_ID, '/refdiscount 99999');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('must be between'), 'an impossible discount is refused');

  // 5. Approve: 2,300 sale, one 300 reward (locked), referrer told, new buyer invited.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, `approve:${o.id}`);
  assert.equal(row(env, 'SELECT amount_etb FROM sales WHERE order_id=?', o.id).amount_etb, 2300);
  const rw = row(env, 'SELECT * FROM referral_rewards WHERE order_id=?', o.id);
  assert.deepEqual([rw.amount_etb, rw.status, rw.referrer_uid], [300, 'earned', REFERRER], 'reward = locked 300, not the new 500');
  assert.ok(allTo(REFERRER).includes('300 ብር</b> አግኝተዋል'), 'referrer told what they earned');
  assert.ok(kbOf(lastTo(FRIEND)).includes('ref:invite'), 'the new buyer is offered their own link');
  await tap(ADMIN_ID, `approve:${o.id}`);
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM referral_rewards').n, 1, 'one reward however many taps');
  await say(ADMIN_ID, '/refreward 300');
  ok('referrals: approval records the 2,300 sale and exactly one locked 300 ብር reward; both people told');

  // 6. Payout account: one message; a pasted Machine ID is not an account.
  await tap(REFERRER, 'ref:payout');
  await say(REFERRER, 'bb22bb22bb22bb22');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM payout_accounts').n, 0, 'Machine ID refused');
  await say(REFERRER, 'CBE 1000123456789 Abebe Kebede');
  assert.equal(row(env, 'SELECT details FROM payout_accounts WHERE uid=?', REFERRER).details, 'CBE 1000123456789 Abebe Kebede');
  ok('referrals: payout account saved from one message; a pasted Machine ID is refused');

  // 7. Refund window, monthly reminder, paying.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:ref-pay');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Nothing to pay'), 'inside the refund window: nothing payable');
  env.DB.prepare("UPDATE referral_rewards SET earned_at=datetime('now','-15 days')").run();
  OUTBOUND.length = 0;
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.equal(OUTBOUND.filter((x) => (x.body.text || '').includes('Referral rewards ready to pay')).length, 1, 'one reminder per month');
  await tap(ADMIN_ID, 'admin:ref-pay');
  const payList = lastTo(ADMIN_ID).body.text;
  assert.ok(payList.includes('300 ብር') && payList.includes('CBE 1000123456789'), 'pay list shows amount + account');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, `admin:ref-paid:${REFERRER}`);
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o.id).status, 'paid');
  assert.ok(allTo(REFERRER).includes('300 ብር ተልኮልዎታል'), 'referrer told it was sent');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, `admin:ref-paid:${REFERRER}`);
  assert.ok(!allTo(REFERRER).includes('ተልኮልዎታል'), 'a second tap pays nothing and tells nobody');
  ok('referrals: payable only after 14 days; one monthly reminder; ✅ Paid marks it once and tells the referrer');

  // 8. Revoking the friend cancels an unpaid reward; restoring brings it back.
  env.DB.prepare('INSERT INTO referrals (friend_uid, referrer_uid, code) VALUES (?, ?, ?)').bind(FRIEND2, REFERRER, code).run();
  env.DB.prepare("INSERT INTO orders (uid, username, machine_id, ref, photo_key, chat_id, status, amount_etb, referrer_uid, discount_etb, reward_etb) VALUES (?, 'f2', 'cc33cc33cc33cc33', '', '', ?, 'pending', 2300, ?, 200, 300)")
    .bind(FRIEND2, FRIEND2, REFERRER).run();
  const o2 = row(env, 'SELECT id FROM orders WHERE uid=?', FRIEND2).id;
  await tap(ADMIN_ID, `approve:${o2}`);
  await say(ADMIN_ID, '/revoke-mid cc33cc33cc33cc33');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o2).status, 'cancelled');
  await say(ADMIN_ID, '/unrevoke-mid cc33cc33cc33cc33');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o2).status, 'earned');
  ok('referrals: revoking the friend cancels an unpaid reward; restoring brings it back');

  // 9. OFF again: no new links or discounts; earned rewards stay owed.
  await tap(ADMIN_ID, 'admin:ref-toggle');
  const F3 = '810000004';
  const F4 = '810000005';
  OUTBOUND.length = 0;
  await say(F3, '/start r_' + code);
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM referrals WHERE friend_uid=?', F3).n, 0, 'OFF: link ignored');
  assert.ok(!lastTo(F3).body.text.includes('2,300'), 'OFF: normal welcome');
  env.DB.prepare('INSERT INTO referrals (friend_uid, referrer_uid, code) VALUES (?, ?, ?)').bind(F4, REFERRER, code).run();
  await tap(F4, 'menu:pay');
  assert.ok(lastTo(F4).body.text.includes('ETB 2,500') && !lastTo(F4).body.text.includes('2,300'), 'OFF: invited friend pays full price');
  await say(REFERRER, '/invite');
  assert.ok(lastTo(REFERRER).body.text.includes('will still be paid'), 'OFF: earned rewards are still promised');
  OUTBOUND.length = 0;
  await say(REFERRER, '/start');
  assert.ok(!kbOf(lastTo(REFERRER)).includes('ref:invite'), 'OFF: button hidden again');
  await tap(ADMIN_ID, 'admin:ref');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('⚪ OFF'), 'admin sees OFF with the rewards still owed');
  ok('referrals: OFF stops links and discounts immediately; rewards already earned stay owed');
}

// Safety: without the referral tables (migration not applied) selling is untouched.
{
  const { env } = fresh();
  env.DB.db.exec('DROP TABLE settings; DROP TABLE referrals; DROP TABLE referral_codes; DROP TABLE referral_rewards; DROP TABLE payout_accounts; DROP TABLE partners;');
  await startBuyFlow(env);
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { text: '7e2b9f4a1c6d3e58' }));
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'P-SAFE' }] }));
  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  const o = row(env, 'SELECT * FROM orders WHERE uid=?', BUYER);
  assert.equal(o.amount_etb, 2500, 'normal price');
  await cb(env, { id: Number(ADMIN_ID) }, `approve:${o.id}`);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'approved', 'approval works');
  OUTBOUND.length = 0;
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: '/start' }));
  assert.ok(OUTBOUND.some((x) => (x.body.text || '').includes('Dashboard')), 'admin dashboard still opens');
  ok('referrals: with the tables missing the bot still sells and approves normally (treated as OFF)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 18 — partner links (a group / channel, own terms and switch)');

{
  const { env } = fresh();
  const PARTNER = '820000001';
  const M1 = '820000011';
  const M2 = '820000012';
  const M3 = '820000013';
  const say = (uid, text, username) => post(env, msg(Number(uid), { id: Number(uid), username: username || 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid) }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)
    && String(x.body.chat_id) === String(uid));
  const lastTo = (uid) => toUid(uid).at(-1);
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || '').join('\n');
  const buy = async (uid, mid, file) => {
    await tap(uid, 'menu:pay');
    await tap(uid, 'pay:proof');
    await say(uid, mid);
    await post(env, msg(Number(uid), { id: Number(uid) }, { photo: [{ file_id: file }] }));
    await tap(uid, 'proof:confirm');
    return row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid);
  };

  // 1. The owner creates the partner: two links; the public one works at once.
  OUTBOUND.length = 0;
  await say(ADMIN_ID, '/partner editgroup Editors Ethiopia');
  const created = lastTo(ADMIN_ID).body.text;
  const token = /start=p_([A-Z2-9]{16})/.exec(created)[1];
  assert.ok(created.includes('start=r_EDITGROUP') && created.includes('Editors Ethiopia'), 'owner gets both links');
  await say(ADMIN_ID, '/partner EDITGROUP Again');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('already in use'), 'a code cannot be reused');
  await say(M1, '/start r_EDITGROUP');
  assert.equal(row(env, 'SELECT referrer_uid FROM referrals WHERE friend_uid=?', M1).referrer_uid, 'partner:EDITGROUP',
    'live before the partner connects (credited to the partner code)');
  ok('partners: owner creates one with /partner; private + public links; the public link works at once');

  // 2. The partner connects with the private link; nobody else can take it.
  OUTBOUND.length = 0;
  await say(PARTNER, '/start p_' + token, 'group_owner');
  assert.equal(row(env, "SELECT uid FROM partners WHERE code='EDITGROUP'").uid, PARTNER);
  assert.ok(lastTo(PARTNER).body.text.includes('Partner link') && lastTo(PARTNER).body.text.includes('start=r_EDITGROUP'), 'partner sees their page');
  assert.ok(allTo(ADMIN_ID).includes('connected') && allTo(ADMIN_ID).includes('@group_owner'), 'owner told who connected');
  await say(M3, '/start p_' + token);
  assert.ok(lastTo(M3).body.text.includes('another Telegram account'), 'a second account cannot take the link');
  ok('partners: the private link connects the partner once; the owner is told who');

  // 3. Buyer referrals are OFF (default) — partner links still work: own switch.
  OUTBOUND.length = 0;
  await say(M1, '/start r_EDITGROUP');
  assert.equal(row(env, 'SELECT referrer_uid FROM referrals WHERE friend_uid=?', M1).referrer_uid, 'partner:EDITGROUP');
  assert.ok(lastTo(M1).body.text.includes('ETB 2,300'), 'group member sees 2,300 even with buyer referrals OFF');
  await say(PARTNER, '/start r_EDITGROUP');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM referrals WHERE friend_uid=?', PARTNER).n, 0, 'partner cannot refer themself');
  const o1 = await buy(M1, '3f9a1c7e5b2d4086', 'P-G1');
  assert.deepEqual([o1.amount_etb, o1.discount_etb, o1.reward_etb, o1.referrer_uid], [2300, 200, 300, 'partner:EDITGROUP']);
  const card = OUTBOUND.find((x) => x.method === 'sendPhoto' && String(x.body.chat_id) === String(ADMIN_ID));
  assert.ok(card.body.caption.includes('via partner EDITGROUP'), 'admin card names the partner');
  ok('partners: works while buyer referrals are OFF; member pays 2,300; order card names the partner');

  // 4. Tier: 400 after the first sale (set with /partnerterms).
  await say(ADMIN_ID, '/partnerterms EDITGROUP 300 200 1 400');
  assert.deepEqual(Object.values(row(env, "SELECT reward_etb, discount_etb, tier_after, tier_reward FROM partners WHERE code='EDITGROUP'")), [300, 200, 1, 400]);
  assert.ok(allTo(PARTNER).includes('ተሻሽለዋል'), 'partner told the terms changed');
  await tap(ADMIN_ID, `approve:${o1.id}`);
  assert.equal(row(env, 'SELECT amount_etb FROM referral_rewards WHERE order_id=?', o1.id).amount_etb, 300, 'first sale: 300 (locked)');
  await say(M2, '/start r_EDITGROUP');
  const o2 = await buy(M2, '7e2b9f4a1c6d3e58', 'P-G2');
  assert.equal(o2.reward_etb, 400, 'after 1 sale the next one earns 400');
  await tap(ADMIN_ID, `approve:${o2.id}`);
  OUTBOUND.length = 0;
  await tap(PARTNER, 'ref:invite');
  const page = lastTo(PARTNER).body.text;
  assert.ok(page.includes('<b>2</b>') && page.includes('700 ብር') && page.includes('Top tier'), 'partner page: 2 sales, 700 earned, top tier');
  ok('partners: /partnerterms sets a tier (300 → 400 after N sales); the partner sees sales and earnings');

  // 5. Paid through the same monthly list, under the partner's name.
  await tap(PARTNER, 'ref:payout');
  await say(PARTNER, 'CBE 1000999888777 Group Owner');
  env.DB.prepare("UPDATE referral_rewards SET earned_at=datetime('now','-15 days')").run();
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:ref-pay');
  const pay = lastTo(ADMIN_ID).body.text;
  assert.ok(pay.includes('🤝 Editors Ethiopia') && pay.includes('700 ብር') && pay.includes('CBE 1000999888777'), 'pay list: partner name, 700, account');
  await tap(ADMIN_ID, 'admin:ref-paid:partner:EDITGROUP');
  assert.equal(row(env, "SELECT COUNT(*) AS n FROM referral_rewards WHERE status='paid'").n, 2);
  ok('partners: paid through the monthly Pay rewards list under their name');

  // 6. Pause: new members get no discount; the partner sees it paused.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partners');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('EDITGROUP') && lastTo(ADMIN_ID).body.text.includes('sold 2'), 'partner list with stats');
  await tap(ADMIN_ID, 'admin:partner-toggle:EDITGROUP');
  assert.equal(row(env, "SELECT active FROM partners WHERE code='EDITGROUP'").active, 0);
  await say(M3, '/start r_EDITGROUP');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM referrals WHERE friend_uid=?', M3).n, 0, 'paused: link ignored');
  await tap(PARTNER, 'ref:invite');
  assert.ok(lastTo(PARTNER).body.text.includes('paused'), 'partner sees paused');
  await tap(ADMIN_ID, 'admin:partner-toggle:EDITGROUP');
  assert.equal(row(env, "SELECT active FROM partners WHERE code='EDITGROUP'").active, 1, 'resumed');
  ok('partners: Pause / Resume per partner from the Partners list');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 19 — partner links v2 (launch-day safety, new phone, fair price, TikTok codes)');

{
  const { env } = fresh();
  const OWNER1 = '830000001';
  const OWNER2 = '830000002';
  const say = (uid, text, username) => post(env, msg(Number(uid), { id: Number(uid), username: username || 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid) }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)
    && String(x.body.chat_id) === String(uid));
  const lastTo = (uid) => toUid(uid).at(-1);
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || '').join('\n');
  const tokenOf = (code) => row(env, 'SELECT claim_token FROM partners WHERE code=?', code).claim_token;
  const finish = async (uid, mid, file) => {
    await tap(uid, 'pay:proof');
    await say(uid, mid);
    await post(env, msg(Number(uid), { id: Number(uid) }, { photo: [{ file_id: file }] }));
    await tap(uid, 'proof:confirm');
    return row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid);
  };

  // 7. New partners start at 300/200 whatever the buyer-referral amounts are;
  //    a Machine-ID-looking code is refused.
  await say(ADMIN_ID, '/refreward 100');
  await say(ADMIN_ID, '/partner GROUPA Group A');
  assert.deepEqual(Object.values(row(env, "SELECT reward_etb, discount_etb FROM partners WHERE code='GROUPA'")), [300, 200]);
  await say(ADMIN_ID, '/partner CAFEBABE Hex');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('looks like a Machine ID'), 'hex-like code refused');
  await say(ADMIN_ID, '/partnername GROUPA Editors Ethiopia');
  assert.equal(row(env, "SELECT label FROM partners WHERE code='GROUPA'").label, 'Editors Ethiopia');
  ok('partners v2: new partners start at 300/200; Machine-ID-like codes refused; /partnername renames');

  // 1. Launch day before the owner connects: the link works, the sale counts,
  //    the reward waits, and the owner of the shop is told.
  const A1 = '830000011';
  OUTBOUND.length = 0;
  await say(A1, '/start r_GROUPA');
  assert.ok(lastTo(A1).body.text.includes('ETB 2,300'), 'discount works before the partner connects');
  await tap(A1, 'menu:pay');
  const oA1 = await finish(A1, '3f9a1c7e5b2d4086', 'P-A1');
  assert.equal(oA1.referrer_uid, 'partner:GROUPA');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, `approve:${oA1.id}`);
  assert.ok(allTo(ADMIN_ID).includes('not connected yet'), 'owner told the reward is held for the partner');
  await say(OWNER1, '/start p_' + tokenOf('GROUPA'), 'owner_one');
  assert.ok(lastTo(OWNER1).body.text.includes('<b>1</b>') && lastTo(OWNER1).body.text.includes('300 ብር'),
    'after connecting, the partner sees the sale made before they connected');
  ok('partners v2: link works before the partner connects; the sale and reward wait for them');

  // 2. New phone: /partnerreset moves the page to a new account, history kept.
  OUTBOUND.length = 0;
  const oldToken = tokenOf('GROUPA');
  await say(ADMIN_ID, '/partnerreset GROUPA');
  assert.ok(allTo(OWNER1).includes('እየተዛወረ'), 'old account told the page is moving');
  assert.notEqual(tokenOf('GROUPA'), oldToken, 'a new private link');
  await say(OWNER2, '/start p_' + oldToken);
  assert.ok(lastTo(OWNER2).body.text.includes('not valid'), 'the old private link no longer works');
  await say(OWNER2, '/start p_' + tokenOf('GROUPA'), 'owner_new');
  assert.equal(row(env, "SELECT uid FROM partners WHERE code='GROUPA'").uid, OWNER2);
  assert.ok(lastTo(OWNER2).body.text.includes('<b>1</b>') && lastTo(OWNER2).body.text.includes('300 ብር'), 'history kept on the new account');
  await say(OWNER1, '/invite');
  assert.ok(!lastTo(OWNER1).body.text.includes('Partner link'), 'the old account is no longer the partner');
  ok('partners v2: /partnerreset moves a partner to a new phone/account and keeps every sale');

  // 3. The price the buyer saw is honoured even if the owner pauses/changes terms.
  const A2 = '830000012';
  await say(A2, '/start r_GROUPA');
  await tap(A2, 'menu:pay');                       // sees 2,300 → transfers it
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');   // owner pauses meanwhile
  await say(ADMIN_ID, '/partnerterms GROUPA 300 50');   // and changes the discount
  const oA2 = await finish(A2, '7e2b9f4a1c6d3e58', 'P-A2');
  assert.equal(oA2.amount_etb, 2300, 'the quoted 2,300 is honoured');
  assert.equal(oA2.referrer_uid, 'partner:GROUPA');
  const A3 = '830000013';
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');   // resume, discount now 50
  await say(ADMIN_ID, '/partnerterms GROUPA 300 200');
  await say(A3, '/start r_GROUPA');
  await tap(A3, 'menu:pay');
  env.DB.prepare("UPDATE referrals SET quoted_at=datetime('now','-3 days') WHERE friend_uid=?").bind(A3).run();
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');   // paused again
  const oA3 = await finish(A3, '9c4d2e7f1a3b5c60', 'P-A3');
  assert.equal(oA3.amount_etb, 2500, 'an expired quote on a paused link: normal price');
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');   // resume for the rest
  ok('partners v2: the price shown on the pay screen is honoured for 48 h, then expires');

  // 4. A paused or old link cannot hold a person forever; a live fresh one can.
  await say(ADMIN_ID, '/partner GROUPB Group B');
  const B1 = '830000021';
  const B2 = '830000022';
  const B3 = '830000023';
  await say(B1, '/start r_GROUPA');                // live and fresh on A
  await say(B1, '/start r_GROUPB');
  assert.equal(row(env, 'SELECT code FROM referrals WHERE friend_uid=?', B1).code, 'GROUPA', 'a live fresh link keeps the person');
  await say(B2, '/start r_GROUPA');
  env.DB.prepare("UPDATE referrals SET created_at=datetime('now','-61 days') WHERE friend_uid=?").bind(B2).run();
  await say(B2, '/start r_GROUPB');
  assert.equal(row(env, 'SELECT code FROM referrals WHERE friend_uid=?', B2).code, 'GROUPB', 'after 60 days a new link takes over');
  await say(B3, '/start r_GROUPA');
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');   // A paused
  await say(B3, '/start r_GROUPB');
  assert.equal(row(env, 'SELECT code FROM referrals WHERE friend_uid=?', B3).code, 'GROUPB', 'a paused link does not hold anyone');
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPA');
  ok('partners v2: first LIVE link wins — paused or 60-day-old links cannot hold people');

  // 5. TikTok/YouTube: typing the code works like the link.
  const T1 = '830000031';
  OUTBOUND.length = 0;
  await say(T1, 'groupb');
  assert.equal(row(env, 'SELECT code FROM referrals WHERE friend_uid=?', T1).code, 'GROUPB');
  assert.ok(lastTo(T1).body.text.includes('ETB 2,300'), 'typed code shows the discount');
  ok('partners v2: typing the partner code in the bot works like opening the link');

  // 6. This month + conversion on the partner page and in the owner's list.
  await tap(OWNER2, 'ref:invite');
  assert.ok(lastTo(OWNER2).body.text.includes('ይህ ወር') && lastTo(OWNER2).body.text.includes('%'), 'partner page: this month + conversion');
  await tap(ADMIN_ID, 'admin:partners');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('this month') && lastTo(ADMIN_ID).body.text.includes('/partnerreset'), 'owner list: this month + reset hint');

  // Payout via the partner code reaches the NEW account.
  env.DB.prepare("UPDATE referral_rewards SET earned_at=datetime('now','-15 days')").run();
  await tap(OWNER2, 'ref:payout');
  await say(OWNER2, 'Awash 0132456789012 New Owner');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:ref-pay');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('🤝 Editors Ethiopia') && lastTo(ADMIN_ID).body.text.includes('Awash 0132456789012'), 'pay list: partner name + new account');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:ref-paid:partner:GROUPA');
  assert.ok(allTo(OWNER2).includes('ተልኮልዎታል') && !allTo(OWNER1).includes('ተልኮልዎታል'), 'paid message goes to the current account only');
  ok('partners v2: this month + conversion shown; payouts reach the partner’s current account');

  // When a link opens but gives no discount, the person is told why (the real
  // test used an account that already owned licenses and saw no explanation).
  env.DB.prepare("INSERT INTO customers (machine_id, name, expiry, key, status, uid) VALUES ('ee55ee55ee55ee55', '@old', '00000000', 'k', 'sold', '830000099')").run();
  OUTBOUND.length = 0;
  await say('830000099', '/start r_GROUPA');
  assert.ok(lastTo('830000099').body.text.includes('new customers only'), 'existing customer told the discount is for new customers');
  await say('830000099', 'groupa');
  assert.ok(lastTo('830000099').body.text.includes('new customers only'), 'same note for a typed code');
  await tap(ADMIN_ID, 'admin:partner-toggle:GROUPB');   // pause B
  await say('830000098', '/start r_GROUPB');
  assert.ok(lastTo('830000098').body.text.includes('not active right now'), 'paused link explained');
  await say('830000097', '/start r_NOSUCHCODE');
  assert.ok(lastTo('830000097').body.text.includes('not active right now'), 'unknown link explained');
  await say(OWNER2, '/start r_GROUPA');
  assert.ok(lastTo(OWNER2).body.text.includes('your own link'), 'partner opening own link explained');
  await say('830000096', '/start');
  assert.ok(!lastTo('830000096').body.text.includes('ℹ️'), 'a plain /start has no note');
  ok('links explain themselves: existing customer / paused or unknown link / own link');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 20 — partner management centre (card, messages, statements, notes)');

{
  const { env, kv } = fresh();
  const OWNER = '840000001';
  const say = (uid, text, username) => post(env, msg(Number(uid), { id: Number(uid), username: username || 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid) }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)
    && String(x.body.chat_id) === String(uid));
  const lastTo = (uid) => toUid(uid).at(-1);
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || '').join('\n');
  const kbOf = (m) => JSON.stringify((m && m.body.reply_markup) || {});
  const sell = async (uid, mid, file) => {
    await say(uid, '/start r_EDITGROUP');
    await tap(uid, 'menu:pay');
    await tap(uid, 'pay:proof');
    await say(uid, mid);
    await post(env, msg(Number(uid), { id: Number(uid) }, { photo: [{ file_id: file }] }));
    await tap(uid, 'proof:confirm');
    const o = row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid);
    await tap(ADMIN_ID, `approve:${o.id}`);
    return o;
  };

  await say(ADMIN_ID, '/partner EDITGROUP Editors Ethiopia');
  const token = row(env, "SELECT claim_token FROM partners WHERE code='EDITGROUP'").claim_token;
  await say(OWNER, '/start p_' + token, 'group_owner');
  const pr = row(env, "SELECT tg_username, connected_at FROM partners WHERE code='EDITGROUP'");
  assert.ok(pr.tg_username === '@group_owner' && pr.connected_at, 'who and when are recorded at connect');
  await tap(OWNER, 'ref:payout');
  await say(OWNER, 'CBE 1000123456789 Abebe Kebede');
  const o1 = await sell('840000011', '3f9a1c7e5b2d4086', 'P-C1');
  const o2 = await sell('840000012', '7e2b9f4a1c6d3e58', 'P-C2');
  env.DB.prepare("UPDATE referral_rewards SET earned_at=datetime('now','-15 days') WHERE order_id=?").bind(o1.id).run();

  // The list leads to the card; the card has identity, terms, bank, performance,
  // each sale with its reward state, payouts and every action.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partners');
  assert.ok(kbOf(lastTo(ADMIN_ID)).includes('admin:partner:EDITGROUP'), 'list → card button');
  await tap(ADMIN_ID, 'admin:partner:EDITGROUP');
  let card = lastTo(ADMIN_ID).body.text;
  for (const want of ['@group_owner', 'CBE 1000123456789', '300 ብር</b>/sale', 'bought 2', 'ETB 4,600',
    '💰 payable now', '⏳ payable', '#' + o1.id, '#' + o2.id, 'payable now <b>300 ብር</b>']) {
    assert.ok(card.includes(want), 'card shows ' + want + '\n' + card);
  }
  assert.ok(!kbOf(lastTo(ADMIN_ID)).includes('partner-del:'), 'no Delete button once a partner has sales');
  for (const btn of ['partner-pause:EDITGROUP', 'partner-pay:EDITGROUP', 'partner-msg:EDITGROUP',
    'partner-report:EDITGROUP', 'partner-sales:EDITGROUP', 'partner-reset:EDITGROUP']) {
    assert.ok(kbOf(lastTo(ADMIN_ID)).includes(btn), 'card button ' + btn);
  }
  ok('partner centre: the card shows who, terms, bank, performance, revenue, each sale and every action');

  // Pay from the card: only what is payable; the partner is told; history shows it.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partner-pay:EDITGROUP');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o1.id).status, 'earned', 'first tap only asks');
  const ask = lastTo(ADMIN_ID).body.text;
  assert.ok(ask.includes('300 ብር') && ask.includes('CBE 1000123456789') && ask.includes('#' + o1.id), 'confirm shows amount, bank, orders');
  assert.ok(!allTo(OWNER).includes('ተልኮልዎታል'), 'partner not told before the owner confirms');
  await tap(ADMIN_ID, 'admin:partner-paid:EDITGROUP:999');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o1.id).status, 'earned', 'a stale amount is not paid');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('amount changed'), 'owner told to check again');
  await tap(ADMIN_ID, 'admin:partner-paid:EDITGROUP:300');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o1.id).status, 'paid');
  assert.equal(row(env, 'SELECT status FROM referral_rewards WHERE order_id=?', o2.id).status, 'earned', 'inside the window: not paid');
  assert.ok(allTo(OWNER).includes('300 ብር ተልኮልዎታል'), 'partner told');
  card = lastTo(ADMIN_ID).body.text;
  assert.ok(card.includes('✅ paid') && card.includes('💸 Payouts') && card.includes('<b>300 ብር</b> (1 sale)'), 'payout history on the card');
  ok('partner centre: 💰 Pay asks first (amount + bank), pays only what is due, tells the partner, logs the payout');

  // Messages both ways.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partner-msg:EDITGROUP');
  await say(ADMIN_ID, 'New promo this week: please pin the post <3');
  assert.ok(allTo(OWNER).includes('From Amharic Captions Pro') && allTo(OWNER).includes('please pin the post &lt;3'), 'partner receives it (escaped)');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Sent to'), 'owner sees it was sent');
  await say(ADMIN_ID, '/pmsg EDITGROUP Thanks for the 2 sales!');
  assert.ok(allTo(OWNER).includes('Thanks for the 2 sales!'), '/pmsg shortcut');
  await tap(ADMIN_ID, 'admin:partner-msg:EDITGROUP');
  await say(ADMIN_ID, '/start');
  await say(ADMIN_ID, 'this should not be sent');
  assert.ok(!allTo(OWNER).includes('should not be sent'), '/start cancels a message being written');
  OUTBOUND.length = 0;
  await say(OWNER, 'Hi, can I get a new banner for the group?', 'group_owner');
  assert.ok(allTo(ADMIN_ID).includes('From partner EDITGROUP') && allTo(ADMIN_ID).includes('new banner'), 'partner → owner forwarded');
  assert.ok(lastTo(OWNER).body.text.includes('ለቡድኑ ደርሷል'), 'partner told it arrived');
  ok('partner centre: owner ↔ partner messages through the bot (✉️ button, /pmsg, forwarding)');

  // Statement on demand + automatic on the 1st (not on the first run after deploy).
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partner-report:EDITGROUP');
  assert.ok(allTo(OWNER).includes('Monthly report') && allTo(OWNER).includes('owed 300'), 'statement sent on demand');
  OUTBOUND.length = 0;
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.ok(!allTo(OWNER).includes('Monthly report'), 'first cron run after deploy only records the month');
  env.DB.prepare("UPDATE settings SET value='2000-01' WHERE key='partner_report_month'").run();
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.equal(toUid(OWNER).filter((x) => (x.body.text || '').includes('Monthly report')).length, 1, 'one automatic statement per month');
  ok('partner centre: statements on demand and automatically once a month');

  // Note, all-sales list, reset needs a confirmation.
  await say(ADMIN_ID, '/partnernote EDITGROUP agreed 400 after 20; prefers CBE');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('agreed 400 after 20'), 'note on the card');
  await say(ADMIN_ID, '/partnernote EDITGROUP -');
  assert.equal(row(env, "SELECT note FROM partners WHERE code='EDITGROUP'").note, null, '"-" clears the note');
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partner-sales:EDITGROUP');
  assert.ok(allTo(ADMIN_ID).includes('all sales (2)'), 'all-sales list');
  await tap(ADMIN_ID, 'admin:partner-reset:EDITGROUP');
  assert.equal(row(env, "SELECT uid FROM partners WHERE code='EDITGROUP'").uid, OWNER, 'reset asks first — nothing changed yet');
  await tap(ADMIN_ID, 'admin:partner-reset-yes:EDITGROUP');
  const after = row(env, "SELECT uid, tg_username FROM partners WHERE code='EDITGROUP'");
  assert.ok(after.uid === null && after.tg_username === null, 'confirmed reset clears the connection');
  await say(ADMIN_ID, '/partnerinfo EDITGROUP');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Not connected yet') && lastTo(ADMIN_ID).body.text.includes('bought 2'), 'history kept after reset');
  ok('partner centre: private notes, all-sales list, confirmed reset, /partnerinfo');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 21 — partner management polish (bank safety, pause, delete, my sales, scale)');

{
  const { env } = fresh();
  const P = '850000001';
  const say = (uid, text, username) => post(env, msg(Number(uid), { id: Number(uid), username: username || 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid) }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)
    && String(x.body.chat_id) === String(uid));
  const lastTo = (uid) => toUid(uid).at(-1);
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || '').join('\n');
  const kbOf = (m) => JSON.stringify((m && m.body.reply_markup) || {});

  // 1. Bank recorded by the owner before the partner connects; kept on reset.
  await say(ADMIN_ID, '/partner BANKG Bank Group');
  await say(ADMIN_ID, '/partnerbank BANKG CBE 1000555666777 Kebede Alemu');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('CBE 1000555666777') && lastTo(ADMIN_ID).body.text.includes('entered by you'), 'owner-entered bank on the card');
  await say(ADMIN_ID, '/partnerbank BANKG 12');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Give bank'), 'a too-short account is refused');
  ok('partner polish: /partnerbank records a bank account for a partner who has not connected');

  // 2. The partner connects and saves their own account: the owner is alerted,
  //    and a CHANGE shows old and new.
  await say(P, '/start p_' + row(env, "SELECT claim_token FROM partners WHERE code='BANKG'").claim_token, 'bank_owner');
  OUTBOUND.length = 0;
  await tap(P, 'ref:payout');
  await say(P, 'Awash 0132456789012 Kebede Alemu');
  assert.ok(allTo(ADMIN_ID).includes('added their payout account') && allTo(ADMIN_ID).includes('Awash 0132456789012'), 'owner told of a new account');
  OUTBOUND.length = 0;
  await tap(P, 'ref:payout');
  await say(P, 'Dashen 5555444433332 Someone Else');
  const alert = allTo(ADMIN_ID);
  assert.ok(alert.includes('CHANGED') && alert.includes('old: <code>Awash') && alert.includes('new: <code>Dashen'), 'change shows old and new');
  await tap(ADMIN_ID, 'admin:partner:BANKG');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Dashen 5555444433332') && !lastTo(ADMIN_ID).body.text.includes('entered by you'), "partner's own account wins");
  ok('partner polish: the owner is alerted when a partner adds or CHANGES their bank account');

  // 3. Terms: the partner gets the actual numbers; the owner sees before/now and a warning.
  OUTBOUND.length = 0;
  await say(ADMIN_ID, '/partnerterms BANKG 900 600');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('before:') && lastTo(ADMIN_ID).body.text.includes('⚠️ Reward + discount'), 'owner: before/now + cost warning');
  assert.ok(allTo(P).includes('900 ብር') && allTo(P).includes('600 ብር') && allTo(P).includes('ተሻሽለዋል'), 'partner told the new numbers');
  await say(ADMIN_ID, '/partnerterms BANKG 300 200 10 250');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('LOWER'), 'tier lower than base is flagged');
  await say(ADMIN_ID, '/partnerterms BANKG 300 200');
  ok('partner polish: terms changes tell the partner the numbers; risky terms are flagged');

  // 4. Pause asks first and can tell the partner; Resume tells them.
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partner-pause:BANKG');
  assert.equal(row(env, "SELECT active FROM partners WHERE code='BANKG'").active, 1, 'pause asks first');
  await tap(ADMIN_ID, 'admin:partner-toggle:BANKG:card:tell');
  assert.equal(row(env, "SELECT active FROM partners WHERE code='BANKG'").active, 0);
  assert.ok(allTo(P).includes('paused for now'), 'partner told of the pause');
  await tap(ADMIN_ID, 'admin:partner-toggle:BANKG:card:tell');
  assert.equal(row(env, "SELECT active FROM partners WHERE code='BANKG'").active, 1);
  assert.ok(allTo(P).includes('active again'), 'partner told of the resume');
  ok('partner polish: Pause asks first (tell / quietly); Resume tells the partner');

  // 5. My sales for the partner; the page tells them they can write to us.
  const B = '850000011';
  await say(B, '/start r_BANKG');
  await tap(B, 'menu:pay');
  await tap(B, 'pay:proof');
  await say(B, '5a4b3c2d1e0f9a8b');
  await post(env, msg(Number(B), { id: Number(B) }, { photo: [{ file_id: 'P-B1' }] }));
  await tap(B, 'proof:confirm');
  const ob = row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', B);
  await tap(ADMIN_ID, `approve:${ob.id}`);
  await tap(P, 'ref:invite');
  assert.ok(lastTo(P).body.text.includes('Just write here') && kbOf(lastTo(P)).includes('ref:sales'), 'page: write-to-us line + My sales button');
  await tap(P, 'ref:sales');
  assert.ok(lastTo(P).body.text.includes('#' + ob.id) && lastTo(P).body.text.includes('300 ብር') && lastTo(P).body.text.includes('⏳'), 'my sales lists the sale and when it is paid');
  assert.ok(!lastTo(P).body.text.includes('5a4b3c2d1e0f9a8b'), 'no buyer identity on the partner side');
  ok('partner polish: partners see their own sales with pay dates (no buyer identities)');

  // 6. Reset keeps the bank account with the partner code.
  await say(ADMIN_ID, '/partnerreset BANKG');
  await tap(ADMIN_ID, 'admin:partner:BANKG');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('Dashen 5555444433332'), 'bank kept after a phone change');
  ok('partner polish: a phone change keeps the bank account');

  // 7. Delete only a partner with no sales, after a confirmation.
  await say(ADMIN_ID, '/partner TYPOX Mistake');
  await tap(ADMIN_ID, 'admin:partner:TYPOX');
  assert.ok(kbOf(lastTo(ADMIN_ID)).includes('partner-del:TYPOX'), 'Delete offered without sales');
  await tap(ADMIN_ID, 'admin:partner-del:TYPOX');
  assert.ok(row(env, "SELECT code FROM partners WHERE code='TYPOX'"), 'delete asks first');
  await tap(ADMIN_ID, 'admin:partner-del-yes:TYPOX');
  assert.ok(!row(env, "SELECT code FROM partners WHERE code='TYPOX'"), 'deleted');
  await tap(ADMIN_ID, 'admin:partner-del-yes:BANKG');
  assert.ok(row(env, "SELECT code FROM partners WHERE code='BANKG'"), 'a partner with sales is never deleted');
  ok('partner polish: 🗑 Delete only for partners with no sales, after a confirmation');

  // 8. Scale: 23 partners → list pages of 10 with totals; reports 10 per run, once each.
  for (let i = 1; i <= 22; i++) {
    await say(ADMIN_ID, `/partner GRP${String(i).padStart(2, '0')} Group ${i}`);
    env.DB.prepare('UPDATE partners SET uid=? WHERE code=?').bind(String(860000000 + i), `GRP${String(i).padStart(2, '0')}`).run();
  }
  env.DB.prepare("UPDATE partners SET uid=? WHERE code='BANKG'").bind(P).run();
  OUTBOUND.length = 0;
  await tap(ADMIN_ID, 'admin:partners');
  const list = lastTo(ADMIN_ID);
  assert.ok(list.body.text.includes('Partners</b> (23)') && list.body.text.includes('23 connected') && list.body.text.includes('1 sales'), 'totals');
  assert.ok(list.body.text.length < 4096 && kbOf(list).includes('admin:partners:1') && list.body.text.indexOf('BANKG') < list.body.text.indexOf('GRP01'), 'paged, best first');
  await tap(ADMIN_ID, 'admin:partners:2');
  assert.ok(lastTo(ADMIN_ID).body.text.includes('GRP22') && kbOf(lastTo(ADMIN_ID)).includes('3/3'), 'last page');
  await worker.scheduled({ cron: '0 */6 * * *' }, env);   // first run records the month
  env.DB.prepare("UPDATE settings SET value='2000-01' WHERE key='partner_report_month'").run();
  const reports = () => OUTBOUND.filter((x) => (x.body.text || '').includes('Monthly report')).length;
  OUTBOUND.length = 0;
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.equal(reports(), 10, 'first run: 10');
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.equal(reports(), 23, 'every partner exactly once');
  ok('partner polish: 23 partners — list pages of 10 with totals; monthly reports 10 per run, once each');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 22 — the whole admin page, tapped on the REAL cards (strict Telegram)');

{
  const { env } = fresh();
  const refusedBefore = REFUSED.length;
  const A = Number(ADMIN_ID);
  const say = (uid, text) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { text }));
  const VISIBLE = ['sendMessage', 'editMessageText', 'editMessageCaption', 'editMessageReplyMarkup', 'sendPhoto', 'sendDocument'];
  // Tap a button as the admin (optionally ON a given message) → what the admin now SEES.
  const tapA = async (data, messageId) => {
    const from = OUTBOUND.length;
    await cb(env, { id: A }, data, { chatId: A, ...(messageId ? { messageId } : {}) });
    return OUTBOUND.slice(from).filter((x) => x.id && VISIBLE.includes(x.method) && String(x.body.chat_id) === String(A));
  };
  const sayA = async (text) => {
    const from = OUTBOUND.length;
    await say(A, text);
    return OUTBOUND.slice(from).filter((x) => x.id && VISIBLE.includes(x.method) && String(x.body.chat_id) === String(A));
  };
  const textOf = (xs) => xs.map((x) => x.body.text || x.body.caption || '').join('\n');
  const kbOf = (xs) => xs.map((x) => String(typeof x.body.reply_markup === 'string' ? x.body.reply_markup : JSON.stringify(x.body.reply_markup || ''))).join('\n');
  const buy = async (uid, mid, proof) => {
    await say(uid, '/start');
    await cb(env, { id: Number(uid) }, 'menu:pay');
    await cb(env, { id: Number(uid) }, 'pay:proof');
    await say(uid, mid);
    const from = OUTBOUND.length;
    await post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, proof));
    const card = OUTBOUND.slice(from).find((x) => x.id && ['sendPhoto', 'sendDocument', 'sendMessage'].includes(x.method)
      && String(x.body.chat_id) === String(A));
    return { o: row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid), card };
  };

  // 1. Screenshot sent AS A FILE (Telegram id BQAC…) — the real @panda21k case.
  const FILE_BUYER = '870000001';
  const f = await buy(FILE_BUYER, '4cba71e3', { document: { file_id: 'BQACAgQAAxkBAAIFile', mime_type: 'image/png', file_name: 'Screenshot.png' } });
  assert.ok(f.o && f.o.status === 'pending' && f.o.photo_key.startsWith('BQAC'), 'order saved with the file id');
  assert.ok(f.card && f.card.method === 'sendDocument', 'admin gets the card as a document (photo refused): ' + (f.card && f.card.method));
  assert.ok(kbOf([f.card]).includes(`approve:${f.o.id}`) && kbOf([f.card]).includes(`reject:${f.o.id}`) && kbOf([f.card]).includes(`admin:detail:${f.o.id}`), 'with Approve / Decline / Details');
  ok('admin page: a screenshot sent as a FILE still reaches the admin with Approve / Decline / Details');

  // 2. A normal photo.
  const PHOTO_BUYER = '870000002';
  const p = await buy(PHOTO_BUYER, '5d6e7f8091a2b3c4', { photo: [{ file_id: 'AgACAgQAAxkBAAIPhoto' }] });
  assert.ok(p.card && p.card.method === 'sendPhoto', 'normal photo card');
  ok('admin page: a normal photo arrives as a photo card');

  // 3. Dashboard, Requests, History, Details — every screen shows something.
  let s = await sayA('/start');
  assert.ok(textOf(s).includes('Admin · Dashboard') && kbOf(s).includes('Requests (2)'), 'dashboard: Requests (2)');
  s = await tapA('admin:queue');
  assert.equal(s.filter((x) => kbOf([x]).includes('approve:')).length, 2, 'Requests: both cards, with buttons');
  assert.ok(s.some((x) => x.method === 'sendDocument') && s.some((x) => x.method === 'sendPhoto'), 'file card + photo card');
  s = await tapA('admin:history');
  assert.ok(textOf(s).includes('History') && kbOf(s).includes(`admin:detail:${f.o.id}`), 'history lists the orders');
  s = await tapA(`admin:detail:${f.o.id}`);
  assert.ok(s.length && kbOf(s).includes(`approve:${f.o.id}`), 'history → order detail shows the card with Approve / Decline');
  s = await tapA('admin:panel');
  assert.ok(textOf(s).includes('Dashboard'), 'back to the dashboard');
  ok('admin page: dashboard → Requests → History → order detail all show, with buttons');

  // 4. Approve ON the file card: key to the buyer, and the card itself changes.
  s = await tapA(`approve:${f.o.id}`, f.card.id);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', f.o.id).status, 'approved');
  assert.ok(row(env, 'SELECT key FROM customers WHERE machine_id=?', '4cba71e3'), 'license issued');
  assert.ok(OUTBOUND.some((x) => x.id && String(x.body.chat_id) === FILE_BUYER && String(x.body.text || '').includes('AMH-')), 'buyer got the key');
  assert.ok(s.some((x) => x.method === 'editMessageCaption' && String(x.body.caption).includes('Approved')), 'the admin card now says Approved');
  ok('admin page: ✅ Approve on the real card issues the key AND visibly updates the card');

  // 5. Decline ON the photo card: reason picker, then the card changes; buyer told.
  s = await tapA(`reject:${p.o.id}`, p.card.id);
  assert.ok(s.some((x) => x.method === 'editMessageReplyMarkup' && kbOf([x]).includes(`rej:photo:${p.o.id}`)), 'reason buttons appear on the card');
  s = await tapA(`rej:photo:${p.o.id}`, p.card.id);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', p.o.id).status, 'rejected');
  assert.ok(s.some((x) => x.method === 'editMessageCaption' && String(x.body.caption).includes('Declined')), 'the card now says Declined');
  assert.ok(OUTBOUND.some((x) => x.id && String(x.body.chat_id) === PHOTO_BUYER && String(x.body.text || '').includes('Reason')), 'buyer told why');
  s = await tapA(`admin:detail:${p.o.id}`);
  assert.ok(kbOf(s).includes(`approve:${p.o.id}`), 'declined order offers Approve anyway');
  const detailCard = s.find((x) => x.method === 'sendPhoto');
  s = await tapA(`approve:${p.o.id}`, detailCard.id);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', p.o.id).status, 'approved');
  assert.ok(s.some((x) => textOf([x]).includes('Approved')), 'approve-anyway visible');
  ok('admin page: ❌ Decline (reason → buyer told) and ✅ Approve anyway, all on the real cards');

  // 6. Revoke / restore from buttons and commands; /find.
  s = await tapA(`admin:revoke:${f.o.id}`);
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', '4cba71e3').revoked, 1);
  assert.ok(s.length, 'revoke visible');
  s = await tapA(`admin:unrevoke:${f.o.id}`);
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', '4cba71e3').revoked, 0);
  s = await sayA('/find 4cba71e3');
  assert.ok(textOf(s).includes('Licensed'), '/find shows the buyer');
  s = await sayA(`/revoke ${f.o.id}`);
  assert.ok(s.length, '/revoke answers');
  s = await sayA(`/unrevoke ${f.o.id}`);
  assert.ok(s.length, '/unrevoke answers');
  ok('admin page: revoke / restore (buttons and commands) and /find');

  // 7. Every other admin screen answers visibly.
  for (const data of ['admin:sales', 'admin:sales-export', 'admin:export', 'admin:ref', 'admin:ref-pay',
    'admin:partners', 'admin:history', 'admin:histp:0', 'admin:queue', 'admin:panel']) {
    s = await tapA(data);
    assert.ok(s.length, `${data} shows something`);
  }
  await tapA('admin:broadcast');
  // Typed with & and <, and a word made bold in Telegram (an entity).
  {
    const from = OUTBOUND.length;
    await post(env, msg(A, { id: A }, { text: 'New: Premiere & After Effects <3 — update now', entities: [{ type: 'bold', offset: 5, length: 8 }] }));
    s = OUTBOUND.slice(from).filter((x) => x.id && String(x.body.chat_id) === String(A));
  }
  assert.ok(textOf(s).includes('New: <b>Premiere</b> &amp; After Effects &lt;3 — update now'), 'preview keeps the words and the bold: ' + textOf(s));
  assert.ok(kbOf(s).includes('bcast-send'), 'broadcast preview has Send');
  const bid = (kbOf(s).match(/bcast-cancel:(\d+)/) || [])[1];
  s = await tapA(`admin:bcast-cancel:${bid}`);
  assert.ok(s.length, 'broadcast cancel visible');
  ok('admin page: Sales, exports, Referrals, Pay rewards, Partners, paging, Broadcast — every screen answers');

  // 8. Nothing refused except the expected photo→file fallback the bot recovered from.
  const refused = REFUSED.slice(refusedBefore).filter((r) => !RECOVERED(r));
  assert.deepEqual(refused.map((r) => `${r.method}: ${r.description} — ${String(r.body.text || r.body.caption || "").slice(0, 160)}`), [], 'no refused Telegram calls');
  ok('admin page: zero calls refused by Telegram in the whole walkthrough');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 23 — simple buying: no Machine ID for the customer');

{
  const { env } = fresh();
  const A = Number(ADMIN_ID);
  const say = (uid, text) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid, first_name: 'Abel' }, { text }));
  const tap = (uid, data, messageId) => cb(env, { id: Number(uid), username: 'u' + uid }, data, { chatId: Number(uid), ...(messageId ? { messageId } : {}) });
  const photo = (uid, id) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { photo: [{ file_id: id }] }));
  const toUid = (uid) => OUTBOUND.filter((x) => x.id && ['sendMessage', 'editMessageText', 'editMessageCaption'].includes(x.method) && String(x.body.chat_id) === String(uid));
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || x.body.caption || '').join('\n');
  const lastTo = (uid) => toUid(uid).at(-1);
  const kbOf = (m) => JSON.stringify((m && m.body.reply_markup) || {});
  const apiJ = async (path, body, ip = '198.51.100.7') => {
    const r = await api(env, path, { method: 'POST', body, headers: { 'CF-Connecting-IP': ip } });
    return { http: r.status, ...(await r.json()) };
  };
  const approveLatest = async (uid) => {
    const o = row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid);
    await cb(env, { id: A }, `approve:${o.id}`);
    return row(env, 'SELECT * FROM orders WHERE id=?', o.id);
  };

  // A. From the panel's Buy button: nothing to type, the panel activates itself.
  const P = '890000001';
  const PMID = '3f9a1c7e5b2d4086';
  const NONCE = 'Q7wErTy12345abcd';
  OUTBOUND.length = 0;
  await say(P, `/start m_${PMID}_${NONCE}`);
  let t = lastTo(P);
  assert.ok(t.body.text.includes('computer is connected') && t.body.text.includes('ETB 2,500') && t.body.text.includes('send the payment screenshot'), 'connected + price + send-the-screenshot');
  assert.ok(!t.body.text.includes('Machine ID') && !kbOf(t).includes('Try 2 free'), 'no Machine ID talk; no trial button for someone who has the panel');
  assert.equal((await apiJ('/api/license', { mid: PMID, nonce: NONCE })).status, 'none', 'nothing before paying');
  await photo(P, 'AgAC-panel');
  let o = row(env, 'SELECT * FROM orders WHERE uid=?', P);
  assert.ok(o && o.machine_id === PMID && o.nonce === NONCE && o.status === 'pending', 'order: that computer + the panel secret');
  assert.ok(allTo(P).includes('activates by itself'), 'buyer told the panel turns on by itself');
  const pendingLic = await apiJ('/api/license', { mid: PMID, nonce: NONCE }, '198.51.100.8');
  assert.ok(pendingLic.status === 'pending' && !pendingLic.key, 'pending: no key yet');
  const wrongLic = await apiJ('/api/license', { mid: PMID, nonce: 'WRONGnonce12345' }, '198.51.100.8');
  assert.ok(wrongLic.status === 'none' && !wrongLic.key, 'wrong secret: nothing');
  o = await approveLatest(P);
  assert.equal(o.status, 'approved');
  assert.ok(allTo(P).includes('activates by itself') && allTo(P).includes('AMH-'), 'key message: activates by itself (key only as fallback)');
  const lic = await apiJ('/api/license', { mid: PMID, nonce: NONCE }, '198.51.100.9');
  assert.equal(lic.status, 'approved');
  assert.equal(lic.key, keyFor(PMID), 'the panel receives its key');
  const noKey = await apiJ('/api/license', { mid: PMID, nonce: 'WRONGnonce12345' }, '198.51.100.9');
  assert.ok(!noKey.key, 'knowing the Machine ID alone never gets the key');
  const v = await apiJ('/api/validate', { mid: PMID, key: lic.key }, '198.51.100.9');
  assert.ok(v.valid === true && v.token, 'that key activates normally (signed lease)');
  ok('simple buying: panel Buy → pay → screenshot → approve → the panel activates ITSELF (secret-protected)');

  // B. From the phone: no Machine ID at all → activation code → redeemed once.
  const F = '890000002';
  OUTBOUND.length = 0;
  await say(F, '/start');
  await tap(F, 'menu:pay');
  assert.ok(lastTo(F).body.text.includes('send the payment screenshot right here'), 'pay screen says: send the screenshot here');
  await photo(F, 'AgAC-phone');
  o = row(env, 'SELECT * FROM orders WHERE uid=?', F);
  assert.ok(o && /^code-[a-z2-9]{8}$/.test(o.machine_id), 'phone order books WITHOUT a Machine ID: ' + (o && o.machine_id));
  assert.ok(allTo(F).includes('activation code') && kbOf(lastTo(F)).includes('/install'), 'told: you get a short code; install meanwhile (button)');
  const card = OUTBOUND.find((x) => x.method === 'sendPhoto' && String(x.body.chat_id) === String(A) && String(x.body.caption).includes('Paid from the phone'));
  assert.ok(card, 'admin card says: paid from the phone, approving sends a code');
  o = await approveLatest(F);
  const codeMsg = toUid(F).map((x) => x.body.text || '').find((s) => s.includes('activation code:'));
  const CODE = (/<code>([A-Z2-9]{4}-[A-Z2-9]{4})<\/code>/.exec(codeMsg || '') || [])[1];
  assert.ok(CODE, 'buyer receives a short activation code: ' + CODE);
  assert.ok(!row(env, 'SELECT 1 AS x FROM customers WHERE uid=?', F), 'no license exists until the code is used');
  await tap(F, 'menu:mykey');
  assert.ok(lastTo(F).body.text.includes(CODE) && lastTo(F).body.text.includes('not used yet'), 'My Key shows the unused code');
  const FMID = 'a0b1c2d3e4f50617';
  assert.equal((await apiJ('/api/redeem', { mid: FMID, code: 'ABCD-EFGH' }, '203.0.113.50')).reason, 'not_found', 'a wrong code is refused');
  const red = await apiJ('/api/redeem', { mid: FMID, code: CODE.toLowerCase().replace('-', ' ') }, '203.0.113.50');
  assert.ok(red.ok && red.key === keyFor(FMID), 'code (any case / spacing) redeems for THIS computer');
  assert.ok((await apiJ('/api/validate', { mid: FMID, key: red.key }, '203.0.113.50')).valid, 'and activates normally');
  assert.equal(row(env, 'SELECT machine_id FROM orders WHERE id=?', o.id).machine_id, FMID, 'order now carries the real computer');
  assert.equal(row(env, 'SELECT machine_id FROM sales WHERE order_id=?', o.id).machine_id, FMID, 'sales ledger too');
  assert.ok(allTo(F).includes('now activated on your computer'), 'buyer told it was activated (security signal)');
  assert.equal((await apiJ('/api/redeem', { mid: 'ffff0000ffff0000', code: CODE }, '203.0.113.51')).reason, 'used', 'one code = one computer');
  assert.ok((await apiJ('/api/redeem', { mid: FMID, code: CODE }, '203.0.113.51')).ok, 'the same computer can redeem again (reinstall)');
  await tap(F, 'menu:mykey');
  assert.ok(lastTo(F).body.text.includes(FMID) && !lastTo(F).body.text.includes('not used yet'), 'My Key now shows the license');
  ok('simple buying: phone buyer pays with NO Machine ID → short code → typed once in the panel → licensed');

  // C. A picture out of the blue asks one question first.
  const R = '890000003';
  OUTBOUND.length = 0;
  await photo(R, 'AgAC-random');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM orders WHERE uid=?', R).n, 0, 'no order yet');
  assert.ok(lastTo(R).body.text.includes('Is this your payment screenshot') && kbOf(lastTo(R)).includes('proof:yes'), 'asked: is this your payment?');
  await tap(R, 'proof:yes');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM orders WHERE uid=?', R).n, 1, '"Yes" books the order');
  const R2 = '890000004';
  await photo(R2, 'AgAC-meme');
  await tap(R2, 'proof:cancel');
  assert.equal(row(env, 'SELECT COUNT(*) AS n FROM orders WHERE uid=?', R2).n, 0, '"No" books nothing');
  ok('simple buying: an unexpected photo asks "is this your payment?" — Yes books, No does nothing');

  // D. Paid from the phone first, pressed Buy in the panel later: linked.
  const L = '890000005';
  const LMID = '1122334455667788';
  const LN = 'LinkNonce0000001';
  await say(L, '/start');
  await tap(L, 'menu:pay');
  await photo(L, 'AgAC-later');
  assert.ok(row(env, 'SELECT machine_id FROM orders WHERE uid=?', L).machine_id.startsWith('code-'), 'booked as a phone order');
  OUTBOUND.length = 0;
  await say(L, `/start m_${LMID}_${LN}`);
  assert.ok(lastTo(L).body.text.includes('linked') && lastTo(L).body.text.includes('activates itself'), 'told: this computer is linked');
  o = row(env, 'SELECT * FROM orders WHERE uid=?', L);
  assert.ok(o.machine_id === LMID && o.nonce === LN, 'the waiting order now points at the computer');
  await approveLatest(L);
  const lic2 = await apiJ('/api/license', { mid: LMID, nonce: LN }, '198.51.100.20');
  assert.equal(lic2.key, keyFor(LMID), 'approved → that panel activates itself, no code needed');
  ok('simple buying: paid from the phone, then pressed Buy in the panel → linked → self-activates');

  // E. Revoking a phone order before the code is used; restoring it.
  const V = '890000006';
  await say(V, '/start');
  await tap(V, 'menu:pay');
  await photo(V, 'AgAC-revoke');
  o = await approveLatest(V);
  const VCODE = o.machine_id.slice(5, 9).toUpperCase() + '-' + o.machine_id.slice(9).toUpperCase();
  await say(ADMIN_ID, `/revoke ${o.id}`);
  assert.equal((await apiJ('/api/redeem', { mid: 'abcdefabcdef0123', code: VCODE }, '203.0.113.60')).reason, 'revoked', 'revoked code cannot be used');
  assert.equal(row(env, 'SELECT status FROM sales WHERE order_id=?', o.id).status, 'revoked', 'not counted as revenue');
  await say(ADMIN_ID, `/unrevoke ${o.id}`);
  assert.ok((await apiJ('/api/redeem', { mid: 'abcdefabcdef0123', code: VCODE }, '203.0.113.60')).ok, 'restored code works');
  ok('simple buying: a phone order can be revoked before its code is used, and restored');

  // F. Guessing codes is throttled.
  let throttled = false;
  for (let i = 0; i < 12; i++) {
    const r = await apiJ('/api/redeem', { mid: 'abcdefabcdef9999', code: 'ZZZZ-ZZZ' + 'ABCDEFGHJKLM'[i] }, '203.0.113.99');
    if (r.reason === 'throttled') throttled = true;
  }
  assert.ok(throttled, 'more than 10 tries in 10 minutes from one address are refused');
  ok('simple buying: activation-code guessing is throttled per address');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 24 — security: reused / forwarded screenshots, admin PIN, audit log');

{
  const PIN = '4827';
  const { env } = fresh({ AMH_ADMIN_PIN: PIN });
  const A = Number(ADMIN_ID);
  const say = (uid, text, extra = {}) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { text, ...extra }));
  const tap = (uid, data) => cb(env, { id: Number(uid), username: 'u' + uid }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => x.id && ['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto', 'sendDocument'].includes(x.method) && String(x.body.chat_id) === String(uid));
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || x.body.caption || '').join('\n');
  const lastTo = (uid) => toUid(uid).at(-1);
  const buyWith = async (uid, fileId, fileUid, extra = {}) => {
    await say(uid, '/start');
    await tap(uid, 'menu:pay');
    await post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { photo: [{ file_id: fileId, file_unique_id: fileUid }], ...extra }));
    return row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', uid);
  };
  // Unlock once so the money/export parts of the flows below are allowed.
  await say(A, '/unlock ' + PIN);

  // 1. A genuine order, approved.
  const o1 = await buyWith('910000001', 'AgAC-real', 'UNIQ-RECEIPT-1');
  assert.equal(o1.proof_flag, null, 'a fresh screenshot is not flagged');
  await tap(A, `approve:${o1.id}`);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o1.id).status, 'approved');

  // 2. Someone else sends the SAME receipt image (a re-upload has a new file_id
  //    but the same file_unique_id): flagged, and Approve needs a second tap.
  OUTBOUND.length = 0;
  const o2 = await buyWith('910000002', 'AgAC-copy', 'UNIQ-RECEIPT-1');
  assert.ok(/SAME screenshot/.test(o2.proof_flag) && /DIFFERENT buyer/.test(o2.proof_flag), 'reused receipt flagged: ' + o2.proof_flag);
  assert.ok(allTo(A).includes('SAME screenshot was already used for order #' + o1.id), 'admin card shows the warning');
  assert.ok(!allTo('910000002').includes('SAME'), 'the buyer is not tipped off');
  await tap(A, `approve:${o2.id}`);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o2.id).status, 'pending', 'first Approve tap on a flagged order does NOT approve');
  assert.ok(lastTo(A).body.text.includes('bank app') && JSON.stringify(lastTo(A).body.reply_markup).includes(`approvef:${o2.id}`), 'asks: is the money really in your bank?');
  await tap(A, `approvef:${o2.id}`);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o2.id).status, 'approved', 'deliberate second tap approves');
  ok('security: a reused payment screenshot is flagged (even months later) and needs a deliberate second Approve');

  // 3. A forwarded screenshot is flagged; a replacement for the SAME order is not "reuse".
  const o3 = await buyWith('910000003', 'AgAC-fwd', 'UNIQ-FWD', { forward_origin: { type: 'user', date: 1 } });
  assert.ok(/Forwarded/.test(o3.proof_flag), 'forwarded screenshot flagged');
  await post(env, msg(910000003, { id: 910000003 }, { photo: [{ file_id: 'AgAC-own', file_unique_id: 'UNIQ-OWN' }] }));
  assert.equal(row(env, 'SELECT proof_flag FROM orders WHERE id=?', o3.id).proof_flag, null, 'a clean replacement clears the flag');
  await post(env, msg(910000003, { id: 910000003 }, { photo: [{ file_id: 'AgAC-own2', file_unique_id: 'UNIQ-OWN' }] }));
  assert.equal(row(env, 'SELECT proof_flag FROM orders WHERE id=?', o3.id).proof_flag, null, 'the same image again for the same order is fine');
  ok('security: forwarded screenshots are flagged; re-sending your own for the same order is not');

  // 4. Admin PIN: locked by default; money/export/broadcast/bank need /unlock.
  await say(A, '/lock');
  OUTBOUND.length = 0;
  await tap(A, 'admin:export');
  assert.ok(allTo(A).includes('needs your admin PIN') && !allTo(A).includes('Customers ('), 'export blocked while locked');
  await say(A, '/partnerbank NOPE CBE 1000123456789 X');
  assert.ok(lastTo(A).body.text.includes('needs your admin PIN'), '/partnerbank blocked while locked');
  await say(A, `/revoke ${o1.id}`);
  assert.equal(row(env, "SELECT status FROM orders WHERE id=?", o1.id).status, 'approved', '/revoke blocked while locked');
  const dash = (await say(A, '/start'), lastTo(A).body.text);
  assert.ok(dash.includes('PIN on') && dash.includes('locked'), 'dashboard shows the lock state');
  // Unlock deletes the PIN message from the chat.
  OUTBOUND.length = 0;
  const unlockMsg = msg(A, { id: A }, { text: '/unlock ' + PIN });
  await post(env, unlockMsg);
  assert.ok(OUTBOUND.some((x) => x.method === 'deleteMessage' && x.body.message_id === unlockMsg.message.message_id), 'PIN message deleted');
  await tap(A, 'admin:export');
  assert.ok(allTo(A).includes('Customers (') && allTo(A).includes('code-not-used'), 'export works once unlocked, incl. unused activation codes');
  ok('security: money, bank, revoke, broadcast and export actions need the admin PIN; the PIN never stays in the chat');

  // 5. Five wrong PINs lock it for an hour and alert the admins; then even the right PIN waits.
  await say(A, '/lock');
  for (let i = 0; i < 5; i++) await say(A, '/unlock 0000');
  assert.ok(allTo(A).includes('5 wrong admin PINs'), 'admins alerted');
  await say(A, '/unlock ' + PIN);
  assert.ok(lastTo(A).body.text.includes('locked for an hour'), 'right PIN refused during the lockout');
  ok('security: 5 wrong PINs → 1-hour lockout + alert (guessing the PIN is hopeless)');

  // 6. Audit log: who did what, when.
  await say(A, '/audit');
  const log = lastTo(A).body.text;
  for (const want of ['approve · #' + o1.id, 'approve_flagged · #' + o2.id, 'unlock_failed', 'blocked_locked', 'export', 'lock']) {
    assert.ok(log.includes(want), 'audit has ' + want + '\n' + log);
  }
  ok('security: /audit shows every approval, flagged approval, export, lock and failed PIN');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 25 — support: find, move a license to a new computer, free keys, admin help');

{
  const PIN = '5931';
  const { env } = fresh({ AMH_ADMIN_PIN: PIN });
  const A = Number(ADMIN_ID);
  const say = (uid, text) => post(env, msg(Number(uid), { id: Number(uid), username: 'u' + uid }, { text }));
  const tap = (uid, data) => cb(env, { id: Number(uid), username: 'u' + uid }, data, { chatId: Number(uid) });
  const toUid = (uid) => OUTBOUND.filter((x) => x.id && ['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto', 'sendDocument'].includes(x.method) && String(x.body.chat_id) === String(uid));
  const allTo = (uid) => toUid(uid).map((x) => x.body.text || x.body.caption || '').join('\n');
  const lastTo = (uid) => toUid(uid).at(-1);
  const kbOf = (m) => JSON.stringify((m && m.body.reply_markup) || {});
  const validate = async (mid, key, ip) => (await api(env, '/api/validate', {
    method: 'POST', body: { mid, key }, headers: { 'CF-Connecting-IP': ip } })).json();

  // A buyer pays from the panel on the OLD computer and is approved.
  const B = '930000001';
  const OLD = '1111aaaa2222bbbb';
  const NEW = '3333cccc4444dddd';
  await say(B, `/start m_${OLD}_Nonce1234567890`);
  await post(env, msg(Number(B), { id: Number(B), username: 'u' + B }, { photo: [{ file_id: 'AgAC-mv', file_unique_id: 'UNIQ-MV' }] }));
  const o = row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', B);
  await say(A, '/unlock ' + PIN);
  await tap(A, `approve:${o.id}`);
  const oldKey = row(env, 'SELECT key FROM customers WHERE machine_id=?', OLD).key;
  assert.equal((await validate(OLD, oldKey, '203.0.113.1')).valid, true, 'old computer works before the move');

  // 1. Dashboard: Find a customer, Partners and Commands are one tap away.
  OUTBOUND.length = 0;
  await say(A, '/start');
  const dash = lastTo(A);
  for (const want of ['admin:findask', 'admin:partners', 'admin:help']) assert.ok(kbOf(dash).includes(want), 'dashboard has ' + want);
  await tap(A, 'admin:findask');
  assert.ok(lastTo(A).body.text.includes('Send me their Machine ID'), 'find asks for the Machine ID');
  await say(A, OLD.toUpperCase());
  assert.ok(lastTo(A).body.text.includes('Licensed') && kbOf(lastTo(A)).includes(`admin:move:${OLD}`), 'the card offers Move');
  ok('admin: dashboard → 🔍 Find a customer → type the Machine ID → the card, with 🔁 Move');

  // 2. Move from the card: the buyer's new computer works, the old one does not.
  await tap(A, `admin:move:${OLD}`);
  assert.ok(lastTo(A).body.text.includes("NEW computer's Machine ID"), 'asks for the new Machine ID');
  await say(A, 'not an id');
  assert.ok(lastTo(A).body.text.includes('not a Machine ID'), 'a wrong entry is explained, still waiting');
  await say(A, NEW);
  const moved = row(env, 'SELECT * FROM customers WHERE machine_id=?', NEW);
  assert.ok(moved && moved.revoked === 0 && moved.uid === B && moved.status === 'sold', 'new computer licensed for the same buyer');
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', OLD).revoked, 1, 'old computer revoked');
  assert.equal(moved.key, keyFor(NEW), 'the new key is a real key for the new computer');
  assert.equal((await validate(NEW, moved.key, '203.0.113.2')).valid, true, 'new computer validates');
  assert.equal((await validate(OLD, oldKey, '203.0.113.3')).valid, false, 'old computer no longer validates');
  assert.ok(allTo(B).includes('moved to your new computer') && allTo(B).includes(moved.key), 'the buyer got the new key in the bot');
  assert.ok(allTo(A).includes('License moved') && allTo(A).includes('buyer got the new key'), 'admin sees it done');
  const sales = env.DB.prepare("SELECT COUNT(*) AS n FROM sales WHERE status='sold'").first().n;
  assert.equal(sales, 1, 'still exactly one sale (revenue unchanged)');
  assert.equal(row(env, 'SELECT machine_id FROM sales LIMIT 1').machine_id, NEW, 'the sale follows the license');
  ok('admin: 🔁 Move — new computer works, old key dies, buyer gets the key, still one sale');

  // 3. Guard rails: same id, unknown id, a computer that already has a license.
  await say(A, `/move ${NEW} ${NEW}`);
  assert.ok(lastTo(A).body.text.includes('same computer'));
  await say(A, `/move 9999eeee9999eeee ${OLD}`);
  assert.ok(lastTo(A).body.text.includes('No license on'));
  await say(A, `/move ${OLD} 5555ffff5555ffff`);
  assert.ok(lastTo(A).body.text.includes('revoked'), 'cannot move a revoked (already moved) license again');
  // The old card now says where it went; moving twice more warns of sharing.
  await say(A, `/find ${OLD}`);
  assert.ok(lastTo(A).body.text.includes('Moved to') && lastTo(A).body.text.includes(NEW), 'old computer shows where it moved');
  await say(A, `/move ${NEW} 6666aaaa6666aaaa`);
  await say(A, '/move 6666aaaa6666aaaa 7777bbbb7777bbbb');
  assert.ok(lastTo(A).body.text.includes('moved <b>3</b> times'), 'moved 3 times → sharing warning: ' + lastTo(A).body.text);
  ok('admin: move guard rails (same / unknown / already moved) and a warning after 3 moves');

  // 4. The PIN protects moving: locked → nothing changes.
  await say(A, '/lock');
  OUTBOUND.length = 0;
  await say(A, '/move 7777bbbb7777bbbb 8888cccc8888cccc');
  assert.ok(lastTo(A).body.text.includes('needs your admin PIN'), 'locked → PIN asked');
  assert.equal(row(env, 'SELECT revoked FROM customers WHERE machine_id=?', '7777bbbb7777bbbb').revoked, 0, 'nothing moved while locked');
  await tap(A, 'admin:move:7777bbbb7777bbbb');
  assert.ok(lastTo(A).body.text.includes('needs your admin PIN'), 'the Move button is PIN-protected too');
  await say(A, '/unlock ' + PIN);
  ok('admin: moving a license needs the admin PIN');

  // 5. Free key: works in the panel, never counts as a sale, revocable.
  const GIFT = 'abcdef0123456789';
  await say(A, `/givekey ${GIFT} Panda`);
  const g = row(env, 'SELECT * FROM customers WHERE machine_id=?', GIFT);
  assert.ok(g && g.status === 'gift' && g.name === 'Panda' && g.key === keyFor(GIFT), 'gift key issued');
  assert.ok(lastTo(A).body.text.includes(g.key) && lastTo(A).body.text.includes('Not counted as a sale'));
  assert.equal((await validate(GIFT, g.key, '203.0.113.4')).valid, true, 'gift key validates');
  assert.equal(env.DB.prepare("SELECT COUNT(*) AS n FROM sales").first().n, 1, 'no sale recorded for a gift');
  await say(A, `/givekey ${GIFT} Again`);
  assert.ok(lastTo(A).body.text.includes('already has a license'), 'no double gift');
  await say(A, `/find ${GIFT}`);
  assert.ok(lastTo(A).body.text.includes('free key'), '/find labels it a free key');
  await say(A, `/revoke-mid ${GIFT}`);
  assert.equal((await validate(GIFT, g.key, '203.0.113.5')).valid, false, 'gift key revocable');
  await say(A, '/find 0000111122223333');
  assert.ok(kbOf(lastTo(A)).includes('admin:gift:0000111122223333'), 'unknown computer → Give a free key button');
  await tap(A, 'admin:gift:0000111122223333');
  assert.equal(row(env, 'SELECT status FROM customers WHERE machine_id=?', '0000111122223333').status, 'gift');
  ok('admin: 🎁 free keys (/givekey or button) work, are labelled, never count as sales, and can be revoked');

  // 6. Admin /help is the admin cheat sheet; buyers still get the buyer help.
  await say(A, '/help');
  assert.ok(lastTo(A).body.text.includes('Admin commands') && lastTo(A).body.text.includes('/move'), 'admin /help');
  await say(B, '/help');
  assert.ok(lastTo(B).body.text.includes('How do I buy') && !lastTo(B).body.text.includes('Admin commands'), 'buyer /help unchanged');
  await tap(B, 'admin:move:' + NEW);
  assert.ok(!allTo(B).includes("NEW computer's Machine ID"), 'a buyer cannot use admin buttons');
  // Audit shows moves and gifts, in Ethiopian time.
  await say(A, '/audit');
  const log = lastTo(A).body.text;
  assert.ok(log.includes('Ethiopia time') && log.includes('move · ') && log.includes('givekey · '), 'audit: ' + log);
  ok('admin: /help = command cheat sheet (buyers unchanged); /audit lists moves and gifts in Ethiopian time');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: scenario 26 — customer bot: questions answered, home screen by customer, one reminder');

{
  const { env } = fresh();
  const U = '960000001';
  const say = (text) => post(env, msg(Number(U), { id: Number(U), username: 'c' + U, first_name: 'Sara' }, { text }));
  const tap = (data) => cb(env, { id: Number(U), username: 'c' + U }, data, { chatId: Number(U) });
  const toU = () => OUTBOUND.filter((x) => x.id && ['sendMessage', 'editMessageText'].includes(x.method) && String(x.body.chat_id) === U);
  const last = () => toU().at(-1);
  const txt = () => String(last().body.text || '');
  const kb = () => JSON.stringify(last().body.reply_markup || {});

  // 1. New customer: the offer, with a Questions button; FAQ list and answers.
  await say('/start');
  assert.ok(txt().includes('Welcome') && kb().includes('menu:pay') && kb().includes('faq:home'), 'newcomer: offer + Pay + Questions');
  await tap('faq:home');
  for (const k of ['price', 'trial', 'need', 'install', 'when', 'newpc', 'key']) assert.ok(kb().includes('faq:' + k), 'FAQ lists ' + k);
  await tap('faq:need');
  assert.ok(txt().includes('2022 or newer') && txt().includes('Mac'), 'requirements answer');
  ok('customer: ❓ Questions — seven answers one tap away');

  // 2. Questions typed in their own words (Amharic, English, Latin-typed Amharic).
  const cases = [['ዋጋው ስንት ነው?', 'ETB 2,500'], ['waga sint new', 'ETB 2,500'], ['is there a free trial?', '2 captions free'],
    ['እንዴት ልጫን?', 'Window → Extensions'], ['does it work on mac', '2022 or newer'], ['eske meche new', 'few hours'],
    ['I changed computer', 'move it for free'], ['key aysera', 'Key not working'], ['amesegnalehu', 'welcome']];
  for (const [q, want] of cases) {
    await say(q);
    assert.ok(txt().includes(want), `"${q}" → ${want}\n${txt()}`);
  }
  await say('this is great'); // "hi" inside "this" is not a greeting
  assert.ok(txt().includes('did not get that') && kb().includes('faq:home'), 'unknown → Questions + Ask a person');
  ok('customer: typed questions (Amharic / English / Latin Amharic) get real answers; unknown → Questions + a person');

  // 3. While paying: the question is answered AND the screenshot is still expected.
  await tap('menu:pay');
  await say('mac lay yiseral?');
  assert.ok(txt().includes('2022 or newer') && txt().includes('send the screenshot'), 'answer + screenshot reminder');
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', U).step, 'photo', 'still waiting for the screenshot');
  await say('selam');
  assert.ok(txt().includes('Waiting for the payment screenshot'), 'a greeting mid-payment just re-asks for the screenshot');

  // 4. Paid and waiting: status in words and on /start; no Pay button.
  await post(env, msg(Number(U), { id: Number(U), username: 'c' + U }, { photo: [{ file_id: 'AgAC-c26', file_unique_id: 'U-c26' }] }));
  const o = row(env, 'SELECT * FROM orders WHERE uid=? ORDER BY id DESC LIMIT 1', U);
  await say('eske meche new?');
  assert.ok(txt().includes(`Order #${o.id} is being checked`) && txt().includes('in line'), 'status: order + place in line');
  await say('/start');
  assert.ok(txt().includes(`#${o.id}`) && !kb().includes('menu:pay'), 'pending home: status, no Pay');
  ok('customer: mid-payment questions keep the payment going; a waiting buyer sees their place in line');

  // 5. Owner: no sales pitch any more.
  await cb(env, { id: Number(ADMIN_ID) }, 'approve:' + o.id, { chatId: Number(ADMIN_ID) });
  await say('/start');
  assert.ok(txt().includes('You own Amharic Captions Pro') && !kb().includes('menu:pay') && kb().includes('menu:mykey'), 'owner home');
  await tap('menu:home');
  assert.ok(txt().includes('You own Amharic Captions Pro'), 'Menu button shows the same owner home');
  await say('when do i get my key');
  assert.ok(txt().includes('confirmed') && kb().includes('menu:mykey'), 'owner asking "when" → it is under My Key');
  ok('customer: an owner sees "you own it" + My Key — never the Pay pitch again');

  // 6. One reminder for someone who opened Pay and went quiet.
  const Q = '960000002', P = '960000003';
  for (const uid of [Q, P]) {
    await post(env, msg(Number(uid), { id: Number(uid), username: 'q' + uid }, { text: '/start' }));
    await cb(env, { id: Number(uid) }, 'menu:pay', { chatId: Number(uid) });
  }
  await post(env, msg(Number(P), { id: Number(P), username: 'q' + P }, { photo: [{ file_id: 'AgAC-p', file_unique_id: 'U-p' }] }));
  env.DB.prepare("UPDATE fsm SET updated_at=datetime('now','-5 hours')").run();
  env.DB.prepare("UPDATE fsm SET step='photo'").run();
  const before = OUTBOUND.length;
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  const nudges = OUTBOUND.slice(before).filter((x) => String(x.body.text || '').includes('opened the payment page earlier'));
  assert.deepEqual(nudges.map((x) => String(x.body.chat_id)), [Q], 'only the quiet one, not the one who paid');
  assert.ok(JSON.stringify(nudges[0].body.reply_markup).includes('faq:home'), 'reminder offers the answers');
  const again = OUTBOUND.length;
  env.DB.prepare("UPDATE fsm SET updated_at=datetime('now','-5 hours')").run();
  await worker.scheduled({ cron: '0 */6 * * *' }, env);
  assert.ok(!OUTBOUND.slice(again).some((x) => String(x.body.text || '').includes('opened the payment page earlier')), 'never twice');
  ok('customer: one friendly reminder (with answers) for a buyer who opened Pay and went quiet — never twice, never after paying');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: support group — quiet helper');
{
  const { env } = fresh();
  const G = Number(GROUP);
  const M = { id: 970000001, first_name: 'Abel', username: 'abel_ed' };
  // A message in a forum topic (thread 91), as Telegram sends it.
  const topic = (extra) => msg(G, M, { is_topic_message: true, message_thread_id: 91,
    reply_to_message: { message_id: 91, forum_topic_created: { name: 'Questions' } }, ...extra });
  const since = (n) => OUTBOUND.slice(n);
  const sends = (n) => since(n).filter((x) => x.method === 'sendMessage');
  const dels = (n) => since(n).filter((x) => x.method === 'deleteMessage').map((x) => x.body.message_id);

  // 1. Chatter, error reports and photos get no reply — people answer people.
  let n = OUTBOUND.length;
  for (const t of ['selam all', 'my premiere crashes when I press make captions', 'nice video!']) {
    await post(env, topic({ text: t }));
  }
  await post(env, topic({ photo: [{ file_id: 'AgAC-shot' }], caption: 'this error' }));
  assert.equal(since(n).length, 0, 'the bot stays silent on normal group talk');
  ok('group: chatter, problem reports and screenshots get no bot reply (no "continue in private" spam)');

  // 2. Joins: the service line goes, one welcome; the next join replaces it.
  n = OUTBOUND.length;
  const join1 = msg(G, M, { new_chat_members: [{ id: 970000002, first_name: 'Hana' }] });
  await post(env, join1);
  assert.deepEqual(dels(n), [join1.message.message_id], 'join line removed');
  const w1 = sends(n);
  assert.equal(w1.length, 1);
  assert.ok(w1[0].body.text.includes('Hana') && w1[0].body.text.includes('Discussion') && w1[0].body.text.includes('@AmharicCaptionsBot'));
  assert.ok(!/\d{10,}/.test(w1[0].body.text), 'no bank account numbers in the group');
  const w1id = w1[0].id;
  n = OUTBOUND.length;
  await post(env, msg(G, M, { new_chat_members: [{ id: 970000003, first_name: '<Dawit>' }] }));
  assert.ok(dels(n).includes(w1id), 'previous welcome removed');
  assert.ok(sends(n)[0].body.text.includes('&lt;Dawit&gt;'), 'names are escaped');
  n = OUTBOUND.length;
  const left = msg(G, M, { left_chat_member: { id: 970000003, first_name: 'Dawit' } });
  await post(env, left);
  assert.deepEqual(dels(n), [left.message.message_id]);
  assert.equal(sends(n).length, 0);
  ok('group: joins/leaves lines removed; one welcome on screen at a time; names escaped; no account numbers');

  // 3. Secrets: key, Machine ID, activation code (also in a photo caption) are taken down.
  for (const [t, kind] of [
    [`my key ${keyFor('1a2b3c4d5e6f7a8b')} not working`, 'license key'],
    ['machine id is 9f3c2a1b7d6e5f40 help', 'Machine ID'],
    ['id: a1b2c3d4', 'Machine ID'],
    ['my code K7QD-3MXP', 'activation code'],
  ]) {
    n = OUTBOUND.length;
    const m = topic({ text: t });
    await post(env, m);
    assert.deepEqual(dels(n), [m.message.message_id], 'removed: ' + t);
    const warn = sends(n);
    assert.equal(warn.length, 1);
    assert.ok(warn[0].body.text.includes(kind) && warn[0].body.message_thread_id === 91, 'warned in the same topic');
  }
  n = OUTBOUND.length;
  const cap = topic({ photo: [{ file_id: 'AgAC-x' }], caption: 'key AMH-1a2b-3c4d-5e6f-7a8b-0000-0000-1234-5678' });
  await post(env, cap);
  assert.deepEqual(dels(n), [cap.message.message_id], 'caption checked too');
  n = OUTBOUND.length;
  for (const t of ['export as H264-HEVC please', 'call me 0911234567', 'version 20261001', 'deadbeef', 'WELL-DONE']) {
    await post(env, topic({ text: t }));
  }
  assert.equal(since(n).length, 0, 'formats, phone numbers, dates and words are left alone');
  ok('group: a pasted key / Machine ID / activation code (text or caption) is deleted with a warning in the same topic; look-alikes are not');

  // 4. The three common questions: answered once per half hour, as a reply in the topic.
  n = OUTBOUND.length;
  await post(env, topic({ text: 'how much is it?' }));
  let a = sends(n);
  assert.equal(a.length, 1);
  assert.ok(a[0].body.text.includes('@AmharicCaptionsBot') && a[0].body.message_thread_id === 91 && a[0].body.reply_parameters);
  n = OUTBOUND.length;
  await post(env, msg(G, { id: 970000009, first_name: 'Sara' }, { text: 'ዋጋው ስንት ነው?' }));
  assert.equal(sends(n).length, 0, 'same question within 30 min: left to people');
  n = OUTBOUND.length;
  await post(env, topic({ text: 'እንዴት ነው የምጭነው? install' }));
  assert.equal(sends(n).length, 1, 'a different question is answered');
  n = OUTBOUND.length;
  await post(env, msg(G, { id: Number(ADMIN_ID), first_name: 'Owner' }, { text: 'is the free trial 2 captions?' }));
  await post(env, topic({ text: 'free trial is great' }));
  await post(env, topic({ text: 'is there a free trial?', reply_to_message: { message_id: 7, text: 'hi' } }));
  assert.equal(sends(n).length, 0, 'not for admins, not for statements, not inside a reply to someone');
  ok('group: price / free trial / install questions answered once per 30 min in the same topic; admins, statements and replies left alone');

  // 5. /start in the group: the short guide, never prices or accounts; no buy flow starts.
  n = OUTBOUND.length;
  await post(env, msg(G, M, { text: '/start@AmharicCaptionsBot' }));
  assert.equal(sends(n).length, 1);
  assert.ok(!/\d{10,}/.test(sends(n)[0].body.text));
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0);
  ok('group: /start shows the group guide (no prices, no accounts) and never starts a purchase');
}

{
  // With the group's topic ids configured, topic names are links into the topics.
  const { env } = fresh({ AMH_GROUP_TOPICS: 'discussion:164,windows:75,mac:80,payment:41' });
  const G = Number(GROUP);
  let n = OUTBOUND.length;
  await post(env, msg(G, { id: 970000101, first_name: 'Abel' }, { new_chat_members: [{ id: 970000102, first_name: 'Hana' }] }));
  const w = OUTBOUND.slice(n).find((x) => x.method === 'sendMessage').body.text;
  for (const id of [164, 75, 80, 41]) assert.ok(w.includes(`https://t.me/c/0000000001/${id}"`), 'link to topic ' + id);
  assert.ok(w.includes('Tap a name'));
  n = OUTBOUND.length;
  await post(env, msg(G, { id: 970000103, first_name: 'Sara' }, { text: 'how do I install it?' }));
  assert.ok(OUTBOUND.slice(n).find((x) => x.method === 'sendMessage').body.text.includes('https://t.me/c/0000000001/75'), 'install answer links the guides');
  ok('group: with AMH_GROUP_TOPICS the welcome and answers link straight into each topic');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: admin — trial users who are not licensed');
{
  const { env } = fresh();
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  await q("INSERT INTO customers (machine_id, key) VALUES ('aaaa1111bbbb2222', 'AMH-x')");
  await q("INSERT INTO trials (machine_id, used) VALUES ('aaaa1111bbbb2222', 2)");          // bought: hidden
  await q("INSERT INTO trials (machine_id, used) VALUES ('cccc3333dddd4444', 2)");          // used both
  await q("INSERT INTO trials (machine_id, used) VALUES ('eeee5555ffff6666', 1)");          // opened Pay
  await q("INSERT INTO trials (machine_id, used) VALUES ('0000777788889999', 0)");          // reserved, never used: hidden
  await q("INSERT INTO trial_uses (run_id, machine_id, used_at) VALUES ('r1', 'eeee5555ffff6666', datetime('now', '+1 minute'))");
  await q("INSERT INTO fsm (uid, step, mid) VALUES ('955500001', 'photo', 'eeee5555ffff6666')");
  const screen = (from) => OUTBOUND.slice(from).filter((x) => /Trial users/.test(String(x.body.text || ''))).pop();
  let n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:trials');
  const page = screen(n);
  assert.ok(page, 'trial users screen shown');
  const t = page.body.text;
  assert.ok(t.includes('<b>2</b> computer') && t.includes('Used both free captions: 1'), 'counts exclude licensed and unused');
  assert.ok(t.includes('cccc3333dddd4444') && t.includes('eeee5555ffff6666'));
  assert.ok(!t.includes('aaaa1111bbbb2222') && !t.includes('0000777788889999'), 'licensed / unused not listed');
  assert.ok(t.indexOf('eeee5555ffff6666') < t.indexOf('cccc3333dddd4444'), 'most recent activity first');
  assert.ok(t.includes('tg://user?id=955500001') && t.includes('opened Pay'), 'linked to the Telegram account that opened Pay');
  n = OUTBOUND.length;
  await cb(env, { id: 955500001 }, 'admin:trials');
  assert.ok(!screen(n), 'admins only');
  for (let i = 0; i < 12; i++) await q('INSERT INTO trials (machine_id, used) VALUES (?, 1)', 'abab' + String(i).padStart(12, '0'));
  n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:trials');
  assert.ok(JSON.stringify(OUTBOUND.slice(n)).includes('admin:trials:10'), 'Load more after 10');
  n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:trials:10');
  assert.ok(/\n11\. /.test(screen(n).body.text), 'second page numbered from 11');
  ok('admin: 🎁 Trial users lists free-trial computers that never bought (newest first, linked to Telegram when known, paged, admins only)');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: editing jobs feed');
{
  const { env } = fresh({
    AMH_SUPPORT_GROUP: GROUP, AMH_GROUP_TOPICS: 'questions:91,jobs:131', AMH_JOB_CHANNELS: 'chanA, @chanB, bad name!',
  });
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString().replace('.000Z', '+00:00');
  const post = (ch, id, text, msAgo = 60000) =>
    `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${ch}/${id}">` +
    `<div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>` +
    `<a class="tgme_widget_message_date" href="#"><time datetime="${iso(msAgo)}" class="time">1:00</time></a></div></div>`;
  const VE = 'Video Editor &amp; Motion Graphics<br/><br/>Company: Dagu Digital<br/>Deadline: October 20th, 2026<br/>Salary: Monthly';
  JOB_PAGES.chanA = post('chanA', 9, 'Senior Video Editor<br/>Company: Old Co', 3 * 86400000) +   // older than a day
    post('chanA', 10, 'Accountant<br/>Company: ABC') + post('chanA', 11, VE);
  JOB_PAGES.chanB = post('chanB', 5, VE.replace('&amp;', 'and')) +                                 // same job, other channel
    post('chanB', 6, 'Copy Editor for our magazine<br/>Company: Paper') +
    post('chanB', 7, 'ቪዲዮ ኤዲተር እንፈልጋለን<br/>Company: ሸገር ሚዲያ');
  const tick = () => worker.scheduled({ cron: '* * * * *' }, env);
  const jobPosts = (from) => OUTBOUND.slice(from).filter((x) => x.method === 'sendMessage' && x.body.message_thread_id === 131);

  // Off by default: nothing is fetched or posted.
  let n = OUTBOUND.length;
  await tick();
  assert.equal(JOB_FETCHES.length, 0, 'feed is off until the owner turns it on');
  assert.equal(jobPosts(n).length, 0);

  // The owner turns it on from the dashboard.
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:panel');
  assert.ok(JSON.stringify(OUTBOUND).includes('Jobs feed · ⚪ OFF'));
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:jobs-toggle');
  assert.equal(row(env, "SELECT value FROM settings WHERE key='jobs_feed'").value, '1');
  n = OUTBOUND.length;
  await cb(env, { id: 955500077 }, 'admin:jobs-toggle');
  assert.equal(row(env, "SELECT value FROM settings WHERE key='jobs_feed'").value, '1', 'buyers cannot toggle it');

  // First pass: today's editing jobs only; one job in two channels posted once.
  n = OUTBOUND.length;
  await tick();
  assert.deepEqual(JOB_FETCHES.map((u) => u.split('/').pop()), ['chanA', 'chanB'], 'valid channels only, both read');
  let posted = jobPosts(n);
  assert.equal(posted.length, 2, 'video editor (once) + the Amharic ቪዲዮ ኤዲተር job');
  const card = posted[0].body;
  const btnUrl = (m) => String(m && m.reply_markup && m.reply_markup.inline_keyboard[0][0].url || '');
  assert.equal(String(card.chat_id), GROUP);
  assert.ok(card.text.includes('<b>Video Editor &amp; Motion Graphics</b>') && card.text.includes('🏢 Dagu Digital') &&
    card.text.includes('⏰ October 20th, 2026') && card.text.includes('Source: @chanA') &&
    card.text.includes('Never pay to apply'), 'short card: labelled rows + source + safety line');
  assert.equal(btnUrl(card), 'https://t.me/chanA/11', 'the link to the original is a button under the card');
  assert.ok(posted[1].body.text.includes('ቪዲዮ ኤዲተር') && btnUrl(posted[1].body) === 'https://t.me/chanB/7');
  assert.ok(!JSON.stringify(posted).includes('Old Co') && !JSON.stringify(posted).includes('Accountant') &&
    !JSON.stringify(posted).includes('Copy Editor'), 'no old posts, no other jobs, no copy editors');

  // Next pass: nothing new → nothing posted. A new job → posted once.
  n = OUTBOUND.length;
  await tick();
  assert.equal(jobPosts(n).length, 0, 'never posted twice');
  JOB_PAGES.chanA += post('chanA', 12, 'TikTok Video Editor (Part-time)<br/>Company: Verified Startup');
  n = OUTBOUND.length;
  await tick();
  await tick();
  posted = jobPosts(n);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.text.includes('TikTok Video Editor') && btnUrl(posted[0].body) === 'https://t.me/chanA/12');

  // A channel that disappears does not break the others.
  delete JOB_PAGES.chanB;
  JOB_PAGES.chanA += post('chanA', 13, 'Video editor<br/>Company: Next Co');
  n = OUTBOUND.length;
  await tick();
  assert.equal(jobPosts(n).length, 1);

  // Off again: nothing more.
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:jobs-toggle');
  JOB_PAGES.chanA += post('chanA', 14, 'Video editor<br/>Company: Later Co');
  const before = JOB_FETCHES.length;
  n = OUTBOUND.length;
  await tick();
  assert.equal(JOB_FETCHES.length, before);
  assert.equal(jobPosts(n).length, 0);
  ok('jobs feed: off by default; owner toggles it; only today\'s video-editing jobs (English + Amharic), short card + link + safety line, into the jobs topic; no duplicates across channels or passes');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: forum topic inventory');
{
  const { env } = fresh({ AMH_SUPPORT_GROUP: GROUP, AMH_GROUP_TOPICS: 'questions:91,jobs:131' });
  const G = Number(GROUP);
  const member = { id: 970000201, first_name: 'Dani' };

  // A normal post in a topic is the only thing that reveals an id exists.
  await post(env, msg(G, member, { text: 'ሰላም', message_thread_id: 91, is_topic_message: true }));
  // Telegram naming a topic gives the bot the name it cannot get any other way.
  await post(env, msg(G, member, { forum_topic_created: { name: 'Buyers chat', icon_color: 6 }, message_thread_id: 77 }));
  // …and it is told when one closes.
  await post(env, msg(G, member, { forum_topic_closed: { message_thread_id: 77 }, message_thread_id: 77 }));

  let n = OUTBOUND.length;
  await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID), first_name: 'Owner' }, { text: '/topics' }));
  const t = String(OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage').pop().body.text);

  assert.ok(t.includes('<b>1</b>') && t.includes('cannot delete'), 'General is listed and flagged undeletable');
  assert.ok(t.includes('<b>77</b>') && t.includes('Buyers chat') && t.includes('closed to new posts'),
    'a created-then-closed topic keeps its real name and state');
  assert.ok(t.includes('<b>91</b>') && t.includes('seen'), 'a topic someone posted in is marked seen');
  assert.ok(t.includes('<b>131</b>') && t.includes('configured as <code>jobs</code>') && t.includes('never heard from'),
    'a configured but silent topic is not passed off as confirmed');
  assert.ok(t.includes('no API to list'), 'the report says where the list came from');

  // A buyer is never shown the inventory.
  n = OUTBOUND.length;
  await post(env, msg(970000555, { id: 970000555, first_name: 'Buyer' }, { text: '/topics' }));
  const leaked = OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage');
  assert.equal(leaked.length, 1, 'a buyer is told plainly it is admin-only');
  assert.ok(/Admin only/.test(String(leaked[0].body.text)) && !/131/.test(String(leaked[0].body.text)));

  // Close "all chat": Telegram is asked to close thread 1 of the support group.
  n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:topics-close');
  const closed = OUTBOUND.slice(n).filter((x) => x.method === 'closeForumTopic');
  assert.equal(closed.length, 1, 'closeForumTopic called once');
  assert.equal(String(closed[0].body.chat_id), String(Number(GROUP)), 'on the support group');
  assert.equal(closed[0].body.message_thread_id, 1, 'thread 1 — General, never deleteForumTopic');
  // It now reads as closed, and the button flips to Reopen.
  const after = OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage').pop();
  assert.ok(/closed to new posts/.test(after.body.text), 'the report shows General as closed');
  assert.ok(JSON.stringify(after.body.reply_markup).includes('admin:topics-open'), 'button now offers Reopen');

  // And it reopens.
  n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:topics-open');
  const opened = OUTBOUND.slice(n).filter((x) => x.method === 'reopenForumTopic');
  assert.equal(opened.length, 1, 'reopenForumTopic called once');
  assert.equal(opened[0].body.message_thread_id, 1);

  // If Telegram refuses (the bot missing "Manage Topics"), say so — never
  // report a close that did not happen.
  FAIL_NEXT = 1;
  n = OUTBOUND.length;
  await cb(env, { id: Number(ADMIN_ID) }, 'admin:topics-close');
  assert.equal(OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage').length, 0, 'no fresh report after a failed close');
  const told = OUTBOUND.slice(n).filter((x) => x.method === 'answerCallbackQuery' && /Could not close/.test(String(x.body.text)))[0];
  assert.ok(told, 'the refusal is shown to the admin');

  ok('admin: /topics reports the support group topics — General flagged undeletable, observed ids and names, configured-only ids labelled as never heard, and never leaked to buyers');
  ok('admin: close/reopen “all chat” acts on thread 1 (never delete), is reversible, audited, and reports a refusal instead of pretending it worked');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: jobs feed — one job posted in English and Amharic (Afriwork) is posted once');
{
  const { env } = fresh({ AMH_SUPPORT_GROUP: GROUP, AMH_GROUP_TOPICS: 'jobs:131', AMH_JOB_CHANNELS: 'afEn,afAm,ejob' });
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('jobs_feed', '1')").run();
  const at = new Date(Date.now() - 60000).toISOString();
  const page = (ch, id, lines) => `<div data-post="${ch}/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">` +
    lines.join('<br/>') + `</div><time datetime="${at}"></time></div>`;
  JOB_PAGES.afEn = page('afEn', 104332, ['Job Title: Short-Form Video Editor ( English )', 'Job Type: Remote - Freelance',
    'Work Location: Addis Ababa, Ethiopia', 'Salary/Compensation: Monthly', 'Deadline: October 7th, 2026']);
  JOB_PAGES.afAm = page('afAm', 58433, ['የስራው መጠሪያ: Short-Form Video Editor ( English )', 'የስራው አይነት: ባሉበት የሚሰራ - ፍሪላንስ',
    'የስራው ቦታ: አዲስ አበባ, ኢትዮጲያ', 'ደሞዝ/ክፍያ: ወርሃዊ', 'የማመልከቻ ማብቂያ ቀን: October 7th, 2026']) +
    page('afAm', 58434, ['የስራው መጠሪያ: Video Editor', 'የማመልከቻ ማብቂያ ቀን: October 9th, 2026']);   // a different job
  JOB_PAGES.ejob = page('ejob', 14051, ['MULTIMEDIA ASSISTANT (VIDEOGRAPHER)', 'at OTECH ENGINEERING &amp; TECHNOLOGY SOLUTION',
    'Location: Addis Ababa', 'Deadline: Oct 10, 2026', 'Requirements:', 'at least 2 years of experience']);
  const n = OUTBOUND.length;
  await worker.scheduled({ cron: '* * * * *' }, env);
  await worker.scheduled({ cron: '* * * * *' }, env);
  const cards = OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage' && x.body.message_thread_id === 131)
    .map((x) => x.body.text + JSON.stringify(x.body.reply_markup || ''));
  assert.equal(cards.filter((t) => t.includes('Short-Form Video Editor')).length, 1, 'English + Amharic copy → one card');
  assert.ok(!cards.some((t) => t.includes('የስራው መጠሪያ')), 'the Amharic label is not part of the title');
  assert.ok(cards.some((t) => t.includes('t.me/afAm/58434')), 'a different job with no company is still posted');
  const ej = cards.find((t) => t.includes('MULTIMEDIA ASSISTANT'));
  assert.ok(ej && ej.includes('OTECH ENGINEERING') && !ej.includes('least 2 years'), 'Ethiojobs "at COMPANY" line is the company');
  assert.equal(cards.length, 3);
  ok('jobs feed: Afriwork English/Amharic copies of one job post once; Amharic labels read; Ethiojobs company found');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n:: jobs feed — the TITLE decides, not the requirements');
{
  const { env } = fresh({ AMH_SUPPORT_GROUP: GROUP, AMH_GROUP_TOPICS: 'jobs:131', AMH_JOB_CHANNELS: 'chanX' });
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('jobs_feed', '1')").run();
  const at = new Date(Date.now() - 60000).toISOString();
  const post = (id, lines) => `<div data-post="chanX/${id}"><div class="tgme_widget_message_text js-message_text" dir="auto">` +
    lines.join('<br/>') + `</div><time datetime="${at}"></time></div>`;
  JOB_PAGES.chanX =
    post(1, ['Job Position: Content Creator', 'FutureX is looking for a creative Content Creator.', 'Requirements:',
      '• Basic video editing or graphic design skills.']) +                                    // posted as "Content Creator"
    post(2, ['GRAPHIC DESIGNER', 'at FG BUSINESS GROUP', 'Requirements:', '• Adobe Premiere and After Effects']) +   // skipped
    post(3, ['Marketing Officer', 'Company: ABC', 'Duties: video editing for social media']) +                   // skipped
    post(4, ['TikTok live ልብስ አስተዋዋቂ', 'Salary: 10000 ETB Monthly']) +                                         // skipped
    post(5, ['Short-Form Video Editor', 'Location: Addis Ababa, Ethiopia Position Type: Freelance']);            // posted
  const n = OUTBOUND.length;
  await worker.scheduled({ cron: '* * * * *' }, env);
  const cards = OUTBOUND.slice(n).filter((x) => x.method === 'sendMessage' && x.body.message_thread_id === 131).map((x) => x.body.text);
  assert.equal(cards.length, 2, 'only the two editing jobs: ' + cards.map((c) => c.split('\n')[0]).join(' | '));
  assert.ok(cards[0].includes('Content Creator') && !cards[0].includes('Basic video editing') && !cards[0].includes('Job Position'),
    'the real title, without its label');
  assert.ok(cards[1].includes('Short-Form Video Editor') && cards[1].includes('Addis Ababa, Ethiopia') && !cards[1].includes('Position Type'),
    'location stops at the next label');
  ok('jobs feed: the job TITLE decides (requirements never do); "Job Position:" label dropped; TikTok sellers and designers skipped');
}

// Across EVERY scenario: nothing may be silently refused by Telegram (a refused
// call is a screen the user never sees). Only the recovered photo→file case.
{
  const bad = REFUSED.filter((r) => !RECOVERED(r));
  assert.deepEqual(bad.map((r) => `${r.method}: ${r.description} — ${String(r.body.text || r.body.caption || '').slice(0, 80)}`), [],
    'Telegram refused calls somewhere in the suite');
  ok('whole suite: no message or screen anywhere is refused by Telegram');
}

if (process.env.TG_AUDIT) {
  const g = {};
  for (const r of REFUSED) {
    const k = `${r.method} | ${r.description}`;
    (g[k] = g[k] || []).push(String(r.body.text || r.body.caption || r.body.photo || '').slice(0, 300));
  }
  for (const [k, v] of Object.entries(g)) console.log(`AUDIT ${v.length}x ${k}\n      e.g. ${JSON.stringify(v[0])}`);
}
console.log('\n' + PASS.length + ' checks — all green ✅');
console.log('PASSED: ' + PASS.join(' · '));