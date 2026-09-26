#!/bin/bash
# ============================================================
#  Amharic Captions - Premiere Pro
#  One-click installer for macOS.
#
#  Usage:
#    Install.command            interactive (default)
#    Install.command /silent    no pauses, minimal output (for IT)
#
#  Does everything automatically:
#    - copies com.amharic.captions into Adobe's CEP folder
#    - clears the macOS Gatekeeper quarantine (kills the
#      "Apple could not verify" warning permanently)
#    - enables the CSXS PlayerDebugMode defaults keys
#    - installs atomically: builds a staged copy first, then
#      swaps it in. A failed run can never leave a broken
#      half-install; the previous version is kept as a rollback
#      copy until the NEXT successful install replaces it.
#    - verifies the install (key files + file count) and logs
#      every step
#
#  Double-click this file in Finder. Terminal will open and
#  run it for you - no commands to type.
#
#  Exit codes (match the Windows installer, for support triage):
#    0 = success
#    1 = extension folder not found next to this file
#    2 = manifest.xml missing in source
#    3 = index.html missing in source
#    4 = could not create the Adobe CEP folder
#    5 = copy to the staging folder failed
#    6 = staging copy failed verification
#    7 = could not swap the new version into place
#    8 = final verification failed after the swap (rare)
# ============================================================

set -euo pipefail

NAME="com.amharic.captions"
LOG="/tmp/amharic-captions-install.log"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$NAME"
model_present() {
  [[ -f "$1/runtime/model/model.bin" || -f "$1/runtime/model/model_meta.json" || -f "$1/runtime/model/config.json" ]]
}
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/$NAME"
# Keep staging outside the scanned extensions directory as well as the backup.
STAGE="$HOME/Library/Application Support/Adobe/CEP/.$NAME.staging"
# Keep rollback outside CEP's scanned extensions directory. A backup containing
# CSXS/manifest.xml under extensions/ can be loaded as a duplicate extension.
BACKUP="$HOME/Library/Application Support/Adobe/CEP/$NAME.old"

SILENT=0
if [[ "${1:-}" == "/silent" || "${1:-}" == "silent" ]]; then
  SILENT=1
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

press_enter() {
  if [[ "$SILENT" -eq 0 ]]; then
    read -r -n 1 -p "  Press Enter to continue..." || true
    echo ""
  fi
}

VER="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$SRC/CSXS/manifest.xml" 2>/dev/null | head -1 || true)"
VER="${VER:-unknown}"

> "$LOG" echo "=============================="
log  "Amharic Captions Installer (macOS)"
log  "Version: $VER"
log  "Date: $(date)"
log  "User: $(whoami)"
log  "Silent mode: $SILENT"
log  "Source: $SRC"
log  "Destination: $DEST"

echo ""
echo "  ============================================="
echo "   Amharic Captions - Installer  v$VER"
echo "  ============================================="
echo ""
echo "  Source:"
echo "    $SRC"
echo ""
echo "  Destination:"
echo "    $DEST"
echo ""

# ---- check we are running next to the extension folder ----

echo "  Checking extension files..."
echo ""

if [[ ! -d "$SRC" ]]; then
  echo "  [ERROR] Could not find the extension folder."
  echo ""
  echo "  This file must stay inside the unzipped amharic-captions-mac-*"
  echo "  folder, side by side with the com.amharic.captions folder."
  echo ""
  echo "  Unzip the download fully, then double-click Install.command again."
  echo ""
  log "ERROR(1): Extension folder not found at $SRC"
  press_enter
  exit 1
fi

if [[ ! -f "$SRC/CSXS/manifest.xml" ]]; then
  echo "  [ERROR] manifest.xml was not found in the extension folder."
  echo ""
  echo "  Check that the extension package is complete."
  echo ""
  log "ERROR(2): manifest.xml missing in source"
  press_enter
  exit 2
fi

if [[ ! -f "$SRC/index.html" ]]; then
  echo "  [ERROR] index.html was not found in the extension folder."
  echo ""
  log "ERROR(3): index.html missing in source"
  press_enter
  exit 3
fi

echo "  [OK] Extension files found."
echo ""
log "Source files verified"

DEGRADED=0
if [[ -f "$HERE/DEGRADED_BUILD.txt" ]]; then
  DEGRADED=1
  echo "  [WARNING] Explicit local/test degraded build; optional ML assets may be absent."
  log "WARNING: DEGRADED_BUILD.txt present; not for release"
fi

# A Lite package ships runtime/model_manifest.json instead of the model; the
# panel / SRT maker download it once into a per-user folder.
LITE=0
if [[ ! -f "$SRC/runtime/model/model.bin" && -f "$SRC/runtime/model_manifest.json" ]]; then
  LITE=1
fi
log "Lite package: $LITE"
REQUIRED_MODEL="runtime/model/model.bin"
if [[ "$LITE" -eq 1 ]]; then REQUIRED_MODEL="runtime/model_manifest.json"; fi

if [[ "$DEGRADED" -eq 0 ]]; then
  for f in \
    "$REQUIRED_MODEL" runtime/bin/ffmpeg runtime/python/bin/python3 \
    runtime/amh_lm.py runtime/amh_lm.json.gz runtime/amh_vad.py \
    runtime/silero_vad.onnx runtime/amh_diarize.py runtime/speaker_embed.onnx; do
    if [[ ! -f "$SRC/$f" ]]; then
      echo "  [ERROR] Required package file is missing: $f"
      log "ERROR(6): source package missing $f"
      press_enter
      exit 6
    fi
  done
else
  if ! model_present "$SRC"; then
    echo "  [ERROR] Required package model is missing."
    log "ERROR(6): source package missing model"
    press_enter
    exit 6
  fi
  for f in runtime/bin/ffmpeg runtime/python/bin/python3; do
    if [[ ! -f "$SRC/$f" ]]; then
      echo "  [ERROR] Required core package file is missing: $f"
      log "ERROR(6): source package missing core file $f"
      press_enter
      exit 6
    fi
  done
fi

# ---- warn if an older system-wide copy exists ----

SYS_GENERAL="/Library/Application Support/Adobe/CEP/extensions/$NAME/CSXS/manifest.xml"
if [[ -f "$SYS_GENERAL" ]]; then
  echo "  [NOTE] An older copy is installed in the system-wide CEP folder."
  echo "         Premiere loads that one before the user copy we are installing."
  echo "         If you see an old version after installing, check:"
  echo "           sudo rm -rf /Library/Application\\ Support/Adobe/CEP/extensions/$NAME"
  echo ""
  log "WARNING: system-wide CEP copy exists at $SYS_GENERAL"
fi

# ---- quarantine: clear from source BEFORE copy ----

xattr -dr com.apple.quarantine "$SRC" 2>/dev/null || true
log "Quarantine cleared from source"

# ---- warn if Premiere is running (helps explain file locks) ----

if pgrep -fi "adobe premiere pro" >/dev/null 2>&1; then
  echo "  [NOTE] Adobe Premiere Pro is currently running."
  echo ""
  echo "  For the cleanest result, fully quit Premiere now and re-run this"
  echo "  installer afterwards. Continuing with it open can fail when the"
  echo "  previous version is replaced."
  echo ""
  press_enter
fi

# ---- make sure the CEP extensions folder exists ----

if ! mkdir -p "$EXT_DIR"; then
  echo "  [ERROR] Could not create the Adobe CEP folder:"
  echo "    $EXT_DIR"
  echo ""
  log "ERROR(4): Could not create CEP folder"
  press_enter
  exit 4
fi
log "CEP folder ready"

# ---- build a staged copy first (atomic install) ----

echo "  Copying files - this can take a minute ..."
echo ""

rm -rf "$STAGE" 2>/dev/null || true

if [[ -d "$STAGE" ]]; then
  echo "  [ERROR] Could not clear the staging folder."
  echo ""
  echo "  Please fully quit Premiere Pro and try again."
  echo ""
  log "ERROR(7): Staging folder locked"
  press_enter
  exit 7
fi

if ! cp -R "$SRC" "$STAGE"; then
  echo "  [ERROR] Copy failed. Check disk space."
  echo ""
  log "ERROR(5): Copy to staging failed"
  rm -rf "$STAGE" 2>/dev/null || true
  press_enter
  exit 5
fi

# ---- verify the staged copy ----

echo "  Verifying staged copy..."
echo ""

if [[ ! -f "$STAGE/CSXS/manifest.xml" || ! -f "$STAGE/index.html" ]]; then
  echo "  [ERROR] Staged copy is incomplete."
  echo ""
  echo "  Re-unzip the complete amharic-captions-mac-*.zip and retry."
  log "ERROR(6): Staged copy incomplete"
  rm -rf "$STAGE" 2>/dev/null || true
  press_enter
  exit 6
fi

SRC_COUNT=$(find "$SRC" -type f 2>/dev/null | wc -l | tr -d ' ')
STAGE_COUNT=$(find "$STAGE" -type f 2>/dev/null | wc -l | tr -d ' ')

echo "  Source files:     $SRC_COUNT"
echo "  Staged files:     $STAGE_COUNT"
echo ""

log "Source files: $SRC_COUNT"
log "Staged files: $STAGE_COUNT"

if [[ "$SRC_COUNT" != "$STAGE_COUNT" ]]; then
  echo "  [ERROR] File count does not match; staged copy is incomplete."
  echo ""
  echo "  Re-unzip the original download and try again."
  echo ""
  log "ERROR(6): File count mismatch ($SRC_COUNT vs $STAGE_COUNT)"
  rm -rf "$STAGE" 2>/dev/null || true
  press_enter
  exit 6
fi

echo "  [OK] Staged copy verified."
echo ""

# Lite update over an install that already has the model: keep it, so the
# customer does not download it again. The panel checks its size against the
# new manifest and asks for a download only if the model changed.
KEPT_MODEL=0
if [[ "$LITE" -eq 1 && -f "$DEST/runtime/model/model.bin" ]]; then
  echo "  Keeping your existing Amharic model..."
  if cp -R "$DEST/runtime/model" "$STAGE/runtime/model" 2>>"$LOG"; then
    KEPT_MODEL=1
  fi
fi
log "Kept existing model: $KEPT_MODEL"

# ---- clear quarantine on the staged copy ----

xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
log "Quarantine cleared from staged copy"

# ---- swap: back up the old, put the new in, rollback if it fails ----

echo "  Installing..."
echo ""

if [[ -d "$DEST" ]]; then
  rm -rf "$BACKUP" 2>/dev/null || true

  if ! mv "$DEST" "$BACKUP"; then
    echo "  [ERROR] Could not back up the previous installation."
    echo ""
    echo "  Please fully quit Premiere Pro and try again."
    log "ERROR(7): Could not back up previous version"
    rm -rf "$STAGE" 2>/dev/null || true
    press_enter
    exit 7
  fi

  echo "  [OK] Previous version backed up."
  echo ""
fi

if ! mv "$STAGE" "$DEST"; then
  echo "  [ERROR] Could not move the new version into place."
  echo ""
  if [[ -d "$BACKUP" ]]; then
    echo "  Restoring the previous version ..."
    mv "$BACKUP" "$DEST" 2>/dev/null || true
  fi
  log "ERROR(7): Swap failed - previous version restored"
  press_enter
  exit 7
fi

echo "  [OK] New version installed."
echo ""

# ---- final verification ----

if [[ ! -f "$DEST/CSXS/manifest.xml" || ! -f "$DEST/index.html" ]]; then
  echo "  [ERROR] Final verification failed."
  log "ERROR(8): Installed manifest/index missing"
  if [[ -d "$BACKUP" ]]; then
    echo "  Restoring previous version ..."
    rm -rf "$DEST" 2>/dev/null || true
    mv "$BACKUP" "$DEST" 2>/dev/null || true
  fi
  press_enter
  exit 8
fi

# ---- verify required runtime pieces (never ship a partial production install) ----

if [[ "$DEGRADED" -eq 0 ]]; then
  for f in \
    "$REQUIRED_MODEL" runtime/bin/ffmpeg runtime/python/bin/python3 \
    runtime/amh_lm.py runtime/amh_lm.json.gz runtime/amh_vad.py \
    runtime/silero_vad.onnx runtime/amh_diarize.py runtime/speaker_embed.onnx; do
    if [[ ! -f "$DEST/$f" ]]; then
      echo "  [ERROR] Required runtime file is missing after install: $f"
      log "ERROR(8): installed copy missing $f"
      if [[ -d "$BACKUP" ]]; then
        rm -rf "$DEST" 2>/dev/null || true
        mv "$BACKUP" "$DEST" 2>/dev/null || true
      else
        rm -rf "$DEST" 2>/dev/null || true
      fi
      press_enter
      exit 8
    fi
  done
else
  if ! model_present "$DEST"; then
    echo "  [ERROR] Required core runtime model is missing after install."
    log "ERROR(8): installed degraded copy missing model"
    if [[ -d "$BACKUP" ]]; then
      rm -rf "$DEST" 2>/dev/null || true
      mv "$BACKUP" "$DEST" 2>/dev/null || true
    else
      rm -rf "$DEST" 2>/dev/null || true
    fi
    press_enter
    exit 8
  fi
  for f in runtime/bin/ffmpeg runtime/python/bin/python3; do
    if [[ ! -f "$DEST/$f" ]]; then
      echo "  [ERROR] Required core runtime file is missing after install: $f"
      log "ERROR(8): installed degraded copy missing core file $f"
      if [[ -d "$BACKUP" ]]; then
        rm -rf "$DEST" 2>/dev/null || true
        mv "$BACKUP" "$DEST" 2>/dev/null || true
      else
        rm -rf "$DEST" 2>/dev/null || true
      fi
      press_enter
      exit 8
    fi
  done
fi

echo "  [OK] Required runtime files verified."

echo ""

# ---- enable the extension debug keys ----

echo "  Enabling Adobe extension support ..."

FOUND=0
for K in 11 12 13 14 15; do
  defaults write "com.adobe.CSXS.$K" PlayerDebugMode 1 2>/dev/null || true
  if [[ "$(defaults read "com.adobe.CSXS.$K" PlayerDebugMode 2>/dev/null)" == "1" ]]; then
    FOUND=1
  fi
done

killall cfprefsd 2>/dev/null || true

if [[ "$FOUND" -eq 0 ]]; then
  echo "  [WARNING] Could not verify the defaults setting."
  echo ""
  echo "  The extension may not show up in Premiere."
  log "WARNING: PlayerDebugMode defaults not verified"
else
  echo "  [OK] CEP Developer Mode enabled."
fi

echo ""

# ---- standalone SRT maker: Desktop link (no Premiere / After Effects needed) ----

SRT_CMD="$DEST/Make Amharic Captions.command"
if [[ -z "${AMH_NO_SHORTCUT:-}" && -f "$SRT_CMD" && -d "$HOME/Desktop" ]]; then
  chmod +x "$SRT_CMD" 2>/dev/null || true
  if ln -sfn "$SRT_CMD" "$HOME/Desktop/Make Amharic Captions.command" 2>>"$LOG"; then
    echo "  [OK] Desktop shortcut: Make Amharic Captions"
    log "SRT shortcut created"
  fi
fi
echo ""

# ---- clean up incomplete staging (rollback backup is KEPT until the
#       next successful install replaces it - true one-version rollback) ----

rm -rf "$STAGE" 2>/dev/null || true

# ---- done ----

DEST_COUNT=$(find "$DEST" -type f 2>/dev/null | wc -l | tr -d ' ')
log "Installed files: $DEST_COUNT"

echo ""
echo "  ============================================="
echo "   DONE - installation successful!  v$VER"
echo "  ============================================="
echo ""
echo "  Installed to:"
echo "    $DEST"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Fully quit Premiere Pro   (Cmd + Q)"
echo ""
echo "       Closing the window is NOT enough - the panel list is"
echo "       only read when Premiere starts up."
echo ""
echo "    2. Reopen Premiere Pro and OPEN a project."
echo ""
echo "       The Extensions menu is greyed out on the start screen."
echo ""
echo "    3. Menu:  Window > Extensions > Amharic Captions"
echo ""
echo "  After Effects 2024+: quit and reopen it the same way, then"
echo "  Window > Extensions > Amharic Captions."
echo ""
if [[ "$LITE" -eq 1 && "$KEPT_MODEL" -eq 0 ]]; then
  echo "  First time only: the panel shows  Download the Amharic model."
  echo "  Press it once. If the internet drops, it continues later."
  echo ""
fi
echo "  No Premiere?  Double-click  Make Amharic Captions  on your Desktop"
echo "  and drag a video into the window. An .srt file appears next to it."
echo ""
echo "  The macOS 'Apple could not verify' warning has been disabled"
echo "  permanently for this extension."
echo ""
if [[ "$SILENT" -eq 0 ]]; then
  echo "  Log file: $LOG"
  echo ""
fi
press_enter
exit 0