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
curl https://amharic-captions-bot.<you>.workers.dev/ready   # → {"ok":true}
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
> # OPTIONAL deployment-level API gate (public desktop clients are supported
> # without it; set AMH_REQUIRE_API_KEY=1 only with an external network policy):
> npx wrangler secret put AMH_API_KEY
> # CORS allow-list — comma-separated origins (include 'null' for CEP file://
> # panels). Empty means no browser origin is allowed.
> npx wrangler secret put AMH_ALLOWED_ORIGIN
> # REQUIRED: ECDSA P-256 private key (PKCS8 PEM) that signs install leases.
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
server-side) and **no shared API secret**. The extension API is transport-public
by design; the Worker protects license authenticity with the server-only HMAC,
D1 customer row, and signed lease. If a deployment sets
`AMH_REQUIRE_API_KEY=1`, it must also provide a separate network-level gate;
a key copied into a public desktop bundle is not an authentication boundary.
Update the CSP `connect-src` in `panel/index.html` when `API_URL` changes, then
rebuild + re-release the extension (Step G).

## STEP E — Back up and verify D1 customer data
Customer keys are **never committed to the repo**. Before any data change,
export a backup:
```bash
npx wrangler d1 export amh_bot --remote --output backup-$(date +%F).sql
```
If keys must be reissued, generate each replacement with `tools/keygen.py`
and update the specific customer row inside a reviewed migration. Do **not**
run `DELETE FROM customers` in production. Never paste live keys/IDs into this
file — the repository is public.

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
npm ci
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
npx wrangler secret put AMH_LICENSE_SIGNING_KEY   # required install-lease signing
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
AMH_TG_TOKEN="<token>" \
AMH_WEBHOOK_URL="https://amharic-captions-bot.<you>.workers.dev" \
AMH_WEBHOOK_SECRET="<same-value-as-worker>" \
  node scripts/set_webhook.mjs
```
The script fails unless Telegram confirms `getMe`, `setWebhook`, and the
registered URL. The secret is mandatory; the Worker rejects unsigned updates.
Telegram now pushes updates straight to your Worker. **The bot is always-on
with zero cost and zero downtime.**

## 9. Verify
- Open the bot in Telegram → `/start` works (no local Mac process needed).
- Run the guided buy flow → `/admin` shows the pending order → Approve →
  key generated with the **same HMAC algorithm** → buyer's DM receives it.
- `curl https://amharic-captions-bot.<you>.workers.dev/ready` → `{"ok":true}`

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
- `migrations/0002_trials.sql` — server-side trial tracking (installation-bound abuse controls)
- `migrations/0003_harden.sql` — customers.uid, duplicate-pending guard,
  machine/uid indexes
- `migrations/0004_fsm_status_msg.sql` — fsm.status_msg_id (durable FSM row)
- `migrations/0005_amount_etb.sql` — orders.amount_etb (numeric price snapshot)
- `migrations/0006_key_activations.sql` — (key,ip) activation telemetry
- `migrations/0007_trial_db_atomic.sql` — trials.last_at + ip_counters (SQL-atomic collapse/caps)
- `migrations/0008_revoked.sql` — authoritative license revocation flag
- `migrations/0009_webhook_updates.sql` / `0013_webhook_lease.sql` — Telegram retry idempotency and crash-reclaim leases
- `migrations/0010_order_delivery.sql` — approval/delivery state and retry lease
- `migrations/0011_trial_uses.sql` / `0012_trial_lease.sql` — run-bound trial reservations and crash recovery

- `wrangler.toml` — bindings + vars (secrets live separately; AMH_KV cache)
  + `[triggers] crons` for the 30-day prune
- `scripts/set_webhook.mjs` / `auto_webhook.mjs` — switch to webhook with
  secret_token (auto_webhook reads token + secret from tools/telegram/bot.env)

## Extension API (used by the Premiere panel)
Use `GET /ready` as the deployment health check; it verifies required secrets,
bindings, and both cryptographic services. The Worker also powers server-side
licensing for the panel; `/api/*` routes
are KV-cached and rate-limited (per-machine and per-IP via
`CF-Connecting-IP`) so hot reads stay off D1 quotas. The `AMH_KV` namespace
binding is required for the API even when the optional API-key gate is off;
`/ready` fails closed if it is absent. The transport is public;
license authenticity comes from the server-only HMAC + D1 row, not a client
key:
- `GET /api/trial?mid=XXXXXXXX` → `{used, max, remaining}` — free-trial usage
- `POST /api/trial/use` with `{mid, run_id}` → idempotent atomic increment +
  returns `used`, `remaining`, and an explicit `charged` bit. `charged:false`
  means the cap/flood/conflict gate rejected the output and the panel must not
  place it. `run_id` is required for new panels so a retry cannot spend a
  second credit.
- `POST /api/validate` with `{mid, key}` → `{valid, expiry, token}` — checks
  the HMAC and the D1 `customers` row, then always returns a fresh signed
  install lease. A missing/invalid signing secret fails closed with 503.

**AMH_API_KEY — optional deployment gate, not client authentication.** The
Worker accepts the public extension API by default. Set `AMH_REQUIRE_API_KEY=1`
and `AMH_API_KEY` only when an external network policy protects the route; a
secret copied into a public desktop panel is not a security boundary.

**🔐 AMH_LICENSE_SIGNING_KEY — required install-lease signing.** Closes the
"edit localStorage to unlock" bypass: the panel trusts only a token that passes
`verifyLicenseToken()` against the public key baked into
`panel/js/core.js` (`LICENSE_TOKEN_PUBKEY_PEM`). Only the private half lives in
the Worker secret `AMH_LICENSE_SIGNING_KEY` (PKCS8 PEM). If it is absent or
malformed, successful validation returns 503 rather than a boolean-only result.
There is no unsigned legacy acceptance path.

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
- **Delivery recovery** — an approval sends under a five-minute D1 lease. If
  Telegram or the Worker dies after claiming delivery, the admin card exposes
  **Retry key delivery** once the lease expires; `failed` and stale `sending`
  rows are safe to retry.
- **⏰ Custom expiry** — `/setexpiry ORDERID YYYYMMDD` before approving; the key
  then embeds that date (default is perpetual).
- **Multi-admin** via comma-separated `AMH_ADMIN_ID`.
- **⛔ License kill-switch** — `/revoke ORDERID` (or `/revoke-mid MID`) marks the
  customer row so `/api/validate` returns `{valid:false, reason:'revoked'}`.
  `/unrevoke ORDERID` and `/unrevoke-mid MID` restore it. Validation checks the
  authoritative D1 row even on a positive KV cache hit, so a cache-delete failure
  cannot leave a revoked key valid. Migration 0008.

**🌐 CORS.** `AMH_ALLOWED_ORIGIN` is fail-closed: while unset, `/api/*`
returns no allow-origin header. Set it to the exact browser origins you need;
CEP deployments commonly use `file://,null` after verifying the real panel
origin. Locked endpoints echo a whitelisted origin and omit it otherwise. To
change, `npx wrangler secret put AMH_ALLOWED_ORIGIN`.

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

- **Key sharing by COMPUTER (migration 0024, 1.10.1+ clients)**: the panel,
  desktop app and SRT maker send `hf` with `/api/validate` — an 8-hex hash of
  username | home folder | platform (the same value on all three). Every valid
  check stamps `(key, hf)` in `key_hosts`. A license copied to another PC has
  the same Machine ID but a different `hf`, whatever the network. Rules (30
  days): `AMH_SHARE_ALERT_HOSTS` (default 2) computers → one admin alert per
  key per 24 h; `AMH_SHARE_HOSTS` (default 3) computers + `AMH_BLOCK_SHARED=1`
  → only the NEW computer is refused (`reason: shared`, never cached), the
  first ones keep working. Clients without `hf` (panels before 1.10.1) are
  never refused.
  **Source IPs are no longer a share signal.** They are still stamped in
  `key_activations` (shown by /find) for support. The old rule (3 distinct
  IPs per key) refused the owner's own key and two customers on 2026-10-07:
  Ethio Telecom gives one computer a new address all the time.
  `AMH_SPREAD_THRESHOLD` is no longer read.
- **Fresh-machine trial flood**: `/api/trial/use` with a mid never seen in D1
  `trials` is the classic clearing-localStorage reset. Per IP, only
  `AMH_FRESH_MID_DAY` (default 5) fresh mids are allowed per 24 h. `/api/trial/use`
  NEVER returns 429 — throttles and the flood cap **echo current state (200)**,
  the flood case saturating to `{used: 2, remaining: 0, charged: false}`.
  Rationale: the panel
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
  boundary (real protection is the D1 cap + HMAC/signed-lease checks).
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

**⚠ Machine ID is Node-anchored now (panel v1.4.x).** The panel's license
anchor lives in `~/.amharic_captions_machine.json` (Node side, OUTSIDE CEP's
removable storage): clearing CEP cookies/uninstalling can no longer regenerate a
fresh trial machine. New IDs are 16 hex characters; legacy 8-hex IDs remain
readable. A host fingerprint is stored alongside; when it mismatches at boot
the panel shows a warning instead of silently cycling the ID. This is still a
file-bound license, not a hardware attestation: copying the identity/license
files can move a license, so do not share them. Online spread detection,
signed leases, and trial-abuse controls remain enabled.

**After deploying**, copy the `*.workers.dev` URL into
`panel/js/main.js` `API_URL` (replace `ACCOUNT`) so the panel can reach these
endpoints, then rebuild/re-release the extension.

## BotFather profile (paste once; not part of the Worker)

The bot's name, the text people see **before** pressing Start, and the `/`
command menu live in Telegram, not in this code. Open @BotFather and send:

**`/setname`** → `Amharic Captions Pro`

**`/setdescription`** (shown on the empty chat before Start, max 512 chars):

```
🎬 አማርኛ ካፕሽን ፕሮ — የቪዲዮዎን የአማርኛ ንግግር በራሱ ወደ ካፕሽን ይቀይራል (Premiere Pro፣ After Effects፣ CapCut)።
💯 ሙሉ በሙሉ በኮምፒውተርዎ ላይ፣ ያለ ኢንተርኔት።
🎁 2 ካፕሽን በነጻ ይሞክሩ · 💰 2,500 ብር፣ አንድ ጊዜ ብቻ።
⚠️ ክፍያ ለ KALEB TEGEGEN ብቻ።

Offline Amharic captions for Premiere Pro, After Effects and any editor. Try 2 free, then buy and get your key right here.
```

**`/setabouttext`** (profile page, max 120 chars):

```
አማርኛ ካፕሽን ፕሮ · ይግዙ፣ ቁልፍዎን ያግኙ፣ እገዛ · amharic-caption-pro.vercel.app
```

**`/setcommands`**:

```
start - ዋና ገጽ · Menu
buy - ክፍያ · Pay
mykey - ቁልፌ · My key
help - እገዛ · Help
invite - ጓደኛ ይጋብዙ · Invite friends
```

## Referral programme (owner guide)

Needs migration 0015 (`npm run migrate` before `npm run deploy`). It starts
**OFF**; nothing changes for buyers until you switch it on.

- **Switch:** `/admin` → **🎁 Referrals** → **🟢 Turn ON / ⚪ Turn OFF**.
- **Amounts** (new orders only; orders already placed keep their terms):
  `/refdiscount 200` (friend's discount, ብር) · `/refreward 300` (your
  payout per referred sale) · `/refhold 14` (days before a reward is payable
  — keep it at the 14-day refund window).
- **Announce:** **📣 Announce to buyers** drafts a ready-made Amharic message
  and opens the normal broadcast preview (Buyers only / Everyone / Cancel).
- **What buyers see:** buyers (only) get **🎁 ጓደኛ ይጋብዙ** in the menu and
  `/invite`: a personal link, a Share button, their earnings and a
  **🏦 Payout account** button. A new buyer is offered their link right after
  their key arrives.
- **What friends see:** opening a link shows the discounted price on the
  welcome, pay and review screens. Your approval card says
  `👥 Referred — expect ETB 2,300`.
- **Paying rewards (about 10 minutes a month):** the bot reminds you once a
  month when rewards are payable. **🎁 Referrals → 💰 Pay rewards** lists each
  person, the amount and their bank account. Transfer, tap **✅ Paid** — the
  referrer is told automatically. No account yet? Tap **📩 Ask**.
- **Rules enforced by the bot:** first link wins; no self-referral (same
  Telegram account or same computer); only new customers get the discount;
  a revoked/refunded friend cancels an unpaid reward; switching OFF stops new
  links and discounts at once, but rewards already earned stay owed.
- **Terms** are on the website legal page (`/legal/#referral`); the bot's
  📜 Terms button links there.

## Partner links (groups, channels, creators)

Needs migration 0016. Independent of the buyer-referral ON/OFF switch.

1. **Create:** `/partner EDITGROUP Editors Ethiopia` → the bot replies with
   two links:
   - a **private link** (`…?start=p_…`) — send it only to the group owner.
     Opening it once connects their Telegram account (you get a message
     saying who connected);
   - the **public link** (`…?start=r_EDITGROUP`) for their group post. It
     works **immediately**; sales made before the partner connects are kept
     and their rewards wait for them. On TikTok/YouTube (no clickable links)
     people can simply **type `EDITGROUP`** in the bot.
2. **Terms:** `/partnerterms EDITGROUP 300 200 20 400` = 300 ብር per sale,
   200 ብር off for the buyer, and 400 ብር per sale after 20 sales (the last
   two numbers are optional). New orders use new terms; placed orders keep
   theirs. The partner is told when terms change.
3. **Manage:** `/partners` (or 🎁 Referrals → 🤝 Partners) lists each partner
   with opened / sold / earned / owed and **⏸ Pause / ▶ Resume**.
4. **Partner's view:** `/invite` or 🎁 in the menu shows their link, a Share
   button, clicks, sales, earnings, tier progress and their payout account.
5. **Paying:** partner rewards appear in the same monthly **💰 Pay rewards**
   list, under the partner's name.

**Partner links v2 (migration 0017):**
- Sales are credited to the partner **code**, so a partner who gets a new
  phone/account keeps everything: `/partnerreset EDITGROUP` sends you a new
  private link for them (the old one stops working).
- `/partnername EDITGROUP New name` renames. New partners always start at
  300 ብር per sale / 200 ብር off (independent of `/refreward`).
- The price a buyer **saw** on the pay screen is honoured for 48 hours, even
  if you pause the partner or change the terms meanwhile.
- First **live** link wins: a paused link, or one older than 60 days without
  a purchase, no longer holds a person — a new link can take over.
- Partner page and `/partners` show **this month** and conversion
  (opened → bought).

## Partner management centre (migration 0018)

`/partners` → tap a partner (or `/partnerinfo EDITGROUP`) for the **partner
card**: Telegram @username + id + connect date, terms and tier progress,
**bank account**, private note, performance (opened / bought / conversion /
this month / revenue they brought), rewards (earned / paid / owed → payable
now + next date), the latest sales with each reward's state, and the payout
history. Buttons:

| Button | Does |
|---|---|
| ⏸ Pause / ▶ Resume | Pause asks first: **Pause & tell them** or **Pause quietly**; Resume tells them |
| 💰 Pay N ብር | shows the amount, the orders and the bank account to copy; after you transfer, tap **✅ I sent N ብር** — then it is marked paid and they are told |
| ✉️ Message | your next text goes to them from the bot (`/pmsg CODE text` too) |
| 📊 Send report | this month's statement to the partner |
| 📄 All sales | every sale: order, date, price, reward, status |
| 📨 Links | the private + public links again |
| 📝 Note / terms help | `/partnernote CODE text` (`-` clears), terms, rename |
| ♻ New phone | asks to confirm, then a new private link; history and bank account kept |
| 🗑 Delete | only for a partner with **no sales** (a typo / test); asks first |

- The **Partners list** shows totals (active, connected, sales, owed, due now)
  and 10 partners per page, best first.
- `/partnerbank CODE CBE 1000123456789 Name` records their bank account for
  them (e.g. given by phone, or before they connect). Their own saved account
  is used first once they add one. `-` clears it.
- 🏦 **Bank-change alert:** when a partner adds or **changes** their bank
  account you get a message with old and new. An unexpected change? Call the
  partner before paying.
- Changing terms tells the partner the **new numbers**, shows you before/now,
  and warns if reward + discount is over half the price.
- Partners have **📄 My sales** on their page (date, reward, pay date — no
  buyer names or Machine IDs).
- When a partner writes to the bot, the message is **forwarded to you** with
  a ✉️ Reply button. Their page tells them they can write there.
- On the **1st of every month** each connected partner automatically gets
  last month's statement (sales, earned, paid, owed) — 10 per cron run, so
  with many partners they arrive over the first day.

## Simple buying — no Machine ID for customers (migration 0019, panel 1.7.7)

Deploy order: `npm run migrate && npm run deploy`, then publish panel 1.7.7.

**Customers never copy a Machine ID any more.** Two ways in, one step each:

| Where they start | What they do | What happens |
|---|---|---|
| **Panel → Buy a license** | Pay, send the screenshot in the bot | The bot already knows the computer. After you approve, **the panel activates itself** (nothing to paste). The key is also sent as a fallback. |
| **Phone** (group post, TikTok, partner link) | Pay, send the screenshot in the bot | After you approve, they get a short **activation code** (e.g. `K7QD-3MXP`). They type it into the panel's key box once — it is then bound to that computer. |

- Any photo or image-file after tapping **Pay** is the order — no Confirm step.
  A photo sent out of the blue first asks "Is this your payment screenshot?".
- A second screenshot while an order waits **replaces** it (you get a
  "🔄 New screenshot for #N" card).
- Phone orders show as **📱 phone order** in Requests / History. Approving
  sends the code. **My Key** in the bot shows unused codes.
- One code = one computer. The same computer can redeem it again (reinstall).
  `/revoke ORDER` works before and after the code is used.
- Paid from the phone and later pressed **Buy** in the panel? The bot links
  that computer to the waiting order automatically.
- Old panels (1.7.6 and earlier) still work: typing a Machine ID in the bot
  is still understood.

## Security (migration 0020)

**Admin PIN (strongly recommended).** Everything is run from your Telegram
account; if it is ever taken over (SIM swap, a stolen session) the PIN stops
the damaging actions. Set it once (pick 6+ digits nobody knows):

    npx wrangler secret put AMH_ADMIN_PIN

Then in the bot: `/unlock 123456` (the message is deleted at once) opens these
for 12 hours — `/lock` closes them now:

- 📣 sending a broadcast · 📤 exporting customers / sales
- 💰 marking rewards / partners paid · 🏦 `/partnerbank` · `/partnerterms`
- 🎁 referral ON/OFF and amounts · 🗑 delete / ♻ move a partner
- 🚫 `/revoke` `/unrevoke` `/setexpiry`

5 wrong PINs lock it for an hour and alert you. Approve / Decline never need
the PIN (they are logged instead).

**Fake / reused payment screenshots.** Every screenshot is fingerprinted and
kept forever. The admin card shows 🚨 when the same image was already used
(by anyone, any time) or when it was forwarded from someone else's chat, and
Approve then asks a second time: *"The money is in my bank — approve"*.
**Always check your bank app before approving any order.**

**Audit log.** `/audit` (or 🔐 Audit log on the dashboard) lists the last 30
admin actions: approvals, declines, exports, payouts, broadcasts, unlocks,
failed PINs. Kept for a year.

**Owner checklist (once, outside the code):**
1. Telegram → Settings → Privacy → **Two-Step Verification ON**; Devices → end
   sessions you don't recognise.
2. Cloudflare, GitHub, Hugging Face and your email: **2-factor login ON**.
3. Backups: D1 keeps a 7-day restore point automatically
   (`npx wrangler d1 time-travel info amh_bot`); also run
   `npx wrangler d1 export amh_bot --remote --output backup.sql` weekly and
   keep it off the repo (the repo is public).
4. Never put tokens, AMH_SECRET or the PIN in chat, screenshots or the repo.

## Customer support: find, move, free keys (no migration)

- **🔍 Find a customer** (dashboard button, or `/find MACHINE-ID`): the whole picture
  for one computer, with the buttons you need.
- **🔁 Move to a new computer** (button on that card, or `/move OLD-ID NEW-ID`): for
  "I changed computer / reinstalled Windows". The old key stops working, a key for the
  new Machine ID is made with the same expiry, the buyer gets it in the bot, and it
  stays ONE sale. After 3 moves of the same license the bot warns it may be shared.
  Needs the admin PIN.
- **🎁 Free key** (`/givekey MACHINE-ID name`, or the button on /find of an unknown
  computer): for partners, testers, reviewers. Status `gift` — never counted as a sale
  or revenue; revoke any time from /find. Needs the admin PIN.
- `/help` (as admin) or **📖 Commands** shows the admin cheat sheet. "Today" on the
  dashboard and the /audit times are Ethiopian time.

## Customer bot: answers, home screen, one reminder (no migration)

- **❓ Questions** on the menu: price, free trial, requirements, install, when the key
  arrives, new computer, key not working — each one tap, with the right buttons.
- **Typed questions get answers** — Amharic, English and Amharic typed in Latin letters
  ("waga sint", "eske meche", "aysera"). While a buyer is paying, the answer also
  reminds them the screenshot is the only step left. Anything else → Questions +
  "Ask a person" (@sumpak6).
- **Home screen by customer:** newcomer → the offer; paid and waiting → "Order #N,
  #k in line"; owner → "You own it" + My Key (no Pay button any more).
- **One reminder:** someone who opened Pay and then went quiet for 3–24 h gets one
  friendly message with the answers and the free trial (6-hour cron). Never twice in
  30 days, never after an order.

## Support group helper (no migration)

In a group the bot is quiet. It never answers normal talk, problem reports or
screenshots, and never posts prices with bank accounts there. It only:

- **Welcomes new members**, one welcome on screen at a time (the previous one is
  deleted), and removes the "X joined / X left" lines.
- **Takes down secrets:** a license key, Machine ID or activation code posted in the
  group (text or photo caption) is deleted, with a short warning in the same topic.
  Look-alikes (H264-HEVC, phone numbers, dates, plain words) are left alone.
- **Answers the three common questions** (price, free trial, install) when a member
  asks one, as a reply in the same topic, at most once per 30 minutes per question.
  Admins, statements and replies to someone are left alone.

To turn it on:
1. Deploy as usual.
2. Add @AmharicCaptionsBot to the group and make it an **admin** with
   **Delete messages** and **Manage topics** (Manage topics lets it post the welcome
   in the closed Announcements topic). Nothing else is needed.

## Jobs: public channel + weekly digest (no migration)

- **Public jobs channel (optional):** create a public channel (e.g. `@EthioEditingJobs`),
  add @AmharicCaptionsBot as an admin with **Post messages**, set
  `AMH_JOBS_CHANNEL = "@EthioEditingJobs"` in `wrangler.toml` and deploy. Every job card the
  group gets is also posted there, with a "Discuss in the group" button.
- **Weekly digest:** every Monday ~09:00 Ethiopian time (the 6-hour cron), while the jobs
  feed is ON, the bot posts "This week: N editing jobs from M channels" in the group
  (Announcements) and the public channel, with "See the jobs" and "Share with a friend"
  buttons. Once per week.
