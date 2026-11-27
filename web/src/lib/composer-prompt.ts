// Lets header/PR controls drop a prompt into an open chat's composer (or queue it
// briefly while navigating to that chat so it lands the moment the composer mounts).

type Listener = (text: string) => void

const listeners = new Map<string, Set<Listener>>()
const pending = new Map<string, { text: string; at: number }>()
const PENDING_TTL_MS = 10_000

export function sendToComposer(session: string, text: string) {
  const handlers = listeners.get(session)
  if (handlers && handlers.size > 0) {
    pending.delete(session)
    for (const handler of handlers) handler(text)
    return
  }
  pending.set(session, { text, at: Date.now() })
}

export function onComposerPrompt(session: string, handler: Listener): () => void {
  let handlers = listeners.get(session)
  if (!handlers) {
    handlers = new Set()
    listeners.set(session, handlers)
  }
  handlers.add(handler)

  const queued = pending.get(session)
  if (queued) {
    pending.delete(session)
    if (Date.now() - queued.at <= PENDING_TTL_MS) {
      queueMicrotask(() => handler(queued.text))
    }
  }

  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) listeners.delete(session)
  }
}
