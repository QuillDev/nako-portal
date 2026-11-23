import type { HistoryMessage, Live, OpenSession } from "./types"

export type RequestGeneration = { request: number; turn: number }
export const isCurrentRequest = (started: RequestGeneration, latest: RequestGeneration) =>
  started.request === latest.request && started.turn === latest.turn

function sameMessage(a: HistoryMessage, b: HistoryMessage) {
  if (a === b) return true
  const keys = Object.keys(a) as (keyof HistoryMessage)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(k => {
    const x = a[k] as unknown
    const y = b[k] as unknown
    return x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]))
  })
}

export function reuse(shown: HistoryMessage[], fresh: HistoryMessage[]) {
  let changed = shown.length !== fresh.length
  const out = fresh.map((m, i) => {
    const old = shown[i]
    if (old && sameMessage(old, m)) return old
    changed = true
    return m
  })
  return changed ? out : shown
}

// Only entries replaced by a live event *after* the request began override HTTP.
// Socket reducers retain entry identity when an entry hasn't received an event.
export function caughtUp(live: Live | null, seen: Live | undefined, started: Live | null): Live | null {
  const merge = <T extends { id: string }>(server: T[], current: T[], before: T[]) => {
    const updates = current.filter(item => !before.includes(item))
    return [...server.filter(item => !updates.some(update => update.id && update.id === item.id)), ...updates]
  }
  const messages = merge(seen?.messages ?? [], live?.messages ?? [], started?.messages ?? [])
  const tools = merge(seen?.tools ?? [], live?.tools ?? [], started?.tools ?? [])
  return seen || messages.length || tools.length ? { messages, tools } : null
}

export function reconcileSession<T extends OpenSession & { loading: boolean; loadingOlder: boolean }>(current: T, opened: OpenSession): T {
  const kept = !current.loading && current.start < opened.start ? current.messages.slice(0, opened.start - current.start) : []
  const start = opened.start - kept.length
  const messages = current.loading ? opened.messages : current.start === start ? reuse(current.messages, [...kept, ...opened.messages]) : [...kept, ...opened.messages]
  return { ...current, ...opened, start, messages, loading: false, loadingOlder: current.loadingOlder }
}

export function sentMessage<T extends OpenSession>(current: T | null, session: string, message: HistoryMessage): T | null {
  return current?.session === session ? { ...current, running: true, messages: [...current.messages, message] } : current
}

export const cachedLive = (opened: OpenSession) => opened.running ? opened.live ?? null : null

export function appendPage<T extends { id: string }>(rows: T[], page: T[]): T[] {
  const have = new Set(rows.map(row => row.id))
  return [...rows, ...page.filter(row => !have.has(row.id))]
}
