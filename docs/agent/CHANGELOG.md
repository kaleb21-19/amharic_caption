# Agent change-log (newest first)

One dated line per task the agent finished: what changed, version, PR.
Older than ~3 months: summarize into one line per month.

- 2026-10-14 — 1.16.5: panel update experience. A "What's new" card shows once on the first open after a version change (never on a first install; ✕ or "Try it", which jumps to the review's style strip); the update banner now says what the update brings + "your license stays the same" and its Download button opens the website's download section (`/install/#download`) instead of the new-user install steps — also for an answer already stored by an older panel; new "↻ Check for updates" in the footer forces a lookup and answers next to it (up to date / new version / no internet). Per-release text lives in one list, `WHATS_NEW` in panel/js/main.js. Website: the install page's download section now tells existing owners that installing over their copy keeps the license. Tests: test_panel_dom 16b/16c/16d + an i18n key-coverage check; all 13 suites pass. Bumped 1.16.4 → 1.16.5.
- 2026-10-14 — 1.16.4: the trial/price story is one story again — website (page.jsx step 1, layout.jsx meta, legal EULA §3), in-zip START HERE.html, the promo library (POSTS.md, selling.md) and the bot's hand-set /setdescription text said "2 captions free" / "20 minutes"; all now 30 minutes + "from ETB 500 a month or ETB 2,500 once". New guard test tools/test/test_trial_texts.py. Bumped 1.16.3 → 1.16.4 (1.16.3 was already published by PR #126).
- 2026-10-14 — 1.16.3: bot/website said "20 minutes free" everywhere while the live D1 setting is 30 — worker.js now reads trialTerms(settings).minutes instead of a fixed 20 (welcome, FAQ, group FAQ, quiet-buyer nudge); website texts set to 30. Panel already showed the live number.
- 2026-10-14 — Claude side: CLAUDE.md start/end routine, .claude/agents/selam.md (Haiku, read-only Q&A), skills amh-problem-report / amh-release / amh-customer-message. No version.
- 2026-10-14 — Selam agent created: PROJECT_MAP / DECISIONS / GOTCHAS, tools/agent scripts (facts, map_check, bump, release_state, test). No version.
- 2026-10-13 — 1.16.2: clip without sound -> audio tracks first + clear message (err_no_audio).
- 2026-10-13 — 1.16.1: preview = caption strip, Customize closed by default, review fits small screens.
- 2026-10-13 — 1.16.0: Glide / Spotlight / Bounce (self-placed words, fonts/metrics.json).
- 2026-10-13 — 1.15.0: 8 entrance animations. 1.14.x: 4 Amharic fonts, My styles id fix.
