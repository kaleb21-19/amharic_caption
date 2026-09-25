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

# 1) Python unit suites (no model, no torch):
"$PY" tools/test/test_long.py      # long-audio windowing + resume + punctuation
"$PY" tools/test/test_diarize.py   # 2-speaker k-means + labelling (e2e skipped w/o model)

# 2) Self-checks that ship inside the runtime:
"$PY" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/ctc_beam.py"
"$PY" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/amh_correct.py"

# 3) Word-split LM self-check (ships in the runtime). Asserts REAL glue splits
#    (e.g. ኢትዮጵያሀገሬ -> ኢትዮጵያ ሀገሬ) plus known-word stay-whole cases; the two
#    headword cases whose parts this corpus never contained report [skip] —
#    an artifact rebuilt from any corpus can't split into unseen words:
"$PY" "$HOME/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions/runtime/amh_lm.py"

# 4) Server-side worker auth (requires Node 22+, in tools/telegram-worker):
node test/e2e.mjs               # all 53 checks: HMAC validate, admin auth,
                                # webhook signing, trial leases, delivery/revocation
                                # secrets from env (AMH_*_TEST)
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

### Release policy (updated 2026-09-25)

- **Stable/public release:** keep the locked WER ≤15% safety gate unchanged.
- **Private beta/early-access:** target ≤30% WER, clearly labeled as beta, with
  rollback instructions and no public-production claim. The current Hohe candidate
  is not yet at this beta target (raw 36.35%, approximate 33.50%).
- **Speed:** compare candidates on the same Windows machine and clips; record
  warm-model processing time, real-time factor, peak RAM, and package size before
  choosing a version. Do not select a model that is materially slower without an
  explicit product decision.

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
| long5min | completes (no OOM) | 5-min clip windowed at VAD boundaries (~20s via `AMH_WINDOW_SECS`, was 60s — see §1.2j); full 5:00 covered, peak RSS ~4.8GB measured at the old 60s default; resumable |
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
  VAD-boundary windows of ~`AMH_WINDOW_SECS` (20s since §1.2j; was 60s). After every window it rewrites a
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
  `srtFromCues`. Whole-file entries from the single-clip path are shared. Functional
  coverage in `tools/test/test_panel_dom.js` (tests 6–7, warm-worker IO faked via
  `opts.hooks`): a sequence run serves an unchanged clip from its single-clip cache
  entry, all-cached re-runs never touch the worker, an edit busts only that clip's key,
  and `attributeCues` window/nearest-fallback attribution + `srtFromCues`⇄
  `srtTextFromCues` mirroring are asserted.
- **API key (server).** The extension API is public by design; a desktop
  client cannot safely embed an authentication secret. `AMH_REQUIRE_API_KEY=1`
  is an optional deployment/network gate, off in the shipped `wrangler.toml`.
  The E2E suite covers the disabled-by-default policy and the opt-in 401 gate.

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
  fallback `Documents/AmharicCaptions`). Pure serializers in `panel/js/core.js`
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

### 1.2e Ultra-short audio is a clean error (2026-09-19)

Audio shorter than one mel frame pair (**560 samples = 35 ms @ 16 kHz**) can't
form two mel frames; the old ddof=1 per-bin variance came out **NaN**, feeding
garbage into the model. `amh_mel.MelExtractor` now raises a plain
`ValueError("audio too short …")` below that floor (and for empty audio):
- `--server` / batch paths catch it per clip → `{"ok":false,"error":…}` or
  `skipped:N` — one bad clip never aborts the rest of a work area.
- Long-audio *windows* below the floor are skipped with an `[info]` line (the
  planner normally never emits tails that small; this is defense-in-depth for
  VAD-boundary cuts) so a clip's tiny leftover can't kill the whole run.
- A single ultra-short file via the CLI prints `[error] … cannot transcribe.`
  and exits 1 — no traceback.

Regression coverage: `python3 tools/test/test_mel_short.py` (raises for
0/300/559 samples, finite features at ≥560 and for 1 s) and §5 of
`tools/test/test_long.py` (single-shot clean raise + degenerate-window skip).

### 1.2f Pure silence produces hallucinated captions — FIXED (2026-09-19)

Found via the new WER harness: `tools/test/fixtures/silence.wav` is
**byte-for-byte digital silence** (5 s, all zero samples, verified
`max|amp|=0.0`), yet transcription emitted two cues (`.ን` at 0.6–2.1 s, `ቸው።`
at 4.8–5.8 s — identical across the installed and new int8 models). Root cause:
`_vad_segments()` reports `[(0.0, 5.0)]` — Silero flags constant-zero input as
"active" — so the whole clip went to the CTC model, which hallucinated on zeros.

**Fix:** `_preflight_audio()` runs first in both engines' `_transcribe_one` (the
single choke point for single-shot, windowed, server and batch paths) and treats
audio whose RMS is below `AMH_SILENCE_RMS` (default `0.0001` ≈ −80 dBFS) as no
speech → empty transcript. The identical guard also raises the "audio too short"
error below one mel frame, preserving the §1.2e contract for degenerate clips.
Verified: the `silence` fixture now matches the blank gate
(`ref 0 / hyp 0`, PASS in `run_engine.sh`) using a post-fix runtime, and a
440 Hz tone / speech is unaffected. Regression tests: §6 of
`tools/test/test_long.py` (silent zeros, tone, env-floor override, too-short
raise).

### 1.2g Real-golden WER gate is RED vs 15% — measured (2026-09-19)

Golden set: **20 recorded clips** from **Common Voice Amharic** (CC0; source
`hadamard-2/common-voice-24-ethiopian-v2`, `amh/test` split), written as
`tools/test/fixtures_real/cv_common_voice_am_*.wav` (+ `.txt`): varied
single-speaker read speech, 2.3–6.6 s, 3–12 tokens, resampled mp3→16 kHz mono
WAV with ffmpeg and verified decodable. Score = shipped runtime via
`run_engine.sh --fixtures tools/test/fixtures_real --max-wer 0.15` (karaoke +
grouped modes, identical WERs): **the ≤15% gate FAILS** — WER mean ≈ 52%
(range 0–100%), 3 of 19 clips perfect (`37842349`, `38629723`, `39643423`),
CER mean ≈ 19%, pass 6/38 scored runs.

**Current Windows re-run (2026-09-25):** the pinned source model
`edda1ab0af0d3cca4f4a6fd0b17ef3726bcce12a` downloaded and hash-verified,
converted to CT2 INT8, and was scored on all 20 truth-backed fixtures in both
caption modes (40 runs). Mean WER was **47.45%**, maximum WER was **100%**,
and **30/40** runs exceeded the 15% gate. This confirms the release blocker;
it is not a packaging or Windows-runtime false positive. The Windows UTF-8
runtime fix and compatible conversion pins are tracked separately in the
feature branch.

The same preserved outputs were also scored diagnostically: mean WER was
**42.70%** with the Amharic word-grid transform and **40.69%** with the
vowel/orthographic approximation; only 10/40 runs passed 15% under each
transform. Mean raw CER was **16.02%**. The diagnostic run had **zero engine
failures**. The transforms reduce the aggregate error but cannot close the gap,
and spot checks show genuine substitutions/deletions as well as boundary
issues. No distinct historical model asset was present in the repository
release inventory for a direct A/B run.

**Candidate Hohe benchmark (2026-09-25):** `snapwre/hohe-asr-amharic`
(CC-BY-4.0), revision `7ee83bdcf748694409f412e06f6c6747b44b3212`, was
pinned and hash-verified (model SHA-256
`9ec1ff28b669eb4a94d330e6879b1e0dbc6b1c451647f49805ed22856979fd77`; 5-gram
SHA-256 `b6ee3b47e2b4840eb5ca44990c48b340f211e67fbce3eb731fb991a6a514215e`).
It converted successfully and produced zero engine failures. On the same 40
scored runs it achieved raw WER **36.35%**, grid WER **34.77%**, approximate
WER **33.50%**, and raw CER **12.58%**; only 14/40 runs were at or below 15%.
This is a meaningful improvement over the shipped model's 47.45%, but it is
**Windows diagnostic package (2026-09-25):** the feature-branch
`amharic-captions-win-x64.zip` built successfully at **771,256,771 bytes**.
Its SHA-256 is
`afc29ac8a5142ee88ee0945a4f00a00f82337adc4a6650d5d099d62bac5a60e1`.
After extraction, the included `verify_win.cmd` passed **10/10** runtime
checks (Python, FFmpeg, CT2 model, imports, and warm-up). The archive is
explicitly a diagnostic/degraded build marker and is not a production release.

**Hohe A/B diagnostic package (2026-09-25):** a separate Windows archive
using the Hohe candidate was built for local comparison only, with the
benchmark's beam settings. The standard Windows-compatible ZIP is
**744,948,974 bytes**, SHA-256
`c7642f5ed45ee2ccfe4cc4bd88431ec2fddf7f7708ac00cd247b7cd5d5bd6013`.
Windows `Expand-Archive` succeeded and its extracted `verify_win.cmd` passed
10/10 checks. It is not the production package and must not be published.

**Decoder-matched current-model package (2026-09-25):** a separate archive
using the current Ethio-ASR-amharic model with beam decoding enabled by
default was built for a fair Hohe-vs-current comparison. The standard ZIP is
**744,614,517 bytes**, SHA-256
`a76245a51c947eee4787e2336c76b803064996cc6777b92693753abeeee70d1f`.
Windows `Expand-Archive` succeeded and its extracted `verify_win.cmd` passed
10/10 checks. It is not the production configuration and must not be published.

**Hohe LM-fusion matrix (2026-09-25):** a small diagnostic run over four
public fixtures (`interview`, `names`, `news`, and `numbers`) in both caption
modes produced identical results at `AMH_LM_LAMBDA=0`, `0.05`, `0.1`, and
`0.2`: mean raw WER **68.375%**, mean CER **23.925%**, and **0/8** runs at or
below 15%, with zero engine failures. This subset is not comparable to the
larger locked benchmark; the result only rejects enabling this word-LM fusion
path as a default. No production decoder or model setting was changed.

Inspection attributes part of the score to two **evaluation confounds**, not
acoustic errors: (1) orthographic/diacritic variants — model output `ታዕምር` for
truth `ተዓምር` (same word, both spellings standard; the ተ/ታ and ዓ/ዕ series collapse
under the CER view, e.g. a 40%-WER clip is 8.7% CER); (2) agglutinative word
boundaries the model splits but the corpus glues (`ነውአሉ` vs `ነው አሉ`). Genuine
misses remain too (truth `ቋሚውንም አግኝተናል አሉ፡፡` → hyp `የኳዋነት ማንታ ላ።`), while the
committed fluent narrative `fixtures_real/abu.mp4.wav` transcribes into
grammatical Amharic. Longer sentences transcribe much better (6–7 s clips score
20–33% WER), so the red gate is concentrated on short, isolated read phrases +
confounds. Closing it needs an Amharic-aware WER normalizer (vowel-length
canonicalization, split glued forms — §1.2g scorer already folds in the
homophone families) and/or a model upgrade (see "pending" note below).

> **Candidate A/B — measured 2026-09-20, RESULT: REJECT, keep the shipped
> model.** `badrex/Ethio-ASR-multilingual-600M` (CC-BY-4.0; same
> wav2vec2-bert architecture, hidden 1024/24 layers; WAXAL Amharic WER
> **22.9% vs ~30%** for the shipped model per its own model card; `[PAD]`
> blank id 408 identical, vocab 414/416) downloaded (2.4 GB fp32, resumable
> parallel-range fetch — bandwidth cooperated this time) and converted to CT2
> int8 (584 MB). Two real compatibility bugs had to be fixed before it would
> even run (see `ethio_srt.py`/`ctc_beam.py` commits 2026-09-20): a hardcoded
> `!= 411` vocab-size check that crashed the CT2 lm_head projection on any
> model with a different vocab, and a missing special-token filter that let
> this multilingual checkpoint's language-ID tag (`[TIR]`/`[AMH]`/etc., a
> one-token prefix before the real transcription) leak into every caption.
>
> Once actually running, the honest gate (`run_engine.sh --fixtures
> fixtures_real --max-wer 0.15`, beam decode, both models identically
> configured) gave: **shipped model mean WER 45.3% vs candidate mean WER
> 53.1%** (38 scored runs each). The candidate is WORSE on this real-world
> Common Voice set despite its better claimed WAXAL benchmark number — most
> likely because WAXAL and Common Voice are different domains, and/or because
> splitting model capacity across 5 languages (Tigrinya/Wolaytta/Amharic/
> Sidamo/Oromo) costs some Amharic-specific quality that a dedicated
> single-language model doesn't pay. Spot-checked several of the candidate's
> transcriptions by hand to rule out a residual pipeline bug: they're
> legitimate Amharic, not garbage — the errors are real ASR mistakes,
> concentrated in word-boundary gluing (`እርግጠኛነኝ` for `እርግጠኛ ነኝ`,
> `ትወደነበር` for `ትወድ ነበር`) — interesting in that this specific failure
> mode is exactly what the LM shallow-fusion feature targets, so this
> candidate might be worth revisiting together with LM fusion tuned in,
> rather than as a decode-parity-only swap.
>
> **Decision: do not ship this model.** No further action needed unless a
> newer/different candidate appears — this one is closed out, not pending.

### 1.2h Per-condition robustness — reverb and phone audio are the real risk (2026-09-21)

The §1.2g gate scores clean, single-speaker read speech. Amharic Captions is
sold nationwide for every kind of content, so a model can pass that gate and
still fail on the footage editors actually bring in. `tools/test/robustness_report.py`
measures each condition separately. **No ground truth is invented:** every
condition is a degradation of a clip whose transcript is already verified, so
the reference text is unchanged; `twospeaker` concatenates two verified clips
with a 0.35 s gap and joins their transcripts, which is what turn-taking is.

Full run, all 19 verified clips, greedy decode, music/noise mixed at 10 dB SNR,
seed 1234 (`python3 tools/test/robustness_report.py`):

```
  condition     clips     WER      CER   CER-nospace   vs clean
  --------------------------------------------------------------
  clean           19    35.0%    16.2%        16.1%        —
  music           19    33.1%    12.9%        13.0%     -1.9 pp
  noise           19    50.5%    26.8%        26.4%    +15.5 pp
  phone           19    57.6%    30.1%        31.5%    +22.6 pp
  reverb          19    74.0%    46.3%        47.2%    +39.0 pp
  twospeaker       9    36.1%    13.5%        14.3%     +1.1 pp
```

> **Correction (2026-09-21).** The first published version of this table gave
> clean as 44.6 % and every other row accordingly. That run was launched from a
> working copy of `robustness_report.py` that was still being edited, so the
> process scored with different code than was committed beside it — and the
> write-up then cited the 44.6 % agreement with §1.2g as proof the harness was
> validated, when it was a coincidence. The table above is a re-run of the
> committed script, cross-checked against an independent per-clip A/B that
> gives the same 35.0 % clean mean. The engine is deterministic (two passes
> over the same clips produce byte-identical text), so these numbers reproduce.
> **The rankings and every conclusion below were unchanged by the correction.**
> Lesson for this harness: don't edit the script while a run of it is in flight.

- **Music beds are a non-issue.** At 10 dB SNR a sustained tonal bed under
  narration costs nothing measurable — it scored marginally *better* than clean.
  Wedding/event footage is safe on this axis. (Synthetic bed, not real music;
  treat the ranking as solid and the absolute number as indicative.)
- **Turn-taking is not a problem either** — two speakers back to back land
  within ~1 pp of the clips alone, consistent with the §1.2g finding that
  longer utterances give the model more context.
- **Broadband noise costs ~15 pp.** Outdoor/crowd shoots degrade but stay usable.
- **Phone/handheld mics cost ~23 pp.** Band-limiting to 300–3400 Hz nearly
  doubles CER. A lot of Ethiopian vlog and interview footage is recorded this
  way, so this is a real, common failure mode — not a corner case.
- **Reverberant rooms are the worst case by far: +39 pp, CER 46%.** At RT60
  0.45 s (a hall, a church, a large event venue) the output stops being
  correctable — an editor would be faster typing from scratch. Sermons and
  event-venue speeches are exactly the content this breaks on.

CER-nospace tracks CER in every row, so these are genuine recognition failures,
not re-segmentation (same test as §1.2g / `cer_nospace`).

**What this means for accuracy work:** any retrain must be judged on *this*
table, not on the clean gate alone. Improving clean WER while `reverb` and
`phone` stay where they are would leave the product failing on the jobs that
matter. The augmentation in `tools/retrain/03_finetune_waxal.py` was MUSAN only
(noise/music) — the two axes that are *already* fine — so it hardened the model
against what it already handled and never showed it what breaks it.
**Fixed 2026-09-21:** `apply_reverb()` and `apply_narrowband()` added there,
applied in physical order (room → noise in that room → microphone bandwidth),
default probability 0.3 each, `--rir-dir` for real impulse responses. Prefer
real RIRs: the synthetic IR is the same model this harness uses, so training
against it risks fitting the test's own assumptions rather than real rooms.

### 1.2i Dereverberation at inference — MEASURED, REJECTED (2026-09-21)

§1.2h makes reverberant rooms the product's worst condition, so the obvious
cheap lever was to strip the reverb *before* the model hears it: no retraining,
no new model file, and it would reach every already-installed copy. Implemented
as `amh_dereverb.py` (WPE — weighted prediction error; numpy only, since the
runtime ships no scipy) and measured through `robustness_report.py --dereverb`.

Full 19-clip runs, WER, against the §1.2h baseline:

```
  condition     baseline   taps=20   taps=40
  clean            35.0%     33.1%     34.8%
  music            33.1%     42.6%     44.1%      <-- badly damaged
  noise            50.5%     53.0%     52.3%
  phone            57.6%     56.0%     60.5%
  reverb           74.0%     68.3%     65.7%      <-- helped
  twospeaker       36.1%     35.0%     37.3%
```

It does what it claims on reverb (74.0 % -> 65.7 %), and is roughly neutral on
clean, noise, phone and two-speaker audio. **But it costs ~10 points on music
at both settings**, so the damage is not an artefact of an aggressive setting.
Plausible mechanism: WPE removes whatever is linearly predictable from the
signal's own past, and a sustained musical bed is far more predictable than
speech, so the fitted filter chases the music and mangles the speech with it.

**Why gating it behind a reverb detector does not rescue it:** the two
conditions co-occur in precisely the footage that would trigger it. An Ethiopian
wedding or event shot in a hall has *both* a reverberant room *and* a music bed.
A detector firing on reverb would therefore switch the filter on exactly where
it does the most harm.

And the win is not a win in product terms: 74 % -> 66 % WER is roughly 26 to 34
words right per 100. Both are uncorrectable — an editor retypes either way. It
buys no usable footage while risking footage that currently works, and costs
0.10x (taps 20) to 0.36x (taps 40) realtime on top of transcription.

**Decision: do not ship. Not wired into `ethio_srt.py`; `amh_dereverb.py` is
not in the `tools/build.sh` / `build_win.ps1` runtime file lists, so it does not
enter the product.** Kept in-tree as a measurement tool: worth re-testing after
a reverb-augmented retrain (§1.2h), when the model's own reverb handling has
moved and the trade-off may look different. `python3 amh_dereverb.py` runs its
self-check.

> Note on that self-check: its first version reported `[pass]` on code that was
> a no-op, because it asserted only "some improvement" and the real change was
> 0.01 %, and because `dereverb()` returns its input on any exception — so a
> genuine `ValueError` (numpy>=2 changed batched `np.linalg.solve` to require a
> stack of matrices) surfaced as a silent pass-through. It now calls the core
> path unguarded and asserts effect sizes. A test that cannot fail is not a test.

### 1.2j Window length 60s -> 20s, and a VAD trap that invalidates measurements (2026-09-22)

**Change:** `AMH_WINDOW_SECS` (`ethio_srt.py:_window_target_samples`) default
**60s -> 20s**. 60s was picked in §1.2b to stop an OOM and never re-examined.

**Why the 19-clip real set cannot see this.** Longest scored fixture is 6.59s;
`_plan_windows` returns a single window whenever audio is shorter than the
target, so every clip in `fixtures_real/` is byte-identical at any setting from
8s to 60s (verified: a 6.6s clip diffs clean at 60s vs 20s). This is a property
of the code, not a measurement.

**Fixture that does exercise it.** The 19 clips concatenated in 4 shuffled
orders with 0.4s gaps — 340.6s, 468 reference words. Different orders put the
cuts in different places. Over 300s, so it also uses the `_run_long()`
resumable path. Greedy decode, **VAD on**, shipped runtime, Apple M4.

| window | wall | peak RSS | hyp tokens (ref 468) | WER | CER | CER-nospace |
|---|---|---|---|---|---|---|
| 60s (old default) | 105.8s | 2.84 GB | 282 | 64.7% | 31.8% | 29.1% |
| 30s | 82.3s | 2.00 GB | 386 | 52.1% | 22.1% | 22.2% |
| **20s (new default)** | 78.5s | **1.52 GB** | 387 | **50.9%** | 21.3% | 21.1% |
| 15s | 76.3s | 1.57 GB | 399 | 50.9% | 21.1% | 21.5% |

60s -> 20s wins on every axis at once: **-13.8 pp WER, -10.5 pp CER,
-1.32 GB peak RSS, -26% wall**. 15s buys nothing over 20s.

**The engine is deterministic.** Verified two ways: the 60s row was reproduced
**byte-identically** a day later, and three repeats at each of 60s/20s produced
identical output. Any apparent run-to-run variation is an environment
difference, not the model — see the trap below.

**THE VAD TRAP — read this before measuring anything.** `amh_vad.py` loads
`silero_vad.onnx` from its own directory and **returns None silently** if the
file (or onnxruntime) is missing. A hand-staged runtime that copies the `.py`
files but not the 1.8 MB `.onnx` therefore runs with VAD effectively off:
93 VAD segments on the fixture become **1**. Nothing errors, nothing warns.

This cost a day of work. A staged runtime missing the file produced numbers
6–14 pp apart from the shipped runtime, and three wrong conclusions were drawn
from comparing the two environments against each other:
- "long windows make the model under-generate" — unsupported,
- "`_run_long()` drops content" — unsupported; the 121-word gap was the VAD,
  and the two paths are equivalent on inspection (both call `_plan_windows`
  then `engine._transcribe_one(wav[st:en])` with the same shift math),
- "the engine is non-deterministic" — false, see above.

**Always** check `len(ethio_srt._vad_segments(wav))` is plausible (dozens, not
1) before trusting a measurement from a non-shipped runtime.

**Open item 1 — VAD may be COSTING accuracy.** With VAD off, the same fixture
scored *better* at every window (60s: 50.0% vs 64.7%; 20s: 43.6% vs 50.9%).
Treat as a lead, not a finding: the fixture's 0.4s digital-silence gaps are
exactly the artefact that could make a neural VAD misbehave. Re-test on natural
continuous audio before acting.

**Resolved CI accuracy configuration:** `accuracy-gate` now installs
`onnxruntime`, stages the Silero VAD asset, verifies that the VAD session loads,
and scores the shipped VAD-on configuration. It is release-blocking.

**Resolved packaging gate:** `tools/build.sh` and `build_win.ps1` fail
release builds when the VAD, speaker model, word-LM, or production CT2 model is
missing. A deliberately degraded local/test archive requires the explicit
`ALLOW_DEGRADED=1` / `-AllowDegraded` opt-in and carries `DEGRADED_BUILD.txt`;
customer/release builds cannot silently omit these assets.

**Regression checks after the change:** `run_engine.sh --fixtures
fixtures_real` 38/38 pass, 0 fail; `test_long.py` ALL PASS; 6.6s clip
byte-identical at 60s vs 20s; the 25.9s `abu` clip unchanged (17 cues, 66
words) — `_plan_windows` tolerates overshoot, so it plans ONE 26s window at a
20s target and the 20–26s band gets no split.

### 1.2k Karaoke mode shipped OVERLAPPING cues — FIXED (2026-09-22)

Found by the structural half of `run_engine.sh` (`test_srt.py`), which had been
reporting `warn=2` without anyone chasing it down.

**Symptom.** In karaoke mode (`--words`) captions could overlap, putting two on
screen at once in Premiere. 2 of 19 real Common Voice clips were affected
(`cv_common_voice_am_37952747`, `cv_common_voice_am_39362368`); grouped mode
passed on both. This violated the §3 pass criterion "cues are non-overlapping
and sorted". Pre-existing, unrelated to the §1.2j window change — reproduced
byte-identically against the untouched installed runtime, and both clips are
short enough to take a single window.

```
3  00:00:01,372 --> 00:00:02,372   ላይ
4  00:00:01,492 --> 00:00:02,492   ተሰቅምታየ።      <- starts 880ms before cue 3 ends
```

**Cause.** `enforce_min_duration()` extends a short cue's END to `min_dur`,
then clamps it to `next_start - tail_room` to keep a gap. That clamp was
guarded by `if e > limit and limit > s:` — so when the next cue started
*within* `tail_room` of this one, `limit <= s`, the guard fell through and the
min_dur extension was left in place, overlapping the next cue. The one case
that most needed clamping was the one case that skipped it.

**Fix.** When there is no room for the gap, butt the cue against the next one
(`e = max(s, nxt_s)`) instead of giving up. A zero-gap cue is correct; an
overlapping cue is not. Roomy neighbours still get the full `min_dur`, the
`tail_room` gap is still preserved whenever it fits, and `max_dur` trimming is
unchanged.

**Verification.** Both clips now PASS `test_srt.py` with all caption text
preserved (5 words before and after on 37952747); full gate `pass=38 fail=0
warn=0`, down from `warn=2`. Regression coverage added as section 7 of
`tools/test/test_long.py` (pure, no model): the exact observed shape, plus
roomy-neighbour, gap-fits and max_dur cases — so CI catches a reintroduction.

### 1.2l VAD A/B on the real clips — suggestive, UNDERPOWERED, not acted on (2026-09-22)

Follow-up to the §1.2j lead. Scored all 19 real Common Voice clips (the only
labelled natural audio we have) twice through the same runtime, changing only
`AMH_VAD`. Corpus WER = total word errors / total reference words:

| config | WER | CER |
|---|---|---|
| `AMH_VAD=1` (shipped default) | 49.6% | 17.3% |
| `AMH_VAD=0` (what CI scored) | **43.6%** | **14.6%** |

Aggregate favours VAD-off by 6.0 pp WER / 2.7 pp CER — **but do not act on that
number yet.** Per clip it is 5 better, 4 worse, 10 tied, which is not
significant by a sign test, and the whole set is **117 reference tokens**, so
6 pp is about 7 words. The shape is at least interesting: the five wins are
large (2–3 errors each; `37952747` goes 80% → 20%) while all four regressions
are exactly +1 error.

**The §1.2j concatenated fixture is NOT independent corroboration** — it is
built from these same 19 clips. Both results are one piece of evidence from one
small pool of audio, not two.

**What it would take to act:** more labelled natural audio, ideally in the
editors' own domain. Note also that VAD is not a free switch — `_plan_windows`
uses VAD segments to snap long-audio window cuts to silence, so disabling it
changes windowing too, and VAD trimming is what keeps silence out of the
encoder on long clips.

**What WAS fixed:** `accuracy-gate` in `.github/workflows/build.yml` used to set
`AMH_VAD: "0"` *and* build a `fake_runtime/` with no `silero_vad.onnx` and no
`onnxruntime` installed — three independent reasons it scored a configuration
no customer runs, on a job whose whole purpose is measuring product accuracy.
It now installs `onnxruntime`, copies `tools/vad/silero_vad.onnx` into the fake
runtime, drops `AMH_VAD=0`, and **asserts `amh_vad._load_session()` is not None
before scoring** — because the failure mode is silent, so absence of an error
proves nothing. Verified locally: the assert exits 1 without the onnx and 0
with it. Expect the reported gate WER to rise ~6 pp; that is the number getting
*more* honest, not a regression.

**Panel:** `main.js` now logs a visible WARNING when `silero_vad.onnx` is absent
from the runtime, while leaving status 'ready' — `tools/build.sh` deliberately
supports building without VAD, so this must not block the panel, but it must
not be silent either.

### 1.2m A Premiere upgrade silently de-licensed a paying customer — FIXED (2026-09-22)

Found on the author's own machine: the panel demanded a license key from an
install that was already activated, and showed *"This machine record was
created on another computer … contact support"*. Two independent bugs.

**Bug 1 — the license lived only in CEP localStorage.** CEP stores it per
extension AND per host version:

```
~/Library/Caches/CSXS/cep_cache/PPRO_26.3.2_com.amharic.captions.panel/Local Storage/
```

That directory had been created fresh that morning; its leveldb held
`amh.machineId`, `amh.trial.used`, `amh.onboarded`, `amh.settings` and **no
`amh.license` at all**. Nothing was corrupt — the whole store was new, because
the path is keyed by `PPRO_<version>`. **Upgrading Premiere, reinstalling the
panel, or clearing the CEP cache therefore de-licenses every customer.** No CEP
cache anywhere on the disk still held the license, so it was unrecoverable.

There was also no way back: `/api/validate` needs the key itself and the server
exposes no mid-only lookup, so a customer who lost their Telegram message had
to contact support to re-obtain a key they had already paid for.

*Fix:* the license is now written to `~/.amharic_captions_license.json` and
localStorage is only a cache (`getLicense`/`setLicense` in `panel/js/main.js`).
The home-dir file is proven durable — the machine record in the same directory
survived this exact wipe. Kept as a SEPARATE file from the machine record so a
license write can never endanger the machine ID. Copying the file to another PC
gains nothing: the lease is an ECDSA signature bound to that Machine ID and
`verifyLicenseToken()` checks it.

**Bug 2 — the "another computer" warning was a false alarm.**
`hostFingerprint()` was `sha256(os.hostname() + "|" + username)`, and macOS
reports `Name.local` on Wi-Fi, `Name.lan` behind some routers and bare `Name`
otherwise. **Changing network was enough to tell a paying customer their
license record came from another machine.** It never invalidated anything (the
license binds to the Machine ID, not the host) — it just sent people to support.

*Fix:* the fingerprint is now `username|homedir|platform` — stable across
networks, still catching a record copied to another PC or another account. The
inputs changed, so the record carries `hv: HOST_FP_VERSION`; a record without
it predates the change, is **not comparable**, and is silently re-stamped with
the machine ID preserved. Without that migration every existing install would
show the false warning exactly once.

**Recovery for the affected machine:** Machine ID `7cc97f2e` was preserved
(`getOrCreateMachineId` path 2 recovered it from localStorage and rewrote the
record), so re-entering the existing key reactivates it — no new purchase.

**Tests.** `panel/test/machine-id.test.mjs` gains cases 6–8 (legacy record is
re-stamped not warned; stable across a boot; the SAME record survives a
hostname change with an identical fingerprint) and `tools/test/test_panel_dom.js`
gains case 9 (license round-trips a localStorage wipe, re-seeds the cache, and
still fails closed when both copies are gone). **Both were verified to FAIL
against the old implementation** — the identity test fails on exactly
`hostname change must NOT be reported as another computer`.

`machine-id.test.mjs` had never been wired into CI at all; it now runs in the
`test` job, so neither regression can ship unnoticed again.

**NOT done — needs a decision.** A `mid`-only re-activation endpoint would let
a wiped install restore itself with no customer action. It is deliberately not
implemented: the Machine ID is displayed in the panel and sent to support, so
serving a lease for a bare mid would let anyone who learns one license that
machine. The durable file above removes the failure without weakening the
model; add the endpoint only as a considered trade-off.

### 1.2n The website's Windows download 404s — release shipped without the Windows zip (2026-09-22)

Reported as "the website download redirects to not found". It is **Windows
only**, which is the platform most buyers are on.

```
404  amharic-captions-win-x64.zip     <- every Windows customer
200  amharic-captions-mac-arm64.zip
200  amharic-captions-mac-x64.zip

releases/latest -> v1.4.26
assets: mac-arm64.zip, mac-arm64.zip.sha256, mac-x64.zip, mac-x64.zip.sha256
```

The link is not broken — the asset does not exist. `v1.4.26` was published with
both macOS zips and no Windows zip. Older `build-*` tags DO contain
`amharic-captions-win-x64.zip`, so Windows builds work; what is new is the
per-job publish step.

**Most likely cause:** `tools/publish_public_zip.sh` ran `shasum -a 256` under
`set -euo pipefail`. `shasum` is a Perl script and is not guaranteed on Git
Bash's PATH on the Windows runner, and the checksum is computed BEFORE the
upload — so a missing tool aborts the script with nothing uploaded. That fits
the evidence exactly: Windows is missing **both** its zip and its `.sha256`,
while macOS has both. NOT confirmed against the Actions log (not readable from
here), so treat it as the leading hypothesis, not a proven root cause — the
fixes below make the pipeline fail loudly whichever of these it is.

**Fixes.**
1. *Portable checksum.* `sha256_into()` tries `sha256sum`, then `shasum`, then
   `openssl`, and fails with a named error if none exists. The three runner
   OSes genuinely disagree here: `sha256sum` is absent on macOS, `shasum`
   unreliable on Git Bash.
2. *Verify the upload landed.* `gh release upload` can report success for an
   asset that is not on the release. The script now re-reads the release and
   greps for the filename, failing if absent.
3. *The systemic one — `publish-ready` now VERIFIES instead of assuming.* It
   used to print "all three published" purely because the three build jobs
   reported success; it never looked at the release. It now reads the release
   assets AND `curl -I -L`s the three public
   `releases/latest/download/...` URLs the website links to, failing the build
   if any is missing or not serving 200.

**Verified:** the new gate was dry-run against the live broken release and
correctly exits 1 on `[MISSING] amharic-captions-win-x64.zip`.

**Still to do:** re-run the build so `v1.4.26` gets its Windows zip. Until then
Windows customers cannot install. If the re-run fails again, the Actions log
for `build-win` will now name the reason.

### 1.2o Numbers, and VAD trimming off by default (2026-09-23)

Started from the numbers fixture (69% WER). Two causes, both decode-side:

**1. The model learned numbers both ways.** At nearly every number word its
runner-up token is a digit (ሶ/`3`, አ/`4`, ባ/`7`, ጠ/`9`, ሮ/`0`) — the
training transcripts evidently write numbers as words *and* digits. Greedy
stitches halves of each: "አምስት" → `5mሰት`, the year → `boሁለትሺi0ህ 20`.
`_masked_token_ids` now removes Latin a–z, 0–9 and ASCII symbols from the
logits (`AMH_TOKEN_MASK`, empty disables). Numbers CER 37.1% → 31.0%; the 19
CV clips byte-identical; long5min 50.1% → 49.6% WER. A beam constraint that
lets digits and letters compete as whole words was tried and scored no better
than the mask, so it was dropped.

**2. VAD trimming was clipping speech** (follows §1.2l). Grid over the
trim margin, same staged runtime, VAD asserted live. CER:

| config | clean | music | noise | phone | reverb | 2spk | long5min | numbers |
|---|---|---|---|---|---|---|---|---|
| trim, 0.05 s margin (old) | 19.8 | 27.1 | 28.6 | 66.4 | 48.4 | 18.8 | 16.9 | 31.0 |
| trim, 0.2 s | 17.5 | 18.6 | 27.1 | 58.7 | 43.8 | 21.2 | 13.4 | 19.0 |
| trim, 0.3 s | 16.3 | 18.5 | 28.6 | 57.9 | 41.9 | 18.6 | 16.4 | 22.4 |
| trim, 0.5 s | 16.9 | 18.6 | 28.0 | 49.2 | 40.4 | 18.0 | 17.1 | 22.4 |
| trim, 0.2 s + 0.3 s gap | 17.9 | 19.2 | 26.8 | 59.2 | 43.5 | 17.8 | 13.4 | 21.6 |
| **no trim, VAD plans windows (new)** | 16.6 | 15.8 | 27.6 | **31.8** | 44.7 | 15.4 | **13.2** | 22.4 |

The gap between concatenated segments barely matters; the margin does —
the cut was eating word edges. Phone is the headline: Silero misses
narrowband speech, so trimming discarded real words (this likely also
explains the older 57.6% phone figure, measured when VAD was silently off).

Checked before switching: 8 s of music bed, crowd noise or room tone before a
real sentence produced **no** captions with trimming off; appending 0.5 s of
digital zero to all 19 CV clips emptied none of them; long5min wall time
unchanged (78–80 s vs 73–80 s). One regression: the synthetic `short1`
(1.7 s, ends in 0.35 s of digital zero) now decodes empty instead of a wrong
"የንደሚ አደ" — its output flips on 50 ms edits either way and no variant is
correct. Numbers remaining errors (ሁለት, ዘጠኝ→መጠኝ, ዜሮ→ሜሮ) are acoustic and
consistent across every config: retrain territory (IMPROVEMENTS.md B3.5).

**Follow-up — captions write numbers as digits.** The owner chose digits
(ዓመቱ 2026 ነው) over spelled-out words. Since the model may no longer emit digit
tokens, `amh_correct.numbers_to_digits` converts the spelled-out words after
decoding: cardinals (ሁለት ሺህ ሀያ ስድስት → 2026), phone numbers (ዜሮ ዘጠኝ … →
09…), decimals (አራት ነጥብ አምስት → 4.5), ranges (ሁለት ሦስት → 2-3) and a
leading በ/ከ/የ/ለ/እስከ (→ በ2016). A lone አንድ stays a word (it is usually the
article "a"); counting runs stay separate (1 2 3). `AMH_DIGITS=0` disables.

The CTC model also *glues* number words into one token (ሁለትሺህ, ዜሮዘጠኝአንድ,
አስራአምስት, መቶሁለት) — `numbers_to_digits` splits a token that is a full tiling
of number vocabulary into its parts before converting, so those become digits
too (በሁለትሺህ → በ2000). A real word that merely *starts* with a number word
(አንድነት, ሁለተኛ, አስረኛ, መቶኛ) is never touched — the whole token must tile.

Scoring: `wer.py` spells caption digits back into words before comparing, so
WER/CER still measure recognition and stay comparable with every earlier
run — verified: numbers clip 51.7% / 22.4% with the pass on and off, 19 CV +
numbers pooled unchanged at 45.2% / 16.5%. Scoring digits on both sides was
tried first and rejected: one wrong digit fails a whole phone number and CER
exceeded 100%. `wer.py` also no longer mistakes an all-digit caption line
("2026" in karaoke mode) for a cue index. Every digit across all 31 fixture
outputs was reviewed by hand: no false conversions (real `abu.mp4`:
"ሶስት ትኩረት" → "3 ትኩረት" correct, "አንድ ስራ ፈጣሪ" left alone).

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
| Export SRT | Valid `.srt`, sequential numbering, `HH:MM:SS,mmm` timestamps, saved to Documents/AmharicCaptions |
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
| 12 | Machine-ID copy | Clipboard gets the 16-char installation ID (legacy 8-char IDs remain readable); button shows ✓ Copied |

**Test keys** (use for scenario 4): generate via `python3 tools/keygen.py <machine_id>`.
Cross-check a negative: a hand-edited sig must FAIL (`tools/keygen.py` is the source of
truth).

**Kinds of check, and who does them:** the panel only checks a key's *structure*
locally (format/length, machine-ID binding, expiry); the **server is authoritative**
for validity — `ACTIVATE` is confirmed against the Worker's database and returns the
server's real expiry, and any caught-corruption/tamper comes back as `reason: invalid`.
Scenarios 4–9 above are therefore verified end-to-end in Premiere with a live key, plus
automatically in `tools/test/test_panel.js` (local structure) and
`tools/telegram-worker/test/e2e.mjs` (server: forged key → semantic `valid:false`,
wrong machine → `mismatch`, stale/revoked/expired → an explicit reason). Trials
(scenarios 1–3, 11) are synchronized with the server before a run, charged with
an idempotent run ID after a result is produced, and an unconfirmed/exhausted
charge blocks the review and placement flow. The trial gate covers clip,
active-sequence, work-area, and imported-file paths (`run()` and `runFile()`).

---

## 6. Failure & Edge Cases

| Area | Failure injected | Expected behavior |
|------|------------------|-------------------|
| Runtime | Delete `runtime/model` | "runtime incomplete" status + clear diagnostic log |
| Runtime | Rename `runtime` to `runtime-backup` | "runtime missing" + path diagnostics |
| python | Point `AMH_MODEL_DIR` at wrong dir | Clean Python error surfaced in log |
| ffmpeg | Feed a **corrupt/truncated** file | Clean "ffmpeg failed" / "Python failed" error, no hang |
| ffmpeg | Very short clip (<1s) | No crash; min-duration enforced or clean error |
| python | `silence.wav` (no speech) | FIXED: energy floor (`_preflight_audio`, RMS < `AMH_SILENCE_RMS` ⇒ empty transcript) — no cues, no traceback (see §1.2f; blank gate PASS in `run_engine.sh`) |
| python | **ultra-short clip** (<560 samples, ~35 ms) | Clean "audio too short" error — per-clip skip + `skipped:N` in batch/server, exit 1 on the CLI; long-clip degenerate windows skipped, never fatal (fixed §8#4; see §1.2e) |
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
   It also exercises the per-clip batch cache end-to-end (single-clip cache sharing,
   all-cached fast path, edit re-transcribes only the changed clip). **FIXED
   2026-09-20:** none of this ran in CI before — `.github/workflows/build.yml`
   now has a `test` job (panel unit + DOM, host-safety, machine identity, both
   self-checks, `test_long.py`, `test_diarize.py`, `test_mel_short.py`, and the
   Worker's 53-check `e2e.mjs`) that is a **required gate on `release`** — a
   regression now blocks the public zip from being cut, not just from being
   noticed later. The separate `accuracy-gate` job runs the real-golden WER gate
   (§1.2g) on every build and is also required; it is intentionally RED until
   the WER ≤15% target passes.
3. **No golden audio `fixtures/`** — harness built 2026-09-19; real recorded
   goldens added 2026-09-19, accuracy gate measured (§1.2g). `tools/test/wer.py`,
   `tools/test/run_engine.sh` (now `--fixtures DIR` + `--max-wer` aware) and
   `tools/test/test_srt.py` are implemented (see §9) and were scored against the
   shipped CT2 int8 model: the committed fixtures (`fast/news/noisy/names/
   numbers/interview/long5min/short1`) are **synthetic (TTS register)** and every
   one clears no gate — WER 50–107% (the model blurs sub-words, e.g. አበበ→አበባ,
   ሰዎች→ሰሞች) — while the REAL clip `tools/test/fixtures_real/abu.mp4.wav`
   transcribes into fluent grammatical Amharic. Synthetic fixtures therefore
measure worst-case voice transfer, not real accuracy. Real recorded goldens
    landed 2026-09-19 (20 Common Voice Amharic clips, CC0; §1.2g): scored via
    `run_engine.sh --fixtures tools/test/fixtures_real --max-wer 0.15`, the
    ≤15% gate is currently RED — WER 0–100% (mean ≈ 52%), CER mean ≈ 19%, 3 of
    19 clips perfect, pass 6/38 — inflated in part by orthographic-variant and
    word-boundary confounds, plus a known class of vowel-length variants (details
    and a pending 600M-model A/B in §1.2g). The `silence` blank-fixture gate
    passes (energy floor, §1.2f).
4. **Mel extractor on ultra-short (<400 sample) audio degrades** — **FIXED**:
   fewer than two mel frames made the ddof=1 per-bin variance NaN, which flowed
   into the model as garbage. `amh_mel.MelExtractor` now raises a clean
   `ValueError("audio too short …")` below 560 samples (400 frame + 160 hop =
   35 ms @ 16 kHz) — the batch/`--server` callers treat it as a per-clip skip
   (`skipped:N`), the single-shot CLI prints a clean error and exits 1, and a
   degenerate *window* of a long clip is skipped, never fatal. Regression tests:
   `python3 tools/test/test_mel_short.py` (real assets) and section 5 of
   `tools/test/test_long.py` (stub engine).

---

## 9. Targeted Testing Harness (implemented 2026-09-19)

`tools/test/` now contains the offline accuracy/structure harness:

```
tools/test/
  fixtures/          (committed: synthetic TTS set — see §8#3 for scored results)
     fast/interview/long5min/names/news/noisy/numbers/short1/silence/twospeaker
  fixtures_real/     (REAL recorded .wav goldens — committed: abu.mp4.wav plus
     20 Common Voice Amharic clips added 2026-09-19; <name>.txt truth alongside,
     run_engine picks both up — see §1.2g)
  wer.py             (WER between ground truth and an SRT/transcript; strips
     Ethiopic punctuation + [S1]/[S2] speaker labels; --max-wer gate; empty
     truth must match an empty hypothesis)
  run_engine.sh      (loop over fixtures, run ethio_srt.py karaoke+grouped, score WER
     + test_srt.py structure per mode; exits 1 on any failure)
  test_srt.py        (validate SRT structure: numbering, timing order, 1-5s cues,
     no empty text)
  # License-key validation has no script of its own: `tools/keygen.py` generates
  # keys, the panel's structural checks are covered by `node tools/test/test_panel.js`
  # (`validateLicense` matrix), and the server's HMAC + D1-`ROW existence checks
  # are covered by `tools/telegram-worker/test/e2e.mjs`. See §5.
```

Commands (RUNTIME must be a built extension runtime dir with `python/bin/python3`,
`ethio_srt.py` and the model — e.g. the installed extension's `runtime/`):

```bash
RUNTIME=/path/to/.../com.amharic.captions/runtime tools/test/run_engine.sh --fixtures tools/test/fixtures
tools/test/run_engine.sh --fixtures tools/test/fixtures_real --max-wer 0.15   # real-golden gate (§1.2g)
python3 tools/test/wer.py --truth tools/test/fixtures/news.txt --hyp /tmp/out.srt --max-wer 0.40
python3 tools/test/test_srt.py /tmp/out_karaoke.srt    # SRT structure check (arg: path)

# Per-condition robustness (§1.2h) — how much a REAL editing job costs vs the
# clean read speech the gate measures. Needs AMH_MODEL_DIR (or a runtime).
python3 tools/test/robustness_report.py                 # all 19 clips x 5 conditions
python3 tools/test/robustness_report.py --max-clips 5   # quick pass
python3 tools/test/robustness_report.py --snr 5 --keep-audio /tmp/rb   # harsher + listen
python3 tools/test/robustness_report.py --dereverb   # A/B the §1.2i filter (rejected)
python3 amh_dereverb.py                              # its own self-check
# NB: do NOT edit robustness_report.py while a run of it is in flight — python
# reads the file once at startup, and that is how the first §1.2h table was wrong.
```

**Definition of done for "unquestionable":** every scenario in sections 1–7 has a
recorded pass and the automated harness runs green (structural/robustness
suites); known-gap #1 is fixed. The real-golden accuracy gate (§1.2g) remains
honest instrumentation whose red result is logged, not hidden.

---

## 10. Suggested Run Order (fastest -> most complete)

1. Offline engine smoke test (A) — validates the model works at all.
2. `ctc_beam.py` + `amh_correct.py` self-checks.
3. Quality golden set WER — run `tools/test/run_engine.sh --fixtures tools/test/fixtures_real --max-wer 0.15` over the real recorded goldens added 2026-09-19 (see §1.2g / §8#3).
4. Options matrix (B, C, D, E, F).
5. License 1–12 (all in Premiere).
6. Source matrix 1–5 + edge cases (in Premiere).
7. Export/format.
8. Failure/edge injection + cancel.
9. Cross-platform pass.
