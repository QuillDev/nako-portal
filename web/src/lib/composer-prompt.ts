// Lets header controls (like the PR popover's quick-prompt actions) drop a prompt
// into the open chat's composer without coupling the header to composer state.

type Listener = (text: string) => void

const listeners = new Map<string, Set<Listener>>()

export function sendToComposer(session: string, text: string) {
  const handlers = listeners.get(session)
  if (!handlers) return
  for (const handler of handlers) handler(text)
}

export function onComposerPrompt(session: string, handler: Listener): () => void {
  let handlers = listeners.get(session)
  if (!handlers) {
    handlers = new Set()
    listeners.set(session, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) listeners.delete(session)
  }
}
