# PROJECT_MAP — where things are (read this instead of searching)

Each line: `file` :: `symbol` — what it is. `python tools/agent/map_check.py`
checks every file and symbol still exists (FRESH / STALE). Update a line in
the same PR that moves or renames the code. Keep this file under ~120 lines.

## Panel (Premiere / After Effects, CEP) — panel/
- `panel/js/main.js` :: `function openReview` — the review screen opens (captions list, style strip)
- `panel/js/main.js` :: `function placeReview` — "Place on timeline": plain captions or a styled layer (falls back to plain)
- `panel/js/main.js` :: `function renderStyleStrip` — style buttons (Plain, My styles, NEW mark, 18 styles, the Templates group)
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
- `panel/js/main.js` :: `WHATS_NEW` — per-release "What's new" text + the update banner's one-line summary (edit this for a new version)
- `panel/js/main.js` :: `function initWhatsNew` — the "What's new" card, once per version, never on a first install
- `panel/js/main.js` :: `function updateUrl` — where the banner's "Download" goes (the website's #download section)
- `panel/js/main.js` :: `function onUpdateCheck` — footer "Check for updates" (forces a lookup, answers in the footer)
- `panel/js/main.js` :: `function loadClients` — the per-client word lists (`~/.amharic_captions_clients.json`, this computer only, 0600)
- `panel/js/main.js` :: `function renderClientPanel` — the 👤 picker: choose/add a client, its words, import/export
- `panel/js/main.js` :: `function projectKey` — which project a client belongs to (clip / video / sequence name; a temp or generic name links nothing)
- `panel/js/main.js` :: `function setActiveClient` — the client of this project (auto from the project's own name, never guessed from the last one)
- `panel/js/main.js` :: `function applyClientWords` — a client's words into the captions as ONE undo step (out: `unapplyClientWords`)
- `panel/js/main.js` :: `function analyzeCleanup` — ✂ Clean up: pauses (footage loudness) + repeats/እ sounds (core.js findSilences/findRepeats/findFillers)
- `panel/js/main.js` :: `function applyCleanup` — cut on a copy (host amh_cleanupCut), captions + footage follow the cut
- `panel/js/main.js` :: `function applyZoom` — 🔍 Auto zoom: moments from core findZoomMoments -> host amh_autoZoom
- `panel/js/main.js` :: `function syncReviewSteps` — the review step bar ① Text ② ✂ ③ 🔍 ④ 🎨 ⑤ Place (✓ per finished step)
- `panel/js/main.js` :: `function refreshSourceLine` — the line under Source: what Generate would use, or what to do
- `panel/js/main.js` :: `function memoryRuleFor` — which store a green word came from (🧠 machine or 👤 client)
- `panel/js/main.js` :: `TEMPLATE_LIST` — the 13 caption templates the editor picks (1.66)
- `panel/js/main.js` :: `TEMPLATE_FONTS` — the font each template starts on (the editor can change it)
- `panel/js/i18n.js` :: `'NEW'` — Amharic UI strings (key = the English text)
- `panel/js/i18n.js` :: `'Templates'` — the Amharic name of the templates group
- `panel/index.html` :: `id="review"` — markup + all panel CSS (dark only)
- `panel/CSXS/manifest.xml` :: `ExtensionBundleVersion` — version (bump with tools/agent/bump.py)
- `panel/jsx/host.jsx` :: `function amharic_getSelectedClip` — which clip Generate uses (audio tracks first, then video)
- `panel/jsx/host.jsx` :: `function amh_placeOverlay` — styled layer on the first empty track above (Premiere)
- `panel/jsx/host.jsx` :: `function amh_cleanupPrepare` — ✂ checks + copy the sequence; then `amh_cleanupSome` cuts groups (razor + ripple, every track)
- `panel/jsx/host.jsx` :: `function amh_autoZoom` — Scale keyframes on the footage (Motion effect), on a copy; skips the editor's own animation
- `panel/jsx/host.jsx` :: `function amharic_getFrame` — sequence width/height/fps
- `panel/jsx/host_ae.jsx` :: `function amh_placeOverlay` — styled layer in After Effects (pure ASCII file!)
- `panel/jsx/host_ae.jsx` :: `function amhAeClipFrom` — the one precomp/comp time mapping (sourceIn/outer times); used by the single-clip pick and the whole-comp list
- `panel/jsx/host_ae.jsx` :: `function amhAeCollectInner` — every layer with sound inside a precomp (Whole comp / Work Area, 3 levels, own layers skipped)

## Desktop app (CapCut / DaVinci) — app/
- `app/app_mode.js` :: `saveSrt` — Save SRT (+ burned styled MP4 when a style is chosen)
- `app/amh_app.py` :: `readBase64` — local bridge op (127.0.0.1 + token only)
- `app/node_shim.js` :: `readBase64` — the fake CEP Node API the panel code uses in the app
- `app/studio.js` :: `function openExport` — Amharic Captions Studio shell: top bar, tabs, Export sheet, drop-and-go, timeline, keys, projects (design: docs/agent/STUDIO_DESIGN.md)
- `panel/js/core.js` :: `function regroupCues` — words per caption / line length after transcription, from the words' times
- `app/studio_script.js` :: `function fix` — Studio Script view: flowing text, selection bar (★ Pop · ✎ Fix · ▶ Play), word following playback
- `app/studio_cuts.js` :: `function renderClean` — Studio ✂ Clean up: tab, preview skip, red stripes, cleaned exports (non-destructive)
- `app/studio_edit.js` :: `function splitHere` — Studio editor: player of the edit, format canvas, multi-lane timeline, Media, Clip tab, undo/redo, export
- `app/studio_edit_core.js` :: `function syncBack` — the edit (clips), captions that follow it (deriveCaptions/syncBack), the export graph (tests: test_edit.js); `function soundChain` — music, ducking, clean voice, loudness (1.23.0)
- `app/studio_core.js` :: `function hitCaption` — Studio pure parts: timeline view maths, ruler, project files (tests: test_studio.js)
- `app/amh_app.py` :: `def peaks_from_raw` — the timeline's sound wave (bridge op "peaks"; the text bridge cannot carry binary)

## Caption styles engine
- `amh_styles.py` :: `def build` — words -> ASS script for a style (+ options)
- `amh_styles.py` :: `def options` — cleans Customize options (FONTS, ANIMS, SIZES, POSITIONS)
- `amh_styles.py` :: `def _modern` — Glide / Spotlight / Bounce (words placed by us from metrics.json)
- `amh_styles.py` :: `TEMPLATES` — the 13 caption templates: a look made of numbers (font, size, colours, outline, shadow, glow, box, gradient, mode, highlight, motion)
- `amh_styles.py` :: `def template` — a template's look with the defaults filled in (None for an unknown id)
- `amh_styles.py` :: `def _build_template` — the ASS script for a template (one code for every template)
- `amh_styles.py` :: `def _tpl_script` — draws one template (text, box, glow, gradient, arch, chips, the spoken word)
- `amh_styles.py` :: `def _entrances` — entrance animations (Auto keeps the style's own)
- `amh_styles.py` :: `def _caption_band` — preview = only the caption strip (480x160)
- `amh_styles.py` :: `def render` — ffmpeg/libass: overlay .mov (qtrle alpha), burn .mp4, preview .webp/.gif
- `tools/fonts/make_metrics.py` :: `def main` — rebuilds tools/fonts/metrics.json after a font change (needs fontTools)
- `tools/make_style_gallery.py` :: `def main` — renders every style + template to MP4 and writes the HTML gallery (the owner's look check); `--thumbs` writes panel/img/styles/<id>.jpg
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
- `tools/test/test_panel_dom.js` :: `3.12 review: 👤 client words` — per-client list: beats the 🧠 rule, never in the memory, import/export
- `tools/test/test_styles.py` :: `glide: the pill slides` — styles (real ffmpeg if AMH_FFMPEG)
- `tools/test/test_templates.py` :: `ALL PASS` — the templates: a clean script, the editor's options, the real drawing, the panel's list in step with the engine
- `tools/test/test_trial_texts.py` :: `ALL PASS` — the free trial is promised with ONE number everywhere (website, guide, panel, bot profile)
- `tools/test/test_host_pick.js` :: `nothing selected` — which clip is used
- `tools/test/test_host_overlay.js` :: — styled layer placement
- `tools/test/test_host_cleanup.js` :: — ✂ clean-up cut (copy, every track in sync, frame-exact)
- `tools/test/test_host_zoom.js` :: — 🔍 auto zoom keyframes (source time, own scale, never over the editor's animation)
- `tools/test/test_app.py` :: — desktop app bridge
- `tools/test/amharic_regression.py` :: — engine output unchanged (~6 min)
