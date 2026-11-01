// Long-lived pages (the apps' floating panels, a tab left open for days) keep the bundle they first
// loaded, so a deploy never reaches them and new kinds of cards show as unanswerable. Whenever the
// page comes back into view, and now and then while it's up, compare our bundle with the one the
// server hands out and reload onto the new one. Drafts live in localStorage, so a reload loses
// nothing; it only waits while a secret is half-typed, the one value deliberately never saved.

const BUNDLE = /\/assets\/index-[\w-]+\.js/
/** Don't ask the server more often than this, however many triggers fire. */
const QUIET = 30_000
const EVERY = 5 * 60_000

/** The bundle this page runs, or null in the dev server (no hashed bundle, nothing to compare). */
export function loadedBundle(doc: Document = document): string | null {
  for (const script of doc.querySelectorAll<HTMLScriptElement>("script[type=module][src]")) {
    const match = new URL(script.src, location.href).pathname.match(BUNDLE)
    if (match) return match[0]
  }
  return null
}

/** The bundle named in a served index.html, or null when it names none. */
export const servedBundle = (html: string): string | null => html.match(BUNDLE)?.[0] ?? null

/** A secret typed into a request card isn't saved anywhere, so a reload would throw it away. */
function typingSecret(): boolean {
  return [...document.querySelectorAll<HTMLInputElement>("[data-secret-request] input")].some(input => input.value)
}

let last = 0

/** Reload onto the server's current bundle if ours is older. `now` skips the quiet period. */
export async function checkBuild(now = false): Promise<void> {
  const ours = loadedBundle()
  if (!ours || (!now && Date.now() - last < QUIET)) return
  last = Date.now()
  try {
    const response = await fetch("/", { cache: "no-store", credentials: "same-origin" })
    if (!response.ok) return
    const theirs = servedBundle(await response.text())
    if (theirs && theirs !== ours && !typingSecret()) location.reload()
  } catch {
    // Offline or mid-restart: the next trigger tries again.
  }
}

if (loadedBundle()) {
  const check = () => document.visibilityState === "visible" && void checkBuild()
  document.addEventListener("visibilitychange", check)
  window.addEventListener("focus", check)
  // The Android panel reopens by moving the hash to the chat it shows.
  window.addEventListener("hashchange", check)
  setInterval(check, EVERY)
}
