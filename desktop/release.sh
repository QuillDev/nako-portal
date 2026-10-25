#!/usr/bin/env bash
# Builds the signed Linux and Windows desktop apps on this machine and publishes them as the
# GitHub release desktop-v<version>, with the desktop-release.json the portal serves to the apps.
# macOS installs from the Homebrew tap, which builds the tagged source.
#
#   desktop/release.sh 1.2.3            build and publish
#   DRY_RUN=1 desktop/release.sh 1.2.3  build any commit, keep the files, publish nothing
#
# Needs: docker (Linux builds in an Ubuntu 24.04 container, see linux-build.Dockerfile), plus
# cargo-xwin, nsis, clang, lld and llvm and the x86_64-pc-windows-msvc rust target for the Windows
# cross-build. The updater key comes from
# TAURI_SIGNING_PRIVATE_KEY(_PASSWORD), or from NAKO_UPDATER_KEY (default
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

# Build caches live outside the checkout, so a fresh worktree builds warm.
cache=${XDG_CACHE_HOME:-$HOME/.cache}/nako-desktop-release
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$cache/target}
mkdir -p "$cache/linux-target" "$cache/linux-cargo"
config="{\"version\":\"$version\",\"bundle\":{\"createUpdaterArtifacts\":true}}"

npm ci --silent
(cd src-tauri && cargo test --locked --quiet && cargo clippy --locked --quiet --all-targets -- -D warnings)
docker build -q -t nako-desktop-linux-build - < linux-build.Dockerfile >/dev/null
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -w /src \
  -v "$cache/linux-target:/target" -e CARGO_TARGET_DIR=/target -v "$cache/linux-cargo:/usr/local/cargo/registry" \
  -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  nako-desktop-linux-build npx tauri build --ci --bundles appimage,deb --config "$config"
npx tauri build --ci --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis --config "$config"

out=$(mktemp -d)
[ -n "${DRY_RUN:-}" ] || trap 'rm -rf "$out"' EXIT
linux=$cache/linux-target/release/bundle
windows=$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle
cp "$linux/appimage/Nako_${version}_amd64.AppImage" "$out/nako.AppImage"
cp "$linux/appimage/Nako_${version}_amd64.AppImage.sig" "$out/nako.AppImage.sig"
cp "$linux/deb/Nako_${version}_amd64.deb" "$out/nako.deb"
cp "$windows/nsis/Nako_${version}_x64-setup.exe" "$out/nako-setup.exe"
cp "$windows/nsis/Nako_${version}_x64-setup.exe.sig" "$out/nako-setup.exe.sig"

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
