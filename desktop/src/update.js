// Self-updates from the release the portal publishes (`/api/desktop/release`). The download is
// checked against the updater key built into the app (minisign.js), then waits until nobody is
// using the window to install. The AppImage replaces itself; Windows runs the new installer.
import { spawn } from "node:child_process"
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

/** Tells the portal page an update is ready, so it can offer a restart. */
export const announcement = version => `window.nakoUpdate = ${JSON.stringify({ version })}; window.dispatchEvent(new Event("nako-update"))`

/** Whether `candidate` (x.y.z) is newer than `current`. */
export function newer(candidate, current) {
  const parse = v => String(v).split(".").map(Number)
  const [a, b] = [parse(candidate), parse(current)]
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

/** This install's entry in the release manifest; null where the app doesn't replace itself (the .deb, Homebrew's app). */
export function platformKey(env = process.env, platform = process.platform, packaged = true) {
  if (platform === "linux") return env.APPIMAGE ? "linux-x86_64" : null
  if (platform === "win32") return packaged ? "windows-x86_64" : null
  return null
}

export class Updater {
  pending = null
  last = null
  checking = false

  /** `cookie()` → Cookie header or null, `onReady(version)` once a download is verified, `notify(title, body)` for the tray's check. */
  constructor({ version, platform, publicKey, cookie, onReady, notify, quit, log = () => {} }) {
    Object.assign(this, { version, platform, cookie, onReady, notify, quit, log })
    this.key = parsePublicKey(publicKey)
  }

  get enabled() {
    return this.platform != null
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

  /** Installs a downloaded update and restarts into it. `hidden` comes back in the tray. */
  install(hidden) {
    const update = this.pending
    if (!update) return
    this.pending = null
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
    }
  }
}

/** The key releases are signed with (`desktop/pubkey.txt`). */
export const readPublicKey = path => readFileSync(path, "utf8")
