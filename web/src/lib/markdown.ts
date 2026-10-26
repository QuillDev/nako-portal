// The Markdown renderer (Streamdown and its parsers) is about half the app, and nothing needs it
// before a chat's history arrives. Loading it as its own chunk, started as soon as the app runs,
// lets the page and the history requests start while it downloads and compiles.
import { useSyncExternalStore } from "react"

type Markdown = typeof import("streamdown")

let loaded: Markdown | null = null
const listeners = new Set<() => void>()

export const markdown: Promise<Markdown> = import("streamdown").then(module => {
  loaded = module
  for (const listener of listeners) listener()
  return module
})

/** The renderer once it's in, for code that only runs on rendered Markdown (a table's copy button). */
export const loadedMarkdown = () => loaded

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The renderer, or null for the moment it's still loading. */
export const useMarkdown = () => useSyncExternalStore(subscribe, loadedMarkdown)
