// One socket to the portal's live events, turned into desktop notifications.
import WebSocket from "ws"

/** The alert in a socket frame ({title, body, session}), or null for every other kind of frame (or junk). */
export function parseAlert(frame) {
  let value
  try {
    value = JSON.parse(frame)
  } catch {
    return null
  }
  if (value?.kind !== "alert" || typeof value.title !== "string") return null
  const body = typeof value.body === "string" ? value.body : ""
  const session = typeof value.session === "string" ? value.session : null
  return { title: [...value.title].slice(0, 120).join(""), body: [...body].slice(0, 400).join(""), session }
}

/** Closes a socket for good; closing one still connecting reports an error nobody needs. */
function drop(socket) {
  if (!socket) return
  socket.removeAllListeners()
  socket.on("error", () => {})
  socket.terminate()
}

/** Seconds before reconnect attempt `attempt` (0-based): 2, 4, 8 … capped at 5 minutes. */
export const backoff = attempt => Math.min(300, 2 << Math.min(attempt, 8))

/**
 * Keeps a socket to the portal open until `stop()`. Without a cookie, or once the portal refuses it
 * (signed out), it waits for `wake()`, which the app calls whenever a portal page finishes loading.
 * `onFrame` sees every frame (the floating Nako reads turn statuses from them).
 */
export function listen({ origin, cookie, onAlert, onFrame = () => {}, log = () => {} }) {
  let stopped = false
  let attempt = 0
  let socket = null
  let timer = null
  let waiting = null

  const wait = ms =>
    new Promise(resolve => {
      waiting = resolve
      if (ms != null) timer = setTimeout(resolve, ms)
    })

  const connect = async () => {
    while (!stopped) {
      const header = await cookie()
      if (!header) {
        await wait(null)
        continue
      }
      const outcome = await new Promise(resolve => {
        socket = new WebSocket(origin.socketUrl, { headers: { Cookie: header, Origin: origin.value } })
        socket.on("open", () => {
          log("listening for alerts")
          attempt = 0
        })
        socket.on("message", data => {
          onFrame(String(data))
          const alert = parseAlert(String(data))
          if (alert) onAlert(alert)
        })
        socket.on("unexpected-response", (_request, response) => resolve([401, 403].includes(response.statusCode) ? "signed-out" : "error"))
        socket.on("error", error => {
          log(`alert socket: ${error.message}`)
          resolve("error")
        })
        socket.on("close", () => resolve("closed"))
      })
      drop(socket)
      socket = null
      if (stopped) return
      if (outcome === "signed-out") {
        log("alerts need a sign-in")
        await wait(null)
        continue
      }
      await wait(backoff(attempt) * 1000)
      attempt += 1
    }
  }
  connect()

  return {
    wake() {
      clearTimeout(timer)
      waiting?.()
      waiting = null
    },
    stop() {
      stopped = true
      drop(socket)
      this.wake()
    },
  }
}
