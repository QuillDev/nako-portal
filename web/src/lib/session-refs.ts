// `@session:<profile>/<id>` references, the form Hermes's session search tells Nako to cite a past
// chat in. Hermes Desktop draws them as links to the chat; here they become links to the chat's
// page in the portal, labelled with its title once the chat list knows it.
import { useSyncExternalStore } from "react"

// Same match as Hermes Desktop (`apps/desktop/src/lib/session-refs.ts`): a bare value or one
// fenced in backticks/quotes, not inside a word, a path or a markdown link a reply already wrote.
const SESSION_REF = /(?<![\w/])(?<!]\()@session:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g
const TRAILING = /[,.;:!?)\]}]+$/
// What the portal's chat route accepts (`parseRoute`).
const SESSION_ID = /^[\w.-]+$/
// Code fences and inline code spans, which show references as typed.
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g

export const CHAT_HREF = "#/c/"

/** The chat a reference points at, or null when it isn't one the portal can open. */
export function sessionOf(value: string): string | null {
  const id = value.slice(value.indexOf("/") + 1).trim()
  return SESSION_ID.test(id) ? id : null
}

/** A chat id short enough to read, for a chat the list doesn't know the title of. */
export const shortId = (id: string) => (id.length > 10 ? `${id.slice(0, 8)}…` : id)

function linkify(text: string) {
  return text.replace(SESSION_REF, (match, raw: string) => {
    const fenced = /^([`"']).*\1$/.test(raw) && raw.length > 1
    const value = fenced ? raw.slice(1, -1) : raw.replace(TRAILING, "")
    const session = sessionOf(value)
    if (!session) return match
    const trailing = fenced ? "" : raw.slice(value.length)
    return `[${shortId(session).replace(/[[\]\\]/g, "\\$&")}](${CHAT_HREF}${session})${trailing}`
  })
}

/** The reply with each reference outside code turned into a markdown link to its chat. */
export function linkSessionRefs(text: string): string {
  if (!text.includes("@session:")) return text
  return text
    .split(CODE)
    .map((part, i) => (i % 2 ? part : linkify(part)))
    .join("")
}

// Chat titles from the sidebar's list, so a link can read as the chat's name.
let titles = new Map<string, string>()
const listeners = new Set<() => void>()

export function rememberTitles(rows: { id: string; title: string }[]) {
  titles = new Map(rows.filter(row => row.title).map(row => [row.id, row.title]))
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The chat's title, or an empty string while the list doesn't have it. */
export const useChatTitle = (session: string) => useSyncExternalStore(subscribe, () => titles.get(session) ?? "")
