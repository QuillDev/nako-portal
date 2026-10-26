import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"

import { WebSocketServer } from "ws"

import { listen } from "../src/alerts.js"
import { ServerOrigin } from "../src/origin.js"

/** A portal socket that only lets in `portal=good` from its own origin, then sends a status frame and an alert. */
async function portal() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = ServerOrigin.parse(`http://127.0.0.1:${server.address().port}`)
  const sockets = new WebSocketServer({ noServer: true })
  let attempts = 0
  server.on("upgrade", (request, socket, head) => {
    attempts += 1
    if (request.headers.cookie !== "portal=good" || request.headers.origin !== origin.value) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
      return
    }
    sockets.handleUpgrade(request, socket, head, ws => {
      ws.send('{"kind":"hub.connected"}')
      ws.send('{"kind":"alert","title":"deploy","body":"shipped","session":"20261024_070707_abcdef"}')
    })
  })
  return { origin, attempts: () => attempts, close: () => (sockets.close(), server.close(), server.closeAllConnections()) }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test("a signed-in app hears alerts and a signed-out one waits for a sign-in", async () => {
  const server = await portal()
  let cookie = "portal=stale"
  const heard = []
  const listener = listen({ origin: server.origin, cookie: async () => cookie, onAlert: alert => heard.push(alert) })

  // Refused: no alerts, and no retrying while signed out (the first retry would come at 2s).
  await sleep(2500)
  assert.equal(server.attempts(), 1)
  assert.deepEqual(heard, [])

  // Signing in (a page load with a good cookie) reconnects at once.
  cookie = "portal=good"
  listener.wake()
  for (let i = 0; i < 100 && !heard.length; i++) await sleep(20)
  assert.deepEqual(heard, [{ title: "deploy", body: "shipped", session: "20261024_070707_abcdef" }])
  listener.stop()
  server.close()
})
