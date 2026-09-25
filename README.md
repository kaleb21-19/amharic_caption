# Amharic Captions — Premiere Pro Extension

Local Amharic speech-to-text captions for Adobe Premiere Pro. Transcription runs entirely on-device; no footage, audio, or transcript is uploaded. A connection is needed for first activation, trial sync, and optional online license checks.

## Pricing

- **One-time license fee:** ETB 2,500 (~$30)
- **Payment:** Bank transfer to KALEB TEGEGEN (CBE / Abyssinia / Zemen)
- **License:** Per-installation, file-bound (one key per licensed installation)

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
5. Paste the key into the panel → **Activate** → done. One key per licensed installation; do not share the identity or license files.

> **Free trial:** every new machine gets **2 free transcriptions** before a
> license key is required, so buyers can try it on their own Premiere first.

### Known limitations

- **Licenses require a server-signed lease.** The panel accepts only a valid
  ECDSA P-256 lease token bound to the installation's Machine ID. Unsigned
  `{valid:true}` state is never accepted. The current license is file-bound:
  the identity and lease files live in the user profile, so copying both files
  can move a license. Do not share them; online validation can detect and block
  a key used from multiple locations.
- **Offline revocation has a deliberate limit.** A previously issued offline
  lease can be honored without a network connection. Revocation and key-spread
  enforcement take effect when the panel next contacts the license server; a
  fully offline client cannot provide an immediate kill switch.
- **Trial is best-effort offline.** The 2-use trial counter is stored locally
  and synchronized/charged authoritatively when the server is reachable; a
  denied or unfinished charge blocks placement. Because the panel must work
  fully offline, a user who is offline — or who clears the panel's
  `localStorage` — can still reset the local fallback counter. We accept this
  trade-off over breaking offline use; the online gate and its limitations are
  documented in `TESTING.md`.
- **Batch is per-clip resilient.** If one clip in a work-area run can't be
  decoded or transcribed, it is skipped (logged + counted) instead of aborting
  the whole run. A skipped count is reported when the batch finishes.
- **Editing a work area is cheap.** Results are cached per clip, so re-running
  a sequence after trimming, moving, or adding a clip only re-transcribes the
  clip(s) that changed.
- **Long clips are windowed and resumable in the standalone engine.** Audio over
  5 minutes is transcribed in ~20-second windows snapped to speech boundaries;
  a partial `.srt` plus a resume journal are written after each window. The
  panel currently creates a new job path for each run, so a killed panel job may
  need to be started again.
- **Punctuation is rule-based.** Sentence (`።`) and clause (`፣`) marks are placed
  at detected pauses; the recognizer itself does not predict punctuation.
- **Speaker labels are opt-in and best-effort.** The "Label speakers (2)" toggle
  tags interview captions `[S1]`/`[S2]` using a small on-device speaker model
  (offline, no torch). It leaves captions unchanged when the clip isn't clearly
  two speakers, so it never makes an unlabelled result worse.
- **Review exports three formats.** The review screen can export SRT, VTT (with
  `<v>` speaker tags) and a plain-text transcript to a folder you choose.

### Install (Windows)

1. Unzip `amharic-captions-win-x64.zip`
2. Copy the `com.amharic.captions` folder to your user's Adobe folder:
   `%AppData%\Adobe\CEP\extensions\`
   (no administrator rights needed; create the `extensions` folder if it doesn't exist)
3. If Adobe doesn't show third-party extensions, force-enable CEP debug mode:
   in the Registry Editor, open
   `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` and set the string (REG_SZ)
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
python3 keygen.py <8-or-16-char-hex-machine-id> [YYYYMMDD-expiry]
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
./build.sh mac-arm64   # or mac-x64; Windows uses build_win.ps1
# creates dist/amharic-captions-<target>.zip
```

Or let CI do it: push to `main` and the GitHub Actions workflow builds all 3 zips.

### Server settings (license/trial/telegram backend)

The Cloudflare Worker docs (`tools/telegram-worker/DEPLOY.md`) cover the
extension API (`/api/*`) and deployment security. The API is transport-public;
a desktop panel cannot keep a meaningful shared secret. License authenticity
comes from the Worker-only HMAC + D1 row and the required ECDSA signing key.
The license **HMAC secret is never stored in this repo and never shipped** —
it lives only in Worker secrets, so keys can't be forged from the public source.

## Legal, privacy & refunds

Customer-facing terms are published at
[`https://amharic-caption-pro.vercel.app/legal/`](https://amharic-caption-pro.vercel.app/legal/)
(website source: `website/app/legal/page.jsx`) and shipped as plain-text files
`EULA.txt` / `PRIVACY.txt` / `REFUND.txt` at the root of every release zip
(source: `tools/legal/`, wired into `tools/build.sh`).

Key points, stated plainly in the privacy policy: transcription is fully
on-device (audio/transcripts never leave the machine); the panel sends a
version + pseudonymous Machine ID beacon when it opens, plus activation and
trial-usage calls; no personal data is sold or shared beyond Cloudflare, Vercel,
and Telegram (ordering/support).

## Tech stack

- CEP panel (HTML/JS) for Adobe Premiere Pro
- CTranslate2 int8 Amharic ASR model (local inference)
- Greedy CTC decoding by default — measured against prefix beam search on the
  real Common Voice clips, beam was 13% slower for no accuracy gain, with
  byte-identical caption timing (`AMH_BEAM=1` opts back into beam search)
- Conservative Amharic post-correction pass (fixes glued words + verified misrecognitions; extend via `AMH_CORRECT_EXTRA` JSON)
- Pure-numpy Kaldi-style mel spectrogram
- Relocatable python-build-standalone (no system Python needed)
- ffmpeg for audio extraction

## Credits

This product bundles two third-party open models, unmodified except for
format conversion, redistributed here under their CC BY 4.0 terms:

- **Acoustic model** — [`badrex/Ethio-ASR-amharic`](https://huggingface.co/badrex/Ethio-ASR-amharic)
  by badrex (Hugging Face). Converted to CTranslate2 int8 for offline CPU
  inference; weights unchanged. License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- **Speaker-embedding model** — TitaNet-Small by NVIDIA (NeMo), via the
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project, used for the
  opt-in 2-speaker labeling feature. License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The same credits are shown in-app under the panel's **Credits** link.

## License

Proprietary. Not for redistribution. Bundled models are credited above under
their own CC BY 4.0 licenses, which remain in effect independent of this
product's proprietary license.
