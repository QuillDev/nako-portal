#!/usr/bin/env bash
# Builds the Linux and Windows desktop apps on this machine and publishes them as the GitHub
# release desktop-v<version>, with the desktop-release.json the portal serves to the apps.
# macOS installs from the Homebrew tap, which builds the tagged source.
#
#   desktop/release.sh 1.2.3            build and publish
#   DRY_RUN=1 desktop/release.sh 1.2.3  build any commit, keep the files, publish nothing
#   desktop/release.sh 1.2.3 --sync-tap  retry only Homebrew synchronization
#
# Needs node/npm, and docker for the Windows installer: electron-builder's NSIS step runs under
# wine, in its electronuserland/builder:wine image. Each download is signed with the updater key
# installed apps check (minisign; the earlier Tauri app checks the same key, so it updates into
# this one): TAURI_SIGNING_PRIVATE_KEY(_PASSWORD), or NAKO_UPDATER_KEY (default
# ~/.config/nako-desktop/updater.key) and the same path with .password.
set -euo pipefail

version=${1:-}
mode=${2:-}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ -n "$mode" && "$mode" != --sync-tap ]]; then
  echo "usage: desktop/release.sh <x.y.z> [--sync-tap]" >&2
  exit 1
fi
tag="desktop-v$version"
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "the worktree has uncommitted changes; release from a clean checkout" >&2
  exit 1
fi
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Re-runnable after publication. Never downgrade the tap or commit unrelated files.
sync_tap() (
  tap_repo=${NAKO_TAP:-git@github.com:QuillDev/homebrew-tap.git}
  [ "$tap_repo" != none ] || return 0
  tap=$(mktemp -d) || return
  trap 'rm -rf "$tap"' EXIT
  git clone -q "$tap_repo" "$tap" || return
  sha=$(curl --retry 3 -fsSL "https://github.com/$repo/archive/refs/tags/$tag.tar.gz" | sha256sum | cut -d' ' -f1) || return
  node --input-type=module - "$tap/Formula/nako.rb" "$repo" "$version" "$sha" <<'NODE' || return
import { readFileSync, writeFileSync } from 'node:fs'
const [file, repo, version, sha] = process.argv.slice(2)
const source = readFileSync(file, 'utf8')
const urls = [...source.matchAll(/^  url "https:\/\/github\.com\/([^"\n]+)\/archive\/refs\/tags\/desktop-v(\d+\.\d+\.\d+)\.tar\.gz"$/gm)]
const hashes = [...source.matchAll(/^  sha256 "([0-9a-f]{64})"$/gm)]
if (urls.length !== 1 || urls[0][1] !== repo || hashes.length !== 1) throw new Error('Unrecognized Nako formula; refusing to edit')
const current = urls[0][2].split('.').map(Number)
const target = version.split('.').map(Number)
let order = 0
for (let i = 0; i < 3; i++) if (current[i] !== target[i]) { order = Math.sign(current[i] - target[i]); break }
if (order > 0) { console.log('Tap already has a newer version; leaving it alone'); process.exit(0) }
if (order === 0 && hashes[0][1] !== sha) throw new Error('Published tag checksum differs from the tap; refusing to overwrite')
writeFileSync(file, source.replace(urls[0][0], `  url "https://github.com/${repo}/archive/refs/tags/desktop-v${version}.tar.gz"`).replace(hashes[0][0], `  sha256 "${sha}"`))
NODE
  git -C "$tap" diff --quiet -- Formula/nako.rb && return 0
  git -C "$tap" add Formula/nako.rb || return
  git -C "$tap" commit -q -m "nako $version" || return
  git -C "$tap" push -q origin HEAD || return
)

if [ "$mode" = --sync-tap ]; then
  [ -z "${DRY_RUN:-}" ] || { echo "--sync-tap cannot be used with DRY_RUN" >&2; exit 1; }
  gh release view "$tag" -R "$repo" --json isDraft -q '.isDraft' | grep -qx false
  sync_tap
  exit 0
fi

git fetch -q origin main
commit=$(git rev-parse HEAD)
if [ -z "${DRY_RUN:-}" ] && ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "HEAD ($commit) isn't on origin/main; release only merged code" >&2
  exit 1
fi
if gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  echo "$tag already exists; retrying Homebrew synchronization only"
  [ -z "${DRY_RUN:-}" ] || exit 0
  gh release view "$tag" -R "$repo" --json isDraft -q '.isDraft' | grep -qx false
  sync_tap
  exit 0
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

# Publication is complete: a tap failure must not stop the combined Android release or cause a
# retry to publish another desktop version. The explicit retry command fails normally on error.
if ! sync_tap; then
  echo "Published $tag, but Homebrew sync failed. Retry: desktop/release.sh $version --sync-tap" >&2
fi
