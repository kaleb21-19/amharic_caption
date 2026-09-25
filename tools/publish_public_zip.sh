#!/usr/bin/env bash
# Stage one built platform zip on a *draft* product release.
#
# A build job must never make a customer-visible asset before the test and
# accuracy gates pass. The final publish job verifies the draft and flips it to
# public. Re-runs refuse to overwrite an existing asset; an already-present zip
# is accepted only when its recorded SHA-256 matches the local build.
#
# Usage: bash tools/publish_public_zip.sh <path-to-zip>
# Env:   GH_TOKEN, optional RELEASE_TAG and GITHUB_REPOSITORY.
set -euo pipefail

ZIP="${1:?usage: publish_public_zip.sh <path-to-zip>}"
test -f "$ZIP" || { echo "zip not found: $ZIP" >&2; exit 1; }
test -n "${GH_TOKEN:-}" || { echo "GH_TOKEN not set" >&2; exit 1; }

PUB="${GITHUB_REPOSITORY:-kaleb21-19/amharic_caption}"
VER="$(grep -o 'ExtensionBundleVersion="[^"]*"' panel/CSXS/manifest.xml | head -1 | sed 's/[^"]*"//;s/"//')"
test -n "$VER" || { echo "could not read ExtensionBundleVersion from panel/CSXS/manifest.xml" >&2; exit 1; }
TAG="${RELEASE_TAG:-v${VER}}"
BASE="$(basename "$ZIP")"
CASE_SUM_NAME="${BASE}.sha256"
CASE_SUM_PATH="${ZIP}.sha256"

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" | awk '{print $1; exit}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$file" | awk '{print $1; exit}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r "$file" | awk '{print $1; exit}'
  else
    echo "no sha256 tool found (tried sha256sum, shasum, openssl)" >&2
    return 1
  fi
}
sha256_into() {
  local file="$1" out="$2" name hash
  name="$(basename "$file")"
  hash="$(sha256_file "$file")"
  printf '%s  %s\n' "$hash" "$name" > "$out"
}
sha256_into "$ZIP" "$CASE_SUM_PATH"
LOCAL_HASH="$(awk '{print $1; exit}' "$CASE_SUM_PATH")"
test -n "$LOCAL_HASH" || { echo "could not calculate SHA-256" >&2; exit 1; }

if ! gh release view "$TAG" --repo "$PUB" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$PUB" --draft \
    --title "Amharic Captions v${VER} (staged)" \
    --notes "Staged build for v${VER}. This draft is not public until all platform builds, tests, and accuracy gates pass." \
    >/dev/null || gh release view "$TAG" --repo "$PUB" >/dev/null
fi

DRAFT="$(gh release view "$TAG" --repo "$PUB" --json isDraft --jq '.isDraft')"
test "$DRAFT" = "true" || { echo "release $TAG is already public; refusing to add assets" >&2; exit 1; }

assets="$(gh release view "$TAG" --repo "$PUB" --json assets --jq '.assets[].name')"
if echo "$assets" | grep -Fxq "$BASE"; then
  # Idempotent re-run: never use --clobber. Verify the recorded digest before
  # accepting an asset that is already on the draft.
  echo "$assets" | grep -Fxq "$CASE_SUM_NAME" || {
    echo "$BASE already exists without its checksum; refusing to trust/replace it" >&2
    exit 1
  }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  gh release download "$TAG" --repo "$PUB" --pattern "$CASE_SUM_NAME" --dir "$TMP" >/dev/null
  REMOTE_HASH="$(awk '{print $1; exit}' "$TMP/$CASE_SUM_NAME")"
  REMOTE_NAME="$(awk '{print $2; exit}' "$TMP/$CASE_SUM_NAME" | sed 's/^\*//')"
  test "$REMOTE_NAME" = "$BASE" || {
    echo "existing checksum record names $REMOTE_NAME, expected $BASE" >&2
    exit 1
  }
  # Verify the archive bytes, not merely the separately stored digest text.
  gh release download "$TAG" --repo "$PUB" --pattern "$BASE" --dir "$TMP" >/dev/null
  ACTUAL_REMOTE_HASH="$(sha256_file "$TMP/$BASE")"
  test "$REMOTE_HASH" = "$LOCAL_HASH" && test "$ACTUAL_REMOTE_HASH" = "$LOCAL_HASH" || {
    echo "existing $BASE bytes/checksum differ; refusing mutable overwrite" >&2
    exit 1
  }
  echo "already staged and verified: $BASE"
else
  gh release upload "$TAG" --repo "$PUB" "$ZIP" "$CASE_SUM_PATH"
fi

# Confirm both the archive and digest are actually attached to the draft.
assets="$(gh release view "$TAG" --repo "$PUB" --json assets --jq '.assets[].name')"
for required in "$BASE" "$CASE_SUM_NAME"; do
  echo "$assets" | grep -Fxq "$required" || {
    echo "upload reported success but $required is not on draft $TAG" >&2
    exit 1
  }
done

echo "staged $BASE -> $PUB $TAG (draft; not public)"
