import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

// The publication scripts use GNU stat/sha256sum on their Linux build host.
const releaseTest = process.platform === "linux" ? test : test.skip

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nako-release-test-"))
  mkdirSync(join(root, "bin"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = (path, text) => writeFileSync(join(root, path), `#!/usr/bin/env bash\nset -euo pipefail\n${text}\n`, { mode: 0o755 })
  const run = (file, args = [], env = {}) => spawnSync("bash", [file, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TMPDIR: root, FIXTURE: root, ...env },
  })
  script("bin/git", `case "$1" in
    status|fetch|merge-base) ;;
    rev-parse) echo abc123 ;;
    log) echo 'abc123 fixture' ;;
    worktree)
      if [ "$2" = add ]; then
        for app in desktop android; do
          mkdir -p "$5/$app"
          cp "$FIXTURE/record" "$5/$app/release.sh"
        done
      fi ;;
    *) echo "unexpected git: $*" >&2; exit 1 ;;
  esac`)
  return { root, script, run }
}

releaseTest("automatic versions use the maximum matching tag across all release pages", t => {
  const { root, script, run } = fixture(t)
  copyFileSync(new URL("../../release.sh", import.meta.url), join(root, "release.sh"))
  script("record", 'echo "$(basename "$(dirname "$0")") $1" >> "$FIXTURE/versions"')
  // The desktop maximum is older than 100 other releases, and neither list is version sorted.
  writeFileSync(join(root, "tags"), [...Array.from({ length: 120 }, (_, i) => `android-v0.0.${i}`), "desktop-v2.9.12", "desktop-v2.10.9", "desktop-v2.3.99", "desktop-v99.invalid"].join("\n"))
  script("bin/gh", `case "$1" in
    repo) echo QuillDev/nako-portal ;;
    api)
      [[ "$*" == *--paginate* && "$*" == *per_page=100* ]]
      cat "$FIXTURE/tags" ;;
    *) exit 1 ;;
  esac`)
  const result = run("release.sh")
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(root, "versions"), "utf8"), "desktop 2.10.10\nandroid 0.0.120\n")
  script("bin/gh", 'if [ "$1" = repo ]; then echo QuillDev/nako-portal; else exit 1; fi')
  const failed = run("release.sh", ["desktop"])
  assert.notEqual(failed.status, 0, "an API failure must not reset numbering")
  assert.equal(readFileSync(join(root, "versions"), "utf8"), "desktop 2.10.10\nandroid 0.0.120\n")
})

releaseTest("Android version codes take the maximum manifest value, not the newest tag's code", t => {
  const { root, script, run } = fixture(t)
  copyFileSync(new URL("../../android/release.sh", import.meta.url), join(root, "release.sh"))
  script("bin/gh", `case "$1" in
    repo) echo QuillDev/nako-portal ;;
    api)
      [[ "$*" == *--paginate* && "$*" == *per_page=100* ]]
      printf 'android-v4.0.0\\nandroid-v0.1.0\\n' ;;
    release)
      [ "$2" != view ] || exit 1
      [ "$2" = download ]
      if [ "$3" = android-v4.0.0 ]; then echo '{"versionCode":3}'; else echo '{"versionCode":900}'; fi ;;
    *) exit 1 ;;
  esac`)
  script("gradlew", 'echo "$PORTAL_ANDROID_VERSION_CODE" > "$FIXTURE/code"; mkdir -p app/build/outputs/apk/release; touch app/build/outputs/apk/release/app-release.apk')
  const result = run("release.sh", ["4.0.1"], { DRY_RUN: "1", PORTAL_ANDROID_KEYSTORE_PASSWORD: "fixture" })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(root, "code"), "utf8"), "901\n")
})

releaseTest("Homebrew synchronization is resumable, idempotent and never downgrades", t => {
  const { root, script, run } = fixture(t)
  copyFileSync(new URL("../../desktop/release.sh", import.meta.url), join(root, "release.sh"))
  const sha = createHash("sha256").update("source archive").digest("hex")
  const formula = version => `class Nako < Formula\n  url "https://github.com/QuillDev/nako-portal/archive/refs/tags/desktop-v${version}.tar.gz"\n  sha256 "${sha}"\nend\n`
  writeFileSync(join(root, "formula"), formula("1.0.0"))
  script("bin/gh", `case "$1" in repo) echo QuillDev/nako-portal ;; release) echo false ;; *) exit 1 ;; esac`)
  script("bin/curl", 'printf "source archive"')
  script("bin/git", `case "$1" in
    status) ;;
    clone) mkdir -p "$4/Formula"; cp "$FIXTURE/formula" "$4/Formula/nako.rb" ;;
    -C)
      case "$3" in
        diff) cmp -s "$FIXTURE/formula" "$2/Formula/nako.rb" ;;
        add|commit) ;;
        push)
          [ ! -f "$FIXTURE/fail-push" ] || exit 1
          cp "$2/Formula/nako.rb" "$FIXTURE/formula"
          echo push >> "$FIXTURE/pushes" ;;
        *) exit 1 ;;
      esac ;;
    *) exit 1 ;;
  esac`)
  writeFileSync(join(root, "fail-push"), "")
  assert.notEqual(run("release.sh", ["1.0.1", "--sync-tap"]).status, 0)
  rmSync(join(root, "fail-push"))
  let result = run("release.sh", ["1.0.1", "--sync-tap"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(root, "formula"), "utf8"), formula("1.0.1"))
  for (const version of ["1.0.1", "1.0.0"]) {
    result = run("release.sh", [version, "--sync-tap"])
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(readFileSync(join(root, "pushes"), "utf8"), "push\n")
  writeFileSync(join(root, "formula"), "unexpected formula\n")
  assert.notEqual(run("release.sh", ["1.0.1", "--sync-tap"]).status, 0)
})
