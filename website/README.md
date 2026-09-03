# Amharic Captions — Marketing Site

Next.js (App Router) static site for the Amharic Captions Premiere extension.
Builds to fully static HTML/CSS/JS and deploys to GitHub Pages.

- `/` — Amharic landing page (`am`)
- `/en/` — English landing page
- `sitemap.xml`, `robots.txt`, JSON-LD `SoftwareApplication` schema, hreflang —
  all generated at build time for SEO.

## Tech
- Next.js 14 (App Router), React 18, pure JSX (no TypeScript)
- Static export (`next.config.mjs` → `output: "export"`)
- Hosted at `https://kaleb21-19.github.io/amharic_caption/` (sub-path → `basePath`)

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
Push to `main` — the `.github/workflows/deploy-website.yml` workflow builds and
deploys to GitHub Pages automatically (or run it manually via Actions →
"deploy-website" → "Run workflow").

> Requires the repo's GitHub Pages setting to publish from GitHub Actions.
> Settings → Pages → Source: **GitHub Actions**.

## Contact / buy links
The site's CTAs point to `https://t.me/sumpak6` (support) and mention
Telebirr **0907 628 809**. Change these in:
- `components/Header.jsx`, `components/Footer.jsx`
- `app/(am)/page.jsx` (buy links), `app/en/page.jsx`
