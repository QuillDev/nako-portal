// Starts the first reads (who's signed in, the chat list, the chat in the address) while the app
// is still downloading, so they're answered or on their way by the time it asks. src/lib/api.ts
// picks each one up once, by path; anything it never asks for is simply dropped.
;(() => {
  const read = path => fetch(path, { credentials: "same-origin" }).catch(() => null)
  const early = { "/api/me": read("/api/me"), "/api/sessions": read("/api/sessions") }
  const chat = location.hash.match(/^#\/c\/([\w.-]+)/)
  if (chat) {
    const path = `/api/sessions/${encodeURIComponent(chat[1])}`
    early[path] = read(path)
  }
  window.__early = early
})()
