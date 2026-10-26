// The apps' in-app browser. The desktop app's searches with the engine picked in Settings; both
// it and the Android app (on a wide screen) can open each chat's browser from the chat header.
// Apps say what they can do with window.nakoBrowser; browsers and older apps never set it.
import { useSyncExternalStore } from "react"
import { desktopApp } from "./desktop-window"

declare global {
  interface Window {
    nakoBrowser?: { search?: boolean; toggle?: boolean; open?: boolean }
    NakoApp?: { toggleBrowser?: () => void }
  }
}

// The app fires "nako-browser" when the browser opens or closes, or stops fitting the window.
const subscribeBrowser = (changed: () => void) => {
  window.addEventListener("nako-browser", changed)
  return () => window.removeEventListener("nako-browser", changed)
}

/** "none" when there's no in-app browser to open from here, else whether it's open. */
const browserState = () => (!window.nakoBrowser?.toggle ? "none" : window.nakoBrowser.open ? "open" : "closed")

export const useAppBrowser = () => useSyncExternalStore(subscribeBrowser, browserState, () => "none" as const)

export function toggleAppBrowser() {
  if (window.NakoApp?.toggleBrowser) window.NakoApp.toggleBrowser()
  else void desktopApp()?.invoke("pane_toggle").catch(() => {})
}

export const SEARCH_ENGINES = { google: "Google", duckduckgo: "DuckDuckGo", bing: "Bing", brave: "Brave" } as const
export type SearchEngine = keyof typeof SEARCH_ENGINES

const KEY = "browser:search"
const listeners = new Set<() => void>()

export const canPickSearch = () => Boolean(window.nakoBrowser?.search)

const stored = (): SearchEngine => {
  const value = localStorage.getItem(KEY)
  return value && value in SEARCH_ENGINES ? (value as SearchEngine) : "google"
}

// The app forgets the pick when it quits, so every page load hands it over again.
const tellApp = () => void desktopApp()?.invoke("pane_search", { engine: stored() }).catch(() => {})
if (canPickSearch()) tellApp()

export function setSearchEngine(engine: SearchEngine) {
  localStorage.setItem(KEY, engine)
  tellApp()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useSearchEngine = () => useSyncExternalStore(subscribe, stored)
