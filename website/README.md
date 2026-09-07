# Amharic Captions Pro — Marketing Site

Next.js (App Router) marketing site for the Amharic Captions Pro Premiere
extension. Runs on Vercel — no GitHub account name in the URL.

- `/` — single English-first landing page
- `/install/` — platform downloads + step-by-step install (Windows, macOS)
- `/pricing/`, `/faq/` — sales + help pages
- `sitemap.xml`, `robots.txt`, JSON-LD `SoftwareApplication` schema — generated
  at build time for SEO

## Tech
- Next.js 14 (App Router), React 18, pure JSX (no TypeScript)
- Deployed on Vercel → https://amharic-captions-pro.vercel.app
- Add your own domain later under Vercel → Project → Settings → Domains

## Central config
All buy/contact links live in `lib/site.js`. The entire funnel points to the
Telegram bot (`@AmharicCaptionsBot`). Change it once there.

- `SITE_NAME` / `SITE_URL` = brand + canonical base
- `BOT_URL` = `https://t.me/AmharicCaptionsBot`
- `SUPPORT_URL` = `https://t.me/sumpak6`
- `PRICE` = `ETB 2,500`
- `PAYMENT` = `Telebirr 0907 628 809`

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
auto-detects Next.js → project name `amharic-captions-pro` → Deploy.