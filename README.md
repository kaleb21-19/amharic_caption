# Amharic Captions — Premiere Pro Extension

Local Amharic speech-to-text captions for Adobe Premiere Pro. Runs entirely on-device — no uploads, no internet required after install.

## Pricing

- **One-time license fee:** ETB 1,500 (~$30)
- **Payment:** Telebirr (mobile money)
- **License:** Per-machine, hardware-locked (one key per PC)

## Buy

Pay **ETB 1,500** via Telebirr to **0907 628 809**.

1. Install the extension (unzip → copy `com.amharic.captions` to `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\`)
2. Restart Premiere Pro → Extensions → Amharic Captions
3. Copy the **Machine ID** shown in the License section
4. Send payment via Telebirr to **0907 628 809**, then send your **Machine ID** + payment screenshot to get your license key
5. Paste the key into the panel → **Activate** → done. One key per machine (hardware-locked).

> **Free trial:** every new machine gets **2 free transcriptions** before a
> license key is required, so buyers can try it on their own Premiere first.

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
