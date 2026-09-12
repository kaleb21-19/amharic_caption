# Amharic Captions — Premiere Pro Extension

Local Amharic speech-to-text captions for Adobe Premiere Pro. Runs entirely on-device — no uploads, no internet required after install.

## Pricing

- **One-time license fee:** ETB 2,500 (~$30)
- **Payment:** Bank transfer to KALEB TEGEGEN (CBE / Abyssinia / Zemen)
- **License:** Per-machine, hardware-locked (one key per PC)

## Requirements

- **Adobe Premiere Pro 2024 or newer (v24.0+)** — the manifest only registers on
  PPRO 24.0+. It does **not** load on Premiere 2021/2022/2023.
- Windows 10/11 or macOS (Apple Silicon or Intel). No internet needed at runtime.

## Buy

Pay **ETB 2,500** by bank transfer to **KALEB TEGEGEN** — CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015.

1. Install the extension (see below for your platform)
2. Restart Premiere Pro → Extensions → Amharic Captions
3. Copy the **Machine ID** shown in the License section
4. Send payment by bank transfer to **KALEB TEGEGEN** (CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015), then send your **Machine ID** + payment screenshot to get your license key
5. Paste the key into the panel → **Activate** → done. One key per machine (hardware-locked).

> **Free trial:** every new machine gets **2 free transcriptions** before a
> license key is required, so buyers can try it on their own Premiere first.

### Install (Windows)

1. Unzip `amharic-captions-win-x64.zip`
2. Copy the `com.amharic.captions` folder to your user's Adobe folder:
   `%AppData%\Adobe\CEP\extensions\`
   (no administrator rights needed; create the `extensions` folder if it doesn't exist)
3. If Adobe doesn't show third-party extensions, force-enable CEP debug mode:
   in the Registry Editor, open
   `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` and set the DWORD
   `PlayerDebugMode` = `1` (create the key/value if missing), then restart
   Premiere. Using Premiere 2025 (v25) or newer? Also set the same
   `PlayerDebugMode` = `1` under `HKEY_CURRENT_USER\Software\Adobe\CSXS.12`.

> Most users skip the first three steps: the zip ships with `Install.cmd`
> that does the copy + keys automatically.

### Install (macOS)

1. Unzip `amharic-captions-mac-arm64.zip` (Apple Silicon) or
   `amharic-captions-mac-x64.zip` (Intel)
2. Copy the `com.amharic.captions` folder to:
   `~/Library/Application Support/Adobe/CEP/extensions/`
   (create the `extensions` folder if it doesn't exist)
3. Force-enable CEP debug mode so Premiere loads third-party panels:
   `defaults write com.adobe.CSXS.11 PlayerDebugMode "1"`
   then restart Premiere. Using Premiere 2025 (v25) or newer? Also run
   `defaults write com.adobe.CSXS.12 PlayerDebugMode "1"`.

> **First-run note:** files from a downloaded zip are quarantined and the
> bundled binaries are blocked until cleared. After copying the folder, run once:
>
> ```
> xattr -dr com.apple.quarantine ~/Library/Application\ Support/Adobe/CEP/extensions/com.amharic.captions
> ```
>
> Or in **System Settings → Privacy & Security**, click **Allow** next to each
> blocked binary and repeat if prompted.

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
