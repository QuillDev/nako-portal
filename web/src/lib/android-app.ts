import { useSyncExternalStore } from "react"

export const ANDROID_APP_PACKAGE = "moe.nakode.portal"
export const ANDROID_APP_SCHEME = "nako"

const CHAT = /^#\/c\/([\w.-]{1,120})(?:[/?#].*)?$/
const SETTINGS = /^#\/settings(?:\/([\w-]{1,64}))?$/

/** True on a mobile Android browser outside Nako's own app shells. */
export function isAndroidBrowser(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Android/.test(ua) && !/Nako(?:Android|Desktop|Bubble)\//.test(ua)
}

function deepLinkTarget(hash: string): string | null {
  if (hash.startsWith("#/desktop?")) return null
  if (new URLSearchParams(hash.slice(1)).has("setup")) return null
  const chat = hash.match(CHAT)
  if (chat) return `open?c=${encodeURIComponent(chat[1])}`
  if (hash === "#/new") return "open?page=new"
  if (hash === "#/elsewhere") return "open?page=elsewhere"
  const settings = hash.match(SETTINGS)
  if (settings) return `open?page=${settings[1] ? `settings/${encodeURIComponent(settings[1])}` : "settings"}`
  if (hash === "#/mesh") return "open?page=settings/mesh"
  if (hash === "#/environments") return "open?page=settings/environments"
  return "open"
}

/** Chrome Android `intent://` link to open the current portal page in the app, falling back to `href`. */
export function androidAppIntentUrl(href: string, hash: string): string | null {
  if (!/^https?:\/\//.test(href)) return null
  const target = deepLinkTarget(hash)
  if (!target) return null
  return `intent://${target}#Intent;scheme=${ANDROID_APP_SCHEME};package=${ANDROID_APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(href)};end`
}

const subscribeRoute = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange)
  window.addEventListener("popstate", onChange)
  return () => {
    window.removeEventListener("hashchange", onChange)
    window.removeEventListener("popstate", onChange)
  }
}

const currentAppUrl = () => (isAndroidBrowser() ? androidAppIntentUrl(location.href, location.hash) : null)

/** Intent link for the current route in a mobile Android browser, or null everywhere else. */
export function useAndroidAppUrl(): string | null {
  return useSyncExternalStore(subscribeRoute, currentAppUrl, () => null)
}
