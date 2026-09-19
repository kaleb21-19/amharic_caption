#!/usr/bin/env bash
#
# check_versions.sh
#
# Version-drift gate. With one version bump, a release must update EVERY place
# the version string is baked into the shipped bundle. This script fails the
# build if any of them disagrees with the source of truth below.
#
#   SOURCE OF TRUTH: const APP_VERSION in panel/js/main.js
#
#   bash tools/check_versions.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VER="$(sed -n "s/^const APP_VERSION = '\([^']*\)';/\1/p" "$ROOT/panel/js/main.js")"
if [[ -z "$VER" ]]; then
  echo "[FAIL] could not read APP_VERSION from panel/js/main.js"
  exit 1
fi
echo "[ok] APP_VERSION (source of truth): $VER"

fail=0
check() { # $1 label, $2 actual
  if [[ "$2" != "$VER" ]]; then
    echo "  [FAIL] $1 = '$2' (expected '$VER')"
    fail=1
  else
    echo "  [ok] $1 = '$2'"
  fi
}

BUNDLE="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/panel/CSXS/manifest.xml" | head -1)"
check "manifest.xml ExtensionBundleVersion" "$BUNDLE"

EXT="$(sed -n 's/.*<Extension Id="[^"]*" Version="\([^"]*\)".*/\1/p' "$ROOT/panel/CSXS/manifest.xml" | head -1)"
check "manifest.xml Extension Version" "$EXT"

HTML="$(sed -n 's/.*<span id="panelVersion">\([^<]*\)<.*/\1/p' "$ROOT/panel/index.html" | head -1)"
check "index.html #panelVersion fallback" "$HTML"

DOM="$(sed -n "s/.*assert.strictEqual(p.els('panelVersion').textContent, '\([^']*\)').*/\1/p" "$ROOT/tools/test/test_panel_dom.js" | head -1)"
check "test_panel_dom.js version assertion" "$DOM"

if [[ "$fail" == "1" ]]; then
  echo
  echo "  Version strings disagree — fix them all to match APP_VERSION."
  exit 1
fi
echo "  versions consistent."