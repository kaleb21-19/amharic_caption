# AGENTS.md — handbook for every AI (and human) working on Amharic Captions Pro

**Read this whole file before you change anything.** Every assistant on this
project — Claude, Codex, Gemini, Copilot, Cursor or a person — follows the same
flow, so nobody breaks what customers already depend on. If something here is
unclear or wrong, say so in your report; do not quietly work around it.

The **owner** is Kaleb Tegegen (GitHub `kaleb21-19`). He writes in English and
Amharic mixed, often short; answer in plain, simple English (Amharic for
anything a customer will read). One AI acts as **manager**: it hands out tasks
with the brief in §10 and reviews the reports. Other AIs do one task each.

---

## 0. The ten rules (if you remember nothing else)

1. **Never push to `main`.** One task = one branch from fresh `origin/main` = one pull request. The owner merges.
2. **Run the tests for every area you touched** (§6), and say exactly which ones you ran and their result. Never claim "tested" for something you did not run.
3. **Real customers use this.** Licenses, payments, trials and the Telegram bot handle real money. Do not change their behaviour unless the task says so.
4. **Amharic output must not change by accident.** Any engine/decoding change: `amharic_regression.py` must print `AMHARIC UNCHANGED` (or every changed golden is an explained improvement), and nothing may slow transcription (§7).
5. **One release version = one PR.** Any change that ships in the customer zip needs a version bump, and two open PRs must never carry the same version (§5).
6. **Never delete or rewrite real data** — customer DB rows, licenses, the owner's files. Read-only queries are fine; anything destructive is prepared as SQL + backup and **the owner runs it**.
7. **Never commit secrets** (tokens, keys, PINs, `.dev.vars`). They live in Cloudflare (`wrangler secret`) and GitHub secrets.
8. **Never act in the owner's name**: no posting, messaging customers, broadcasting, publishing or merging. Prepare the text; the owner sends it.
9. **Tests must never touch the real computer's identity**: `~/.amharic_captions_license.json`, `~/.amharic_captions_machine.json`. Use temp homes (`AMH_MACHINE_HOME`). (A test once overwrote the owner's real license.)
10. **When unsure, stop and ask** the manager/owner instead of guessing — especially before anything irreversible.

---

## 1. What the product is

Amharic Captions Pro turns Amharic speech in a video into editable captions,
**fully offline** on the editor's computer. Sold to Ethiopian video editors:
ETB 2,500 one-time, bank transfer, through a Telegram bot; 2 free captions per
computer. Windows + macOS (Apple silicon and Intel).

| Part | What it is | Where |
|---|---|---|
| Panel | Adobe CEP panel for **Premiere Pro** and **After Effects** 2022+: transcribe → review/edit → place on the timeline | `panel/` (`js/main.js`, `js/core.js`, `js/i18n.js`, `jsx/host.jsx`, `jsx/host_ae.jsx`) |
| Desktop app | The **same panel code** in its own window (pywebview) for **CapCut / DaVinci Resolve**: drag a video in, review with video preview, Save SRT. Opened by the "Make Amharic Captions" shortcut | `app/` (`amh_app.py` server + `node_shim.js` stand-in for CEP's Node + `app_mode.js` UI swaps) |
| SRT maker | Console fallback when the app cannot open a window | `amh_standalone.py` |
| Engine | Hohe CTC model (CTranslate2 int8, pinned in `tools/model.lock`), word-aware decoder, Amharic corrections, VAD, background-voice filter, speakers | `ethio_srt.py`, `amh_*.py`, `ctc_beam.py` |
| Licensing | Machine ID, server-signed ECDSA lease, trials, activation codes (XXXX-XXXX) | `amh_license.py` (Python side), panel `main.js` (JS side) |
| Bot + license server | Cloudflare Worker + D1: sales, approval, keys, codes, trials, admin dashboard, support group helper, jobs feed | `tools/telegram-worker/` (`src/worker.js`, `migrations/`, `test/e2e.mjs`) |
| Website | Next.js on Vercel (auto-deploys from `main`) | `website/` |
| Installers / builds | `Install.cmd` (Windows), `Install.command` (Mac), Lite/Full zips | `tools/installers/`, `tools/build_win.ps1`, `tools/build.sh`, `tools/prepare_python.sh` |
| CI / release | Tests, accuracy gate, builds, **real-Mac install test**, publish | `.github/workflows/build.yml`, `mac-smoke.yml` |

Live: website https://amharic-caption-pro.vercel.app · bot @AmharicCaptionsBot ·
support group @AmharicCaptionsPro · owner support @sumpak6 · license API
`https://amharic-captions-bot.amhcaps.workers.dev`.

Deeper docs: **`TESTING.md` Part A** (every test, CI, accuracy numbers, manual
checks), `README.md`, `tools/telegram-worker/DEPLOY.md`, `tools/MODEL_HOSTING.md`.

---

## 2. Owner decisions — do not re-propose without asking

- **No model training / fine-tuning** (GPU, Kaggle, collecting customer corrections for training). Improvements come from decoding, rules, word lists — measured.
- **Nothing may slow transcription.** Time any added engine code.
- No find & replace / search box in the review (rejected). Fix-a-word → "Change all (N)" / "🧠 Always fix" is the design. Nothing persistent above the caption list; hints hide after use.
- No Telebirr / Chapa payments. Bank transfer through the bot only.
- Partners / referrals: exist, owner-controlled (`/partner…`, referrals OFF by default).
- Product language: **Amharic first**, English second, in the UI and in every customer message.
- New languages (Oromo, Tigrinya, …) only as an **optional download**, measured first, Amharic untouched.

---

## 3. Repository map (where to look)

```
panel/            CEP panel: index.html, js/{main,core,i18n,CSInterface}.js, jsx/, CSXS/manifest.xml, test/
app/              desktop app: amh_app.py, node_shim.js, app_mode.js, app.css
*.py (root)       engine + SRT maker + licensing (shipped inside runtime/)
tools/test/       all automated tests (see §6)
tools/installers/ Install.cmd / Install.command / Make Amharic Captions.(cmd|command) / START HERE.html
tools/telegram-worker/  bot + license server (src/worker.js, migrations/NNNN_*.sql, test/e2e.mjs)
website/          Next.js site (app/, components/, lib/site.js)
.github/workflows/ build.yml (CI + release), mac-smoke.yml (on-demand Mac check)
TESTING.md        how we test (Part A = current)
```
`runtime/`, `dist/`, `tools/stage/` are local build output — never commit them.

---

## 4. The flow for every task

1. **Understand** the brief (§10). Read the code you will touch and the tests that cover it. If the task conflicts with §0/§2, stop and ask.
2. **Branch** from a fresh `origin/main`. Prefer a separate worktree so you never disturb another agent's checkout:
   ```bash
   git fetch origin
   git worktree add -b <type>/<short-name> ../wt_<short-name> origin/main
   ```
   Branch types: `feature/`, `fix/`, `docs/`, `ci/`, `chore/`.
3. **Change** the smallest thing that does the job. Match the surrounding style and comment density. Customer-facing text: Amharic + English.
4. **Test** — every area you touched (§6), plus a real check where possible (run the app/panel, the bot suite's strict fake Telegram, `mac_smoke.py`, a browser preview of the website).
5. **Version** — bump only if the change ships in the customer zip (§5).
6. **Commit** with a message that says *why* (the problem seen), *what* changed and *how it was verified*. One logical change per commit.
7. **Bring main in** if it moved: `git merge origin/main` (or rebase if nothing is pushed yet). Re-run the tests after a merge.
8. **Push** the branch and open a PR using the template (it asks for tests run, version, deploy steps). If `gh` is unavailable, give the owner the "compare" link `https://github.com/kaleb21-19/amharic_caption/pull/new/<branch>`.
9. **Report** to the manager/owner with the report format (§10). Plain words: what changed, what was tested, what is NOT tested, what the owner must do.
10. **After merge** (owner merges): check CI (§5), then the deploy steps if any (bot: `npm run migrate` *before* `npm run deploy`).

Several agents at once: the manager gives each one **non-overlapping files**.
If you must touch a file another open PR changes, say so in the report.

---

## 5. Versions, CI and releases

**Version bump needed** when anything in the customer zip changes: `panel/`,
`app/`, engine `*.py`, installers, `tools/prepare_python.sh`, build scripts.
Change all five places (or CI's version check fails):
`panel/CSXS/manifest.xml` (ExtensionBundleVersion + Extension Version),
`panel/index.html` (`panelVersion`), `panel/js/main.js` (`APP_VERSION`),
`tools/test/test_panel_dom.js` (version assertion). Check: `bash tools/check_versions.sh`.

**No bump** for bot-only, website-only, docs, tests, CI changes.

**CI on every push to `main`** (`build.yml`): model fetch → version check → all
tests → website build → accuracy gate (real-golden WER ≤ 40 %) → Windows + Mac
builds → **mac-smoke** (installs each Mac package on real Apple-silicon and Intel
Macs and uses it) → **publish** (only if everything passed).

Rules that matter:
- **Merge one release PR at a time** and let it publish before the next version merges. Two merges with the same version: the first publishes, the second is refused — its fixes never reach customers (this happened; fix = cancel the first run, or bump again).
- A merge **without** a bump ends with a red ❌ at "Stage verified packages in a commit-bound draft" — expected and harmless (version already published). Any *other* red step is a real failure.
- GitHub outage (jobs "cancelled"): open the run → **Re-run failed jobs**. Never re-run an old, superseded run.
- Re-check any published version on a Mac: Actions → **mac-smoke** → Run workflow.
- Results without logging in: job steps and annotations are readable through the public API (`/actions/runs/<id>/jobs`, `/check-runs/<id>/annotations`); job logs need login.

---

## 6. Tests — run what you touched

Python for tests = the product's bundled Python (has numpy, ctranslate2,
onnxruntime): Windows `%APPDATA%\Adobe\CEP\extensions\com.amharic.captions\runtime\python\python.exe`,
Mac `~/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/python/bin/python3`.
Full details and timings: `TESTING.md` §A2.

| You touched | Run |
|---|---|
| `panel/js/*`, `panel/index.html` | `node tools/test/test_panel.js` · `node tools/test/test_panel_dom.js` (needs a placeholder `runtime/` — TESTING.md; not an installed Lite runtime) · `node panel/test/host-safety.test.mjs` · `node panel/test/machine-id.test.mjs` |
| `panel/jsx/*` | `node tools/test/test_host_captions.js` · `node tools/test/test_host_ae.js` |
| `app/*` | `python tools/test/test_app.py` · `node tools/test/test_app_shim.js` · `python3 tools/test/mac_smoke.py --app-from app` (uses the installed product; opens a window briefly) |
| engine `*.py`, decoding, corrections | the self-checks (`ctc_beam.py`, `amh_decode.py`, `amh_correct.py`, `amh_lm.py`), `test_long.py`, `test_background.py`, `test_diarize.py`, **`amharic_regression.py`** (~6 min, must say `AMHARIC UNCHANGED`), and WER on FLEURS/WAXAL for any accuracy claim |
| `amh_standalone.py`, `amh_license.py` | `tools/test/test_standalone.py` (needs model + ffmpeg) |
| installers `.cmd` | `python tools/test/test_cmd_syntax.py` (cmd.exe parse traps), keep CRLF |
| `tools/telegram-worker/*` | `cd tools/telegram-worker && node test/e2e.mjs` (145+ checks, strict fake Telegram: any message Telegram would refuse fails) |
| `website/*` | `npm run build` in `website/`, then look at it (desktop + phone width) |
| `.github/workflows/*` | validate YAML; prove it in a run (workflow_dispatch or a `ci/` branch for new workflows) |

Add a test for every bug you fix and every behaviour you add, in the suite of
that area. A test that needs the real model/Adobe/a Mac and cannot run in CI
goes in TESTING.md §A5 (manual) — say so in the report.

---

## 7. Safety rules in detail

- **Engine**: measure before/after (FLEURS + WAXAL + CV, scripts in TESTING.md §A4). Time added code. Keep `tools/model.lock`; a new model needs conversion, benchmark and an explicit owner decision.
- **Licensing**: the server is the authority; the client only checks shape + the signed lease. Never weaken signature checks, never embed secrets in the panel/app (they are public).
- **Bot / D1**: new tables/columns = a new numbered migration in `tools/telegram-worker/migrations/`; deploy order is **`npm run migrate` then `npm run deploy`**. Read-only queries: `npx wrangler d1 execute amh_bot --remote --json --command "SELECT …"`. Never `DELETE`/`UPDATE` live data yourself.
- **Admin-only** features in the bot must refuse buyers (add a test).
- **The app's local server** (`app/amh_app.py`): 127.0.0.1 only, token + Host check on every API, media by unguessable URL. Do not open it up.
- **Customer privacy**: no personal data in URLs, logs or commits.
- **Owner's computer**: do not change his installed product or files except when the task is to fix his setup, and keep a backup of anything you overwrite.

---

## 8. Windows / tooling gotchas (seen in this project)

- Owner's shell: **PowerShell 5.1** — no `&&`; use `npm.cmd` / `npx.cmd`.
- **Shell heredocs can collapse `\\` to `\`** in some agent shells: write files that contain backslashes (JSON paths, regexes, `\n` in code) with a file-write tool, not `cat <<EOF`.
- `.cmd` files must stay **CRLF**; `.command`/`.sh` stay **LF** (`.gitattributes`). In `.cmd`, never put a `)` inside an `if (...)` block's echo/rem — it ends the block (broke the 1.8.9 installer); `test_cmd_syntax.py` catches it.
- Long scratch paths can exceed Windows MAX_PATH for the bundled Python: work under a short `%TEMP%\…` folder.
- Main checkout has a **real `runtime/` folder** (not in git) — never delete it; for tests create a junction in your own worktree and remove only the junction.
- Browser previews of the app/panel: background tabs pause muted video and animation frames — test with that in mind.

---

## 9. Talking to the owner

- Lead with the result: what works now, what he must do (merge link, deploy commands in their own code blocks), what is not tested.
- Short, plain, no jargon; a small table beats a long paragraph.
- Customer messages he will forward: **Amharic first, English after**, friendly, one clear action, ask for a screenshot when debugging.
- Be honest: if a screenshot shows something you cannot explain, say so and say what would tell you.

---

## 10. Templates

**Task brief (manager → agent):**
```
Task: <one sentence>
Why: <customer problem / owner request, with evidence (screenshot, message)>
Area & files you may change: <paths>   Do NOT touch: <paths>
Done when: <observable result>
Tests to run: <from §6> + new test for <behaviour>
Version bump: yes (to X.Y.Z) / no
Deploy after merge: none / bot (migrate? deploy) / website (auto)
Report back: the §10 report
```

**Report (agent → manager/owner):**
```
Result: <works / partly / blocked> — one sentence
Changed: <files + what, in plain words>
Tested: <command → result>, <manual check → result>
Not tested / risks: <…>
Version: <X.Y.Z or none>   PR: <link>
Owner to do: <merge link, deploy commands, customer message to send>
```

---

## 11. Definition of done

- [ ] Only the files the task needs; no stray `runtime/`, `dist/`, secrets, local paths.
- [ ] Tests for the touched areas pass; new behaviour/bug has a test.
- [ ] Customer-facing text in Amharic + English.
- [ ] Version bumped iff the zip changes; no other open PR uses that version.
- [ ] `TESTING.md` updated if how-to-test changed; this file updated if the flow changed.
- [ ] PR opened with the template filled; report sent.
