# Amharic Captions — Cross-Platform Install & Build

The panel is **self-contained**: everything it runs lives in a `runtime` folder
inside the extension directory, so a user just copies the extension folder and
opens Premiere. No Python, ffmpeg, or model install is needed on their machine.

## Layout

```
com.amharic.captions/          <- copy this whole folder into Adobe CEP extensions
  CSXS/manifest.xml
  index.html
  js/main.js  js/CSInterface.js
  jsx/host.jsx  jsx/json2.jsx
  runtime/                     <- self-contained (built per platform)
    ethio_srt.py
    amh_mel.py                 <- standalone numpy mel extractor (no torch)
    bin/ffmpeg[.exe]           <- STATIC build required
    python/                    <- relocatable Python 3.11 + ctranslate2/numpy/soundfile
    model/                     <- CTranslate2 INT8 model (~582 MB) + mel/vocab assets
```

`js/main.js` detects the platform (Windows/Mac) at load, resolves these paths
relative to the extension, and shows `ready · win` / `ready · mac` in the status
pill. If any piece is missing it reports `runtime incomplete` and names the gap.

## 1. Build the 3 target zips

Ship three separate zips (the panel files are identical in each; only the
`runtime/` content differs because **ctranslate2 is platform- and arch-specific**):

| Zip | Target | Runtime built on |
|-----|--------|------------------|
| `amharic-captions-mac-arm64.zip` | Apple Silicon Mac | an Apple Silicon Mac |
| `amharic-captions-mac-x64.zip`   | Intel Mac | an Intel Mac |
| `amharic-captions-win-x64.zip`   | Windows x64  | a Windows x64 PC |

The pipeline is split into two steps so a single shared repo builds all three —
you only need to run step 1 on each OS, and step 2 (the zip) on any machine.

### Step 0 — build the CTranslate2 INT8 model once (any machine)

```
# downloads badrex/Ethio-ASR-amharic (fp32) and converts to CTranslate2 int8,
# writing tools/stage/model-ct2-int8 (~582 MB) + numpy mel/vocab assets.
tools/make_model_ct2_int8.sh
```

Requires a dev venv with `transformers` + `torch` + `ctranslate2` + `scipy`
(the conversion only; none of these ship in the runtime).

### Step 1 — prepare the runtime (run ON each target OS/arch)

```
# macOS (Apple Silicon or Intel)
bash tools/prepare_python.sh

# Windows (native build, assemble-only)
bash tools/prepare_python.sh     # under Git-Bash/WSL: python + ffmpeg + ctranslate2
powershell -ExecutionPolicy Bypass -File tools\build_win.ps1   # then assemble + zip
```

`prepare_python.sh` downloads a **relocatable CPython**
(python-build-standalone) for the target, pip-installs the tiny ML runtime
(`ctranslate2` + `numpy` + `soundfile`, ~50 MB), prunes pip/setuptools, and
fetches a **static** ffmpeg, all into `tools/stage/<target>/`.

> **Why not a system `python3 -m venv`?** macOS's system/Xcode python is not
> relocatable (`bin/python3` symlinks to `/Applications/Xcode.app`), so a venv
> it creates breaks once the bundle is moved to another machine. The bundled
> standalone interpreter uses relative loader paths and runs from any directory,
> which is what makes the copy-anywhere extension work.

### Step 2 — assemble + zip (any machine, just needs the staged artifacts)

```
bash tools/sync_panel.sh      # once: copy the live panel into panel/
bash tools/build.sh mac-arm64 # or mac-x64 / win-x64
```

On Windows the assemble step is `tools\build_win.ps1` (native PowerShell). Both
assemble + zip steps copy `tools/stage/<target>/python` + ffmpeg + the CT2 int8
model into a fresh `runtime/` and zip to `dist/amharic-captions-<target>.zip`.

> **Model.** The shipped weights are **CTranslate2 INT8** (~582 MB, from
> `tools/stage/model-ct2-int8`). This is what lets the runtime drop
> torch/transformers entirely — the final zip is ~0.6 GB vs ~1.4 GB for the old
> fp16/torch build. `build.sh` prefers the CT2 model but falls back to
> `tools/stage/model-fp16` or `ethio-asr/` (torch dev path) if the CT2 model is
> absent. `ethio_srt.py` auto-selects the engine by probing the model dir for
> `model_meta.json` (CT2) vs `config.json`+safetensors (torch).

### Build on GitHub Actions (no need to own all 3 machines)

`.github/workflows/build.yml` builds all three zips on GitHub's hosted runners:
`macos-14` (arm64), `macos-13` (Intel), `windows-latest` (x64). It runs on
push to `main` or via **Actions → "build-zips" → "Run workflow"** (manual).

```
job model-ct2    ubuntu  download badrex/Ethio-ASR-amharic -> convert to CT2 int8 -> upload artifact
job build        x3      download CT2 int8 artifact -> prepare_python.sh -> build.sh / build_win.ps1 -> upload zip
```

Notes:
- The CT2 int8 conversion happens **once** (on a cheap ubuntu runner with CPU
  torch + ctranslate2), then the three platform jobs reuse that artifact — no
  repeated 2.3 GB conversions.
- The 2.3 GB source download is cached via `actions/cache` on `ethio-asr/`.
- The zips are uploaded as **artifacts** (Artifacts → download), available for
  30 days. Grab them from the Actions run page.
- To rebuild the CT2 int8 weights, bump `HF_MODEL` in the workflow.

## 2. Enable CEP extensions (PlayerDebugMode)

CEP extensions only run when the host allows them. This is a one-time system
setting, per OS:

### macOS
Create/append the plist key (run once):

```
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
```

### Windows
Add a registry DWORD (run once), then restart Premiere:

```
reg add "HKCU\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_DWORD /d 1 /f
```

### Host
Open Premiere Pro → Extensions → Amharic Captions. The panel must be reloaded
whenever `main.js`/`host.jsx` change: **quit and reopen Premiere (restarting the
panel alone is not enough — ExtendScript and CEF cache at load).**

## 3. Verify

1. Open Premiere → Extensions → Amharic Captions.
2. Status pill should read `ready · win` (or `ready · mac`).
3. If it reads `runtime missing` / `runtime incomplete`, check the Log
   disclosure for the exact missing path and ensure `runtime/` is complete.
4. Run a clip's audio through once — the first load of the model takes
   a few seconds.

## 4. Built artifacts (status)

| Zip | Status |
|-----|--------|
| `dist/amharic-captions-mac-arm64.zip` | ✅ **built & verified** (~0.6 GB, CT2 int8 model; was ~1.4 GB fp16/torch) |
| `dist/amharic-captions-mac-x64.zip` | ⏳ run `prepare_python.sh` on an Intel Mac, then `build.sh mac-x64` |
| `dist/amharic-captions-win-x64.zip` | ⏳ run `prepare_python.sh` (Git-Bash) + `build_win.ps1` on a Windows PC |

The **mac-arm64** bundle was verified end-to-end (static ffmpeg → relocatable
python → ctranslate2 int8 model, all from inside `runtime/`, no dev paths) and
produces output matching the fp32 reference. The scripts for the other two
targets are ready — they just need to be executed on machines of that OS/arch,
and the user re-verifies output on Windows. No panel code changes are required;
`js/main.js` already handles all platforms and both engines.
