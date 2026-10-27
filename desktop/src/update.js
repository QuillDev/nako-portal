// Self-updates from the release the portal publishes (`/api/desktop/release`). The download is
// checked against the updater key built into the app (minisign.js), then waits until nobody is
// using the window to install. The AppImage replaces itself; Windows runs the new installer.
// Homebrew's Mac app can't replace itself: it sees the new version in the same manifest and, when
// you click the update arrow, runs `brew upgrade nako` and reopens.
import { execFile, spawn } from "node:child_process"
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { parsePublicKey, verifySignature } from "./minisign.js"

/** Coming back to the app checks again once this long has passed since the last check. */
const RECHECK_AFTER = 10 * 60 * 1000

export const due = (last, now, after = RECHECK_AFTER) => last == null || now - last >= after

/** What to tell someone whose check failed. */
export function reason(error) {
  if (error === "not signed in") return "Sign in to the portal first"
  if (error === "no release") return "This portal doesn't offer desktop updates"
  return `The portal didn't answer: ${error}`
}

/** How long "up to date" or a failed check stays beside the version before it shows the version again. */
const SETTLE_AFTER = 4000

/** How long the "updating" screen shows before an install quits the app, so you see it happen. */
const SHOW_INSTALL_FOR = 1500

/**
 * Tells the portal page where updating stands: `state` is idle, checking, latest, error (`error`
 * says why), ready (`version` is downloaded) or installing (`brew` when Homebrew builds it). Older
 * pages only read `version` and show their restart arrow for it, so only ready and installing carry one.
 */
export const announcement = status => `window.nakoUpdate = ${JSON.stringify(status)}; window.dispatchEvent(new Event("nako-update"))`

/** Whether `candidate` (x.y.z) is newer than `current`. */
export function newer(candidate, current) {
  const parse = v => String(v).split(".").map(Number)
  const [a, b] = [parse(candidate), parse(current)]
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

/** Homebrew's Mac app: it updates through brew, not from the release files. */
export const BREW = "macos-brew"

/**
 * How this install updates: its entry in the release manifest, BREW for Homebrew's Mac app
 * (`appPath` is the app's real path, inside brew's Cellar), or null where the app doesn't update
 * itself (the .deb updates through apt, a Mac app from elsewhere through whoever installed it).
 */
export function platformKey(env = process.env, platform = process.platform, packaged = true, appPath = "") {
  if (platform === "linux") return env.APPIMAGE ? "linux-x86_64" : null
  if (platform === "win32") return packaged ? "windows-x86_64" : null
  if (platform === "darwin") return packaged && /\/Cellar\/nako\//.test(appPath) ? BREW : null
  return null
}

/** The Homebrew tap the Mac app installs from. */
export const TAP = "quilldev/tap"

/** Where `brew` is: Apple silicon, then Intel. GUI apps don't get the shell's PATH. */
export const findBrew = (exists = existsSync) => ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(path => exists(path)) ?? null

/** The version in `brew list --versions nako` ("nako 0.3.1"), or null. */
export const brewVersion = output => /^nako (\d+\.\d+\.\d+)/m.exec(output)?.[1] ?? null

/** Runs `brew` with `args`; resolves {ok, output}. */
function runBrew(brew, args) {
  // brew's own bin dir first, so the build finds the node it installed.
  const env = { ...process.env, PATH: `${dirname(brew)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOMEBREW_NO_ENV_HINTS: "1" }
  return new Promise(resolve =>
    execFile(brew, args, { env, maxBuffer: 64 << 20 }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` })),
  )
}

export class Updater {
  pending = null
  last = null
  checking = false
  status = { state: "idle" }

  /** `cookie()` → Cookie header or null, `onReady(version)` once a download is verified, `notify(title, body)` for the tray's check. */
  constructor({
    version,
    platform,
    publicKey,
    cookie,
    onReady,
    onStatus = () => {},
    notify,
    quit,
    log = () => {},
    brew = findBrew,
    runBrew: brewRunner = runBrew,
    reopen,
    settleAfter = SETTLE_AFTER,
    showInstallFor = SHOW_INSTALL_FOR,
  }) {
    Object.assign(this, { version, platform, cookie, onReady, onStatus, notify, quit, log, brew, brewRunner, settleAfter, showInstallFor })
    this.reopen = reopen ?? (app => spawn("sh", ["-c", 'sleep 1; exec open "$0"', app], { detached: true, stdio: "ignore" }).unref())
    this.key = parsePublicKey(publicKey)
  }

  get enabled() {
    return this.platform != null
  }

  /** Whether a found update installs by itself once the window loses focus. Homebrew's build takes minutes, so it waits for a click. */
  get automatic() {
    return this.platform !== BREW
  }

  /** Checks shortly after the portal opens, then every six hours (ten minutes after a failed check). */
  watch(origin) {
    clearTimeout(this.timer)
    this.origin = origin
    if (!this.enabled) return
    const next = ms => (this.timer = setTimeout(async () => next((await this.run(false)) === "error" ? 600_000 : 6 * 3600_000), ms))
    next(Number(process.env.NAKO_FIRST_CHECK_MS) || 20_000)
  }

  /** The window came back (focused, reopened, the portal reloaded): check if the last one was a while ago. */
  checkIfDue() {
    if (this.enabled && !this.pending && this.origin && due(this.last, Date.now(), Number(process.env.NAKO_RECHECK_MS) || RECHECK_AFTER)) this.run(false)
  }

  #set(status) {
    clearTimeout(this.settle)
    this.status = status
    this.onStatus(status)
    // "Up to date" and a failed check are answers to a click; after a moment the version shows again.
    if (status.state === "latest" || status.state === "error")
      this.settle = setTimeout(() => this.#set(this.pending ? { state: "ready", version: this.pending.version } : { state: "idle" }), this.settleAfter)
  }

  /** The portal's version button: check now and show the answer beside the version; a found update waits for its button. */
  async check() {
    if (!this.enabled || this.status.state === "installing") return
    if (this.pending) return this.#set({ state: "ready", version: this.pending.version })
    if (!this.origin) return this.#set({ state: "error", error: "Connect to a portal first" })
    this.#set({ state: "checking" })
    while (this.checking) await new Promise(r => setTimeout(r, 200))
    const result = this.pending ? "found" : await this.run(false)
    if (result === "none") this.#set({ state: "latest" })
    else if (result === "error") this.#set({ state: "error", error: reason(this.error) })
  }

  /** The tray's "Check for updates": check now and install what it finds, or say why not. */
  async checkNow() {
    if (!this.enabled) return
    if (this.pending) return this.install(false)
    if (!this.origin) return this.notify("Can't check for updates", "Connect to a portal first")
    while (this.checking) await new Promise(r => setTimeout(r, 200))
    if (this.pending) return this.install(false)
    const result = await this.run(true)
    if (result === "none") this.notify("Nako is up to date", `Version ${this.version}`)
    else if (result === "error") this.notify("Couldn't check for updates", reason(this.error))
  }

  /** "found", "none" or "error" (the reason in `this.error`); "busy" when another check is running. */
  async run(now) {
    if (this.checking) return "busy"
    this.checking = true
    this.last = Date.now()
    try {
      const found = await this.#check()
      if (!found) return "none"
      this.#set({ state: "ready", version: this.pending.version })
      this.onReady(this.pending.version)
      if (now) this.install(false)
      return "found"
    } catch (error) {
      this.error = error.message
      this.log(`no update: ${error.message}`)
      return "error"
    } finally {
      this.checking = false
    }
  }

  async #check() {
    const cookie = await this.cookie()
    if (!cookie) throw new Error("not signed in")
    const response = await fetch(new URL("/api/desktop/release", this.origin.url), { headers: { Cookie: cookie } })
    if (response.status === 404) throw new Error("no release")
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const release = await response.json()
    if (this.platform === BREW) {
      if (!newer(release?.version, this.version)) return false
      this.pending = { version: release.version, brew: true }
      return true
    }
    const entry = release?.platforms?.[this.platform]
    if (!entry || !newer(release.version, this.version)) return false
    // Only from the portal itself, like the manifest.
    if (!this.origin.opensInApp(entry.url)) throw new Error("the release isn't on the portal")
    const file = await fetch(entry.url, { headers: { Cookie: cookie } })
    if (!file.ok) throw new Error(`HTTP ${file.status}`)
    const bytes = Buffer.from(await file.arrayBuffer())
    if (!verifySignature(bytes, entry.signature, this.key)) throw new Error("the download's signature doesn't match")
    this.pending = { version: release.version, bytes }
    return true
  }

  /** Homebrew's app: brew builds the new version (a few minutes), then the app reopens as it. */
  async #upgrade(update) {
    if (this.upgrading) return
    const brew = this.brew()
    if (!brew) return this.notify("Couldn't update Nako", "Homebrew isn't installed where Nako looks (/opt/homebrew or /usr/local)")
    this.upgrading = true
    this.#set({ state: "installing", version: update.version, brew: true })
    this.notify("Updating Nako", `Homebrew is building ${update.version}. Nako reopens when it's done.`)
    let failed = null
    try {
      await this.brewRunner(brew, ["update", "--quiet"])
      // brew update sometimes leaves a tap behind; pull the app's own tap so the new formula is there.
      const tap = (await this.brewRunner(brew, ["--repo", TAP])).output.trim()
      if (tap.startsWith("/")) await this.brewRunner("/usr/bin/git", ["-C", tap, "pull", "--ff-only", "--quiet"])
      const upgrade = await this.brewRunner(brew, ["upgrade", "nako"])
      const installed = brewVersion((await this.brewRunner(brew, ["list", "--versions", "nako"])).output)
      if (!installed || !newer(installed, this.version)) {
        this.log(`brew upgrade: ${upgrade.output.trim().split("\n").at(-1)}`)
        failed = upgrade.ok ? `Homebrew doesn't have ${update.version} yet` : upgrade.output.trim().split("\n").at(-1) || "brew upgrade failed"
        return this.notify("Couldn't update Nako", failed)
      }
      this.pending = null
      this.reopen(join(dirname(dirname(brew)), "opt", "nako", "Nako.app"))
      this.quit()
    } catch (error) {
      failed = error.message
      throw error
    } finally {
      this.upgrading = false
      // Still here: the update button comes back, with what went wrong.
      if (failed) this.#set({ state: "ready", version: update.version, error: failed })
    }
  }

  /** Installs a downloaded update and restarts into it. `hidden` comes back in the tray. */
  async install(hidden) {
    const update = this.pending
    if (!update) return
    if (update.brew) return this.#upgrade(update)
    this.pending = null
    this.#set({ state: "installing", version: update.version })
    if (!hidden) await new Promise(r => setTimeout(r, this.showInstallFor))
    try {
      if (this.platform === "linux-x86_64") {
        const image = process.env.APPIMAGE
        writeFileSync(`${image}.new`, update.bytes)
        chmodSync(`${image}.new`, 0o755)
        renameSync(`${image}.new`, image)
        // Start the new copy after this one has quit, so the single-instance lock is free.
        spawn("sh", ["-c", 'sleep 1; exec "$0" "$@"', image, ...(hidden ? ["--hidden"] : [])], { detached: true, stdio: "ignore" }).unref()
      } else if (this.platform === "windows-x86_64") {
        const installer = join(tmpdir(), `nako-setup-${update.version}.exe`)
        writeFileSync(installer, update.bytes)
        // Silent, and the installer starts the new version when it's done.
        spawn(installer, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref()
      }
      this.quit()
    } catch (error) {
      this.log(`update failed: ${error.message}`)
      this.pending = update
      this.#set({ state: "ready", version: update.version, error: error.message })
    }
  }
}

/** The key releases are signed with (`desktop/pubkey.txt`). */
export const readPublicKey = path => readFileSync(path, "utf8")
