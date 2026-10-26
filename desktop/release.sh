#!/usr/bin/env bash
# Builds the Linux and Windows desktop apps on this machine and publishes them as the GitHub
# release desktop-v<version>, with the desktop-release.json the portal serves to the apps.
# macOS installs from the Homebrew tap, which builds the tagged source.
#
#   desktop/release.sh 1.2.3            build and publish
#   DRY_RUN=1 desktop/release.sh 1.2.3  build any commit, keep the files, publish nothing
#
# Needs node/npm, and docker for the Windows installer: electron-builder's NSIS step runs under
# wine, in its electronuserland/builder:wine image. Each download is signed with the updater key
# installed apps check (minisign; the earlier Tauri app checks the same key, so it updates into
# this one): TAURI_SIGNING_PRIVATE_KEY(_PASSWORD), or NAKO_UPDATER_KEY (default
# ~/.config/nako-desktop/updater.key) and the same path with .password.
set -euo pipefail

version=${1:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: desktop/release.sh <x.y.z>" >&2
  exit 1
fi
tag="desktop-v$version"
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

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  key=${NAKO_UPDATER_KEY:-$HOME/.config/nako-desktop/updater.key}
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$key")
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(cat "$key.password")
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

# Downloads (Electron itself, NSIS) are cached outside the checkout, so a fresh worktree builds warm.
cache=${XDG_CACHE_HOME:-$HOME/.cache}/nako-desktop-release
mkdir -p "$cache/electron" "$cache/electron-builder" "$cache/wine-home"
export ELECTRON_CACHE=$cache/electron ELECTRON_BUILDER_CACHE=$cache/electron-builder
set_version="-c.extraMetadata.version=$version"

npm ci --silent
npm test --silent
rm -rf dist
npx electron-builder --linux AppImage deb "$set_version" --publish never
# wine wants a home it owns; its prefix stays there between builds.
docker run --rm -u "$(id -u):$(id -g)" -v "$cache/wine-home:/home/builder" -e HOME=/home/builder -v "$PWD:/project" -w /project \
  -v "$cache/electron:/cache/electron" -e ELECTRON_CACHE=/cache/electron \
  -v "$cache/electron-builder:/cache/electron-builder" -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
  electronuserland/builder:wine npx electron-builder --win nsis "$set_version" --publish never

out=$(mktemp -d)
[ -n "${DRY_RUN:-}" ] || trap 'rm -rf "$out"' EXIT
cp "dist/nako-$version-x86_64.AppImage" "$out/nako.AppImage"
cp "dist/nako-$version-amd64.deb" "$out/nako.deb"
cp "dist/nako-$version-x64.exe" "$out/nako-setup.exe"
for file in nako.AppImage nako-setup.exe; do
  npx tauri signer sign "$out/$file" >/dev/null
done

entry() {
  jq -n --arg file "$1" --arg signature "$(cat "$out/$1.sig")" --argjson sizeBytes "$(stat -c %s "$out/$1")" \
    '{file: $file, signature: $signature, sizeBytes: $sizeBytes}'
}
jq -n --arg version "$version" --argjson linux "$(entry nako.AppImage)" --argjson windows "$(entry nako-setup.exe)" \
  '{version: $version, platforms: {"linux-x86_64": $linux, "windows-x86_64": $windows}}' > "$out/desktop-release.json"

if [ -n "${DRY_RUN:-}" ]; then
  echo "built $tag into $out (not published)"
  exit 0
fi
(cd "$out" && gh release create "$tag" -R "$repo" --target "$commit" --title "Desktop $version" --notes "" --latest=false \
  nako.AppImage nako.AppImage.sig nako.deb nako-setup.exe nako-setup.exe.sig desktop-release.json)
