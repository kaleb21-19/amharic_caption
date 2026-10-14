# Agent change-log (newest first)

One dated line per task the agent finished: what changed, version, PR.
Older than ~3 months: summarize into one line per month.

- 2026-10-14 — 1.16.4: the trial/price story is one story again — website (page.jsx step 1, layout.jsx meta, legal EULA §3), in-zip START HERE.html, the promo library (POSTS.md, selling.md) and the bot's hand-set /setdescription text said "2 captions free" / "20 minutes"; all now 30 minutes + "from ETB 500 a month or ETB 2,500 once". New guard test tools/test/test_trial_texts.py. Bumped 1.16.3 → 1.16.4 (1.16.3 was already published by PR #126).
- 2026-10-14 — 1.16.3: bot/website said "20 minutes free" everywhere while the live D1 setting is 30 — worker.js now reads trialTerms(settings).minutes instead of a fixed 20 (welcome, FAQ, group FAQ, quiet-buyer nudge); website texts set to 30. Panel already showed the live number.
- 2026-10-14 — Claude side: CLAUDE.md start/end routine, .claude/agents/selam.md (Haiku, read-only Q&A), skills amh-problem-report / amh-release / amh-customer-message. No version.
- 2026-10-14 — Selam agent created: PROJECT_MAP / DECISIONS / GOTCHAS, tools/agent scripts (facts, map_check, bump, release_state, test). No version.
- 2026-10-13 — 1.16.2: clip without sound -> audio tracks first + clear message (err_no_audio).
- 2026-10-13 — 1.16.1: preview = caption strip, Customize closed by default, review fits small screens.
- 2026-10-13 — 1.16.0: Glide / Spotlight / Bounce (self-placed words, fonts/metrics.json).
- 2026-10-13 — 1.15.0: 8 entrance animations. 1.14.x: 4 Amharic fonts, My styles id fix.
