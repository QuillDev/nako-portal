import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule, deferred } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"
const state = await loadModule("../src/lib/portal-state.ts")
let sequence = 0
const page = (source, count = 50) => Array.from({ length: count }, (_, i) => ({ id: `${source}-${i}`, title: `${source}-${i}`, source, last_active: 1 }))
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== "object") return []
  return [tree, ...elements(tree.props?.children)]
}
async function setup(t) {
  const harness = hookHarness()
  let observer
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observer = this }
    observe() {}
    disconnect() { if (observer === this) observer = null }
  }
  const previous = globalThis.IntersectionObserver
  globalThis.IntersectionObserver = IntersectionObserver
  const requests = []
  const name = `__elsewhereTest${++sequence}`
  globalThis[name] = {
    ...harness.hooks, ...state,
    useRef(value) { const ref = harness.hooks.useRef(value); if (value === null) ref.current = {}; return ref },
    api(path) { const response = deferred(); requests.push({ path, ...response }); return response.promise },
    useDrawer: () => ({ go() {} }), sourceName: value => value, age: () => "older", timeOf: () => "", cn: () => "", PageHeader: "header",
  }
  const module = await loadModule("../src/components/portal/elsewhere.tsx", source =>
    `const { ${Object.keys(globalThis[name]).join(", ")} } = globalThis.${name};\n${source.replace(/^import .*\n/gm, "")}`)
  harness.mount(() => module.Elsewhere({ portal: { outside: { sources: ["slack", "discord"], running: [] }, prefetch() {} } }))
  await harness.flush()
  t.after(() => { harness.cleanup(); globalThis.IntersectionObserver = previous; delete globalThis[name] })
  return {
    harness, requests,
    nodes: () => elements(harness.value),
    async pick(source) {
      elements(harness.value).find(node => node.type === "button" && node.props.children === source).props.onClick()
      await harness.flush()
    },
    async more() { assert.ok(observer); observer.callback([{ isIntersecting: true }]); await harness.flush() },
  }
}

test("actual Elsewhere pagination response cannot cross a source-filter change", async t => {
  const env = await setup(t)
  env.requests[0].resolve(page("slack"))
  await env.harness.flush()
  await env.more()
  const pagination = env.requests[1]
  assert.match(pagination.path, /offset=50/)
  await env.pick("discord")
  assert.match(env.requests[2].path, /source=discord/)
  env.requests[2].resolve(page("discord", 1))
  await env.harness.flush()
  pagination.resolve([{ id: "stale-slack", title: "stale-slack", source: "slack", last_active: 1 }])
  await env.harness.flush()
  const text = env.nodes().flatMap(node => typeof node.props?.children === "string" ? [node.props.children] : [])
  assert.ok(text.includes("discord-0"))
  assert.ok(!text.includes("stale-slack"))
  assert.ok(!env.nodes().some(node => node.props?.role === "status"))
})

test("Elsewhere first-page errors show Retry and loading, then recover", async t => {
  const env = await setup(t)
  assert.ok(env.nodes().some(node => node.props?.role === "status"))
  env.requests[0].reject(new Error("offline"))
  await env.harness.flush()
  assert.ok(env.nodes().some(node => node.props?.role === "alert"))
  env.nodes().find(node => node.props?.children === "Retry").props.onClick()
  await env.harness.flush()
  assert.ok(env.nodes().some(node => node.props?.role === "status"))
  env.requests[1].resolve(page("slack", 1))
  await env.harness.flush()
  assert.ok(!env.nodes().some(node => node.props?.role === "alert" || node.props?.role === "status"))
})

test("Elsewhere retries failed pagination at the same offset without losing rows", async t => {
  const env = await setup(t)
  env.requests[0].resolve(page("slack"))
  await env.harness.flush()
  await env.more()
  env.requests[1].reject(new Error("page unavailable"))
  await env.harness.flush()
  env.nodes().find(node => node.props?.children === "Retry").props.onClick()
  await env.harness.flush()
  assert.equal(env.requests[2].path, env.requests[1].path)
  env.requests[2].resolve([{ id: "last", title: "last", source: "slack", last_active: 1 }])
  await env.harness.flush()
  assert.ok(env.nodes().some(node => node.props?.children === "slack-0"))
  assert.ok(env.nodes().some(node => node.props?.children === "last"))
})
