#!/usr/bin/env bash
# Stage one built platform zip on a *draft* product release.
#
# A dedicated publish job must never make a customer-visible asset before the
# test and accuracy gates pass. The job stages a draft only after all gates;
# re-runs refuse to overwrite an existing asset and verify its recorded digest.
#
# Usage: bash tools/publish_public_zip.sh <path-to-zip>
# Env:   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA; RELEASE_TAG is optional but
#        must match the manifest version when supplied.
set -euo pipefail

trap 'rc=$?; printf "::error title=publish_public_zip failed::line=%s command=%s rc=%s\\n" "$LINENO" "$BASH_COMMAND" "$rc"; exit "$rc"' ERR

ZIP="${1:?usage: publish_public_zip.sh <path-to-zip>}"
test -f "$ZIP" || { echo "zip not found: $ZIP" >&2; exit 1; }
test -n "${GH_TOKEN:-}" || { echo "GH_TOKEN not set" >&2; exit 1; }

PUB="${GITHUB_REPOSITORY:-}"
test -n "$PUB" || { echo "GITHUB_REPOSITORY is required; refusing to guess a repository" >&2; exit 1; }
: "${GITHUB_SHA:?GITHUB_SHA is required; release tags must be bound to the tested commit}"
VER="$(grep -o 'ExtensionBundleVersion="[^"]*"' panel/CSXS/manifest.xml | head -1 | sed 's/[^"]*"//;s/"//')"
test -n "$VER" || { echo "could not read ExtensionBundleVersion from panel/CSXS/manifest.xml" >&2; exit 1; }
TAG="v${VER}"
if [ -n "${RELEASE_TAG:-}" ] && [ "$RELEASE_TAG" != "$TAG" ]; then
  echo "RELEASE_TAG=$RELEASE_TAG does not match manifest version $TAG" >&2
  exit 1
fi
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

# Create the draft once, but tolerate the GitHub API's short-lived
# unavailability/ eventual-consistency window. Do not let a transient release
# API failure abort an otherwise fully verified build.
release_ready=0
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if gh release view "$TAG" --repo "$PUB" >/dev/null 2>&1; then
    release_ready=1
    break
  fi
  if release_output=$(gh release create "$TAG" --repo "$PUB" --draft --target "$GITHUB_SHA" \
      --title "Amharic Captions v${VER} (staged)" \
      --notes "Staged build for v${VER}, commit ${GITHUB_SHA}. This draft is not public until all platform builds, tests, and accuracy gates pass." 2>&1); then
    release_ready=1
    break
  else
    printf '::error title=GitHub release creation failed::%s\n' "$(printf '%s' "$release_output" | tr '\n' ' ' | cut -c1-900)"
  fi
  sleep 2
done
test "$release_ready" = "1" || {
  echo "could not create or find draft release $TAG after retries" >&2
  exit 1
}
# GitHub's release/tag creation endpoints are eventually consistent: a newly
# created release can be visible a moment before its tag resolves through the
# commits API. Retry the read instead of turning that transient state into a
# failed publish.
TAG_SHA=""
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  TAG_SHA="$(gh api "repos/${PUB}/commits/${TAG}" --jq .sha 2>/dev/null || true)"
  [ -n "$TAG_SHA" ] && break
  sleep 2
done
test -n "$TAG_SHA" || {
  echo "release tag $TAG did not become visible after creation" >&2
  exit 1
}
test "$TAG_SHA" = "$GITHUB_SHA" || {
  echo "release tag $TAG points at $TAG_SHA, expected $GITHUB_SHA" >&2
  exit 1
}

DRAFT="$(gh release view "$TAG" --repo "$PUB" --json isDraft --jq '.isDraft')"
test "$DRAFT" = "true" || { echo "release $TAG is already public; refusing to add assets" >&2; exit 1; }

assets="$(gh release view "$TAG" --repo "$PUB" --json assets --jq '.assets[].name')"
if echo "$assets" | grep -Fxq "$BASE"; then
  echo "zip already exists; it will be verified rather than overwritten"
else
  gh release upload "$TAG" --repo "$PUB" "$ZIP"
fi

assets="$(gh release view "$TAG" --repo "$PUB" --json assets --jq '.assets[].name')"
if echo "$assets" | grep -Fxq "$CASE_SUM_NAME"; then
  echo "checksum already exists; it will be verified rather than overwritten"
else
  gh release upload "$TAG" --repo "$PUB" "$CASE_SUM_PATH"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
gh release download "$TAG" --repo "$PUB" --pattern "$CASE_SUM_NAME" --dir "$TMP" >/dev/null
gh release download "$TAG" --repo "$PUB" --pattern "$BASE" --dir "$TMP" >/dev/null
REMOTE_HASH="$(awk '{print $1; exit}' "$TMP/$CASE_SUM_NAME")"
REMOTE_NAME="$(awk '{print $2; exit}' "$TMP/$CASE_SUM_NAME" | sed 's/^\*//')"
test "$REMOTE_NAME" = "$BASE" || {
  echo "existing checksum record names $REMOTE_NAME, expected $BASE" >&2
  exit 1
}
test "$REMOTE_HASH" = "$LOCAL_HASH" || {
  echo "existing checksum differs from the local archive" >&2
  exit 1
}
ACTUAL_REMOTE_HASH="$(sha256_file "$TMP/$BASE")"
test "$ACTUAL_REMOTE_HASH" = "$LOCAL_HASH" || {
  echo "existing $BASE bytes differ from the local archive" >&2
  exit 1
}

# Confirm both the archive and digest are actually attached to the draft.
assets="$(gh release view "$TAG" --repo "$PUB" --json assets --jq '.assets[].name')"
for required in "$BASE" "$CASE_SUM_NAME"; do
  echo "$assets" | grep -Fxq "$required" || {
    echo "upload reported success but $required is not on draft $TAG" >&2
    exit 1
  }
done

echo "staged $BASE -> $PUB $TAG (draft; not public)"
