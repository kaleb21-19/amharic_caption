# Improving the Amharic ASR model — deep research (2026-09-19)

Question: *how can we improve this model, what can we do?*

This document audits where accuracy is lost today, surveys what the field does
for low-resource Amharic ASR (2025-2026 literature + open datasets/models), and
turns that into a ranked, executable backlog. Every item respects the product's
hard constraint: **offline, CPU-only, CTranslate2 int8 runtime**.

---

## Part A — Where we stand today (audited facts)

### The shipped stack

| Piece | Today | Notes |
|---|---|---|
| Acoustic model | `badrex/Ethio-ASR-amharic` — Wav2Vec2Bert (24 layers, hidden 1024), CTC head, 411-token Ethiopic grapheme vocab | trained on WAXAL; per the Ethio-ASR paper the suite's best averages **~30% WER on the WAXAL test set** |
| Runtime | CTranslate2 int8 (`tools/stage/model-ct2-int8`, **584 MB**) + pure-numpy Kaldi mel (`amh_mel.py`) | no torch at runtime |
| Decoding | Greedy argmax, or CTC prefix beam search (`ctc_beam.py`, beam 24, top-k 16) | beam carries per-char alignment for timing |
| Word rescue | Word-LM OOV splitter (`amh_lm.py`, 3.3 MB unigram+bigram, min-margin 4.0 nats) + hand-verified `SPLIT_FIXES`/`WORD_FIXES` | fixes glued words only |
| Punctuation | Rule-based ።/፣ from inter-word gaps | no model knowledge |
| Pre/post audio | Silero VAD trim (skip music-only regions), windowed long audio, resume journal | |
| Retrain pipeline | WAXAL fetch → prep → head-only fine-tune (encoder frozen, no SpecAugment) → WER gate → CT2 int8 | local GPU or free Kaggle T4 |
| Measured quality | Real held-out WAXAL WER **0.227**; synthetic TTS fixtures 60–114% WER (domain mismatch); gate is relative (current vs retrained on 40-clip holdout) | gate is honest but tiny |

### Where accuracy is actually lost

1. **Acoustic model errors** — substitution of look-alike glyphs (የገንዘብ→የገንነብ,
   በዚህ→በሊህ), numbers mangled, proper nouns wrong. This is the dominant cost and
   only retraining / a better checkpoint fixes it.
2. **No external LM at decode time** — the beam is purely acoustic. The word-LM
   only rescues *post-hoc* OOV glue cases; it cannot rescore near-tie beam
   hypotheses where the acoustics are genuinely ambiguous.
3. **Head-only fine-tuning on a small slice** — current pipeline freezes the
   encoder (600M params) and trains the CTC head on a few hundred WAXAL rows
   (400-row manifest today), with no SpecAugment (config has
   `mask_time_prob: 0.0`), no speed/tempo perturbation, no lr warmup schedule
   beyond a linear decay, and no CER/WER eval during training.
4. **No character-level metric in the gate** — WER on agglutinative Amharic is
   brutal (one glued word = one error); CER tracks progress better and
   ETHIC-correctness (vowel length / gemination — the paper shows these drive a
   large share of errors) is invisible at word level.
5. **VAD/trimming is on by default** — helps music, but a mis-triggered VAD can
   clip speech; no measurement of how often this hurts.

---

## Part B — What the research and ecosystem offer

### B1. Better / newer checkpoints (highest leverage)

- **Ethio-ASR suite grew.** `badrex` now publishes a multilingual 600M CTC model
  (`Ethio-ASR-multilingual-600M`, Apr 2026) whose average WER beats the
  monolingual model's generation (paper: best suite model ≈ **30.48% WER** on
  WAXAL, beating OmniASR baselines at lower param count). The repo currently
  pins the older monolingual checkpoint. → Simply converting the newest suite
  checkpoint to CT2 int8 could drop WER with **zero code changes** (same
  Wav2Vec2Bert architecture, same vocab pipeline — verify blank_id/vocab).
- **Community benchmarking is active.** A 2026 Hugging Face benchmark of 6 open
  Amharic models on 1,548 fresh recordings exists (findings: smaller 606M model
  beat a 963M model by 24% relative). → Re-run our 40-clip holdout + WAXAL dev
  slice against the top models on that list before investing in training.
- **Whisper fine-tunes for Amharic exist** ("Whispering in Amharic", 2025) and
  faster-whisper/CT2 supports Whisper natively (int8, well-optimized). Whisper
  gives punctuation + digit handling for free. Risks: model size (large is too
  big for the runtime; small/medium may lose to Wav2Vec2Bert on Amharic),
  hallucination on silence/music (needs the Silero VAD gate we already have),
  and its non-CTC decode changes the timing path (cross-attention DTW like
  WhisperX). → *Evaluate*, don't assume: same holdout, same gate.

### B2. More data (the classic lever, still the strongest training lever)

| Corpus | Size | Domain | Notes |
|---|---|---|---|
| WAXAL amh_asr (in use) | hundreds of hours; full split ~10 GB parquet | broadcast/media, spontaneous | already integrated; only ~400 rows prepped so far |
| ALFFA Amharic (OpenSLR 25) | ~20 h | read news | matches `news` fixture domain |
| MWACS / "Building a Robust Amharic ASR" (NeurIPS 2024 workshop) | ~110 h | mixed | wav2vec2 recipe published |
| Kaggle Amharic Speech Corpus (2025) | ~20 h, 100 speakers, 10,850 sentences | read | clean multi-speaker |
| FLEURS am_et | ~10 h | read (Bible-ish) | standard eval set |
| WorldSpeech (2026) | 65k h multilingual, incl. Ethiopian langs | mixed | mining source |
| User audio (owned) | unbounded | **the actual product domain** | Premiere users cut Ethiopian media |

Key insight: the biggest *untouched* corpus is the users' own audio. Because the
panel runs offline, collect **opt-in** transcripts (never audio content without
consent — license already requires per-machine keys, so ask at activation).

### B3. Training techniques that matter for low-resource CTC

1. **SpecAugment** — the single most cited low-resource regularizer. The
   checkpoint ships with masking disabled (`mask_time_prob: 0.0`); enable
   (`mask_time_prob 0.05–0.1`, `mask_feature_prob 0.0–0.05`) during fine-tune.
   Free +2-5% relative in most published low-resource recipes.
2. **Unfreeze the encoder (staged).** Head-only fine-tune can't fix acoustic
   confusions (ገ/ነ, ዚ/ሊ). Recipe: 1 epoch head-only → unfreeze last 6–12
   layers at lr 1e-5–3e-5 (vs 3e-4 for the head) → full unfreeze only if data
   ≥ 50 h. Avoids catastrophic forgetting on a 600M model.
3. **Speed/tempo perturbation** (0.9/1.0/1.1) + gain jitter + MUSAN mixing
   (already implemented — keep it) + **RIR room reverb** (openSLR 28 convolve,
   cheap, helps `noisy`).
4. **Self-training / pseudo-labeling** — the standard modern recipe for
   low-resource ASR (Noisy Student, 2024-25 lit): transcribe untranscribed
   audio with the current model, keep high-confidence utterances (mean token
   log-prob threshold), add them (optionally with MUSAN noise) as pseudo-labels,
   retrain, iterate 1–2 rounds. Pairs perfectly with (a) full WAXAL unlabeled
   audio, (b) user-domain audio.
5. **TTS augmentation** — LREC 2026 studied synthetic-data conditions for
   low-resource ASR; Amharic TTS quality is now usable (Addis Voice 2: 4.4%
   CER). Effective mainly for **numbers, names, homophone contrast** — exactly
   our fixture weaknesses. Generate with TTS + MUSAN mix at varied SNR.
6. **Decoding: LM fusion.** Publish-side evidence (deep fusion / shallow fusion,
   2025) shows external-LM fusion beats post-hoc fixing for CTC. Concretely:
   extend `ctc_beam.py` scoring with `score += λ · logp_lm(word | prev_word)`
   when a word boundary is crossed (KenLM-style trigram from the same corpus the
   word-LM was built from; λ ≈ 0.3–0.6). Keep pure-numpy; the word-LM data is
   already shipped (3.3 MB). This is the highest-leverage *inference-side*
   change and doesn't require retraining.
7. **Homophone/grapheme normalization at scoring time.** Amharic has a
   documented homophone problem (ሀ/ኀ/ሃ, ሠ/ሰ, ጸ/ፀ). The papers normalize
   equivalent graphemes before WER; the product could apply a conservative
   *canonicalization* for display-risk-free classes (ኀ→ሀ family) — verify with
   native speakers first.
8. **Eval hygiene**: report WER **and** CER on every gate; keep the WAXAL
   holdout fixed; add a small real-speech holdout (record 30 min of
   representative material once) because TTS fixtures don't transfer.

---

## Part C — Ranked backlog (impact × effort, offline constraint respected)

### Tier 0 — no training, days, big expected wins

1. **Upgrade the checkpoint** (C/B1): convert `Ethio-ASR-multilingual-600M` (or
   the newest best-on-benchmark suite model) to CT2 int8 with
   `tools/make_model_ct2_int8.sh`; run `04_eval_wer.py` against the current
   model on the WAXAL dev slice + the honest fixture set. Acceptance: mean WER
   strictly lower than 0.227-baseline. Cost: one Kaggle session + one command.
2. **LM fusion in the beam decoder** (B3.6) — **wired, not yet tuned/measured**
   (2026-09-20): `ctc_beam.py` now takes `lm=`/`lambda_lm=`, wired through
   `ethio_srt.py` via `AMH_LM_LAMBDA` (lazy-imports `amh_lm` only when > 0).
   Delegates the OOV-rescue decision to `lm.split_word()` (same vetted logic
   `amh_correct`'s post-pass uses) rather than re-deriving it, and resets the
   per-word token buffer at every space (an early draft leaked word_tokens
   across boundaries — fixed) plus scores the utterance's trailing word at
   final beam selection (it has no following space to trigger scoring
   otherwise). Regression-tested in `ctc_beam.py`'s self-check (`AMH_LM_LAMBDA=0`
   byte-identical to `lm=None`; word-boundary reset + trailing-word scoring
   verified with a stub LM under `beam_width=1`). Verified end-to-end against
   the shipped CT2 model (identical output at λ=0, no crash at λ=0.5).

   **Critical follow-up fix (same day):** the space-boundary detection looked
   for a literal `" "` glyph, but the real model's vocab encodes the
   word-delimiter as the raw string `"|"` (`vocab.json["|"] == 0`) — so
   `_SPACE_ID` was `None` against the real model and the whole feature was
   **silently inert even when λ > 0**, despite passing the earlier "verified
   end-to-end" check (that check only proved "doesn't crash," not "does
   anything," on a clip with no glued words). Fixed the detection to match
   `"|"`; the self-check's stub glyphs now deliberately use `"|"` too so this
   exact regression can't slip past unnoticed again.

   **Qualitative validation post-fix:** ran the real model's output through
   `lm.split_word()` on every long token from all 20 real fixtures. It found
   8 rescuable glued runs, most good (`ተግቶመራአብረው`→`ተግቶ መራ አብረው`,
   `እኩልወይም`→`እኩል ወይም`) but at least one likely wrong
   (`የፈጠራቸው`→`የፈጠራ ቸው` — probably a single inflected word ["created them"],
   not two; `ቸው` is corpus count 5, right at `min_part_count=3`, and looks
   like a verb-suffix artifact rather than a real standalone word). None of
   this moved the scored 20-clip gate's pass/fail either way, because the one
   fixture containing most of the rescuable words (`abu.mp4.wav`) has no
   ground-truth `.txt` and isn't scored.

   **Still open, deliberately not guessed at:** (a) a λ sweep against a real
   WER measurement — needs a fixture set that actually contains glued words
   *with verified ground truth*, which doesn't exist yet (won't fabricate
   truth text for audio I can't verify by ear); (b) whether tightening
   `min_part_count`/`min_margin`/a minimum part length in `amh_lm.py` fixes
   the `ቸው`-style over-split without breaking already-validated good splits
   like `ውሃ` (2 chars) in `amh_lm.py`'s own self-check — this is a real
   precision/recall trade-off that needs the same eval set, not a guess.

   **Also checked and ruled out as a further lever:** swept beam-search
   `top_k`/`beam_width` (8/16/32/None × 24/50) against the real 19-clip set —
   every combination gave the *identical* mean WER (0.3705). The CTC
   posteriors are peaked enough that top_k=8 already captures the winning
   path; decode-parameter tuning is saturated here. Confirms the acoustic
   model itself (Tier 0 #1) is the real lever, not search breadth.
3. **Fix the WER gate's decode parity** — **DONE (2026-09-20)**: `04_eval_wer.py`
   now takes `--decode {greedy,beam}` (beam uses the same `ctc_beam.py`, matched
   to production's actual `AMH_BEAM_TOP_K`/`AMH_BEAM_WIDTH` defaults, not an
   unbounded search). Real finding on the 19 scored clips: greedy mean WER
   37.6% vs beam mean WER 37.0% — **only marginally better overall, and not
   uniformly**: beam fully fixed one clip (50%→0%) but made three others worse
   (e.g. 10%→20%, 16.7%→33.3%). Confirms the parity gap was real (a candidate
   could look fine greedy and ship worse), but also that beam search is a
   double-edged sword here, not a strict upgrade — worth keeping both numbers
   visible rather than assuming beam always wins.

### Tier 1 — one retrain cycle, ~1 week

4. **Serious fine-tune run** (B3.1–3): all WAXAL amh shards (not 400 rows) →
   SpecAugment on → staged unfreeze (last 12 layers, lr 3e-5) → speed/tempo
   perturbation + MUSAN → eval CER+WER every 500 steps on dev+holdout → keep
   best-by-CER checkpoint, gate with Tier-0 #3 tooling. Expected: the single
   biggest accuracy jump of the whole plan.
5. **Grow the word-LM with WAXAL text** (build_lm.py --corpus over all WAXAL
   transcriptions): more unigrams/bigrams → fewer false OOV splits, better
   margins, better fusion scores. Cost: minutes; re-run
   `python3 tools/build_lm.py ...` and swap the gz.

### Tier 2 — iterative gains, ongoing

6. **Self-training round(s)** (B3.4): pseudo-label full unlabeled WAXAL audio +
   any opt-in user-domain audio with the Tier-1 model; filter by confidence;
   retrain. One round typically buys a few points; iterate while it pays.
7. **TTS augmentation for digits/names** (B3.5): targeted, only if fixture
   weaknesses persist after Tier 1.
8. **Opt-in data collection from the panel** (B2): consented error reports
   ("this caption is wrong") give free, in-domain labeled data for Tier 1/2
   retrains — the corpus nobody else has.
9. **RIR reverb augmentation** (B3.3) for the `noisy`/music failure class if
   MUSAN alone plateaus.
10. **Speaker-label + punctuation upgrades**: once the acoustic model is
    retrained, revisit punctuation from pauses (maybe learned from WAXAL text
    bigrams at sentence ends instead of fixed 0.6/0.3 s gaps).

### Watchlist (don't do yet)

- **Whisper/CT2 swap** — only if the newest Ethio-ASR checkpoint still loses to
  a fine-tuned small/medium Whisper on our holdout; would need a new timing
  path (DTW) and hallucination defenses.
- **RNN-T / transducer** — better streaming story, but a runtime rewrite; the
  product isn't streaming.
- **Bigger multilingual models (963M+)** — the 2026 benchmark already showed
  size ≠ Amharic accuracy; int8 runtime size also balloons.

---

## Part D — Concrete next actions (in order)

1. `python3 tools/retrain/04_eval_wer.py --manifest tools/stage/waxal/dev.tsv
   --candidate <new-suite-checkpoint> --decode beam` (after adding beam parity)
2. Kaggle notebook run with `--max-shards all`, SpecAugment on, staged unfreeze.
3. Rebuild word-LM over the full WAXAL text; add shallow fusion to the beam.
4. Re-run honest fixture set; if KEEP → `install_retrained.sh` as usual.

## Sources

- Ethio-ASR paper (arXiv 2603.23654): suite trained on WAXAL, best ≈ 30.48% WER
  on WAXAL test; vowel length + gemination drive error classes.
- HF model page + collection (badrex/Ethio-ASR-*, 2026).
- "Whispering in Amharic" (arXiv 2503.18485, 2025): Whisper fine-tuning recipe +
  homophone normalization for Amharic.
- "Augmenting Wav2Vec 2.0 for Superior ASR in Low-resource settings" (arXiv
  2501.00425): augmentation recipe for low-resource wav2vec2 fine-tunes.
- NeurIPS 2024 workshop "Building a Robust Amharic ASR" (110 h corpus, wav2vec2).
- Noisy-student / self-training for low-resource ASR (ACL SIGUL 2024; surveys
  2025); deep/external-LM fusion for low-resource E2E ASR (Electronics 2025).
- LREC 2026: synthetic (TTS) data augmentation conditions for low-resource ASR.
- WAXAL corpus (Google research blog): amh_asr scale; WorldSpeech 2026 paper
  (1,250 h African corpus; 65k h multilingual).
- Community benchmark: 6 open Amharic ASR models on 1,548 recordings
  (chapimenge, LinkedIn 2026-09).
