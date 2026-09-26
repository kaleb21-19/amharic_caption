# Hosting the Amharic model (for the Lite download)

The **Lite** zip (~175 MB) does not contain the Amharic model (~612 MB). The panel
and the *Make Amharic Captions* tool download it **once** into
`%LOCALAPPDATA%\AmharicCaptions\models\<id>` (macOS:
`~/Library/Application Support/AmharicCaptions/models/<id>`), resume after a
dropped connection, and check every file's SHA-256 before using it. Updates
never delete it, so later updates stay small.

The **Full** zip (~690 MB) still bundles the model. Keep offering it for people
who install from a USB stick or cannot download inside the app.

## 1. Upload the model files (once per model)

Upload **these 10 files, flat, with the same names** from
`tools/stage/model-ct2-int8/`:

```
config.json  lm_head_b.npy  lm_head_w.npy  mel_filters.npy  model.bin
model_meta.json  preprocessor_config.json  vocab.json  vocabulary.json  window.npy
```

**Hugging Face (free, recommended):**

1. Create a free account at huggingface.co, then **New → Model**, e.g.
   `amharic-captions-model`, **Public**.
2. **Files → Add file → Upload files**, drop the 10 files, commit.
   (Or: `huggingface-cli upload <you>/amharic-captions-model tools/stage/model-ct2-int8 .`)
3. In the repo's README (model card), credit the source model: *converted from
   [snapwre/hohe-asr-amharic](https://huggingface.co/snapwre/hohe-asr-amharic),
   license CC-BY-4.0*.
4. Your base URL is:
   `https://huggingface.co/<you>/amharic-captions-model/resolve/main/`

**GitHub Release (good second mirror):** create a release (e.g. tag
`model-10d5ee24c7a8`) and attach the same 10 files. Base URL:
`https://github.com/<you>/<repo>/releases/download/model-10d5ee24c7a8/`

Check a base URL works: open `<base URL>model_meta.json` in a browser.

## 2. Build the Lite zip

```powershell
powershell -ExecutionPolicy Bypass -File tools\build_win.ps1 -Lite `
  -ModelSource "https://huggingface.co/<you>/amharic-captions-model/resolve/main/" `
  -ModelSource "https://github.com/<you>/<repo>/releases/download/model-10d5ee24c7a8/"
```

Sources are tried in order, so list the fastest first. macOS:
`LITE=1 MODEL_SOURCES="<url1> <url2>" ./tools/build.sh mac-arm64`.

The Full zip is built as before (`tools\build_win.ps1` with no `-Lite`).

## The release pipeline uses the hosted copy

`.github/workflows/build.yml` does **not** re-convert the model. Its `model` job
downloads the 10 files from `MODEL_SOURCE` (currently
`https://huggingface.co/kal11/amharic-captions-model/resolve/main/`) and checks
every file against `tools/model_manifest.json` and `model.bin` against
`tools/model.lock`. That guarantees the Lite zips expect exactly the bytes
customers download. **Never replace the hosted files without updating those two
files in the same change**, or every Lite download fails its integrity check.

## 3. When the model changes

1. Convert and benchmark the new model locally (`tools/fetch_model.sh`,
   `tools/make_model_ct2_int8.sh`, `tools/test/run_engine.sh`), and check the
   Amharic regression gate (`tools/test/amharic_regression.py`).
2. Upload the new files to a **new** location (new repo, branch or release tag),
   so existing installs keep downloading the model they expect.
3. Point `MODEL_SOURCE` in `build.yml` there, regenerate
   `tools/model_manifest.json` with `tools/make_model_manifest.py`, and put the
   new `model.bin` SHA-256 in `tools/model.lock`.

A new model gets a new id (first 12 hex of `model.bin`'s SHA-256), so customers
download it once into a new folder; the old folder can be deleted.

## Test before you publish

Install the Lite zip on a PC, open the panel, press **Download the Amharic
model**, unplug the network halfway, plug it back, press **Resume** — it must
continue, not restart — then transcribe a clip.
