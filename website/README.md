# Amharic Captions Pro — Marketing Site

Next.js (App Router) marketing site for the Amharic Captions Pro Premiere
extension. Runs on Vercel — no GitHub account name in the URL.

- `/` — single English-first landing page
- `/install/` — platform downloads + step-by-step install (Windows, macOS)
- `/pricing/`, `/faq/` — sales + help pages
- `/legal/` — EULA, privacy policy, refund policy (also shipped as plain-text
  `EULA.txt` / `PRIVACY.txt` / `REFUND.txt` at the root of every release zip;
  sources: `website/app/legal/page.jsx` + `tools/legal/`)
- `sitemap.xml`, `robots.txt`, JSON-LD `SoftwareApplication` schema — generated
  at build time for SEO

## Tech
- Next.js 14 (App Router), React 18, pure JSX (no TypeScript)
- Deployed on Vercel → https://amharic-caption-pro.vercel.app
- Add your own domain later under Vercel → Project → Settings → Domains

## Central config
All buy/contact links live in `lib/site.js`. The entire funnel points to the
Telegram bot (`@AmharicCaptionsBot`). Change it once there.

- `SITE_NAME` / `SITE_URL` = brand + canonical base
- `BOT_URL` = `https://t.me/AmharicCaptionsBot`
- `SUPPORT_URL` = `https://t.me/sumpak6`
- `PRICE` = `ETB 2,500`
- Payment = bank transfer to `KALEB TEGEGEN` (CBE `1000504159977` / Abyssinia `402393939` / Zemen `1031111343277015`),
  defined in `lib/site.js` as `ACCT_NAME` + `ACCOUNTS` and rendered by `components/BankCards.jsx`

## Product assets
- **Header/Footer logo:** `public/images/logo@2x.png` (web-optimized from the
  `~/Desktop/assets/logo.png` source)
- **Hero product screenshot:** `public/images/panel-hi.png` (web-optimized from
  the `~/Desktop/assets/panel.png` source)

To update, drop the new files into `public/images/` (as `logo@2x.png` /
`panel-hi.png`) and push. Originals live in `~/Desktop/assets/`.

## Develop locally
```
cd website
npm install
npm run dev        # http://localhost:3000
```

## Deploy
Push to `main` — Vercel auto-deploys the `website` project on every change.
First time only: Vercel → Add New Project → import the GitHub repo → framework
auto-detects Next.js → project name `amharic-caption-pro` → Deploy.

The deployed host must stay in sync with `SITE_URL` in `lib/site.js`, the
release notes URL in `.github/workflows/build.yml`, and the `SITE_URL`
constants in `tools/telegram-worker/src/worker.js` and `tools/telegram/bot.py`.