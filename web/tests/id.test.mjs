import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule } from "./load-module.mjs"
const { id } = await loadModule("../src/lib/id.ts")
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function withCrypto(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  Object.defineProperty(globalThis, "crypto", { configurable: true, value })
  t.after(() => original ? Object.defineProperty(globalThis, "crypto", original) : delete globalThis.crypto)
}

test("IDs prefer crypto.randomUUID and preserve its receiver", t => {
  const crypto = { randomUUID() { assert.equal(this, crypto); return "native-id" }, getRandomValues() { assert.fail("unexpected fallback") } }
  withCrypto(t, crypto)
  assert.equal(id(), "native-id")
})

test("IDs use random bytes when randomUUID is unavailable and set UUID version/variant", t => {
  const crypto = { getRandomValues(bytes) { assert.equal(this, crypto); assert.equal(bytes.length, 16); bytes.fill(255); return bytes } }
  withCrypto(t, crypto)
  assert.equal(id(), "ffffffff-ffff-4fff-bfff-ffffffffffff")
})

test("IDs work without Web Crypto in older/insecure webviews", t => {
  withCrypto(t, undefined)
  const values = Array.from({ length: 2048 }, id)
  values.forEach(value => assert.match(value, uuid))
  assert.equal(new Set(values).size, values.length)
})

test("IDs work when crypto exists without either random API", t => {
  withCrypto(t, {})
  assert.match(id(), uuid)
})

test("native IDs are unique across rapid attachment/preset creation", () => {
  const values = Array.from({ length: 2048 }, id)
  assert.equal(new Set(values).size, values.length)
  values.forEach(value => assert.match(value, uuid))
})
