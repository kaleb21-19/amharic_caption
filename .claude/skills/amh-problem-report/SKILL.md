---
name: amh-problem-report
description: Handle a "🆘 Problem report" (or a customer's error screenshot) for Amharic Captions Pro - find the cause, fix it with a test, ship it as the next version, and write the customer reply. Use when the owner pastes a problem report or an error from a customer.
---
# Problem report -> fix -> reply

1. **Read the report, not the code.** Note: version, host (PPRO/AEFT/app), OS, RAM, trial/licence, error type (`err_...`), the log tail. Never repeat IPs, keys or full Machine IDs (first 6 characters only).
2. **Find the cause cheaply.** Error type -> `docs/agent/PROJECT_MAP.md` (`errorStep` / `humanError` / the area), then grep the error text. Check `docs/agent/GOTCHAS.md` - it may be known.
3. **Explain it to the owner first** in 2-3 plain lines: what happened, why, who else it can hit.
4. **Fix on a new branch** from fresh origin/main (`fix/<short-name>`):
   - the real cause, and a clear Amharic + English message if the user can do something;
   - a test that fails on the old code and passes now (prove it: run it before and after);
   - `python tools/agent/release_state.py` then `python tools/agent/bump.py <next>`;
   - `python tools/agent/test.py <areas touched>` (and `all` when unsure).
5. **Ship:** push the branch; for a full Windows+Mac build force-push it to `ci/build-1.10.20`; give the PR link.
6. **Customer reply** for the owner to send (he sends it, not you): Amharic first, then English, polite form; what happened in one line, what to do now, the new version if it fixes it, ask for a screenshot if not fixed. Say if their free minutes were not used (check first).
7. **Notes:** one CHANGELOG line; a GOTCHAS line if it was a new kind of trap.
