#!/usr/bin/env bash
# Releases the newest origin/main by hand: builds on this machine and publishes the GitHub
# releases the portal hands to installed apps. Nothing builds in CI.
#
#   ./release.sh            desktop and android, each one patch version up
#   ./release.sh desktop    just the desktop app (or: android)
#   ./release.sh desktop 1.3.0
#
# It builds a fresh checkout of origin/main in a temporary worktree, so the clone you run it
# from can be on any branch, dirty or not. See desktop/release.sh and android/release.sh for
# what each build needs. To run the newest copy of this script without checking it out:
#   git fetch origin main && RELEASE_REPO=$PWD bash <(git show origin/main:release.sh)
set -euo pipefail

what=${1:-all}
version=${2:-}
case $what in
  all | desktop | android) ;;
  *)
    echo "usage: ./release.sh [all|desktop|android] [x.y.z]" >&2
    exit 1
    ;;
esac
if [ -n "$version" ] && [ "$what" = all ]; then
  echo "give a version for one app at a time" >&2
  exit 1
fi

cd "${RELEASE_REPO:-$(dirname "$0")}"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
git fetch -q origin main
tree=$(mktemp -d)
git worktree add -q --detach "$tree" origin/main
trap 'git worktree remove --force "$tree"' EXIT
echo "releasing $(git -C "$tree" log -1 --format='%h %s')"

# One patch version past the newest release of that app.
next() {
  local last
  last=$(gh release list -R "$repo" -L 50 --json tagName -q "[.[].tagName | select(startswith(\"$1-v\"))][0] // \"$1-v0.0.0\"")
  IFS=. read -r major minor patch <<<"${last#"$1"-v}"
  echo "$major.$minor.$((patch + 1))"
}

for app in desktop android; do
  if [ "$what" = all ] || [ "$what" = "$app" ]; then
    v=${version:-$(next "$app")}
    echo "== $app $v"
    "$tree/$app/release.sh" "$v"
  fi
done
