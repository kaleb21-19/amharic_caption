# Amharic Captions — Premiere Pro Extension

Local Amharic speech-to-text captions for Adobe Premiere Pro. Runs entirely on-device — no uploads, no internet required after install.

## Pricing

- **One-time license fee:** ETB 1,500 (~$30)
- **Payment:** Telebirr (mobile money)
- **License:** Per-machine, hardware-locked (one key per PC)

## Requirements

- **Adobe Premiere Pro 2024 or newer (v24.0+)** — the manifest only registers on
  PPRO 24.0+. It does **not** load on Premiere 2021/2022/2023.
- Windows 10/11 or macOS (Apple Silicon or Intel). No internet needed at runtime.

## Buy

Pay **ETB 1,500** via Telebirr to **0907 628 809**.

1. Install the extension (see below for your platform)
2. Restart Premiere Pro → Extensions → Amharic Captions
3. Copy the **Machine ID** shown in the License section
4. Send payment via Telebirr to **0907 628 809**, then send your **Machine ID** + payment screenshot to get your license key
5. Paste the key into the panel → **Activate** → done. One key per machine (hardware-locked).

> **Free trial:** every new machine gets **2 free transcriptions** before a
> license key is required, so buyers can try it on their own Premiere first.

### Install (Windows)

1. Unzip `amharic-captions-win-x64.zip`
2. Copy the `com.amharic.captions` folder to:
   `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\`
3. If Adobe doesn't show third-party extensions, force-enable CEP debug mode:
   in the Registry Editor, open
   `HKEY_CURRENT_USER\Software\Adobe\CSXS.9` and set the string value
   `PlayerDebugMode` = `1` (create the key/value if missing), then restart
   Premiere.

### Install (macOS)

1. Unzip `amharic-captions-mac-arm64.zip` (Apple Silicon) or
   `amharic-captions-mac-x64.zip` (Intel)
2. Copy the `com.amharic.captions` folder to:
   `~/Library/Application Support/Adobe/CEP/extensions/`
   (create the `extensions` folder if it doesn't exist)
3. Force-enable CEP debug mode so Premiere loads third-party panels:
   `defaults write com.adobe.CSXS.9 PlayerDebugMode "1"`
   then restart Premiere.

> **First-run note:** macOS will not run the bundled binaries until you grant
> them permission — on first use, open **System Settings → Privacy & Security**,
> click **Allow** next to the blocked app, and repeat if prompted.

## Developer tools

### Generate a license key

```bash
cd tools
python3 keygen.py <8-char-hex-machine-id> [YYYYMMDD-expiry]
```

Examples:
```bash
python3 keygen.py a1b2c3d4              # perpetual license
python3 keygen.py deadbeef 20271231     # expires 2027-12-31
```

### Build zips

```bash
cd tools
./prepare_python.sh    # fetches relocatable python-build-standalone
./build.sh             # creates dist/amharic-captions-{mac-arm64,mac-x64,win-x64}.zip
```

Or let CI do it: push to `main` and the GitHub Actions workflow builds all 3 zips.

## Tech stack

- CEP panel (HTML/JS) for Adobe Premiere Pro
- CTranslate2 int8 Amharic ASR model (local inference)
- CTC prefix beam search decoder (better than greedy; `AMH_BEAM=0` reverts to greedy)
- Conservative Amharic post-correction pass (fixes glued words + verified misrecognitions; extend via `AMH_CORRECT_EXTRA` JSON)
- Pure-numpy Kaldi-style mel spectrogram
- Relocatable python-build-standalone (no system Python needed)
- ffmpeg for audio extraction

## License

Proprietary. Not for redistribution.
