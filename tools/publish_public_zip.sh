#!/usr/bin/env bash
#
# Upload one platform's built zip to THIS repo's releases (kaleb21-19/
# amharic_caption), which is public, so customers can download the asset
# anonymously — GitHub only serves release assets of private repos to authed
# API clients (browsers get 404). Each build job calls this with its zip; the
# release tag is the semver extension version so GitHub's releases/latest
# always resolves to the newest build.
#
# Usage: bash tools/publish_public_zip.sh <path-to-zip>
#
# Requires GH_TOKEN (the workflow's GITHUB_TOKEN, with contents: write). The
# release is created on first publish and assets are overwritten (--clobber)
# on re-runs.
set -euo pipefail

ZIP="${1:?usage: publish_public_zip.sh <path-to-zip>}"
test -f "$ZIP" || { echo "zip not found: $ZIP" >&2; exit 1; }
test -n "${GH_TOKEN:-}" || { echo "GH_TOKEN not set" >&2; exit 1; }

PUB="kaleb21-19/amharic_caption"
VER="$(grep -o 'ExtensionBundleVersion="[^"]*"' panel/CSXS/manifest.xml | head -1 | sed 's/[^"]*"//;s/"//')"
test -n "$VER" || { echo "could not read ExtensionBundleVersion from panel/CSXS/manifest.xml" >&2; exit 1; }
TAG="v${VER}"

# Portable SHA-256. This runs on ubuntu, macOS AND Windows (Git Bash), and the
# three do not agree on which tool exists: coreutils `sha256sum` is absent on
# macOS, and `shasum` is a Perl script that is not guaranteed to be on Git
# Bash's PATH. Under `set -e` a missing tool killed the script BEFORE the
# upload, which is how v1.4.26 shipped with both macOS zips and no Windows zip
# at all — the release simply had no win-x64 asset, so the website's Windows
# download 404'd while macOS worked.
sha256_into() {
  local file="$1" out="$2"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" > "$out"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" > "$out"
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$file" > "$out"
  else
    echo "no sha256 tool found (tried sha256sum, shasum, openssl)" >&2
    return 1
  fi
}
sha256_into "$ZIP" "$ZIP.sha256"

# Create the release once (first publishing job to reach it); later jobs just
# upload --clobber. The tag stays semver so releases/latest always resolves.
gh release view "$TAG" --repo "$PUB" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$PUB" \
    --title "Amharic Captions v${VER}" \
    --notes "Amharic Captions v${VER} — self-contained builds for Windows 10/11, macOS (Apple Silicon), Intel Mac. Download the zip for your platform and install into Adobe CEP extensions. Install guide: https://amharic-caption-pro.vercel.app/install/" \
    >/dev/null 2>&1 || true

gh release upload "$TAG" --repo "$PUB" "$ZIP" "$ZIP.sha256" --clobber

# Confirm the asset is actually ON the release. `gh release upload` can report
# success for an upload that does not land, and a missing zip is invisible
# until a customer clicks Download and gets a 404.
BASE="$(basename "$ZIP")"
gh release view "$TAG" --repo "$PUB" --json assets \
  --jq '.assets[].name' 2>/dev/null | grep -Fxq "$BASE" || {
    echo "upload reported success but $BASE is NOT on release $TAG" >&2
    exit 1
  }

echo "published $BASE -> $PUB $TAG (verified on the release)"