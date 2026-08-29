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
    bin/ffmpeg[.exe]           <- STATIC build required
    python/                    <- Python 3.11 + torch/transformers/soundfile/numpy
    model/                     <- fp16 model (~1.1 GB) or fp32 ethio-asr (~2.3 GB)
```

`js/main.js` detects the platform (Windows/Mac) at load, resolves these paths
relative to the extension, and shows `ready · win` / `ready · mac` in the status
pill. If any piece is missing it reports `runtime incomplete` and names the gap.

## 1. Build the 3 target zips

Ship three separate zips (the panel files are identical in each; only the
`runtime/` content differs because **torch is platform- and arch-specific**):

| Zip | Target | Runtime built on |
|-----|--------|------------------|
| `amharic-captions-mac-arm64.zip` | Apple Silicon Mac | an Apple Silicon Mac |
| `amharic-captions-mac-x64.zip`   | Intel Mac | an Intel Mac |
| `amharic-captions-win-x64.zip`   | Windows x64  | a Windows x64 PC |

The pipeline is split into two steps so a single shared repo builds all three —
you only need to run step 1 on each OS, and step 2 (the zip) on any machine.

### Step 1 — prepare the runtime (run ON each target OS/arch)

```
# macOS (Apple Silicon or Intel)
bash tools/prepare_python.sh

# Windows (native)
powershell -ExecutionPolicy Bypass -File tools\build_win.ps1
```

This builds a fresh Python venv with the ML deps, prunes dead-weight packages
(keeps `sympy`/`mpmath`/`networkx` — `torch.fx` needs them), and fetches a
**static** ffmpeg, all into `tools/stage/<target>/`.

### Step 2 — assemble + zip (any machine, just needs the staged artifacts)

```
bash tools/sync_panel.sh      # once: copy the live panel into panel/
tools/make_model_fp16.sh      # once: build the half-size fp16 model (see below)
bash tools/build.sh mac-arm64 # or mac-x64 / win-x64
```

Output: `dist/amharic-captions-<target>.zip`.

> **Model.** The shipped weights are the **fp16** half-size model, built into
> `tools/stage/model-fp16` (~1.1 GB) by `tools/make_model_fp16.sh` from the full
> fp32 source (`~/Documents/amharic-captions/ethio-asr`, 2.3 GB). Shipping fp16
> cuts the bundle roughly in half, and inference output is **byte-identical** to
> fp32 (the runtime applies `.half()` either way). If `tools/stage/model-fp16`
> is absent, `build.sh` falls back to bundling `ethio-asr/` (fp32) automatically.
> The dev venv must contain `transformers` + `torch` for the conversion step.

### Build on GitHub Actions (no need to own all 3 machines)

`.github/workflows/build.yml` builds all three zips on GitHub's hosted runners:
`macos-14` (arm64), `macos-13` (Intel), `windows-latest` (x64). It runs on
push to `main` or via **Actions → "build-zips" → "Run workflow"** (manual).

```
job model-fp16   ubuntu  download badrex/Ethio-ASR-amharic -> convert to fp16 -> upload artifact
job build        x3      download fp16 artifact -> prepare_runtime -> build.sh / build_win.ps1 -> upload zip
```

Notes:
- The fp16 conversion happens **once** (on a cheap ubuntu runner with CPU
  torch), then the three platform jobs reuse that artifact — no repeated 2.3 GB
  conversions.
- The 2.3 GB source download is cached via `actions/cache` on `ethio-asr/`.
- The Windows job runs `build_win.ps1` (native PowerShell, built-in
  `Compress-Archive`) rather than Git-Bash, for reliable zipping.
- The zips are uploaded as **artifacts** (Artifacts → download), available for
  30 days. Grab them from the Actions run page.
- To rebuild the fp16 weights, bump `HF_MODEL` in the workflow.

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
| `dist/amharic-captions-mac-arm64.zip` | ✅ **built & verified** (~1.3 GB, fp16 model — was 2.3 GB fp32) |
| `dist/amharic-captions-mac-x64.zip` | ⏳ run `prepare_python.sh` on an Intel Mac, then `build.sh mac-x64` |
| `dist/amharic-captions-win-x64.zip` | ⏳ run `build_win.ps1` on a Windows PC |

The **mac-arm64** bundle was verified end-to-end (static ffmpeg → python →
fp16 model, all from inside `runtime/`, no dev paths) and produces output
byte-identical to the fp32 reference. The scripts for the other two targets are
ready — they just need to be executed on machines of that OS/arch. No panel code
changes are required; `js/main.js` already handles all platforms.
