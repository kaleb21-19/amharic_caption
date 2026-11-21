# Cut-quality test set (phase 0)

The silence cut and edit-with-text are measured on **real Amharic clips with
hand-checked word times**, not guessed. This folder holds the measuring tool;
the clips themselves stay on the owner's computer (`tools/eval/set/` is in
`.gitignore` — real people's voices are never committed).

## The set: 10 clips

| What | How many |
|---|---|
| Interview / talking head, one speaker | 4 |
| Two speakers (podcast) | 2 |
| Background music under the voice (about −20 dB) | 3 |
| One long clip (about 10 minutes) | 1 |

Each clip gets its own folder:

```
tools/eval/set/<name>/
  audio.wav        16-bit mono WAV of the clip (ffmpeg -i clip.mp4 -ac 1 -ar 16000 -c:a pcm_s16le audio.wav)
  captions.srt     the program's captions for it (+ captions.srt.words.json next to it)
  words.txt        the hand-checked word times (Audacity labels)
```

## Quick: pauses only (2–3 minutes a clip) — enough for the silence cut

1. Make the clip folder from any video (the program's own ffmpeg is used):
   `python tools/eval/cut_eval.py prepare "C:\path\clip.mp4" -o tools/eval/set/clip1`
   It writes `audio.wav`, `env.json` (the loudness exactly as the panel measures it)
   and `pauses.txt` — the quiet parts the program hears, already marked.
2. Open `audio.wav` in **Audacity**, then **File → Import → Labels…** and choose `pauses.txt`.
3. Play it and fix the marks so each one covers a real pause (silence or breath between words):
   - drag a mark's edges to where the voice stops and starts again;
   - delete a mark that is not a pause (click it, **Ctrl+A** in the label, Delete the text, then remove the label);
   - add a missed pause: select it on the waveform and press **Ctrl+B**, type `pause`, Enter.
   Short or long does not matter — mark every real pause.
4. **File → Export → Export Labels…** over `pauses.txt`.
5. Score the panel's silence detection on it:
   `python tools/eval/cut_eval.py score tools/eval/set/clip1`
   → how many cuts reach into speech, and how many pauses (≥ 0.8 s) it removed.

## Labelling one clip word by word (about 5–10 minutes) — needed later, for word timing

1. Make the captions in the program as usual and keep the `.srt` and `.srt.words.json`.
2. Make the draft labels from the program's own word times:
   `python tools/eval/cut_eval.py draft captions.srt -o words.txt`
3. Open `audio.wav` in **Audacity** (free), then **File → Import → Labels…** and choose `words.txt`.
4. Drag each label's edges to where the word really starts and ends (zoom in; the
   waveform shows it). Fix a wrong word's text if needed — only the edges matter most.
5. **File → Export → Export Labels…** over `words.txt`.

## Measuring

```
python tools/eval/cut_eval.py score   set/x                                              # silence cut vs your pauses (quick way)
python tools/eval/cut_eval.py detect  set/x --min 0.8                                    # the cuts the panel would offer
python tools/eval/cut_eval.py edges   set/x/words.txt set/x/captions.srt                 # word-edge error (ms), per minute
python tools/eval/cut_eval.py midword set/x/words.txt cuts.json                          # cuts inside a word
python tools/eval/cut_eval.py pauses  set/x/words.txt cuts.json --audio-len 63.2 --min 0.8
python tools/eval/cut_eval.py clicks  exported.wav --joins 4.20,9.85                     # clicks at the joins
```

`cuts.json` = the list of `[start, end]` the panel removes (written to the panel's
Log as "✂ N cut(s)"). Each command prints one line; add `--max` / `--min-ratio` /
`--max-median` to make it fail (exit 1) when a limit is missed.

## The acceptance limits (from the rebuild plan)

| Feature | Test | Limit |
|---|---|---|
| Silence cut | cut edges inside words, 10 clips | 0 |
| Silence cut | pauses ≥ chosen length removed, incl. start/end | ≥ 95% |
| Silence cut | pauses found with background music | ≥ 80% |
| Both | clicks at joins in the exported audio | 0 |
| Edit with text | word-edge error | median ≤ 50 ms, p95 ≤ 120 ms, no worse at minute 10 |
| Edit with text | 100 random single-word deletions inside words | 0 |
