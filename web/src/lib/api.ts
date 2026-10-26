export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

let onSignedOut: () => void = () => {}
export function whenSignedOut(handler: () => void) {
  onSignedOut = handler
}

// Reads public/early.js started from the page's head, before this code had loaded.
const early: Record<string, Promise<Response | null> | undefined> = (window as { __early?: typeof early }).__early ?? {}
// After this long the page has moved on from its first load, and a fresh read is the right one.
const EARLY_MS = 10_000

// The early read of a path, once, when it worked; anything else is read again normally.
async function takeEarly(path: string) {
  const pending = early[path]
  delete early[path]
  if (!pending || performance.now() > EARLY_MS) return null
  const response = await pending
  return response?.ok ? response : null
}

export async function api<T = unknown>(path: string, { method = "GET", body, form }: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} }
  if (form) {
    init.body = form
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" }
    init.body = JSON.stringify(body)
  }
  const response = (method === "GET" && (await takeEarly(path))) || (await fetch(path, init))
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (response.status === 401 && path !== "/api/me") onSignedOut()
  if (!response.ok) throw new ApiError(data?.error || `request failed (${response.status})`, response.status)
  return data as T
}

export const sessionPath = (session: string, rest = "") => `/api/sessions/${encodeURIComponent(session)}${rest}`

export function fileUrl(session: string, path: string) {
  return `/api/file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(path)}`
}

export function b64url(buffer: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function unb64url(text: string) {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

// PromptInput hands attachments over as data URLs; the portal takes multipart files.
export function dataUrlToFile(url: string, name: string, type: string) {
  const comma = url.indexOf(",")
  const bytes = Uint8Array.from(atob(url.slice(comma + 1)), c => c.charCodeAt(0))
  return new File([bytes], name, { type })
}
