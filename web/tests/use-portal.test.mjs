import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule, deferred } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"
const state = await loadModule("../src/lib/portal-state.ts")
let sequence = 0

const opened = (session, extra = {}) => ({ session, title: session, start: 0, requests: [], messages: [], running: false, ...extra })
async function setup(t) {
  const harness = hookHarness()
  const window = new EventTarget()
  const document = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true })
  const location = { hash: "#/c/A", href: "https://portal.test/#/c/A", protocol: "https:" }
  const calls = []
  let handler = path => Promise.resolve(path === "/api/me" ? { signed_in: true } : path === "/api/sessions" || path === "/api/commands" ? [] : opened(path.split("/")[3].split("?")[0]))
  class WebSocket {
    static OPEN = 1
    readyState = 1
    constructor() { WebSocket.latest = this }
    send() {}
    receive(frame) { this.onmessage({ data: typeof frame === "string" ? frame : JSON.stringify(frame) }) }
  }
  const globals = { window, document, location, WebSocket }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]))
  Object.assign(globalThis, globals)
  const name = `__portalTest${++sequence}`
  globalThis[name] = {
    ...harness.hooks, ...state,
    api: (path, options) => { calls.push([path, options]); return handler(path, options) },
    sessionPath: (session, suffix = "") => `/api/sessions/${session}${suffix}`,
    dataUrlToFile: () => { throw new Error("unexpected conversion") },
    whenSignedOut: () => {}, reloadMcp: () => {}, reloadProviders: () => {}, reloadSecrets: () => {}, rememberTitles: () => {},
  }
  const module = await loadModule("../src/hooks/use-portal.ts", source => {
    source = source.replace(/^import .*\n/gm, "")
    const bindings = Object.keys(globalThis[name]).join(", ")
    return `const { ${bindings} } = globalThis.${name};\n${source}`
  })
  harness.mount(module.usePortal)
  await harness.flush()
  t.after(() => { harness.cleanup(); Object.assign(globalThis, previous); delete globalThis[name] })
  return {
    harness, calls, socket: WebSocket.latest,
    respond(fn) { handler = fn },
    async switchTo(id) { location.hash = `#/c/${id}`; window.dispatchEvent(new Event("hashchange")); await harness.flush() },
    async refresh() { document.dispatchEvent(new Event("visibilitychange")); await harness.flush() },
  }
}

test("actual send completion after switching chats leaves B and its live state alone", async t => {
  const env = await setup(t)
  const post = deferred()
  env.respond((path, options) => options?.method === "POST" ? post.promise : Promise.resolve(path === "/api/sessions" ? [] : opened("B")))
  const sending = env.harness.value.send("for A", [])
  await env.switchTo("B")
  const before = env.harness.value.current
  post.resolve({})
  await sending
  await env.harness.flush()
  assert.equal(env.harness.value.current, before)
  assert.equal(env.harness.value.current.session, "B")
  assert.equal(env.harness.value.current.running, false)
  assert.equal(env.harness.value.live, null)
})

test("actual reconnect replaces stale live text but keeps events arriving during HTTP", async t => {
  const env = await setup(t)
  env.socket.receive({ kind: "event", session: "A", type: "message.start" })
  env.socket.receive({ kind: "event", session: "A", type: "gateway.message", payload: { id: "a", text: "stale" } })
  await env.harness.flush()
  const response = deferred()
  env.respond(path => path.includes("?since") ? response.promise : Promise.resolve([]))
  await env.refresh()
  env.socket.receive({ kind: "event", session: "A", type: "gateway.message", payload: { id: "b", text: "just streamed" } })
  response.resolve(opened("A", { running: true, live: { messages: [{ id: "a", text: "server newer" }], tools: [] } }))
  await env.harness.flush()
  assert.deepEqual(env.harness.value.live.messages.map(m => m.text), ["server newer", "just streamed"])
})

test("actual older refresh cannot stop a turn begun while HTTP was pending", async t => {
  const env = await setup(t)
  const response = deferred()
  env.respond(path => path.includes("?since") ? response.promise : Promise.resolve([]))
  await env.refresh()
  env.socket.receive({ kind: "event", session: "A", type: "message.start" })
  env.socket.receive({ kind: "event", session: "A", type: "gateway.message", payload: { id: "new", text: "new turn" } })
  response.resolve(opened("A"))
  await env.harness.flush()
  assert.equal(env.harness.value.current.running, true)
  assert.equal(env.harness.value.live.messages[0].text, "new turn")
})

test("actual overlapping refreshes keep the newest response", async t => {
  const env = await setup(t)
  const responses = [deferred(), deferred()]
  let next = 0
  env.respond(path => path.includes("?since") ? responses[next++].promise : Promise.resolve([]))
  await env.refresh()
  await env.refresh()
  responses[1].resolve(opened("A", { title: "newest" }))
  await env.harness.flush()
  responses[0].resolve(opened("A", { title: "oldest" }))
  await env.harness.flush()
  assert.equal(env.harness.value.current.title, "newest")
})

test("actual fresh cache restores live text without another HTTP request", async t => {
  const env = await setup(t)
  const snapshot = { messages: [{ id: "reply", text: "cached running reply" }], tools: [] }
  env.respond(path => path.includes("?since") ? Promise.resolve(opened("A", { running: true, live: snapshot })) : Promise.resolve(path === "/api/sessions" ? [] : opened("B")))
  await env.refresh()
  await env.switchTo("B")
  const count = env.calls.length
  await env.switchTo("A")
  assert.equal(env.calls.length, count)
  assert.deepEqual(env.harness.value.live, snapshot)
})

test("malformed WebSocket JSON cannot prevent a following valid frame", async t => {
  const env = await setup(t)
  for (const invalid of ["{", "null", "[]", "123"]) assert.doesNotThrow(() => env.socket.receive(invalid))
  env.socket.receive({ kind: "event", session: "A", type: "message.start" })
  await env.harness.flush()
  assert.equal(env.harness.value.current.running, true)
})
