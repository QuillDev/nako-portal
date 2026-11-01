// Secrets the agent and you hand each other by name. The agent-secrets plugin keeps them; the
// portal is where you type and reveal them. A reply shows one with a `SECRET:NAME` line; hub.py's
// SECRET_LINE matches the same shape for notifications.
import { useSyncExternalStore } from "react"
import { api, ApiError } from "@/lib/api"

export type SecretInfo = { name: string; note: string; origin: "you" | "agent"; created_at: number; updated_at: number }

const LINE = /^[^\S\n]*SECRET:([A-Za-z_][A-Za-z0-9_]{0,63})[^\S\n]*$/gm
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

export type ReplyPart = { text: string; secret?: undefined } | { secret: string; text?: undefined }

/** A reply cut at its SECRET: lines, so each secret shows where the line was. Lines inside code
 * stay text, and so does a last line still streaming in (its name may not be complete yet). */
export function splitSecrets(text: string, streaming = false): ReplyPart[] {
  const masked = text.replace(CODE, m => " ".repeat(m.length))
  const found = [...masked.matchAll(LINE)].filter(m => !streaming || m.index + m[0].length < text.trimEnd().length)
  if (!found.length) return [{ text }]
  const parts: ReplyPart[] = []
  let at = 0
  for (const m of found) {
    const before = text.slice(at, m.index).trim()
    if (before) parts.push({ text: before })
    parts.push({ secret: m[1] })
    at = m.index + m[0].length
  }
  const after = text.slice(at).trim()
  if (after) parts.push({ text: after })
  return parts
}

export const secretPath = (name: string) => `/api/secrets/${encodeURIComponent(name)}`

export const revealSecret = (name: string) => api<SecretInfo & { value: string }>(secretPath(name)).then(s => s.value)

// The stored names and notes, shared by every card and Settings; reloaded on `secrets.changed`.
// null until the first read; false when the server has no secrets plugin.
let list: SecretInfo[] | false | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

export function reloadSecrets() {
  loading = api<SecretInfo[]>("/api/secrets").then(
    rows => {
      list = rows
      for (const l of listeners) l()
    },
    e => {
      if (e instanceof ApiError && e.status === 404) {
        list = false
        for (const l of listeners) l()
      }
    },
  )
  return loading
}

// A name a reply shows that the list doesn't have yet (stored by a command just now): read again
// once before calling it gone.
const rechecked = new Set<string>()
export function recheckSecret(name: string) {
  if (rechecked.has(name)) return null
  rechecked.add(name)
  return reloadSecrets()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loading) void reloadSecrets()
  return () => listeners.delete(listener)
}

export const useSecrets = () => useSyncExternalStore(subscribe, () => list)
