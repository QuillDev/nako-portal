// The one portal this install talks to, normalized to `scheme://host[:port]`.

/** `scheme://host[:port]` of an http(s) URL, else null. URL already drops a default port and lowercases the host. */
export function originOf(link) {
  let url
  try {
    url = link instanceof URL ? link : new URL(link)
  } catch {
    return null
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null
  return url.origin
}

export const isSessionId = session => typeof session === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(session)

export class ServerOrigin {
  constructor(value) {
    this.value = value
  }

  /** Accepts `portal.example.com`, `https://portal.example.com/` or `http://10.0.0.5:8797`; null otherwise. */
  static parse(input) {
    const trimmed = String(input ?? "").trim().replace(/\/+$/, "")
    if (!trimmed) return null
    const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`
    let url
    try {
      url = new URL(withScheme)
    } catch {
      return null
    }
    const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password && !withScheme.endsWith("#") && !withScheme.endsWith("?")
    const origin = bare ? originOf(url) : null
    return origin ? new ServerOrigin(origin) : null
  }

  get url() {
    return `${this.value}/`
  }

  page(path) {
    return new URL(path, this.url).toString()
  }

  /** Only the portal itself stays in the app; every other link opens elsewhere. */
  opensInApp(link) {
    return originOf(link) === this.value
  }

  /** The portal page for a chat a notification points at; null when the id isn't a session id. */
  chatPage(session) {
    return isSessionId(session) ? this.page(`/#/c/${session}`) : null
  }

  /** The live-event socket alerts arrive on. */
  get socketUrl() {
    return `${this.value.replace(/^http/, "ws")}/ws`
  }

  toJSON() {
    return this.value
  }
}
