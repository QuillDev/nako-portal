// What the in-app browser's address bar does with what you type: go there, or search for it.

/** The engines the portal's Settings can pick (localStorage `browser:search`); Google until one is. */
const ENGINES = {
  google: "https://www.google.com/search",
  duckduckgo: "https://duckduckgo.com/",
  bing: "https://www.bing.com/search",
  brave: "https://search.brave.com/search",
}

export const isEngine = name => Object.hasOwn(ENGINES, name)

/** An address (a scheme is optional) or a search with `engine`; null for nothing typed. */
export function addressOrSearch(text, engine) {
  const typed = String(text ?? "").trim()
  if (!typed) return null
  if (!/\s/.test(typed)) {
    try {
      const url = new URL(typed)
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    } catch {}
    // example.com, localhost:3000, 10.0.0.2/admin: no scheme, but clearly a place.
    const host = typed.split(/[/?#]/)[0]
    const port = host.lastIndexOf(":")
    const name = port > 0 && /^\d+$/.test(host.slice(port + 1)) ? host.slice(0, port) : host
    const looksLikeHost = name === "localhost" || (name.includes(".") && !name.startsWith(".") && !name.endsWith("."))
    if (looksLikeHost) {
      try {
        return new URL(`https://${typed}`).toString()
      } catch {}
    }
  }
  const url = new URL(ENGINES[isEngine(engine) ? engine : "google"])
  url.searchParams.set("q", typed)
  return url.toString()
}
