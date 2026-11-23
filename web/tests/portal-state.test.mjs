import assert from "node:assert/strict"
import { test } from "node:test"
import { deferred, loadModule } from "./load-module.mjs"

const { sentMessage, caughtUp, cachedLive, reconcileSession, reuse, isCurrentRequest, appendPage } = await loadModule("../src/lib/portal-state.ts")
const message = (id, text) => ({ id, text })
const tool = (id, state) => ({ id, name: "shell", state })
const live = (messages = [], tools = []) => ({ messages, tools })
const session = (id, extra = {}) => ({ session: id, title: id, start: 0, messages: [], requests: [], running: false, loading: false, loadingOlder: false, ...extra })

test("deferred send for A leaves newly opened B's transcript and running state unchanged", async () => {
  const post = deferred()
  let current = session("A")
  const target = current.session
  const sending = post.promise.then(() => { current = sentMessage(current, target, { role: "user", text: "for A" }) })
  const b = session("B", { messages: [{ role: "assistant", text: "B's reply" }] })
  current = b
  post.resolve()
  await sending
  assert.equal(current, b)
  assert.equal(current.running, false)
})

test("successful send updates the captured chat without mutating its old snapshot", () => {
  const a = session("A")
  const next = sentMessage(a, "A", { role: "user", text: "hello" })
  assert.equal(next.running, true)
  assert.equal(next.messages[0].text, "hello")
  assert.deepEqual(a.messages, [])
  assert.equal(sentMessage(null, "A", { role: "user", text: "hello" }), null)
})

test("reconnect accepts newer HTTP text and tool state over pre-disconnect entries", () => {
  const old = live([message("reply", "stale")], [tool("call", "running")])
  const server = live([message("reply", "newer")], [tool("call", "done")])
  assert.deepEqual(caughtUp(old, server, old), server)
})

test("only entries receiving events after refresh starts override the HTTP snapshot", () => {
  const before = live([message("a", "old a"), message("b", "old b")], [tool("t", "running")])
  const server = live([message("a", "server a"), message("b", "server b")], [tool("t", "done")])
  const current = live([message("a", "streamed a"), before.messages[1], message("c", "new c")], before.tools)
  const result = caughtUp(current, server, before)
  assert.deepEqual(result.messages.map(m => [m.id, m.text]), [["b", "server b"], ["a", "streamed a"], ["c", "new c"]])
  assert.deepEqual(result.tools, server.tools)
})

test("tool events after refresh starts override the matching snapshot tool", () => {
  const before = live([], [tool("t", "running")])
  const current = live([], [tool("t", "done"), tool("new", "running")])
  assert.deepEqual(caughtUp(current, before, before), current)
})

test("missing snapshots drop stale local entries but retain new events", () => {
  const before = live([message("stale", "old")])
  assert.equal(caughtUp(before, undefined, before), null)
  const added = message("new", "fresh")
  assert.deepEqual(caughtUp(live([...before.messages, added]), undefined, before), live([added]))
  assert.equal(caughtUp(null, undefined, null), null)
})

test("opening a fresh running cache restores its live reply and tools", () => {
  const snapshot = live([message("reply", "in progress")], [tool("t", "running")])
  assert.equal(cachedLive(session("A", { running: true, live: snapshot })), snapshot)
  assert.equal(cachedLive(session("A", { live: snapshot })), null)
  assert.equal(cachedLive(session("A", { running: true })), null)
})

test("refresh preserves older pages loaded while the HTTP request was pending", () => {
  const first = { role: "user", text: "older" }
  const current = session("A", { start: 1, messages: [first, { role: "assistant", text: "stale" }], loadingOlder: true })
  const result = reconcileSession(current, session("A", { start: 2, messages: [{ role: "assistant", text: "updated" }], running: true }))
  assert.equal(result.start, 1)
  assert.equal(result.messages[0], first)
  assert.equal(result.messages[1].text, "updated")
  assert.equal(result.loadingOlder, true)
  assert.equal(result.running, true)
})

test("initial refresh replaces placeholders and stable rows retain identity", () => {
  const fresh = [{ role: "user", text: "same", images: ["data:image/png;base64,AA"] }]
  const old = structuredClone(fresh)
  assert.equal(reuse(old, fresh), old)
  assert.equal(reuse(old, [...fresh, { role: "assistant", text: "new" }])[0], old[0])
  const opened = reconcileSession(session("A", { loading: true }), session("A", { start: 50, messages: fresh }))
  assert.equal(opened.messages, fresh)
  assert.equal(opened.loading, false)
  assert.equal(opened.start, 50)
})

test("out-of-order refresh responses cannot overwrite a newer request or turn", async () => {
  let latest = { request: 1, turn: 2 }
  let current = session("A", { running: true })
  const old = deferred()
  const first = { ...latest }
  const applying = old.promise.then(opened => {
    if (isCurrentRequest(first, latest)) current = reconcileSession(current, opened)
  })
  latest = { request: 2, turn: 2 }
  old.resolve(session("A", { running: false }))
  await applying
  assert.equal(current.running, true)
  assert.equal(isCurrentRequest(latest, { ...latest, turn: 3 }), false)
  assert.equal(isCurrentRequest(latest, { ...latest }), true)
})

test("Elsewhere's old page cannot append after a filter change, even when changing back", async () => {
  let generation = { request: 1, turn: 0 }
  const pending = deferred()
  const ticket = { ...generation }
  let rows = [{ id: "slack-1" }]
  const loading = pending.promise.then(page => {
    if (isCurrentRequest(ticket, generation)) rows = appendPage(rows, page)
  })
  generation = { request: 3, turn: 0 } // Slack -> Discord -> Slack
  rows = [{ id: "slack-new" }]
  pending.resolve([{ id: "slack-old-page" }])
  await loading
  assert.deepEqual(rows, [{ id: "slack-new" }])
  assert.deepEqual(appendPage(rows, [{ id: "slack-new" }, { id: "slack-2" }]), [{ id: "slack-new" }, { id: "slack-2" }])
})
