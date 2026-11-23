#!/usr/bin/env bash
# Builds the signed Android shell on this machine and publishes it as the GitHub release
# android-v<version>, with the android-release.json the portal serves to installed apps.
#
#   android/release.sh 1.2.3            build and publish
#   DRY_RUN=1 android/release.sh 1.2.3  build any commit, keep the files, publish nothing
#
# Needs: JDK 21 and an Android SDK (ANDROID_HOME). The signing key comes from
# PORTAL_ANDROID_KEYSTORE (default ~/.config/hermes-portal/android-release.jks) and
# PORTAL_ANDROID_KEYSTORE_PASSWORD (default: the keystore path with .password instead of .jks).
set -euo pipefail

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: android/release.sh <x.y.z>" >&2
  exit 1
fi
tag="android-v$version"
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "the worktree has uncommitted changes; release from a clean checkout" >&2
  exit 1
fi
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
git fetch -q origin main
commit=$(git rev-parse HEAD)
if [ -z "${DRY_RUN:-}" ] && ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "HEAD ($commit) isn't on origin/main; release only merged code" >&2
  exit 1
fi
if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  echo "$tag already exists" >&2
  exit 1
fi

# Codes need not follow tag order. Inspect every published Android manifest, on every page.
releases=$(gh api --paginate "repos/$repo/releases?per_page=100" --jq '.[] | select(.draft | not) | select(.tag_name | test("^android-v[0-9]+\\.[0-9]+\\.[0-9]+$")) | select(any(.assets[]; .name == "android-release.json")) | .tag_name')
code=1
while IFS= read -r released; do
  [ -n "$released" ] || continue
  previous=$(gh release download "$released" -R "$repo" -p android-release.json -O - |
    jq -er '.versionCode | select(type == "number" and . == floor and . > 0 and . < 2100000000)')
  if (( previous >= code )); then code=$((previous + 1)); fi
done <<<"$releases"

export PORTAL_ANDROID_KEYSTORE=${PORTAL_ANDROID_KEYSTORE:-$HOME/.config/hermes-portal/android-release.jks}
if [ -z "${PORTAL_ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  PORTAL_ANDROID_KEYSTORE_PASSWORD=$(cat "${PORTAL_ANDROID_KEYSTORE%.jks}.password")
fi
export PORTAL_ANDROID_KEYSTORE_PASSWORD
export PORTAL_ANDROID_KEY_PASSWORD=${PORTAL_ANDROID_KEY_PASSWORD:-$PORTAL_ANDROID_KEYSTORE_PASSWORD}
export PORTAL_ANDROID_KEY_ALIAS=${PORTAL_ANDROID_KEY_ALIAS:-hermes}
export PORTAL_ANDROID_VERSION_CODE=$code PORTAL_ANDROID_VERSION_NAME=$version

./gradlew --no-daemon -q testDebugUnitTest lintDebug assembleRelease

out=$(mktemp -d)
[ -n "${DRY_RUN:-}" ] || trap 'rm -rf "$out"' EXIT
cp app/build/outputs/apk/release/app-release.apk "$out/nako.apk"
jq -n --argjson versionCode "$code" --arg versionName "$version" \
  --arg sha256 "$(sha256sum "$out/nako.apk" | cut -d' ' -f1)" --argjson sizeBytes "$(stat -c %s "$out/nako.apk")" \
  '{versionCode: $versionCode, versionName: $versionName, sha256: $sha256, sizeBytes: $sizeBytes}' > "$out/android-release.json"

if [ -n "${DRY_RUN:-}" ]; then
  echo "built $tag (version code $code) into $out (not published)"
  exit 0
fi
(cd "$out" && gh release create "$tag" -R "$repo" --target "$commit" --title "Android $version" --notes "" --latest=false \
  nako.apk android-release.json)
