# Windows runtime verification

`verify_win.cmd` runs a read-only health check against the extracted
win-x64 runtime. It verifies the exact class of failure the previous
installer shipped, **without** installing anything or touching the customer's
CEF registration: every bundled file is present, the bundled Python can import
the real dependency chain, the CTranslate2 model loads (int8, same class +
MelExtractor the engine uses), and `ffmpeg.exe` actually runs.

## How to run

1. Unzip `amharic-captions-win-x64.zip` anywhere (e.g. `Desktop\amh-test`).
   Keep zip **and** extracted folder **both open** in Explorer.
2. Right-click `verify_win.cmd` inside the extracted folder → **Run as
   administrator** (not needed, but harmless).
3. Read the tail of the console: `ALL CHECKS PASSED` or a `[FAIL]` list with
   the named file.

Exit codes: `0` = all passed, `1` = one or more failed.

## What it checks

| Check | File / command |
|---|---|
| python.exe + python311.dll | `runtime\python\` |
| ffmpeg.exe presence | `runtime\bin\ffmpeg.exe` |
| ffmpeg runs | `ffmpeg -version` |
| model.bin / model_meta.json / vocab.json / config.json | `runtime\model\` |
| speaker_embed.onnx, silero_vad.onnx, amh_lm.json.gz | `runtime\` |
| `import numpy, soundfile, ctranslate2` | bundled python |
| `import onnxruntime` (VAD) | bundled python |
| `import sherpa_onnx` (diarization) | bundled python |
| model + mel load | `ctranslate2.models.Wav2Vec2Bert(pcx, compute_type=int8)` + `MelExtractor`, vocab size asserted |

## Why these build numbers

- ctranslate2 4.8.1 · numpy 2.4.6 · soundfile · onnxruntime 1.19.2 · sherpa_onnx
  — these are the exact wheels packaged in `com.amharic.captions/runtime/python/site-packages`,
  so the check reflects production, not a dev venv.
- The model load uses the **same** `Wav2Vec2Bert(..., device='cpu',
  compute_type='int8')` + `MelExtractor(model_dir)` paths the engine hits at
  real transcription start-up.

## Re-packaging

After any change that rebuilds `dist/amharic-captions-win-x64.zip`, re-add this
file as `verify_win.cmd` **at the zip root** (sibling of `Install.cmd`), keep it
CRLF (`perl -pi -e 's/\r?\n/\r\n/'` or `.gitattributes` `*.cmd text eol=crlf`),
and update the win-zip build task to include it so customers get the harness
for free.