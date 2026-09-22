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

shasum -a 256 "$ZIP" > "$ZIP.sha256"

# Create the release once (first publishing job to reach it); later jobs just
# upload --clobber. The tag stays semver so releases/latest always resolves.
gh release view "$TAG" --repo "$PUB" >/dev/null 2>&1 || \
  gh release create "$TAG" --repo "$PUB" \
    --title "Amharic Captions v${VER}" \
    --notes "Amharic Captions v${VER} — self-contained builds for Windows 10/11, macOS (Apple Silicon), Intel Mac. Download the zip for your platform and install into Adobe CEP extensions. Install guide: https://amharic-caption-pro.vercel.app/install/" \
    >/dev/null 2>&1 || true

gh release upload "$TAG" --repo "$PUB" "$ZIP" "$ZIP.sha256" --clobber

echo "published $(basename "$ZIP") -> $PUB $TAG"