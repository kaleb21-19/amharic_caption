# GOTCHAS — lessons learned the hard way (read before you start)

One line each: what happens -> what to do. Add a line when you hit something
new; merge duplicates; keep < 80 lines.

## Release / CI
- "release tag vX already points at ..." -> X was published by an earlier merge. New branch from origin/main + `python tools/agent/bump.py <next>`. Check first: `python tools/agent/release_state.py`.
- New `ci/build-*` branches do NOT start build-zips (paths-ignore) -> force-push the work to the existing `ci/build-1.10.20` branch to get a full Windows+Mac build.
- A merge without a version bump ends red at "Stage verified packages" -> expected, harmless.
- A fix release needs NO `WHATS_NEW` entry (since 1.16.7 the card shows the newest news not yet seen); add an entry only when a release brings news. Keep the banner's "ፈቃድዎ እንደቀድሞው ይቀጥላል" wording (test 16 pins it). Tests 16d check the NEWEST entry (`WHATS_NEW[newsVersion()]`), never a fixed text - adding news must not break them.
- GitHub API without login is rate-limited -> poll at most every 150 s.

## Shell / files (Windows)
- The write tool writes UTF-8 **with a BOM** -> Python's `json.load` / `open(encoding="utf-8")` then fails with "Unexpected UTF-8 BOM". Strip it: `[IO.File]::WriteAllText($p, $t, (New-Object Text.UTF8Encoding($false)))` (the panel's own job.json has no BOM - Node writes it).
- Bash heredocs collapse `\\` to `\` (and `\a`, `\1`, `\f` become control characters) -> write files with a file-write/edit tool, never `cat <<EOF` when backslashes matter. After big edits: grep for control characters.
- PowerShell 5.1: no `&&`; use `;` and `if ($?)`. Use `npm.cmd` / `npx.cmd`.
- Run Python on downloaded or scratch files with `python -I`; `-I` also ignores PYTHONIOENCODING -> call `sys.stdout.reconfigure(encoding="utf-8")` before printing Amharic.
- Long scratch paths break the bundled Python (MAX_PATH) -> work under a short `%TEMP%\...` folder.
- `.cmd` files stay CRLF; `.command` / `.sh` stay LF. Never put `)` inside an `if (...)` echo in .cmd.
- Next.js build inside a worktree needs its own `node_modules`: a junction fails under Turbopack ("symlink ... points out of the filesystem root") -> build with `npx.cmd next build --webpack`, then delete `.next` and remove the junction with `cmd /c rmdir` (never `Remove-Item -Recurse` on a junction — it empties the target).
- `tools/agent/test.py all` runs the versions suite with `bash` -> in plain PowerShell this dies with "CreateProcess ... FileNotFoundError"; prepend Git's bin: `$env:PATH = "C:\Program Files\Git\bin;" + $env:PATH`.

## Tests
- `test_panel_dom.js` needs `runtime/` -> `tools/agent/test.py panel` makes a junction to the main clone's runtime and removes ONLY the junction. Never delete the main clone's `runtime/` folder.
- Tests must never touch `~/.amharic_captions_license.json` / `~/.amharic_captions_machine.json` NOR the real `~/Documents/AmharicCaptions` (test_panel_dom sets AMH_CAPTIONS_DIR to a temp folder and checks the real one at the end; a test once overwrote the owner's real license, and tests filled his Recent list).
- dom_shim: `className` and `classList` are not synced -> assert on `className`; objects from the vm need JSON comparison. Static `data-i18n` labels are NOT applied (no attribute selectors) -> assert those via `evalVm("AM_STATIC['<key>']")`.
- Headless Edge screenshots: minimum window ~500 px wide -> put the page in a fixed-size box and crop.
- ffmpeg cannot decode animated WebP -> for frame checks render previews as GIF (`A._has_encoder = lambda f, n: False`).

## Product behaviour
- The panel always works in a FRESH temporary .srt (`amh_captions_<Date.now()>.srt`, same for `amh_sequence_`/`amh_file_`) -> never key anything that must survive a run (client links, caches) on that path; use the clip / video / sequence name.
- After cutting, Premiere's selection also holds titles / captions / nested sequences (no media file) -> pick the first selected clip that HAS a media path (host.jsx findSelected).
- A video file with no audio stream but the voice on A1 -> host sends `audioAlt` (audio clip under the same timeline range); runSelectedClip retries with it on the no-audio error (extraction runs BEFORE the trial charge, so the failed try costs nothing).
- Our own styled caption layers (`amhstyle_*.mov`, no sound) sit ABOVE the footage -> never pick them as the clip to listen to (host.jsx `amhListenPath`); with nothing selected the playhead found the Glide layer first (owner report 1.16.8).
- The editor's timeline can be a NESTED sequence (no media path): single-clip mode must look inside it like Work Area (`amhCollectClips` over the clip's timeline range) - otherwise "No clip found" (owner, 1.16.9).
- After Effects: `amhAeFootagePath` is null for a precomp layer (source is a CompItem), so any host loop that only takes layers with a path silently misses a comp built from precomps -> open precomps (Whole comp / Work Area too, not only the single-clip pick) with the SAME shift mapping, or the user gets "no clips" (1.16.16).
- A clip with no sound -> ffmpeg "Output file does not contain any stream" -> err_no_audio (clear message). Premiere picks audio-track clips first.
- Premiere on Apple Silicon shows QuickTime Animation (qtrle) overlays as smeared streaks (customer screenshot 1.16.7) -> Mac overlays are ProRes 4444 + alpha (`_overlay_codec`); Windows keeps qtrle. CI on Mac requires ProRes.
- Styled-layer "replace" must only take layers MOSTLY inside the new time range: cut parts of one video share the name prefix and sit back to back (owner, 1.16.12).
- `removeTempCaptionArtifact` deletes ANY `amh_review_*` file, also in Documents -> never make the linked .srt the review file (Recent reopens on an `amh_reopen_*` temp copy). Tests must redirect `ensureCaptionsDir` to a temp folder (default = the real Documents/AmharicCaptions).
- libass `\move` cannot ease -> smooth moves use a tiny `\frz` turn around a far `\org` (see amh_styles `_glide_tags`).
- libass fakes bold on variable fonts -> ship static Regular/Bold files.
- CEP CSP allows `img-src 'self' data:` only -> show generated images as data: URIs.
- The desktop app bridge `readFileSync` is text-only -> use `readBase64` for images.
- One changed setting = one stale text somewhere. A customer-visible number lives in worker.js, website/*.jsx, the in-zip tools/installers/START HERE.html AND the bot's hand-set profile (DEPLOY.md `/setdescription`, `/setabouttext`) -> grep the literal old value in all four and update the bot profile by hand. tools/telegram/bot.py is DECOMMISSIONED (DEPLOY.md) - never "fix" its texts.
- The dev/worktree runtime's `bin/ffmpeg.exe` can be a 0-byte placeholder: a test that needs real ffmpeg must find a working one (`-version` exit 0 AND output says "ffmpeg version": on Linux CI the placeholder is an EMPTY +x file, which runs as a blank shell script and exits 0), never silently skip. (2026-10-17, 1.16.19 test 4k)
- Any "is this the right sequence/clip" check in host.jsx must look INSIDE nested sequences (amhNestedSequence) - the owner edits with nested sequences (1.16.10, 1.16.21).
- host.jsx: every clips[k] / tracks[k] read crosses the CEP bridge (slow in real Premiere). Never walk whole tracks inside a per-cut/per-item loop - binary search the time-ordered clips (amhCleanupFirstAfter). test_host_cleanup counts READS. (1.16.22)
- The dev runtime's python.exe (like bin/ffmpeg.exe) can be a 0-byte placeholder - running it prints NOTHING and exits 0, so an engine test 'passes' silently. Use the installed panel's Python (%APPDATA%/Adobe/CEP/extensions/com.amharic.captions/runtime/python) and AMH_MODEL_DIR = the model whose model.bin matches tools/model.lock (%LOCALAPPDATA%/AmharicCaptions/models/4df80292bfb7). (1.16.26)
- A NEW engine sidecar file (<srt>.X.json) must also go into amh_standalone.drop_sidecars: the SRT maker writes the .srt NEXT TO THE CUSTOMER'S VIDEO and only the .srt may stay (test_standalone check 1, run on CI's Macs by mac-smoke). Locally: PATH += installed panel runtime/bin, PYTHONIOENCODING=utf-8, AMH_MODEL_DIR = locked model, then the installed panel's Python -s tools/test/test_standalone.py. (1.16.26)
- Studio ducking: the strength comes from sidechaincompress `mix` (the duck amount), NOT the ratio - with a high ratio + low threshold the depth barely changes with ratio. To measure the music under the voice, subtract a voice-only render (amerge + pan c0-c2); a band-pass on the music's notes also catches the voice. A hidden browser pane never runs requestAnimationFrame, so the editor's play loop (and the music preview) only runs with the pane visible or in headless shoot.js.
- ffmpeg xfade refuses inputs with different time bases: concat outputs 1/1000000, colour sources 1/fps - after a concat that feeds an xfade add settb=1/fps (studio_edit_core editGraph). Test edits that MIX plain cuts and transitions, not only all-transition chains.
- The Studio dev server (amhexp/studio_dev.py) runs the INSTALLED product's runtime (amh_styles.py etc.), not the branch's: a new amh_styles mode fails there ('Output file does not contain any stream' for c.ass). For a live test, override in the page: window.runtimePath = (n) => n === 'amh_styles.py' ? '<worktree>/amh_styles.py' : orig(n) (lost on reload). Releases ship both together.
- To run the BRANCH against the owner's installed model/runtime without touching his product: make a folder of junctions (`cmd /c mklink /J` for dirs, `/H` for files) to the installed runtime's parts and copy only the changed .py into it; the app takes it with `--ext <that folder>` (the app looks for `<ext>/runtime`). The desktop app needs the INSTALLED runtime's python (it has pywebview), not the system one.
- The caption templates (1.66): the editor's font option wins over the template's font only when it DIFFERS, so the panel must start a template on its own font (TEMPLATE_FONTS in panel/js/main.js). The panel's list and the engine's catalogue must stay in step - test_templates.py compares them (ids, names, fonts, the picture file).
- `build()` groups words by COUNT and by pauses over `GAP_HOLD` (0.6 s): a dev fixture or gallery that passes whole SENTENCES as "words" gets one giant caption (the style gallery did until 1.66) -> pass word timings, and space two sentences more than 0.6 s apart.
- A stacked look (`rows: 2`) draws the second line as its OWN event: its word redraws must use `_cont(t - that_row's start)`, not the phrase start, or the entrance restarts and the line jumps. Test both lines with pixels, not just the script.
- Testing typing: the browser tools' 'type' action inserts text WITHOUT keydown events (Amharic typing never sees it) - press keys one by one with 'key'. Headless/background pages may not fire focus events for el.focus(), so UI shown on focus must also show on click/key.
- Premiere ProjectItem.setInPoint / setOutPoint: the scripting guide says in = ticks but out = seconds. Never trust one unit: set, read back with getInPoint().seconds, try the other (host.jsx amhSetRange), and check the placed clip's length.
- host.jsx functions called through amhGuard must RETURN a JSON string (amhOk / amhErr / JSON.stringify) - a plain object reaches the panel as "[object Object]".
- Font sizes: libass scales a font by usWinAscent+usWinDescent, a browser (CSS) by unitsPerEm. Any HTML preview of libass text must multiply by upm / (winAscent+winDescent) (metrics.json 'upm' / 'em'; Studio E.fontInfo().css) - Noto 0.734, Menbere 0.581, Senamirmir ~1.0. Never compare 'em' in metrics.json with unitsPerEm: it IS winAscent+winDescent.
- New fonts: only OFL; fonts with Reserved Font Names (Abyssinica, Senamirmir) ship unmodified - no subsetting, no renaming, no static instances. Verify Ethiopic coverage and draw a sample sheet before adding.
- Studio live captions (JASSUB): the page CSP needs 'wasm-unsafe-eval' (amh_app adds it to the APP page only). npm packages that are CommonJS (throughput) or GPL (rvfc-polyfill) must not go into app/vendor - stub them (tools/vendor_jassub.py). In headless tests give file paths with FORWARD slashes: a heredoc swallows the backslashes of 'C:\\Users\\...' and the failure looks like a product bug.
