# Instructions

Read and follow **AGENTS.md** at the repository root before doing anything. It is the single handbook for every AI working on this project: the product, the owner's decisions, the branch -> test -> PR flow, the release rules and the safety rules. If this file and AGENTS.md ever disagree, AGENTS.md wins.

## Start every task cheaply

1. `python tools/agent/facts.py` — version, prices, styles, fonts (do not open big files for these).
2. @docs/agent/DECISIONS.md and @docs/agent/GOTCHAS.md are the owner's decisions and our lessons learned: obey them.
3. Find code through `docs/agent/PROJECT_MAP.md` (file :: symbol); read only the lines around the symbol. Never read `panel/js/main.js` or `tools/telegram-worker/src/worker.js` whole.
4. Use the scripts instead of manual steps: `tools/agent/test.py <area|all>`, `tools/agent/bump.py X.Y.Z`, `tools/agent/release_state.py`, `tools/agent/map_check.py`.
5. Questions about the project ("where is…", "how does… work", "what is the price…") -> the `selam` subagent answers them cheaply.
6. Repeated jobs: `/amh-problem-report`, `/amh-release`, `/amh-customer-message`.

## End every task

Add one line to `docs/agent/CHANGELOG.md`; new trap -> one line in `GOTCHAS.md`; owner decision -> `DECISIONS.md`; moved code -> `PROJECT_MAP.md` and `map_check.py` must say FRESH. Same PR.

## Talking to the owner

Kaleb writes short English/Amharic. Answer short and plain, result first, tables over paragraphs. Customer texts: Amharic first, then English, polite form (እርስዎ). Never send, post or merge for him.
