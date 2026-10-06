## What and why
<!-- One or two sentences: the customer/owner problem and what this changes. -->

## Areas touched
- [ ] Panel (`panel/`)   - [ ] Desktop app (`app/`)   - [ ] Engine (`*.py`)   - [ ] Licensing
- [ ] Installers / build   - [ ] Bot (`tools/telegram-worker/`)   - [ ] Website   - [ ] CI / docs

## Tests run (AGENTS.md §6) — command → result
<!-- e.g. node tools/test/test_panel_dom.js → ALL PASS (34/34) -->
-

## Not tested / risks
<!-- Be honest: what could not be run here (real Adobe app, Mac, live bot) and why. -->
-

## Release
- Version: <!-- X.Y.Z, or "none (no zip change)" -->
- [ ] Version bumped in all five places (`bash tools/check_versions.sh`) — only if the customer zip changes
- [ ] No other open PR carries this version
- Deploy after merge: <!-- none / bot: npm run migrate then npm run deploy / website: automatic -->

## Checklist (AGENTS.md §11)
- [ ] Only the needed files; no `runtime/`, `dist/`, secrets, local paths
- [ ] New behaviour / bug fix has a test
- [ ] Customer-facing text in Amharic + English
- [ ] TESTING.md / AGENTS.md updated if the flow changed
