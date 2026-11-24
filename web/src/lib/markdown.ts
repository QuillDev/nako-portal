import { useEffect, useSyncExternalStore } from "react"
import { retryableLoader } from "./retryable-loader"

type Markdown = typeof import("streamdown") & { plugins: import("streamdown").PluginConfig }

// Code highlighting rides in the same chunk; Shiki fetches each language's grammar on first use.
const loader = retryableLoader<Markdown>(async () => {
  const [markdown, { code }] = await Promise.all([import("streamdown"), import("@streamdown/code")])
  return { ...markdown, plugins: { code } }
})

/** Start only after sign-in (or when a Markdown body is actually mounted). */
export const loadMarkdown = loader.load
export const retryMarkdown = loader.load
export const useMarkdownError = () => useSyncExternalStore(loader.subscribe, loader.error)

/** The renderer once it's in, for code that only runs on rendered Markdown (a table's copy button). */
export const loadedMarkdown = loader.get

/** The renderer, or null for the moment it's still loading. */
export const useMarkdown = () => {
  // Newly mounted plain-text replies must not restart a failed import in a loop.
  useEffect(() => { if (!loader.error()) void loadMarkdown().catch(() => {}) }, [])
  return useSyncExternalStore(loader.subscribe, loadedMarkdown)
}
