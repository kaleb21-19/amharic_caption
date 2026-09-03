# Amharic Captions — Marketing Site

Next.js (App Router) static site for the Amharic Captions Premiere extension.
Builds to fully static HTML/CSS/JS and deploys to GitHub Pages.

- `/` — single English-first landing page
- `sitemap.xml`, `robots.txt`, JSON-LD `SoftwareApplication` schema — generated
  at build time for SEO

## Tech
- Next.js 14 (App Router), React 18, pure JSX (no TypeScript)
- Static export (`next.config.mjs` → `output: "export"`)
- Hosted at `https://kaleb21-19.github.io/amharic_caption/` (sub-path → `basePath`)

## Central config
All buy/contact links live in `lib/site.js`. The entire funnel points to the
Telegram bot (`@AmharicCaptionsBot`). Change it once there.

- `BOT_URL` = `https://t.me/AmharicCaptionsBot`
- `SUPPORT_URL` = `https://t.me/sumpak6`
- `PRICE` = `ETB 1,500`
- `PAYMENT` = `Telebirr 0907 628 809`

## Product screenshot
The hero shows `public/images/screenshot.svg`. To use a real screenshot:
save your panel/demo capture as `public/images/screenshot.png` and update the
`<img src>` in `app/page.jsx`.

## Develop locally
```
cd website
npm install
npm run dev        # http://localhost:3000
```

## Production build (outputs to `website/out/`)
```
NEXT_PUBLIC_SITE_URL=https://kaleb21-19.github.io/amharic_caption \
NEXT_PUBLIC_BASE_PATH=/amharic_caption \
npm run build
```

## Deploy
Push to `main` — `.github/workflows/deploy-website.yml` builds and deploys to
GitHub Pages automatically (or run manually via Actions → "deploy-website" →
"Run workflow"). GitHub Pages source must be set to **GitHub Actions**.
