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
#    - verifies the install
#
#  Double-click this file in Finder. Terminal will open and
#  run it for you - no commands to type.
# ============================================================

set -euo pipefail

NAME="com.amharic.captions"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/$NAME"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$NAME"

echo ""
echo "  ============================================="
echo "   Amharic Captions - Installer (macOS)"
echo "  ============================================="
echo ""

# ---- check we are running next to the extension folder ----
if [[ ! -f "$SRC/CSXS/manifest.xml" ]]; then
  echo "  [ERROR] Could not find the extension next to this installer."
  echo ""
  echo "  This file must stay inside the unzipped amharic-captions-mac-*"
  echo "  folder, side by side with the com.amharic.captions folder."
  echo ""
  echo "  Unzip the download fully, then double-click Install.command again."
  echo ""
  read -r -n 1 -p "Press Enter to close..."
  exit 1
fi

# ---- Gatekeeper: clear quarantine from the pre-copy source as well ----
# (doing this means the files get copied already-cleaned and nothing is
#  left over to trigger the "malware" dialog after install.)
xattr -dr com.apple.quarantine "$SRC" 2>/dev/null || true

# ---- make sure the CEP extensions folder exists ----
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$EXT_DIR"

# ---- remove any previous install so files do not mix ----
if [[ -d "$DEST" ]]; then
  echo "  Removing previous version ..."
  rm -rf "$DEST"
fi

# ---- copy the extension ----
echo "  Copying files - this can take a minute ..."
cp -R "$SRC" "$DEST"

# ---- verify the install ----
if [[ ! -f "$DEST/CSXS/manifest.xml" || ! -f "$DEST/index.html" ]]; then
  echo "  [ERROR] The install is incomplete or corrupted."
  echo "  Re-unzip the complete amharic-captions-mac-*.zip and retry."
  read -r -n 1 -p "Press Enter to close..."
  exit 1
fi

# ---- clear Gatekeeper quarantine on the installed copy ----
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# ---- enable the extension debug keys (covers all recent Premiere) ----
echo "  Enabling Adobe extension support ..."
for K in 7 8 9 10 11 12 13 14 15; do
  defaults write "com.adobe.CSXS.$K" PlayerDebugMode 1 2>/dev/null || true
done

# ---- make the defaults flush so Premiere sees the change on restart ----
killall cfprefsd 2>/dev/null || true

echo ""
echo "  ============================================="
echo "   DONE - installation successful!"
echo "  ============================================="
echo ""
echo "  Next steps:"
echo "    1. Fully quit Premiere Pro  (Cmd + Q)"
echo "    2. Reopen Premiere Pro"
echo "    3. Menu:  Window > Extensions > Amharic Captions"
echo ""
echo "  The macOS 'Apple could not verify' warning has been disabled"
echo "  permanently for this extension."
echo ""
read -r -n 1 -p "Press Enter to close..."
exit 0