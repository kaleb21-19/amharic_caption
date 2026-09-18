# Amharic Captions — Comprehensive Test Plan

Goal: make the caption product **unquestionable** by proving it works correctly across
every real scenario a user can hit. The two pillars:

1. **Transcription correctness** — the Amharic caption *text* must be accurate.
2. **Pipeline robustness** — every source, option, export, license, and failure path
   must behave correctly (no crashes, no missing timelines, no lost time.

---

## How to run the automated core tests (start here)

These validate the transcription engine and the pure-Python helpers **without needing
Premiere**. They run fully offline using the bundled runtime.

```bash
# Use the SAME bundled python the extension ships with:
PY="$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/python/bin/python3"

# 0) Panel logic tests (Node, no deps, offline — fastest, run first):
node tools/test/test_panel.js      # pure core helpers (SRT/export/speakers/license)
node tools/test/test_panel_dom.js  # main.js driven through a dom_shim inside vm

# 1) Self-checks that ship inside the runtime:
"$PY" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/ctc_beam.py"
"$PY" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/amh_correct.py"
```

### A. End-to-end transcription smoke test (offline, no Premiere)

This proves the whole engine works: WAV -> model -> text -> SRT.

```bash
PY=.../runtime/python/bin/python3
RT=.../com.amharic.captions/runtime
# needs a real Amharic speech WAV (16 kHz mono). See "Quality test set" below.
"$PY" "$RT/ethio_srt.py" /path/to/sample.wav /tmp/out_karaoke.srt --words --max-chars 42
"$PY" "$RT/ethio_srt.py" /path/to/sample.wav /tmp/out_grouped.srt --group 3 --max-chars 42

# Batch mode (work-area / whole-edit path):
printf '[{"wav": "/path/to/sample.wav", "offset": 0}]\n' > /tmp/req.json
"$PY" "$RT/ethio_srt.py" --batch /tmp/req.json /tmp/out_batch.srt --group 3
```

**Pass criteria:** non-empty SRT produced; timestamps increasing; no Python traceback;
Amharic text readable and matching the spoken audio.

---

## 1. Transcription-Quality Test Set (the "unquestionable" part)

ASR accuracy can only be proven with **real Amharic speech**. Build a small golden set
of audio files with known ground-truth text, then compare the engine output.

### 1.1 Build the golden set

Record or source 10–15 short clips (~3–20 seconds each) of clear Amharic speech,
covering:

| Tag | Content | Why |
|-----|---------|-----|
| `news` | news-style read speech, formal register | most common use; clear diction |
| `interview` | natural, conversational, overlapping slightly | speaker speed, disfluencies |
| `numbers` | contains digits, years, prices, phone numbers | number/transliteration accuracy |
| `names` | Ethiopian names + foreign names | proper-noun handling |
| `punct` | sentences with ? ! and long clauses | punctuation/sentence grouping |
| `short1` | a single 1-second utterance | min-duration path |
| `long5min` | a 5-minute continuous clip | long-audio + memory + SRT size |
| `silence` | mostly silence / no speech | blank-decoding path (must not crash) |
| `noisy` | speech with music/background noise | robustness |
| `fast` | very fast speaker | timing segmentation |

Each clip needs a **ground-truth transcript** (the exact lines). Save as
`tools/test/fixtures/<tag>.txt` next to `<tag>.wav`.

### 1.2 Scoring

For each file, run the engine (Karaoke and Grouped) and compare the *full transcript*
(normalized: lowercase, collapse spaces) against ground truth using **word error rate
(WER)**.

```bash
# helper: extract the "full transcription" the engine can emit, compare to truth
python3 tools/test/wer.py --truth tools/test/fixtures/news.txt --hyp /tmp/news_out.srt
```

**Pass criteria:** WER <= 15% on clear speech (`news`, `numbers`, `punct`, `names`);
no words silently dropped in `short1`; no crash on `silence`; reasonable WER even on
`noisy`/`fast`.

### 1.2b Recorded WER baseline (shipped runtime; re-verified 2026-09-17)

Measured with `tools/test/run_engine.sh tools/test/fixtures` against the **installed**
runtime (`~/Library/.../com.amharic.captions/runtime`). Karaoke and Grouped agree, so
one number per tag. `news` was re-checked after the punctuation change and is unchanged
at 64.3% (the harness now strips Ethiopic punctuation U+1360–U+1368 before scoring, so
`።`/`፣` do not inflate WER):

| Tag | WER | Notes |
|-----|-----|-------|
| fast | 60.0% | |
| interview | 100.0% | hypothesis far shorter than reference |
| names | 114.3% | proper-noun errors |
| news | 64.3% | real word errors (e.g. የገንዘብ→የገንነብ, በዚህ→በሊህ) |
| noisy | 92.9% | |
| numbers | 72.4% | digits badly mangled |
| short1 | 100.0% | 1s clip, both tokens wrong |
| long5min | completes (no OOM) | 5-min clip windowed at VAD boundaries (~60s via `AMH_WINDOW_SECS`); full 5:00 covered, peak RSS ~4.8GB; resumable |
| silence | n/a | ground truth empty — no crash, correct |

**Honest reading:** these synthetic/TTS-domain fixtures are far harder than the
production use case — they do **not** meet the <=15% target, and the real held-out WAXAL
WER (0.227) shows the model is much stronger on actual human speech. Treat this table as
a **regression baseline** (deltas matter), not an absolute quality score. Two real
follow-ups surfaced: (1) `long5min --words` was killed (memory) — **fixed** by windowing
long audio in `_windowed_transcribe` (bounded ~60s windows, cuts snapped to VAD
boundaries, plus a long-audio resumable path — see §1.2c; short clips take the unchanged
single-shot path); (2) fixture WER itself is high — the fixtures may be
TTS-domain-mismatched.

### 1.2c Long-audio resumability & punctuation (2026-09-17)

Engine changes on top of 1.4.14 (repo; shipped in the next version):

- **Rule-based punctuation.** `amh_correct.punctuate_words()` appends `።` (sentence end)
  when the gap to the next word is ≥ `AMH_PUNCT_PERIOD_GAP` (0.6s) and `፣` when ≥
  `AMH_PUNCT_COMMA_GAP` (0.3s); the last cue always ends in `።`. `AMH_PUNCT=0` disables.
  Applied in `make_cues()` *after* digit re-gluing so numbers stay intact. Verified on
  `news`: `...አስታውቅዋል።` and a final `ተልዮዋል።`, WER unchanged.
- **Resumable long audio.** Audio longer than `AMH_LONG_SECS` (300s) uses `_run_long()`:
  VAD-boundary windows of ~`AMH_WINDOW_SECS` (60s). After every window it rewrites a
  valid partial SRT and a journal `<out_srt>.part.json` (`{fp,total,done,cues,texts}`).
  A killed/timed-out run resumes (fingerprint-checked against the WAV) and processes only
  the remaining windows; the journal is deleted on clean finish. Verified end-to-end:
  a run killed at `1/6` windows left 23 cues + journal; rerun logged
  `resuming long audio: 1/6 windows already done` and continued.
- **Unit tests.** `tools/test/test_long.py` (stub engine, no model, no torch) covers
  window coverage, resume-skips-done-windows, journal cleanup, and punctuation. Run:
  `python3 tools/test/test_long.py`.
- **Per-clip batch cache (panel).** `main.js` now caches one entry per clip
  (`clipCacheKey`), so re-running a sequence after editing/adding a clip re-transcribes
  only the changed clip(s); cue→clip attribution via `attributeCues`, serialization via
  `srtFromCues`. Whole-file entries from the single-clip path are shared. `node --check`
  passes; no functional JS test yet (gap #2).
- **API key (server).** Verified 2026-09-17 against the deployed Worker
  (`amharic-captions-bot.amhcaps.workers.dev`): `POST /api/ping` returns
  `200 {"ok":true}` with the shipped `X-Api-Key`, and `401 {"error":"unauthorized"}`
  without it or with a wrong key. Enforcement is live and the panel key matches.

### 1.2d Speaker labels + multi-format export (2026-09-18)

- **2-speaker diarization (interviews).** New `amh_diarize.py` embeds ~1.5s windows
  (0.75s hop) with a small ONNX speaker model (`nemo_en_titanet_small.onnx`) via
  sherpa-onnx/onnxruntime — no torch — then cosine k-means (k=2). Each cue is
  labelled `[S1] `/`[S2] ` (S1 = first to speak) by embedding a window **on the
  cue itself** and picking the nearer centroid; a low-confidence cue falls back to
  window-overlap voting, and an ambiguous one is left unlabelled. (Per-cue
  classification fixed boundary cues that whole-window voting mislabelled.)
  **Fail-safe**: cues are returned unchanged when the model/package is missing,
  when the clip looks like one speaker (<15% of windows in the minority cluster),
  or when separation (`mean intra-cluster cosine − inter-centroid cosine`) <
  `AMH_DIARIZE_SEP` (0.10). So enabling it never makes captions worse. Pure parts
  (`kmeans2`, `assign_labels`, the gate) self-test with no model:
  `python3 amh_diarize.py`. Integration test: `python3 tools/test/test_diarize.py`
  — pure checks always run, plus an end-to-end label check on
  `fixtures/twospeaker.wav` (a synthetic two-voice clip) that is skipped unless the
  model is present. Verified 2026-09-18: 6/6 turns labelled `[S1]/[S2]` correctly
  through the bundled runtime, separation 0.499 (gate 0.10), and a single-voice
  fixture stays unlabelled.
- **Engine wiring.** `ethio_srt.py --speakers` (CLI) and `"speakers": true`
  (server/batch request) label cues on the single, batch and long paths; unavailable
  models log to stderr and continue unlabelled.
- **Panel export.** Review now has an **Export SRT/VTT/TXT** button (folder picker,
  fallback `Desktop/AmharicCaptions`). Pure serializers in `panel/js/core.js`
  (`srtTextFromCues`/`vttTextFromCues`/`txtTextFromCues`): SRT/TXT use `[S1] `/`S1: `,
  VTT uses `<v S1>`. `detectSpeaker`/`normalizeCues` lift the engine's `[Sx] ` prefix
  into `cue.speaker` so each format gets the right tag.
- **Unit tests.** `node tools/test/test_panel.js` → **24 passed** (adds `detectSpeaker`,
  `normalizeCues`, and the per-format speaker serialization). `node tools/test/test_panel_dom.js`
  → **5 passed**: loads `main.js` (with `core.js`) inside Node's `vm` against a
  zero-dependency DOM shim (`tools/test/dom_shim.js`) and drives it as a browser would —
  dark-theme + runtime/font/health rendering, settings persistence across a reload,
  the license gate (bad keys rejected locally, trial-exhausted disables Generate,
  server-confirmed activation), and a full cache-hit transcribe → review → edit →
  SRT/VTT/TXT export (speaker tags `<v S1>`/`[S1]`/`S1: ` verified on disk) → nudge →
  add → discard. Both suites run offline with **no** model/python/deps.

### 1.3 Correctness of caption grouping / timing (visual)

For `long5min` import into Premiere and verify:
- Caption band covers the **full duration** (no trailing gap, no overrun).
- Cues are **1–5s** long (enforced by `enforce_min_duration`).
- Captions land on the timeline at the **correct absolute times** (especially the
  Selected-Clip path with a source-in trim offset).

---

## 2. Source Input Matrix (in Premiere)

Test every source type. Log pass/fail; the key thing to verify is **absolute timestamp
correctness** and **which clips get captioned**.

| # | Source | Setup | Expected | Verify |
|---|--------|-------|----------|--------|
| 1 | **Selected Clip** | 1 clip mid-timeline, add a source trim (in-point not 0) | Captions for that clip only, at its real timeline position | Captions start at clip's timelineStart (not 0) |
| 2 | **Selected Clip (playhead)** | No explicit selection; playhead on a clip | Falls back to clip under playhead | Captions match playhead clip |
| 3 | **Work Area** | 3 clips, work area covers #2 and half of #3 | Captions only for clips overlapping the work area, clipped to bounds | Timeline in/out respected |
| 4 | **Whole Edit** | Sequence with 5 clips incl. one video-only (no audio) | All audio-bearing clips captioned; video-only skipped | No crash on silent clip |
| 5 | **File Import** | External .mp3 + .mov + .wav + .m4a | Transcribe whole file, timestamps start at 0 | SRT starts at 0 |

### Edge cases for sources

- Empty sequence / no clips -> clean error, no crash.
- No project open -> `ping` fails gracefully.
- Clip with **offline/missing** media (red clip) -> handled error, not a hang.
- Clip on an **audio-only track** (no video) -> still captioned.
- Two **linked** video+audio clips (same source at same time) -> deduped, NOT doubled.
- Multiple clips sharing **the same source file** -> each placed correctly.
- Clip exactly **at the work-area boundary** -> included/excluded consistently.
- A clip whose duration is **0** -> clean error (already coded at runSelectedClip).

---

## 3. Options Matrix

Run each option combo on the SAME clip, then confirm the SRT cue pattern matches.

| # | Style | Group | MaxChars | Expected cue shape |
|---|-------|-------|----------|--------------------|
| A | Karaoke | (ignored) | 42 | 1 word per cue, cue <= 1.5s |
| B | Grouped | 3 | 42 | 3 words per cue (or 42 chars) |
| C | Grouped | 1 | 42 | ~1 word per cue |
| D | Grouped | 12 | 42 | up to 12 words per cue |
| E | Karaoke | — | 10 | very short cues, hard wrap at 10 chars |
| F | Grouped | 3 | 200 | long cues (up to 200 chars) |

**Pass criteria:** cue count/lengths match the expected shape; no invisible/zero-length
cues; Karaoke must not exceed ~1.5s per cue; Grouped never exceeds `maxChars`; cues are
non-overlapping and sorted.

---

## 4. Export / Format

| Test | Expected |
|------|----------|
| Export SRT | Valid `.srt`, sequential numbering, `HH:MM:SS,mmm` timestamps, saved to Desktop/AmharicCaptions |
| Export VTT | Valid `.vtt` with `WEBVTT` header + `hh:mm:ss.mmm` times |
| Full transcript with Amharic + punctuation | All characters preserved, no mojibake (UTF-8) |
| Long transcript (> hours) | Timestamps roll over correctly, no negative/overflow |
| No transcript yet -> Export | Clean early return / disabled state, no crash |
| Re-export overwrites | New export replaces previous file, no stale duplicate |

---

## 5. License System

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Fresh install, no key | Get Machine ID; 2 free trials allowed, Generate enabled |
| 2 | After 1 trial | Enabled, "1 free transcription left" |
| 3 | After 2 trials | Generate disabled, purchase banner shown |
| 4 | Enter **valid** key | Activated; machine ID + key hidden; Generate enabled |
| 5 | Enter wrong-length key | "Invalid key length", no crash |
| 6 | Enter key for **different** machine | "Key is for a different machine" |
| 7 | Enter **expired** key | "License expired on ..." |
| 8 | Enter **tampered** key (bad sig) | "Invalid license key" |
| 9 | Licensed user's own trial counter | Trials ignored (counter doesn't block licensed user) |
| 10 | Reload panel while licensed | Stays licensed (state persists in localStorage) |
| 11 | Button liveness | Generate disabled exactly when trial exhausted AND unlicensed |
| 12 | Machine-ID copy | Clipboard gets the 8-char ID; button shows ✓ Copied |

**Test keys** (use for scenario 4): generate via `python3 tools/keygen.py <machine_id>`.
Cross-check a negative: a hand-edited sig must FAIL (`tools/keygen.py` is the source of
truth).

---

## 6. Failure & Edge Cases

| Area | Failure injected | Expected behavior |
|------|------------------|-------------------|
| Runtime | Delete `runtime/model` | "runtime incomplete" status + clear diagnostic log |
| Runtime | Rename `runtime` to `runtime-backup` | "runtime missing" + path diagnostics |
| python | Point `AMH_MODEL_DIR` at wrong dir | Clean Python error surfaced in log |
| ffmpeg | Feed a **corrupt/truncated** file | Clean "ffmpeg failed" / "Python failed" error, no hang |
| ffmpeg | Very short clip (<1s) | No crash; min-duration enforced or clean error |
| python | `silence.wav` (no speech) | Bucket: all-blank -> empty/no cues, no traceback |
| batch | One bad WAV in the middle of a work area | FIXED: bad clip is skipped (logged + counted), rest are captioned, run returns `skipped:N` |
| batch | ALL clips in a work area are bad | FIXED: run completes with `ok` + all skipped, no crash/abort |
| cancel | Tap Cancel during ffmpeg | Process killed, clean return |
| cancel | Tap Cancel during transcription | Process killed, clean return |
| cancel | Cancel during batch | Clean return |
| clipboard | Machine ID copy when text unavailable | Graceful ignore |

---

## 7. Cross-Platform

- **mac-arm64** and **mac-x64** and **win-x64** all pass test set 1–3.
- Paths with **spaces and non-ASCII** (e.g. `ሙዚቃ.mp4`, folder `My Music`) work end-to-end.
- Windows: output written to `%LOCALAPPDATA%\AmharicCaptions\output`; no permission errors.
- Filename with apostrophes/quotes doesn't break the Python CLI argument (arglist safe).

---

## 8. Known Gaps Found During Planning (fix candidates)

1. **Batch failure is all-or-nothing** — FIXED. `handle_server_batch()` (warm path) and
   `run_batch()` (one-shot path) now wrap each clip in try/except: a bad clip is logged
   to stderr, counted, and skipped; the rest are captioned; the server returns
   `{"ok": true, "skipped": N}`. Follow-up `long5min` in `--words` mode OOM — **FIXED**
   by windowing long audio (see §1.2b).
2. **`ctc_beam` / `amh_correct` self-checks are the only automated tests** — no
   integration tests exist. `tools/test/test_long.py` now covers long-audio windowing +
   resume + punctuation (stub engine, no model); `tools/test/test_panel.js` covers the
   panel's pure core helpers (`parseSrt`, serialization incl. speaker labels,
   `validateLicense` paths) in Node, and `amh_diarize.py` self-tests its pure
   clustering/labelling. `tools/test/test_panel_dom.js` (with `dom_shim.js`) adds the
   DOM-level `main.js` coverage (settings, license gate, review→export) via Node's `vm`.
3. **No golden audio `fixtures/`** — cannot assert real accuracy. Must be recorded.
4. **Mel extractor on ultra-short (<400 sample) audio degrades** — confirm the
   `short1` case returns *something* acceptable or a clean error.

---

## 9. Targeted Testing Harness (proposed)

To make regression testing repeatable, add `tools/test/`:

```
tools/test/
  fixtures/          (git-ignored: golden .wav + .txt ground truth)
     news.wav / news.txt ...
  wer.py             (compute WER between ground truth and an SRT/full-transcript)
  run_engine.sh      (loop over fixtures, run ethio_srt.py karaoke+grouped, score)
  test_srt.py        (validate SRT structure: numbering, timing order, 1-5s cues)
  test_keygen.py     (license key valid/invalid/expired/foreign-machine matrix)
```

Commands:

```bash
tools/test/run_engine.sh --truth tools/test/fixtures
tools/test/test_srt.py /tmp/out_karaoke.srt
tools/test/test_keygen.py
```

**Definition of done for "unquestionable":** every scenario in sections 1–7 has a
recorded pass, the automated harness runs green, and known-gap #1 is fixed.

---

## 10. Suggested Run Order (fastest -> most complete)

1. Offline engine smoke test (A) — validates the model works at all.
2. `ctc_beam.py` + `amh_correct.py` self-checks.
3. Quality golden set WER (add fixtures).
4. Options matrix (B, C, D, E, F).
5. License 1–12 (all in Premiere).
6. Source matrix 1–5 + edge cases (in Premiere).
7. Export/format.
8. Failure/edge injection + cancel.
9. Cross-platform pass.
