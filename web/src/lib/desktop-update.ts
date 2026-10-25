import { useSyncExternalStore } from "react"

// The desktop app sets window.nakoUpdate once it has downloaded an update, and fires
// "nako-update". Browsers and older apps never set it, so nothing shows there.
declare global {
  interface Window {
    nakoUpdate?: { version: string }
  }
}

const subscribe = (changed: () => void) => {
  window.addEventListener("nako-update", changed)
  return () => window.removeEventListener("nako-update", changed)
}

const version = () => window.nakoUpdate?.version ?? null

export function useDesktopUpdate() {
  return useSyncExternalStore(subscribe, version, () => null)
}

/** The app catches this navigation, installs the update and restarts. */
export function installDesktopUpdate() {
  window.location.assign("/desktop/update")
}

/** The installed desktop or Android app's version, from the agent the app tags; null in a browser. */
export const appVersion = navigator.userAgent.match(/Nako(?:Desktop|Android)\/(\d+\.\d+\.\d+)/)?.[1] ?? null
