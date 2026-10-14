# PROJECT_MAP — where things are (read this instead of searching)

Each line: `file` :: `symbol` — what it is. `python tools/agent/map_check.py`
checks every file and symbol still exists (FRESH / STALE). Update a line in
the same PR that moves or renames the code. Keep this file under ~120 lines.

## Panel (Premiere / After Effects, CEP) — panel/
- `panel/js/main.js` :: `function openReview` — the review screen opens (captions list, style strip)
- `panel/js/main.js` :: `function placeReview` — "Place on timeline": plain captions or a styled layer (falls back to plain)
- `panel/js/main.js` :: `function renderStyleStrip` — style buttons (Plain, My styles, NEW mark, 18 styles)
- `panel/js/main.js` :: `function styleOpts` — Customize options per style (colour, text, anim, font, size, pos, words, box)
- `panel/js/main.js` :: `function renderPreview` — the caption-strip preview (runs amh_styles.py preview)
- `panel/js/main.js` :: `function renderStyled` — spawns `amh_styles.py render` (overlay / burn / preview)
- `panel/js/main.js` :: `function placeStyled` — imports the styled .mov and calls amh_placeOverlay
- `panel/js/main.js` :: `function checkStyles` — styles shown only if ffmpeg has the `subtitles` filter (libass)
- `panel/js/main.js` :: `function saveMyStyle` — My styles (saved looks, max 20)
- `panel/js/main.js` :: `function errorStep` — error type for telemetry (err_no_audio, err_memory, ...)
- `panel/js/main.js` :: `function humanError` — the message the user sees for an error (English key, Amharic in i18n.js)
- `panel/js/main.js` :: `function engineAuth` — license lease or trial ticket before the engine runs
- `panel/js/main.js` :: `TRIAL_GATE` — free-minutes gate (Telegram trial, 30 min / 7 days)
- `panel/js/main.js` :: `function liveReviewAllowed` — review opens while long videos still transcribe
- `panel/js/main.js` :: `function track` — anonymous step counts (/api/event)
- `panel/js/i18n.js` :: `'NEW'` — Amharic UI strings (key = the English text)
- `panel/index.html` :: `id="review"` — markup + all panel CSS (dark only)
- `panel/CSXS/manifest.xml` :: `ExtensionBundleVersion` — version (bump with tools/agent/bump.py)
- `panel/jsx/host.jsx` :: `function amharic_getSelectedClip` — which clip Generate uses (audio tracks first, then video)
- `panel/jsx/host.jsx` :: `function amh_placeOverlay` — styled layer on the first empty track above (Premiere)
- `panel/jsx/host.jsx` :: `function amharic_getFrame` — sequence width/height/fps
- `panel/jsx/host_ae.jsx` :: `function amh_placeOverlay` — styled layer in After Effects (pure ASCII file!)

## Desktop app (CapCut / DaVinci) — app/
- `app/app_mode.js` :: `saveSrt` — Save SRT (+ burned styled MP4 when a style is chosen)
- `app/amh_app.py` :: `readBase64` — local bridge op (127.0.0.1 + token only)
- `app/node_shim.js` :: `readBase64` — the fake CEP Node API the panel code uses in the app

## Caption styles engine
- `amh_styles.py` :: `def build` — words -> ASS script for a style (+ options)
- `amh_styles.py` :: `def options` — cleans Customize options (FONTS, ANIMS, SIZES, POSITIONS)
- `amh_styles.py` :: `def _modern` — Glide / Spotlight / Bounce (words placed by us from metrics.json)
- `amh_styles.py` :: `def _entrances` — entrance animations (Auto keeps the style's own)
- `amh_styles.py` :: `def _caption_band` — preview = only the caption strip (480x160)
- `amh_styles.py` :: `def render` — ffmpeg/libass: overlay .mov (qtrle alpha), burn .mp4, preview .webp/.gif
- `tools/fonts/make_metrics.py` :: `def main` — rebuilds tools/fonts/metrics.json after a font change (needs fontTools)
- `tools/fonts/metrics.json` :: `"Noto Sans Ethiopic|1"` — letter widths (shipped in runtime/fonts)
- `panel/img/styles/glide.jpg` :: — style thumbnails 300x150 (neutral background, no third-party video)

## Engine + licensing (careful: AGENTS.md §7)
- `ethio_srt.py` :: `def require_license` — engine refuses without a license / trial ticket
- `amh_license.py` :: `def engine_auth` — lease / ticket verification for this machine
- `amh_decode.py` :: `def ` — word-aware CTC decoder (+ forced alignment)
- `tools/model.lock` :: — the only allowed model.bin hash

## Bot + license server — tools/telegram-worker/
- `tools/telegram-worker/src/worker.js` :: `const PLANS` — 1 month 500 / 2 months 900 (+ partner rewards); Forever = AMH_PRICE_ETB
- `tools/telegram-worker/src/worker.js` :: `const EVENT_NAMES` — allowed panel telemetry steps
- `tools/telegram-worker/src/worker.js` :: `const ERROR_LABELS` — error names in admin stats
- `tools/telegram-worker/migrations/0029_trial_week.sql` :: — latest migration (new ones: next number; migrate BEFORE deploy)
- `tools/telegram-worker/test/e2e.mjs` :: `function ok` — the bot test suite (strict fake Telegram)
- `tools/telegram-worker/wrangler.toml` :: `AMH_PRICE_ETB` — Forever price

## Build, CI, release
- `.github/workflows/build.yml` :: `test_host_pick.js` — all tests, builds, mac-smoke, publish (on main)
- `tools/build_win.ps1` :: `metrics.json` — Windows zip (copies fonts, amh_styles.py)
- `tools/build.sh` :: `metrics.json` — Mac zips
- `tools/check_versions.sh` :: — the 5 version places agree

## Tests (run what you touched — tools/agent/test.py does it for you)
- `tools/test/test_panel_dom.js` :: `4g. customize` — panel UI (needs a runtime/ junction)
- `tools/test/test_styles.py` :: `glide: the pill slides` — styles (real ffmpeg if AMH_FFMPEG)
- `tools/test/test_host_pick.js` :: `nothing selected` — which clip is used
- `tools/test/test_host_overlay.js` :: — styled layer placement
- `tools/test/test_app.py` :: — desktop app bridge
- `tools/test/amharic_regression.py` :: — engine output unchanged (~6 min)
