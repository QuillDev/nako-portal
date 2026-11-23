import { useEffect, useSyncExternalStore } from "react"

type Markdown = typeof import("streamdown")

let loaded: Markdown | null = null
const listeners = new Set<() => void>()

let pending: Promise<Markdown> | null = null

/** Start only after sign-in (or when a Markdown body is actually mounted). */
export function loadMarkdown(): Promise<Markdown> {
  return pending ??= import("streamdown").then(module => {
    loaded = module
    for (const listener of listeners) listener()
    return module
  }).catch(error => {
    pending = null
    throw error
  })
}

/** The renderer once it's in, for code that only runs on rendered Markdown (a table's copy button). */
export const loadedMarkdown = () => loaded

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The renderer, or null for the moment it's still loading. */
export const useMarkdown = () => {
  useEffect(() => { void loadMarkdown().catch(() => {}) }, [])
  return useSyncExternalStore(subscribe, loadedMarkdown)
}
