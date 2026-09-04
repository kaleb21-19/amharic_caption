# Amharic Captions — Cloudflare Worker (webhook) Deployment

Converts the Telegram sales bot into a **free, always-on** version using
Cloudflare Workers + D1 (database). Payment-proof screenshots are stored in D1
as base64 BLOBs. **No R2, no card on file, no domain.** The working long-poll
`bot.py` on the Mac stays as a fallback until this is proven live.

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

# apply all DB migrations (0001 schema, 0002 trials table)
npx wrangler d1 migrations apply amh_bot --remote

# deploy the worker
npx wrangler deploy
```
The deploy prints your Worker URL — **copy it**, e.g.
`https://amharic-captions-bot.<you>.workers.dev`.

Verify it's live:
```bash
curl https://amharic-captions-bot.<you>.workers.dev/ok   # → ok
```

## STEP C — Point Telegram at your Worker (webhook)
```bash
AMH_TG_TOKEN="<telegram-bot-token>" \
AMH_WEBHOOK_URL="https://amharic-captions-bot.<you>.workers.dev" \
  node scripts/set_webhook.mjs
```
> If you haven't set the worker secrets yet, also run (once):
> ```bash
> npx wrangler secret put AMH_TG_TOKEN
> npx wrangler secret put AMH_ADMIN_ID
> npx wrangler secret put AMH_SECRET
> ```
> `AMH_SECRET` = `7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g=` (the HMAC license secret).

## STEP D — Update the extension panel with your real URL
Open `panel/js/main.js`, line 20, and replace the placeholder:
```js
const API_URL = 'https://amharic-captions-bot.<you>.workers.dev';
```
Then rebuild + re-release the extension (Step G).

## STEP E — Refresh D1 customer/seed keys (old 24-char keys no longer validate)
In the Cloudflare dashboard: **Workers & Pages → D1 → amh_bot → Console**, run:
```sql
DELETE FROM customers;
INSERT INTO customers (machine_id, name, expiry, key, status) VALUES
('88888888','@selstyan7','00000000','AMH-8888-8888-0000-0000-c30f-f618-fb26-efd0','sold'),
('a1b2c3d4','@its_kaleb21','00000000','AMH-a1b2-c3d4-0000-0000-e936-c5b9-40cc-4bc0','sold'),
('9d710139','@its_kaleb21','00000000','AMH-9d71-0139-0000-0000-260b-19dc-fb1d-5c4b','sold'),
('4cba71e3','@its_kaleb21','00000000','AMH-4cba-71e3-0000-0000-0137-d378-d661-696e','sold'),
('7cc97f2e','@its_kaleb21','00000000','AMH-7cc9-7f2e-0000-0000-32ba-3c27-4895-805d','sold');
```

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
npx wrangler secret put AMH_ADMIN_ID      # 5842127112  (admin chat id)
npx wrangler secret put AMH_SECRET        # HMAC license secret
```
> The HMAC secret stays in Cloudflare — it is never in the Worker code and
> never served to any browser/client. This preserves the existing license keys.

## 6. Import existing customers (one-time)
Run the SQL below against `amh_bot` via the D1 console, or a seed migration.
Keeps the 3 already-sold keys working so their keys still activate:
```sql
INSERT INTO customers (machine_id, name, expiry, key, status) VALUES
('88888888','@selstyan7','00000000','AMH-8888-8888-0000-0000-c30f-f618-fb26-efd0','sold'),
('a1b2c3d4','@its_kaleb21','00000000','AMH-a1b2-c3d4-0000-0000-e936-c5b9-40cc-4bc0','sold'),
('9d710139','@its_kaleb21','00000000','AMH-9d71-0139-0000-0000-260b-19dc-fb1d-5c4b','sold');
```

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
To go back to the local long-poll bot:
```bash
# remove webhook so long-poll can take over
curl "https://api.telegram.org/bot<token>/deleteWebhook"
# then run bot.py as before (the Mac fallback)
```
Both the Worker and `bot.py` use the **identical HMAC key algorithm**, so a
key issued by either works in the Premiere panel interchangeably.

## Files
- `src/worker.js` — the webhook bot (stateless, D1-backed) + extension API
- `migrations/0001_schema.sql` — orders / customers / fsm / funnel schema
- `migrations/0002_trials.sql` — server-side trial tracking (machine-bound)
- `wrangler.toml` — bindings + vars (secrets live separately)
- `scripts/set_webhook.mjs` — switches Telegram to webhook mode

## Extension API (used by the Premiere panel)
The Worker also powers server-side licensing for the panel:
- `GET /api/trial?mid=XXXXXXXX` → `{used, max, remaining}` — free-trial usage
- `POST /api/trial/use` with `{mid}` → increments + returns remaining (machine-bound,
  so clearing localStorage no longer resets the trial)
- `POST /api/validate` with `{mid, key}` → `{valid, expiry?}` — checks the key exists
  in D1 `customers` for this machine (blocks forged/unofficial keys)

**After deploying**, copy the `*.workers.dev` URL into
`panel/js/main.js` `API_URL` (replace `ACCOUNT`) so the panel can reach these
endpoints, then rebuild/re-release the extension.
