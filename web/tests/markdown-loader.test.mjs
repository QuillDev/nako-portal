import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule, deferred } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"

const { retryableLoader } = await loadModule("../src/lib/retryable-loader.ts")
const { loadMarkdown, retryMarkdown, loadedMarkdown } = await loadModule("../src/lib/markdown.ts", source => source
  .replace('from "react"', `from ${JSON.stringify(import.meta.resolve("react"))}`)
  .replace('import { retryableLoader } from "./retryable-loader"', `const retryableLoader = ${retryableLoader.toString()}`)
  .replace('() => import("streamdown")', '() => globalThis.__markdownImportTest()'))

test("failed markdown imports clear their promise and expose a working retry", async () => {
  // The actual markdown module shares the same recoverable import path as its hook.
  let calls = 0
  const renderer = { Streamdown: () => null }
  globalThis.__markdownImportTest = async () => {
    if (++calls === 1) throw new Error("chunk unavailable")
    return renderer
  }
  await assert.rejects(loadMarkdown(), /chunk unavailable/)
  assert.equal(loadedMarkdown(), null)
  assert.equal(await retryMarkdown(), renderer)
  assert.equal(await loadMarkdown(), renderer)
  assert.equal(calls, 2)
  delete globalThis.__markdownImportTest
})

test("concurrent loads share the import and notify on failure and recovery", async () => {
  const first = deferred()
  let calls = 0
  const loader = retryableLoader(() => ++calls === 1 ? first.promise : Promise.resolve("loaded"))
  let changes = 0
  const unsubscribe = loader.subscribe(() => changes++)
  const a = loader.load()
  assert.equal(a, loader.load())
  first.reject(new Error("offline"))
  await assert.rejects(a, /offline/)
  assert.equal(loader.error().message, "offline")
  assert.equal(await loader.load(), "loaded")
  assert.equal(loader.error(), null)
  assert.equal(loader.get(), "loaded")
  assert.equal(changes, 4)
  unsubscribe()
})

test("mounting a plain-text reply after failure waits for explicit retry", async t => {
  const harness = hookHarness()
  let calls = 0
  const loader = retryableLoader(async () => { calls++; throw new Error("offline") })
  globalThis.__markdownHookTest = {
    ...harness.hooks,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    retryableLoader: () => loader,
  }
  const { useMarkdown } = await loadModule("../src/lib/markdown.ts", source => source
    .replace('import { useEffect, useSyncExternalStore } from "react"', 'const { useEffect, useSyncExternalStore } = globalThis.__markdownHookTest')
    .replace('import { retryableLoader } from "./retryable-loader"', 'const { retryableLoader } = globalThis.__markdownHookTest'))
  t.after(() => { harness.cleanup(); delete globalThis.__markdownHookTest })
  await assert.rejects(loader.load(), /offline/)
  harness.mount(() => useMarkdown())
  await harness.flush()
  assert.equal(calls, 1)
  assert.equal(harness.value, null)
})
