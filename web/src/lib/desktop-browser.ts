// The desktop app's in-app browser searches with the engine picked in Settings. Apps that can
// set it say so with window.nakoBrowser; browsers and older apps never set it.
import { useSyncExternalStore } from "react"

declare global {
  interface Window {
    nakoBrowser?: { search: boolean }
  }
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
const tellApp = () => void window.__TAURI_INTERNALS__?.invoke("pane_search", { engine: stored() }).catch(() => {})
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
