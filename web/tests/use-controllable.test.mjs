import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"

let sequence = 0
async function setup(t, initial) {
  const harness = hookHarness()
  const name = `__controllableTest${++sequence}`
  globalThis[name] = harness.hooks
  const { useControllableState } = await loadModule("../src/lib/use-controllable.ts", source => source.replace(/^import .*\n/, `const { useState, useEffect, useLayoutEffect, useRef, useCallback } = globalThis.${name};\n`))
  delete globalThis[name]
  let props = initial
  const render = () => useControllableState(props)
  harness.mount(render)
  t.after(() => harness.cleanup())
  return { harness, rerender(next) { props = next; harness.mount(render) } }
}

test("uncontrolled state notifies after commit and skips unchanged values", async t => {
  const calls = []
  const { harness } = await setup(t, { defaultProp: false, onChange: value => calls.push(value) })
  const set = harness.value[1]
  assert.deepEqual(calls, [])
  set(true)
  assert.deepEqual(calls, [])
  await harness.flush()
  assert.equal(harness.value[0], true)
  assert.equal(harness.value[1], set)
  assert.deepEqual(calls, [true])
  set(true)
  await harness.flush()
  assert.deepEqual(calls, [true])
})

test("queued functional updates compose and notify once with committed state", async t => {
  const calls = []
  const { harness } = await setup(t, { defaultProp: 0, onChange: value => calls.push(value) })
  harness.value[1](value => value + 1)
  harness.value[1](value => value + 1)
  await harness.flush()
  assert.equal(harness.value[0], 2)
  assert.deepEqual(calls, [2])
})

test("controlled state requests changes but waits for the parent prop", async t => {
  const calls = []
  const props = { defaultProp: true, prop: false, onChange: value => calls.push(value) }
  const { harness, rerender } = await setup(t, props)
  harness.value[1](false)
  assert.deepEqual(calls, [])
  harness.value[1](value => !value)
  await harness.flush()
  assert.deepEqual(calls, [true])
  assert.equal(harness.value[0], false)
  rerender({ ...props, prop: true })
  assert.equal(harness.value[0], true)
  assert.deepEqual(calls, [true])
})

test("the stable setter uses the latest callback and ignores later defaults", async t => {
  const oldCalls = [], newCalls = []
  const { harness, rerender } = await setup(t, { defaultProp: false, onChange: value => oldCalls.push(value) })
  const set = harness.value[1]
  rerender({ defaultProp: true, onChange: value => newCalls.push(value) })
  assert.equal(harness.value[0], false)
  assert.equal(harness.value[1], set)
  set(true)
  await harness.flush()
  assert.deepEqual(oldCalls, [])
  assert.deepEqual(newCalls, [true])
})

test("duration can start undefined and work without an onChange callback", async t => {
  const { harness } = await setup(t, { defaultProp: undefined })
  assert.equal(harness.value[0], undefined)
  harness.value[1](0)
  await harness.flush()
  assert.equal(harness.value[0], 0)
})
