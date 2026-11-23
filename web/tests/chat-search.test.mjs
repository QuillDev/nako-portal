import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule, deferred } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"

const { mergeMessageMatches } = await loadModule("../src/lib/chat-search.ts")
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []

test("message search debounces, aborts stale requests and opens archived results", async t => {
  const harness = hookHarness()
  const window = new EventTarget()
  const requests = [], unarchived = [], navigated = [], timers = new Map()
  let timerID = 0
  const original = { window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  globalThis.window = window
  globalThis.document = { querySelector: () => null }
  globalThis.setTimeout = (callback, ms) => { assert.equal(ms, 180); timers.set(++timerID, callback); return timerID }
  globalThis.clearTimeout = id => timers.delete(id)
  const components = ["Command", "CommandEmpty", "CommandGroup", "CommandInput", "CommandItem", "CommandList", "Dialog", "DialogDescription", "DialogOverlay", "DialogPortal", "DialogTitle", "ArchiveIcon", "BellIcon", "GitPullRequestIcon", "MessageSquareIcon"]
  globalThis.__chatSearchTest = {
    ...harness.hooks, memo: component => component, mergeMessageMatches,
    ...Object.fromEntries(components.map(name => [name, name])), DialogPrimitive: { Content: "Content" },
    api(path, options) { const response = deferred(); requests.push({ path, options, ...response }); return response.promise },
    navigate: path => navigated.push(path),
  }
  const { ChatSearch } = await loadModule("../src/components/portal/chat-search.tsx", source =>
    `const { ${Object.keys(globalThis.__chatSearchTest).join(", ")} } = globalThis.__chatSearchTest;\n${source.replace(/^import[\s\S]*?from ["'][^"']+["'];?\n/gm, "")}`)
  t.after(() => { harness.cleanup(); Object.assign(globalThis, original); delete globalThis.__chatSearchTest })
  harness.mount(() => ChatSearch({ sessions: [{ id: "title", title: "apricot" }], unarchive: id => unarchived.push(id) }))
  window.dispatchEvent(new Event("nako-chat-search"))
  await harness.flush()
  requests[0].resolve([])
  await harness.flush()
  const query = async value => { nodes(harness.value).find(node => node.type === "CommandInput").props.onValueChange(value); await harness.flush() }
  const tick = () => { for (const [id, run] of timers) { timers.delete(id); run() } }

  await query("a")
  assert.equal(timers.size, 0)
  await query("ap")
  assert.equal(requests.length, 1)
  assert.equal(timers.size, 1)
  await query("apr")
  assert.equal(timers.size, 1)
  tick()
  const stale = requests[1]
  assert.equal(stale.path, "/api/search?q=apr")
  await query("apricot")
  assert.equal(stale.options.signal.aborted, true)
  tick()
  requests[2].resolve([{ id: "title", title: "apricot", snippet: "duplicate" }, { id: "archive", title: "Old", snippet: "apricot note", archived: true }])
  await harness.flush()
  stale.resolve([{ id: "stale", title: "Stale", snippet: "old request" }])
  await harness.flush()
  const items = nodes(harness.value).filter(node => node.type === "CommandItem")
  assert.deepEqual(items.map(node => node.props.value), ["chat:title", "message:archive"])
  items[1].props.onSelect()
  await harness.flush()
  assert.deepEqual(unarchived, ["archive"])
  assert.deepEqual(navigated, [])
  assert.equal(requests[2].options.signal.aborted, true)
})
