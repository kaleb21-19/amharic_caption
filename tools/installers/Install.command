#!/bin/bash
# ============================================================
#  Amharic Captions - Premiere Pro
#  One-click installer for macOS.
#
#  Does everything automatically:
#    - copies com.amharic.captions into Adobe's CEP folder
#    - clears the macOS Gatekeeper quarantine (kills the
#      "Apple could not verify" warning permanently)
#    - enables the CSXS PlayerDebugMode defaults keys
#    - installs atomically: builds a staged copy first, then
#      swaps it in. If anything fails the previous version is
#      kept.
#    - verifies the install and logs every step
#
#  Double-click this file in Finder. Terminal will open and
#  run it for you - no commands to type.
#
#  Exit codes (used for support):
#    0 = success
#    1 = extension folder not found next to this file
#    2 = manifest.xml missing in source
#    3 = copy to staging folder failed
#    4 = staging copy failed verification
#    5 = could not swap the new version into place
#    6 = final verification failed after the swap
# ============================================================

set -euo pipefail

NAME="com.amharic.captions"
LOG="/tmp/amharic-captions-install.log"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$NAME"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/$NAME"
STAGE="$EXT_DIR/.$NAME.staging"
BACKUP="$EXT_DIR/$NAME.old"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

VER="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$SRC/CSXS/manifest.xml" 2>/dev/null | head -1 || true)"
VER="${VER:-unknown}"

> "$LOG" echo "=============================="
log  "Amharic Captions Installer (macOS)"
log  "Version: $VER"
log  "Date: $(date)"
log  "User: $(whoami)"
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
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 1
fi

if [[ ! -f "$SRC/CSXS/manifest.xml" ]]; then
  echo "  [ERROR] manifest.xml was not found in the extension folder."
  echo ""
  echo "  Check that the extension package is complete."
  echo ""
  log "ERROR(2): manifest.xml missing in source"
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 2
fi

if [[ ! -f "$SRC/index.html" ]]; then
  echo "  [ERROR] index.html was not found in the extension folder."
  echo ""
  log "ERROR(2): index.html missing in source"
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 2
fi

echo "  [OK] Extension files found."
echo ""
log "Source files verified"

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
  read -r -n 1 -p "  Press Enter to continue..." || true
fi

# ---- make sure the CEP extensions folder exists ----

mkdir -p "$EXT_DIR"
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
  log "ERROR(5): Staging folder locked"
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 5
fi

if ! cp -R "$SRC" "$STAGE"; then
  echo "  [ERROR] Copy failed. Check disk space."
  echo ""
  log "ERROR(3): Copy to staging failed"
  rm -rf "$STAGE" 2>/dev/null || true
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 3
fi

# ---- verify the staged copy ----

echo "  Verifying staged copy..."
echo ""

if [[ ! -f "$STAGE/CSXS/manifest.xml" || ! -f "$STAGE/index.html" ]]; then
  echo "  [ERROR] Staged copy is incomplete."
  echo ""
  echo "  Re-unzip the complete amharic-captions-mac-*.zip and retry."
  log "ERROR(4): Staged copy incomplete"
  rm -rf "$STAGE" 2>/dev/null || true
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 4
fi

SRC_COUNT=$(find "$SRC" -type f 2>/dev/null | wc -l | tr -d ' ')
STAGE_COUNT=$(find "$STAGE" -type f 2>/dev/null | wc -l | tr -d ' ')

echo "  Source files:     $SRC_COUNT"
echo "  Staged files:     $STAGE_COUNT"
echo ""

log "Source files: $SRC_COUNT"
log "Staged files: $STAGE_COUNT"

if [[ "$SRC_COUNT" != "$STAGE_COUNT" ]]; then
  echo "  [WARNING] File count does not match."
  echo ""
  echo "  The extension may be incomplete. Re-unzip the original download"
  echo "  and try again."
  echo ""
  log "WARNING: File count mismatch ($SRC_COUNT vs $STAGE_COUNT)"
fi

echo "  [OK] Staged copy verified."
echo ""

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
    log "ERROR(5): Could not back up previous version"
    rm -rf "$STAGE" 2>/dev/null || true
    read -r -n 1 -p "  Press Enter to close..." || true
    exit 5
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
  log "ERROR(5): Swap failed - previous version restored"
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 5
fi

echo "  [OK] New version installed."
echo ""

# ---- final verification ----

if [[ ! -f "$DEST/CSXS/manifest.xml" || ! -f "$DEST/index.html" ]]; then
  echo "  [ERROR] Final verification failed."
  log "ERROR(6): Installed manifest/index missing"
  if [[ -d "$BACKUP" ]]; then
    echo "  Restoring previous version ..."
    rm -rf "$DEST" 2>/dev/null || true
    mv "$BACKUP" "$DEST" 2>/dev/null || true
  fi
  read -r -n 1 -p "  Press Enter to close..." || true
  exit 6
fi

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

# ---- clean up incomplete staging (rollback backup is KEPT until the
#       next successful install replaces it - true one-version rollback) ----

rm -rf "$STAGE" 2>/dev/null || true

# ---- done ----

DEST_COUNT=$(find "$DEST" -type f 2>/dev/null | wc -l | tr -d ' ')
log "Installed files: $DEST_COUNT"

echo ""
echo "  ============================================="
echo "   DONE - installation successful!"
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
echo "  The macOS 'Apple could not verify' warning has been disabled"
echo "  permanently for this extension."
echo ""
echo "  Log file: $LOG"
echo ""
read -r -n 1 -p "  Press Enter to close..." || true
exit 0