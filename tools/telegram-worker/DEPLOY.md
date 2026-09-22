# Amharic Captions — Cloudflare Worker (webhook) Deployment

Converts the Telegram sales bot into a **free, always-on** version using
Cloudflare Workers + D1 (database) + KV (cache/rate-limits). Payment-proof
screenshots are stored in D1 as **Telegram file_ids** (tagged to each order).
**No R2, no card on file, no domain.** The working long-poll `bot.py` on the
Mac stays as a fallback until this is proven live.

> **⚠️ FIRST (do this before anything else):** two Cloudflare API tokens were
> **exposed in chat and are compromised** (since deleted). Delete any leaked
> token, then create ONE fresh token and use it everywhere below.

## Cost
**$0/month** on the free tier. Workers = 100k requests/day, D1 = 5GB DB —
far above this bot's needs.

---

## STEP A — Rotate the compromised tokens (2-3 min)
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Find the two tokens named `kal` and `cloudflare work` → click **Delete** on BOTH.
3. Click **Create Token** → use the **"Edit Cloudflare Workers"** template (or start
   from scratch and grant):
   - *Account* → *Workers Scripts* → **Edit**
   - *Account* → *Workers Scripts* → **Deploy**
   - *Account* → *D1* → **Edit**
4. Click **Continue → Create Token**, then **Copy** the token.
   ⚠️ It's shown once. Save it somewhere safe (password manager). **Never paste it in chat.**
5. Use this new token as `CLOUDFLARE_API_TOKEN` in the steps below.

---

## STEP B — Deploy the Worker + apply database migration (5 min)
```bash
cd tools/telegram-worker
npm install                                 # if not already done
export CLOUDFLARE_API_TOKEN="<paste your NEW token>"

# apply all DB migrations (0001 schema, 0002 trials, 0003 harden)
npx wrangler d1 migrations apply amh_bot --remote

# deploy the worker (creates/uses the AMH_KV namespace bound in wrangler.toml)
npx wrangler deploy
```
The deploy prints your Worker URL — **copy it**, e.g.
`https://amharic-captions-bot.<you>.workers.dev`.

Verify it's live:
```bash
curl https://amharic-captions-bot.<you>.workers.dev/ok   # → ok
```

## STEP C — Point Telegram at your Worker (webhook)
The webhook is registered **with a secret_token** so forged updates are
rejected (401) — `scripts/auto_webhook.mjs` reads the secret from
`tools/telegram/bot.env`:
```bash
node scripts/auto_webhook.mjs
```
> If you haven't set the worker secrets yet, also run (once):
> ```bash
> npx wrangler secret put AMH_TG_TOKEN
> npx wrangler secret put AMH_ADMIN_ID
> npx wrangler secret put AMH_SECRET
> npx wrangler secret put AMH_WEBHOOK_SECRET   # same value as AMH_WEBHOOK_SECRET in bot.env
> # ONLY when locking down /api/* (see the AMH_API_KEY transition below):
> npx wrangler secret put AMH_API_KEY
> # OPTIONAL: CORS allow-list — comma-separated origins (include 'null' for CEP
> # file:// panels). Omit to stay open ('*'), see CORS section below.
> npx wrangler secret put AMH_ALLOWED_ORIGIN
> # OPTIONAL: ECDSA P-256 private key (PKCS8 PEM) that signs install leases so
> # the panel can verify licenses offline (see the lease section below).
> npx wrangler secret put AMH_LICENSE_SIGNING_KEY
> ```
> `AMH_SECRET` is the HMAC license secret — retrieve the value from your
> password manager (**it is no longer printed in this repo — keygen.py,
> deliver_key.py, bot.py and panel/js/main.js all refuse to embed it**).
> Keep `AMH_WEBHOOK_SECRET` in sync between the Worker secret and the bot.env
> value used by `auto_webhook.mjs`.
>

### ⚠️ Rotating `AMH_SECRET` — read before you do it

Every license key is an HMAC of `machineid|expiry` under `AMH_SECRET`, and
`/api/validate` checks that signature **before** it looks the key up in the
database. So replacing `AMH_SECRET` invalidates **every key ever issued, for
every customer, instantly** — they all see *"Key not recognized"* and nothing
in the logs connects it to the rotation.

`AMH_SECRET_PREV` exists to make that survivable. Validation accepts the
current secret **or** the previous one; minting always uses the current one.

```bash
# 1. keep the outgoing value first — old keys keep working
npx wrangler secret put AMH_SECRET_PREV     # paste the CURRENT secret
# 2. then rotate
npx wrangler secret put AMH_SECRET          # paste the NEW secret
# 3. later, once nobody is still on an old key, drop the fallback
npx wrangler secret delete AMH_SECRET_PREV
```

Before step 3, check whether the old secret is still load-bearing: every key
accepted under it logs `key_validated_with_previous_secret` with the machine
id. No such entries for a full re-activation cycle means it is safe to clear.

Covered by `test/e2e.mjs` (“AMH_SECRET rotation”), which asserts that without
`AMH_SECRET_PREV` a pre-rotation key is rejected, that with it the same key
validates, and that a key signed with neither secret is still refused.

> **Webhook secret is now mandatory**: the Worker refuses every update (HTTP
> 500, surfaced as a Telegram webhook error) when `AMH_WEBHOOK_SECRET` is
> unset. Do not deploy without it.
>
> `AMH_ADMIN_ID` supports **multi-admin**: comma-separate numeric chat ids
> (set via `wrangler secret put AMH_ADMIN_ID`, e.g. `123456789,987654321`).
> Every id gets /admin and Approve/Decline. Never commit the live admin ids.
> `AMH_PRICE_ETB` is set in `wrangler.toml` `[vars]` (numeric price used for
> revenue math + stamped on each order as `amount_etb`).

## STEP D — Update the extension panel with your real URL
Open `panel/js/main.js`, find the `API_URL` constant, and replace the placeholder:
```js
const API_URL = 'https://amharic-captions-bot.<you>.workers.dev';
```
The panel deliberately contains **no license HMAC secret** (validation is
server-side). It sends a shared key via the `X-Api-Key` header on every
`/api/*` call, using `API_KEY_HINT` (non-empty since v1.4.x). Keep
`API_KEY_HINT` byte-for-byte equal to the Worker `AMH_API_KEY` secret — the
Worker rejects any `/api/*` request whose header doesn't match (401).
Then rebuild + re-release the extension (Step G).

## STEP E — Refresh D1 customer/seed keys (old 24-char keys no longer validate)
Customer keys are **never committed to the repo**. Re-issue each sold license
with `tools/keygen.py` (reads `AMH_SECRET` from `tools/telegram/bot.env`), then
in the Cloudflare dashboard: **Workers & Pages → D1 → amh_bot → Console**, run:
```sql
DELETE FROM customers;
INSERT INTO customers (machine_id, name, expiry, key, status) VALUES
('xxxxxxxx','@<buyer>','00000000','AMH-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx','sold');
```
Replace each row with a **freshly generated** key (see the `keygen.py` usage in
the root README). Never paste live keys/IDs into this file — the repo is public.

## STEP F — Enable D1 backups
Cloudflare dashboard → **D1 → amh_bot → Backups** → enable automatic backups.

## STEP G — Build + release the extension
Push the changed panel (new `API_URL`, new key format) and ship a new release zip
via the CI `build.yml`, or rebuild manually and re-attach to a release.

---

## Deploying (original notes kept below)

## 1. Prerequisites
- Free **Cloudflare** account → https://dash.cloudflare.com/sign-up
- **Node.js 18+** installed locally (already present on this Mac)

## 2. Install the CLI + this project
```bash
cd tools/telegram-worker
npm install
```

## 3. Create the D1 database
```bash
cd tools/telegram-worker
npx wrangler d1 create amh_bot
```
It prints a `database_id` — that's already patched into `wrangler.toml`.
(A note: R2 is intentionally not used — proof screenshots live in D1, so no
card is needed.)

## 4. Run the DB migration
```bash
npx wrangler d1 migrations apply amh_bot --remote
```

## 5. Set the secrets (never commit these)
```bash
npx wrangler secret put AMH_TG_TOKEN      # Telegram bot token
npx wrangler secret put AMH_ADMIN_ID      # comma-separated admin chat ids
npx wrangler secret put AMH_SECRET        # HMAC license secret
npx wrangler secret put AMH_LICENSE_SIGNING_KEY   # optional: install-lease signing (see § AMH_LICENSE_SIGNING_KEY)
```
> The HMAC secret stays in Cloudflare — it is never in the Worker code and
> never served to any browser/client. This preserves the existing license keys.

## 6. Import existing customers (one-time)
Re-generate each sold key via `tools/keygen.py` (never reuse committed
placeholders) and seed them through the D1 console so existing buyers' keys
still activate:

## 7. Deploy the Worker
```bash
npx wrangler deploy
#  -> prints a URL like https://amharic-captions-bot.<you>.workers.dev
```

## 8. Point Telegram at your Worker (webhook)
```bash
AMH_TG_TOKEN="<token>" AMH_WEBHOOK_URL="https://amharic-captions-bot.<you>.workers.dev" \
  node scripts/set_webhook.mjs
```
Telegram now pushes updates straight to your Worker. **The bot is always-on
with zero cost and zero downtime.**

## 9. Verify
- Open the bot in Telegram → `/start` works (no local Mac process needed).
- Run the guided buy flow → `/admin` shows the pending order → Approve →
  key generated with the **same HMAC algorithm** → buyer's DM receives it.
- `curl https://amharic-captions-bot.<you>.workers.dev/ok` → `ok`

---

## Switching back (safety net)
The legacy `tools/telegram/bot.py` long-poll bot is **decommissioned** (it also
refuses to start without an `AMH_SECRET` env var). To route Telegram elsewhere
anyway:
```bash
# remove webhook so long-poll can take over
curl "https://api.telegram.org/bot<token>/deleteWebhook"
```
Both the Worker and `bot.py` use the **identical HMAC key algorithm**, so a
key issued by either works in the Premiere panel interchangeably.

## Files
- `src/worker.js` — the webhook bot (stateless, D1-backed) + extension API
  (webhook authenticated by `X-Telegram-Bot-Api-Secret-Token`; /debug removed)
- `migrations/0001_schema.sql` — orders / customers / fsm / funnel schema
- `migrations/0002_trials.sql` — server-side trial tracking (machine-bound)
- `migrations/0003_harden.sql` — customers.uid, duplicate-pending guard,
  machine/uid indexes
- `migrations/0004_fsm_status_msg.sql` — fsm.status_msg_id (durable FSM row)
- `migrations/0005_amount_etb.sql` — orders.amount_etb (numeric price snapshot)
- `migrations/0006_key_activations.sql` — (key,ip) activation telemetry
- `migrations/0007_trial_db_atomic.sql` — trials.last_at + ip_counters (SQL-atomic collapse/caps)
- `wrangler.toml` — bindings + vars (secrets live separately; AMH_KV cache)
  + `[triggers] crons` for the 30-day prune
- `scripts/set_webhook.mjs` / `auto_webhook.mjs` — switch to webhook with
  secret_token (auto_webhook reads token + secret from tools/telegram/bot.env)

## Extension API (used by the Premiere panel)
The Worker also powers server-side licensing for the panel; `/api/*` routes
are **KV-cached and rate-limited** (per-machine **and** per-IP via
`CF-Connecting-IP`) so hot reads stay off D1 quotas:
- `GET /api/trial?mid=XXXXXXXX` → `{used, max, remaining}` — free-trial usage
- `POST /api/trial/use` with `{mid}` → atomic increment + returns remaining
  (machine-bound, so clearing localStorage no longer resets the trial)
- `POST /api/validate` with `{mid, key}` → `{valid, expiry?, token?}` — checks the key
  exists in D1 `customers` for this machine (blocks forged/unofficial keys). When
  `AMH_LICENSE_SIGNING_KEY` is set, a successful validation additionally returns
  a signed **install lease token** (see below) that the panel verifies locally.

**🛡 AMH_API_KEY — REQUIRED (enforced live).** `AMH_API_KEY` is a Worker secret
and **already enforced**: every `/api/*` call WITHOUT a matching `X-Api-Key`
header is rejected 401 (re-verified 2026-09-17 against panel v1.4.14: POST
`/api/ping` → `200 {"ok":true}` with the shipped key, `401` without/with a
wrong key). The value must match `API_KEY_HINT` in `panel/js/main.js` (any
panel build that sends `X-Api-Key` keeps working, older builds are locked
out). Rotation /
recovery: `openssl rand -hex 24` → update `API_KEY_HINT` → ship the panel → set
the secret → deploy. `AMH_BLOCK_SHARED` is also live (`1`): a key presented
from ≥ `AMH_SPREAD_THRESHOLD` (3) distinct source IPs stops validating with
`{valid:false, reason:'shared'}` after alerting admins. Set `AMH_BLOCK_SHARED`
back to `0` (or unset) to return to notify-only.

**🔐 AMH_LICENSE_SIGNING_KEY — install-lease signing (enable after deploying
v1.4.26+ panel).** Closes the "edit localStorage to unlock" bypass (audit #4):
the panel no longer trusts a bare `{valid:true}` — everything must survive
`verifyLicenseToken()` against the *public* key baked into
`panel/js/core.js` (`LICENSE_TOKEN_PUBKEY_PEM`). Only the **private** half lives
here, as the Worker secret `AMH_LICENSE_SIGNING_KEY` (PKCS8 PEM). When the secret
is unset, `/api/validate` simply omits `token` and the shipped panel keeps its
bounded legacy path (30-day migration grace measured from activation) — so this
can be rolled out without locking out existing buyers.

Generate the keypair **offline, once** (P-256; keep the private key out of the
repo — it is minted machine-side, not in CI) and set only the private half on
Cloudflare:
```bash
mkdir -p ~/.config/amharic-captions/license-signing && cd "$_"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out priv.pem
openssl pkey -in priv.pem -pubout -out pub.pem
npx wrangler secret put AMH_LICENSE_SIGNING_KEY < priv.pem   # sets the PKCS8 PEM
```
Then embed `pub.pem` as `LICENSE_TOKEN_PUBKEY_PEM` in `panel/js/core.js`,
rebuild the extension, and deploy. Rotation: replace the keypair, ship the new
public half, then `secret put` the new private half. Key tokens are cached with
the validation response (1h), so a signed token keeps the machine working
offline until its `expiry` (`00000000` = perpetual).

**📤 Backups/export.** Two options:
- In-app: admin **📤 Export customers** button → paste-ready TSV
  (machine | name | expiry | key | status | uid) in the admin chat.
- Full DB: `npx wrangler d1 export amh_bot --remote --output backup-$(date +%F).sql`
  (also enable automatic D1 backups in the dashboard — you already did this).

**🛠 Admin features (installed):**
- **Requests queue is paginated** (newest 10 per page, **▶ More** to load older).
- **📣 Broadcast** — tap it, then send the exact message; it goes to every
  buyer DM (admins skipped, throttled at 90 ms).
- **⏰ Custom expiry** — `/setexpiry ORDERID YYYYMMDD` before approving; the key
  then embeds that date (default is perpetual).
- **Multi-admin** via comma-separated `AMH_ADMIN_ID`.
- **⛔ License kill-switch** — `/revoke ORDERID` marks the customer row so
  `/api/validate` returns `{valid:false, reason:'revoked'}` (panel shows
  "License revoked — contact @sumpak6"); the buyer's status message is edited
  when possible. `/unrevoke ORDERID` restores the license. Each command busts
  the `val:<mid>:<key>` cache so the flip is immediate (that's why the live
  check above clears the key before re-validating). Migration 0008.

**🌐 CORS.** While `AMH_ALLOWED_ORIGIN` is unset, `/api/*` returns
`Access-Control-Allow-Origin: *`. It is now **set live** — verified production
value is `file://,null` (a real CEP panel fetch was captured via the `panel_ping`
beacon and shows the current Premiere/CEF stack sends `Origin: file://`; older
stacks report `null`, so keep both). Locked endpoints echo a whitelisted origin
and omit the header otherwise. To change, `npx wrangler secret put
AMH_ALLOWED_ORIGIN`; to re-open, delete the secret.

**🗑 Pruning.** Now also runs on a cron (`0 */6 * * *`) via the Worker's
`scheduled` handler — no longer depends on admin activity. Orders/funnel older
than 30 days are deleted.

**🌍 Language.** Buyer-facing UI is **English** (single primary language). The
one intentional exception is the **Amharic group-welcome** message, kept for
the support group's brand voice. The decommissioned `tools/telegram/bot.py`
still holds legacy Amharic copy but is archived — do not reactivate it.

**Structured logging.** Worker emits one JSON line per event (levels
`info/warn/error`; events `order_created`, `order_approved`, `order_rejected`,
`prune_run`, `broadcast_sent`, `api_unauthorized`, `webhook_auth_failed`,
`webhook_secret_missing`, `handler_error`, `key_spread`, `trial_fresh_flood`) —
visible under **Workers → Logs / wrangler tail**.

**🛡 Anti-piracy / anti-trial-abuse (migration 0006).**
A license key can only ever validate against the machine_id embedded in it
(the panel and server both enforce that), so `machine_id` is NOT a share
signal — the panel *invents* it (localStorage). The honest signals are:

- **Key spread by source IP**: every valid `/api/validate` (cache hit or miss)
  stamps a `(key, CF-Connecting-IP)` row in `key_activations`. When a key has
  been presented from `AMH_SPREAD_THRESHOLD` distinct IPs (default 3) an admin
  gets one alert per key per 24 h. To hard-block instead of just flag:
  `wrangler secret put AMH_BLOCK_SHARED` → enter `1`. Default is notify-only so
  legit buyers on CGNAT/rotating IPs aren't locked out.
- **Fresh-machine trial flood**: `/api/trial/use` with a mid never seen in D1
  `trials` is the classic clearing-localStorage reset. Per IP, only
  `AMH_FRESH_MID_DAY` (default 5) fresh mids are allowed per 24 h. `/api/trial/use`
  NEVER returns 429 — throttles and the flood cap **echo current state (200)**,
  the flood case saturating to `{used: 2, remaining: 0}`. Rationale: the panel
  collapses a non-200 to null and falls into its local-only increment, which
  would hand an abuser a credit instead of blocking them; syncing to
  `remaining: 0` routes them into the panel's real trial gate. Tune via
  `wrangler secret put AMH_FRESH_MID_DAY`.
- **Why consumption is SQL-atomic (migration 0007):** the 2 s double-fire
  collapse and the per-IP fresh-mid counter run as `UPDATE/INSERT ... WHERE`
  statements in D1, **not** KV read-then-write — Cloudflare KV is eventually
  consistent, so two back-to-back requests could each read a null marker and
  double-increment. `trials.last_at` + `ip_counters` make that impossible and
  free of KV races. Remaining KV micro-throttles (on `/api/validate` and
  `/api/trial` GET) are best-effort anti-annoyance only — never a security
  boundary (real protection is the D1 cap + the API key gate).
- **IP retention (privacy)**: `key_activations` rows (which contain raw source
  IPs) are purged after 30 days by the same cron that prunes orders/funnel
  (`prune_run` logs the count). Raw IPs are never kept indefinitely; the
  30-day window is what spread detection reasons over.

Start with defaults (notify + alert). After you've watched a week of logs, set
`AMH_BLOCK_SHARED=1` if the alert rate stays sane.

**Panel builds.** Manifest + `APP_VERSION` in `panel/js/main.js` are the version
source of truth — keep them in lockstep on every release so support logs can
tell old vs new builds (footer badge shows it; it ships in the released zip).
Each build announces `POST /api/ping {v, mid}` once per machine per day
(logged as `panel_ping` + `api_call`) — watch those to (a) see which build a
machine runs and (b) learn the real `Origin` a CEP panel sends, which is what
`AMH_ALLOWED_ORIGIN` must whitelist when locking CORS.

**⚠ Machine ID is Node-anchored now (panel v1.4.0).** The panel's license
anchor lives in `~/.amharic_captions_machine.json` (Node side, OUTSIDE CEP's
removable storage): clearing CEP cookies/uninstalling can no longer regenerate a
fresh trial machine. A `host` fingerprint (hostname+username SHA-256) is stored
alongside; when it mismatches at boot the panel shows a "created on another
computer" warning instead of silently cycling the ID — so a record copied onto a
second PC is visible to support, and a factory reinstall (same host) keeps
working. Existing localStorage IDs migrate into the file on first run (no
re-keying for current licensees). This is a big step but NOT a true
hardware-echo: the file is still copyable, and a determined cracker who patches
the panel wins regardless — which is why the server-side signals above
(distinct-IP spread, fresh-trial flood) stay enabled. Keep them on.

**After deploying**, copy the `*.workers.dev` URL into
`panel/js/main.js` `API_URL` (replace `ACCOUNT`) so the panel can reach these
endpoints, then rebuild/re-release the extension.
