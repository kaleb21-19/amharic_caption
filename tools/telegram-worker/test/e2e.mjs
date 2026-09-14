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
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

//                                                        Accounts
const ADMIN_ID = '1887247213'; // live worker ADMIN_ID (see session notes)
const BUYER = '900000001';
const GROUP = '-1000000000001';
const SECRET = '7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g=';
const WEBHOOK_SECRET = '81f7daefdf489dcfc24dcf84392bdd17';
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
      `CREATE TABLE key_activations (key TEXT NOT NULL, ip TEXT NOT NULL, mid TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (key, ip))`,
      `CREATE UNIQUE INDEX idx_orders_pending_mid ON orders(machine_id) WHERE status='pending'`,
      `CREATE INDEX idx_orders_mid ON orders(machine_id)`,
      `CREATE INDEX idx_customers_uid ON customers(uid)`,
    ];
    for (const ddl of ddls) this.db.exec(ddl);
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
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
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
  MSG++;
  entry.id = MSG;
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
    AMH_WEBHOOK_SECRET: WEBHOOK_SECRET, AMH_KV: kv, DB: db,
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
async function post(env, update, secret = WEBHOOK_SECRET, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret, ...extraHeaders };
  const req = new Request('https://x.workers.dev/', { method: 'POST', headers, body: JSON.stringify(update) });
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
function keyFor(mid, expiry = '00000000') {
  const sig = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(`${mid}|${expiry}`).digest('hex').slice(0, 16);
  return 'AMH-' + (mid + expiry + sig).match(/.{1,4}/g).join('-');
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
  assert.ok(JSON.stringify(OUTBOUND).includes('Step 2/2'), 'asks for screenshot');

  const m = msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'FA', width: 1, height: 1 }, { file_id: 'FB', width: 2, height: 2 }] });
  res = await post(env, m);
  assert.equal(res.status, 200);

  // review message sent -> fsm.status_msg_id persisted (migration 0004)
  const fsm = row(env, 'SELECT * FROM fsm WHERE uid=?', BUYER);
  assert.equal(fsm.step, 'confirm');
  assert.equal(fsm.photo_key, 'FB');
  const review = OUTBOUND.filter((o) => o.method === 'sendMessage' && (o.body.text || '').includes('Review your order')).at(-1);
  assert.ok(review && review.id, 'review message sent');
  assert.equal(fsm.status_msg_id, review.id, 'fsm.status_msg_id persisted');
  ok('fsm.status_msg_id column persisted');

  // confirm order
  res = await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
  assert.equal(res.status, 200);
  let orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'one order');
  const o = orders[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.machine_id, 'a1b2c3d4');
  assert.equal(o.uid, BUYER);
  assert.equal(o.photo_key, 'FB');
  assert.ok(o.status_msg_id >= 1, 'buyer status message id stored on order');
  assert.equal(rows(env, 'SELECT * FROM fsm').length, 0, 'fsm cleared on confirm');
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
  const edited = OUTBOUND.filter((x) => x.method === 'editMessageText' && String(x.body.chat_id) === BUYER).find((x) => (x.body.text || '').includes('Approved'));
  assert.ok(edited, 'buyer status edited to Approved');
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
  r = await api(env, '/api/validate', { method: 'POST', body: { mid: 'a1b2c3d4', key: 'AMH-' + 'f'.repeat(34) } });
  j = await r.json();
  assert.equal(j.valid, false);
  ok('/api/validate accepts real key, rejects forged');
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
  assert.ok(JSON.stringify(OUTBOUND).includes('as a <b>file</b>, not a photo'), 'pdf rejected');
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'photo', 'still awaiting photo');

  // image mimetype sent as a document -> accepted as proof
  res = await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { document: { file_id: 'IMG1', mime_type: 'image/png' } }));
  assert.equal(res.status, 200);
  assert.equal(row(env, 'SELECT step FROM fsm WHERE uid=?', BUYER).step, 'confirm', 'image doc accepted');

  await cb(env, { id: Number(BUYER) }, 'proof:confirm', { chatId: Number(BUYER) });
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
  ok('group /start only welcomes (no fsm)');

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
  await post(env, msg(Number(BUYER), { id: Number(BUYER) }, { photo: [{ file_id: 'Z1' }, { file_id: 'Z2' }] }));

  // blip: the status message fails to send
  FAIL_NEXT = 0;
  const cbBody = { callback_query: { id: 'blip', from: { id: Number(BUYER), first_name: 'B' }, message: { message_id: 700, date: 1, chat: { id: Number(BUYER), type: 'private' } }, data: 'proof:confirm' } };
  // simulate: make the FIRST outbound on confirm fail (the status text)
  FAIL_NEXT = 1;
  let res = await post(env, cbBody);
  assert.equal(res.status, 200, 'worker still answers 200 despite blip');
  let orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'order booked despite blip');
  assert.equal(orders[0].status_msg_id, null, 'status_msg_id kept null on send failure');

  // Telegram re-delivers the exact same update (it got a 200, but a mirror/op
  // retry or double-delivery) -> must stay at one order
  res = await post(env, cbBody);
  assert.equal(res.status, 200);
  orders = rows(env, 'SELECT * FROM orders');
  assert.equal(orders.length, 1, 'same confirm update replayed -> one order');
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
  let res = await cb(env, { id: Number(ADMIN_ID) }, `reject:${o.id}`);
  assert.equal(res.status, 200);
  assert.equal(row(env, 'SELECT status FROM orders WHERE id=?', o.id).status, 'rejected');
  assert.equal(rows(env, 'SELECT * FROM customers').length, 0, 'no key minted');
  const buyerMsg = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === BUYER && (x.body.text || '').includes('proof not verified'));
  assert.ok(buyerMsg.length, 'buyer told proof not verified');
  res = await cb(env, { id: Number(ADMIN_ID) }, `reject:${o.id}`);
  assert.equal(res.status, 200);
  ok('reject works, idempotent, buyer notified, no key');
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
  // same machine, another IP, immediately -> 2s mid marker collapses to used=1 (200)
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.used, 1, 'double-fire collapses to one increment');
  // same IP within 3s -> 429
  r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(r.status, 429, 'per-IP throttle on use');
  ok('trial/use: per-mid collapse + per-IP throttle');

  // trial caps at max_free
  for (let i = 0; i < 6; i++) {
    const ip = '198.51.100.' + i;
    r = await api(env, '/api/trial/use', { method: 'POST', body: { mid: 'a1b2c3d4' }, headers: { 'CF-Connecting-IP': ip } });
    j = await r.json();
  }
  const used = row(env, 'SELECT used FROM trials WHERE machine_id=?', 'a1b2c3d4').used;
  assert.ok(used <= 2, `trial never exceeds cap (used=${used})`);
  ok('trial hard-capped at max_free');

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

  // API-key toggle: OFF by default (works), ON requires header
  const envA = fresh();
  r = await api(envA.env, '/api/trial?mid=b1b2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.60' } });
  assert.equal(r.status, 200, 'API_KEY empty -> open as today');
  const envK = fresh({ AMH_API_KEY: 'sekrit' });
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.61' } });
  assert.equal(r.status, 401, 'API_KEY set -> no header => 401');
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.62', 'X-Api-Key': 'sekrit' } });
  assert.equal(r.status, 200, 'API_KEY set + header => allowed');
  r = await api(envK.env, '/api/trial?mid=c1c2c3d4', { headers: { 'CF-Connecting-IP': '203.0.113.63', 'X-Api-Key': 'nope' } });
  assert.equal(r.status, 401, 'wrong header => 401');
  ok('AMH_API_KEY toggle: off now, on -> requires header');
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

  // broadcast: admin taps, sends the text, buyers receive it
  r = await cb(env, { id: Number(ADMIN_ID) }, 'admin:broadcast');
  assert.equal(r.status, 200);
  r = await post(env, msg(Number(ADMIN_ID), { id: Number(ADMIN_ID) }, { text: 'Hello buyers! New promo coming.' }));
  assert.equal(r.status, 200);
  const toBuyer = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === BUYER && (x.body.text || '').includes('Hello buyers!'));
  assert.equal(toBuyer.length, 1, 'broadcast reaches buyer DM');
  const toOther = OUTBOUND.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '900000002' && (x.body.text || '').includes('Hello buyers!'));
  assert.equal(toOther.length, 1, 'broadcast reaches order-only buyer');
  const confirm = OUTBOUND.find((x) => x.method === 'sendMessage' && String(x.body.chat_id) === String(ADMIN_ID) && (x.body.text || '').includes('Broadcast sent'));
  assert.ok(confirm, 'admin sees broadcast confirmation');
  assert.equal(await kv.get('bcast:await:' + ADMIN_ID), null, 'broadcast draft cleared');
  ok('broadcast fans out to all buyers and skips admins');

  // reply-keyboard hint attached to the Machine ID prompt
  const envH = fresh();
  envH.env.DB.prepare("INSERT INTO fsm (uid, step, mid, hint, updated_at) VALUES (?, 'mid', NULL, 1, datetime('now'))").bind(BUYER).run();
  OUTBOUND.length = 0; MSG = 0;
  r = await post(envH.env, msg(Number(BUYER), {}, { text: 'notamachineid' }));
  assert.equal(r.status, 200);
  const hintMsg = OUTBOUND.filter((o) => o.method === 'sendMessage').at(-1);
  assert.ok(
    hintMsg.body.reply_markup && hintMsg.body.reply_markup.keyboard && hintMsg.body.reply_markup.keyboard[0][0].text === '📍 Show me where to find my Machine ID',
    'reply keyboard hint attached'
  );
  ok('reply-keyboard hint offered at the Machine ID prompt');
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
  const acts = rows(env, 'SELECT * FROM key_activations WHERE key=?', key);
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
  assert.equal(r3.status, 429);
  const j3 = await r3.json();
  assert.equal(j3.error, 'trial_abuse', 'flood of fresh mids from one IP → 429 trial_abuse');
  const rowSeen = rows(env, "SELECT used FROM trials WHERE machine_id='11cccccc'");
  assert.equal(rowSeen.length, 0, 'flooded mid was not counted');
  ok('fresh-mid flood capped per IP per day');
}

console.log('\n' + PASS.length + '/' + (st) + ' scenarios — all green ✅');
console.log('PASSED: ' + PASS.join(' · '));