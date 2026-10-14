# GOTCHAS — lessons learned the hard way (read before you start)

One line each: what happens -> what to do. Add a line when you hit something
new; merge duplicates; keep < 80 lines.

## Release / CI
- "release tag vX already points at ..." -> X was published by an earlier merge. New branch from origin/main + `python tools/agent/bump.py <next>`. Check first: `python tools/agent/release_state.py`.
- New `ci/build-*` branches do NOT start build-zips (paths-ignore) -> force-push the work to the existing `ci/build-1.10.20` branch to get a full Windows+Mac build.
- A merge without a version bump ends red at "Stage verified packages" -> expected, harmless.
- GitHub API without login is rate-limited -> poll at most every 150 s.

## Shell / files (Windows)
- Bash heredocs collapse `\\` to `\` (and `\a`, `\1`, `\f` become control characters) -> write files with a file-write/edit tool, never `cat <<EOF` when backslashes matter. After big edits: grep for control characters.
- PowerShell 5.1: no `&&`; use `;` and `if ($?)`. Use `npm.cmd` / `npx.cmd`.
- Run Python on downloaded or scratch files with `python -I`; `-I` also ignores PYTHONIOENCODING -> call `sys.stdout.reconfigure(encoding="utf-8")` before printing Amharic.
- Long scratch paths break the bundled Python (MAX_PATH) -> work under a short `%TEMP%\...` folder.
- `.cmd` files stay CRLF; `.command` / `.sh` stay LF. Never put `)` inside an `if (...)` echo in .cmd.

## Tests
- `test_panel_dom.js` needs `runtime/` -> `tools/agent/test.py panel` makes a junction to the main clone's runtime and removes ONLY the junction. Never delete the main clone's `runtime/` folder.
- Tests must never touch `~/.amharic_captions_license.json` / `~/.amharic_captions_machine.json` (a test once overwrote the owner's real license).
- dom_shim: `className` and `classList` are not synced -> assert on `className`; objects from the vm need JSON comparison.
- Headless Edge screenshots: minimum window ~500 px wide -> put the page in a fixed-size box and crop.
- ffmpeg cannot decode animated WebP -> for frame checks render previews as GIF (`A._has_encoder = lambda f, n: False`).

## Product behaviour
- A clip with no sound -> ffmpeg "Output file does not contain any stream" -> err_no_audio (clear message). Premiere picks audio-track clips first.
- libass `\move` cannot ease -> smooth moves use a tiny `\frz` turn around a far `\org` (see amh_styles `_glide_tags`).
- libass fakes bold on variable fonts -> ship static Regular/Bold files.
- CEP CSP allows `img-src 'self' data:` only -> show generated images as data: URIs.
- The desktop app bridge `readFileSync` is text-only -> use `readBase64` for images.
- worker.js bot texts hardcoded "20 minutes" instead of reading the live `trial_free_minutes` setting -> when a setting changes, grep the literal old value across worker.js AND website/*.jsx, do not assume one fix covers every copy.
