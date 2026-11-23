import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { loadModule } from "./load-module.mjs"

const { d, Decoder, DecodeError } = await loadModule("../src/lib/decode.ts")
globalThis.__decodeTest = { d }
// Compile the actual declarations, without importing React or running UI/data effects.
async function schemas(path, start, end, names) {
  return loadModule(path, source => {
    const from = source.indexOf(start)
    const to = source.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `schema boundaries in ${path}`)
    return `const { d${names.includes("signOff") ? ", modelChoice" : ""} } = globalThis.__decodeTest;\n${source.slice(from, to)}\nexport { ${names.join(", ")} };`
      .replaceAll("export const", "const")
  })
}
const { GROUP_COLORS, ChatGroup } = await schemas("../src/lib/types.ts", "export const GROUP_COLORS", "export type SessionRow", ["GROUP_COLORS", "ChatGroup"])
const { Environments } = await schemas("../src/lib/environments.ts", "const Link =", "export const STATUS_DOT", ["Environments"])
const { MachineLoad } = await schemas("../src/lib/machine-load.ts", "export const MachineLoad", "// Past this", ["MachineLoad"])
const { preset, picks } = await schemas("../src/lib/model-presets.ts", "const selection =", "// Presets and starred", ["preset", "picks"])
const { favorite } = await schemas("../src/lib/model-favorites.ts", "const route =", "export function favoriteId", ["favorite"])
const { modelChoice } = await schemas("../src/components/portal/model-picker.tsx", "export const modelChoice", "export type ModelSelection", ["modelChoice"])
globalThis.__decodeTest.modelChoice = modelChoice
const { signOff } = await schemas("../src/components/portal/sign-off-settings.tsx", "const signOff =", "// Nako's line", ["signOff"])
const { usage } = await schemas("../src/lib/usage.ts", "const usage =", "// How much", ["usage"])
// Inline boundaries remain inline in the hook and picker.
async function inlineSchema(path, prefix, suffix) {
  const { schema } = await loadModule(path, source => {
    const start = source.indexOf(prefix) + prefix.length
    assert.ok(start >= prefix.length)
    const end = source.indexOf(suffix, start)
    assert.ok(end > start)
    return `const { d } = globalThis.__decodeTest; export const schema = ${source.slice(start, end)};`
  })
  return schema
}
const created = await inlineSchema("../src/hooks/use-portal.ts", "const created = ", ".parse(await")
const selected = await inlineSchema("../src/hooks/use-portal.ts", "const selected = ", ".parse(await")
const warning = await inlineSchema("../src/components/portal/model-picker.tsx", "const warning = ", ".safeParse(raw)")
delete globalThis.__decodeTest

function rejects(schema, values) {
  for (const value of values) {
    assert.throws(() => schema.parse(value), DecodeError)
    const result = schema.safeParse(value)
    assert.equal(result.success, false)
    assert.ok(result.error instanceof DecodeError)
  }
}

test("strings and booleans validate without coercion", () => {
  assert.equal(d.string().parse(""), "")
  rejects(d.string(), [null, undefined, 1, true, {}, [], new String("text")])
  for (const value of [true, false]) assert.equal(d.boolean().parse(value), value)
  rejects(d.boolean(), [0, 1, "true", null, undefined])
})

test("numbers accept finite values, including fractions and negatives, and reject NaN/infinities", () => {
  for (const value of [0, -0, -2, 0.5, Number.MAX_VALUE]) assert.ok(Object.is(d.number().parse(value), value))
  rejects(d.number(), [NaN, Infinity, -Infinity, "2", null, undefined, new Number(2)])
})

test("unknown preserves values and references", () => {
  for (const value of [null, undefined, NaN, {}, [], Symbol("value")]) assert.ok(Object.is(d.unknown().parse(value), value))
})

test("trim, min and max apply in declaration order with inclusive UTF-16 lengths", () => {
  const name = d.string().trim().min(1).max(4)
  assert.equal(name.parse("  name \n"), "name")
  assert.equal(name.parse("😀😀"), "😀😀")
  rejects(name, ["", " \t", "names", "😀😀x"])
  assert.equal(d.string().min(2).trim().parse(" x "), "x")
  rejects(d.string().max(1).trim(), [" x "])
})

test("enum accepts only exact declared values", () => {
  const value = d.enum(["running", "stopped"])
  assert.equal(value.parse("running"), "running")
  rejects(value, ["Running", " running", "", 0, null, undefined])
})

test("optional and nullable accept their own sentinel only", () => {
  assert.equal(d.string().optional().parse(undefined), undefined)
  assert.equal(d.string().nullable().parse(null), null)
  rejects(d.string().optional(), [null])
  rejects(d.string().nullable(), [undefined])
  for (const value of [null, undefined, "x"]) assert.equal(d.string().nullable().optional().parse(value), value)
})

test("defaults apply only to undefined and retain false and empty values", () => {
  assert.equal(d.boolean().default(false).parse(undefined), false)
  assert.equal(d.boolean().default(true).parse(false), false)
  assert.equal(d.string().default("fallback").parse(""), "")
  rejects(d.boolean().default(false), [null, "false"])
  assert.deepEqual(d.object({ on: d.boolean().default(false) }).parse({}), { on: false })
})

test("arrays validate every entry including holes and produce a fresh array", () => {
  const input = ["a", "b"]
  assert.deepEqual(d.array(d.string()).parse(input), input)
  assert.notEqual(d.string().array().parse(input), input)
  assert.deepEqual(d.array(d.array(d.number())).parse([[1], []]), [[1], []])
  rejects(d.array(d.string()), [null, {}, "a", ["a", 1], Array(1)])
})

test("objects require fields, strip unknown keys recursively, and preserve explicit undefined", () => {
  const schema = d.object({ inner: d.object({ value: d.string() }), optional: d.string().optional() })
  const input = { inner: { value: "x", drop: true }, drop: true }
  assert.deepEqual(schema.parse(input), { inner: { value: "x" } })
  assert.deepEqual(schema.parse({ ...input, optional: undefined }), { inner: { value: "x" }, optional: undefined })
  assert.notEqual(schema.parse(input).inner, input.inner)
  rejects(schema, [null, [], 1, "x", {}, { inner: {} }, { inner: { value: null } }])
})

test("object decoding handles inherited declared fields and prototype keys safely", () => {
  const schema = d.object({ value: d.string() })
  assert.deepEqual(schema.parse(Object.create({ value: "inherited" })), { value: "inherited" })
  const keyed = d.object({ ["__proto__"]: d.string(), constructor: d.string() })
  const result = keyed.parse(JSON.parse('{"__proto__":"text","constructor":"name"}'))
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(Object.hasOwn(result, "__proto__"), true)
  assert.equal(result.__proto__, "text")
})

test("extend adds and overrides fields without changing the base schema", () => {
  const base = d.object({ value: d.string() })
  const extended = base.extend({ value: d.number(), on: d.boolean() })
  assert.deepEqual(extended.parse({ value: 3, on: false, extra: true }), { value: 3, on: false })
  assert.deepEqual(base.parse({ value: "base", on: true }), { value: "base" })
  rejects(extended, [{ value: "base", on: true }, { value: 3 }])
})

test("unions return the first valid decoded branch", () => {
  const basic = d.object({ model: d.string() })
  const detailed = basic.extend({ effort: d.string() })
  const input = { model: "m", effort: "high", extra: true }
  assert.deepEqual(d.union([detailed, basic]).parse(input), { model: "m", effort: "high" })
  assert.deepEqual(d.union([basic, detailed]).parse(input), { model: "m" })
  assert.equal(d.union([d.string(), d.number()]).parse(2), 2)
  rejects(d.union([d.string(), d.number()]), [null, true, {}])
})

test("safeParse discriminates success and errors report nested array/field paths", () => {
  const schema = d.object({ rows: d.array(d.object({ name: d.string() })) })
  const value = { rows: [{ name: "ok" }] }
  assert.deepEqual(schema.safeParse(value), { success: true, data: value })
  const result = schema.safeParse({ rows: [{ name: 2 }] })
  assert.equal(result.success, false)
  assert.deepEqual(result.error.path, ["rows", 0, "name"])
  assert.equal(result.error.message, "rows.0.name: expected string")
  assert.equal(result.error.name, "DecodeError")
})

test("unexpected programming errors are not hidden by safeParse or unions", () => {
  const error = new Error("programming error")
  const broken = new Decoder(() => { throw error })
  assert.throws(() => broken.safeParse(null), value => value === error)
  assert.throws(() => d.union([broken, d.unknown()]).parse(null), value => value === error)
})

test("portal chat group colors are exact and group arrays validate each member", () => {
  for (const color of GROUP_COLORS) assert.deepEqual(ChatGroup.parse({ id: "", name: "", color }), { id: "", name: "", color })
  rejects(ChatGroup, [{ id: "id", name: "name", color: "pink" }, { id: 1, name: "name", color: "blue" }])
  rejects(ChatGroup.array(), [[{ id: "id", name: "name", color: "blue" }, null]])
})

test("portal folded group IDs recover from corrupted storage and persist toggles", async () => {
  let raw, current, written
  globalThis.__foldTest = {
    d, useCallback: fn => fn,
    useState(initial) { current = initial(); return [current, update => { current = update(current) }] },
    localStorage: { getItem: () => raw, setItem: (key, value) => { written = [key, value] } },
  }
  const { useFolded } = await loadModule("../src/components/portal/sidebar-utils.ts", source => {
    const start = source.indexOf('const FOLDED =')
    return `const { d, useState, useCallback, localStorage } = globalThis.__foldTest;\n${source.slice(start, source.indexOf('// Dragging', start))}`
  })
  delete globalThis.__foldTest
  for (raw of [null, "{", "null", "{}", '["group-1", 2]']) assert.deepEqual([...useFolded()[0]], [])
  raw = '["group-1", "group-1", ""]'
  const [folded, toggle] = useFolded()
  assert.deepEqual([...folded], ["group-1", ""])
  toggle("group-1")
  assert.deepEqual([...current], [""])
  toggle("group-2")
  assert.deepEqual(written, ["nako-folded-groups", '["","group-2"]'])
})

test("portal environments keep optional fields absent and default can_stop to false", () => {
  const env = { name: "box", status: "running", links: [{ label: "open", url: "any string" }] }
  const input = { title: "Machines", environments: [env], links: [] }
  assert.deepEqual(Environments.parse(input), { ...input, can_stop: false })
  assert.deepEqual(Environments.parse({ ...input, can_stop: true, environments: [{ ...env, detail: "", session: "", memory: -1.5 }] }).environments[0], { ...env, detail: "", session: "", memory: -1.5 })
  for (const status of ["running", "partial", "stopped"]) assert.equal(Environments.parse({ ...input, environments: [{ ...env, status }] }).environments[0].status, status)
  rejects(Environments, [{ ...input, can_stop: null }, { ...input, environments: [{ ...env, status: "offline" }] }, { ...input, environments: [{ ...env, detail: null }] }, { ...input, environments: [{ ...env, memory: Infinity }] }])
})

test("portal machine load allows null CPU but requires finite memory, CPU and warning numbers", () => {
  const load = { memory: { used: -1, total: 0, percent: 150.5 }, cpu: { percent: null }, warn_at: 85 }
  assert.deepEqual(MachineLoad.parse(load), load)
  assert.equal(MachineLoad.parse({ ...load, cpu: { percent: 0 } }).cpu.percent, 0)
  rejects(MachineLoad, [{ ...load, cpu: {} }, { ...load, cpu: { percent: "0" } }, { ...load, memory: { ...load.memory, percent: NaN } }, { ...load, warn_at: Infinity }])
})

const pick = { provider: "p", model: "m", effort: "", speed: "" }
const saved = { id: "", name: "Preset", icon: "", pick }
test("portal presets trim names before enforcing 1–40 and enforce the 32-character icon boundary", () => {
  assert.equal(preset.parse({ ...saved, name: "  valid  " }).name, "valid")
  assert.equal(preset.parse({ ...saved, name: ` ${"x".repeat(40)} `, icon: "x".repeat(32) }).name.length, 40)
  rejects(preset, [{ ...saved, name: " \n" }, { ...saved, name: "x".repeat(41) }, { ...saved, icon: "x".repeat(33) }, { ...saved, pick: { ...pick, provider: "" } }, { ...saved, pick: { ...pick, model: "" } }, { ...saved, pick: { provider: "p", model: "m" } }])
  assert.equal(preset.parse({ ...saved, pick: { ...pick, provider: " " } }).pick.provider, " ")
})

test("portal picks validate the envelope while retaining unknown entries for per-entry filtering", () => {
  const raw = { presets: [saved, null, 3], favorites: [{ provider: "p", model: "m" }, false] }
  assert.deepEqual(picks.parse(raw), raw)
  assert.deepEqual(raw.presets.flatMap(entry => { const result = preset.safeParse(entry); return result.success ? [result.data] : [] }), [saved])
  rejects(picks, [{ presets: [], favorites: null }, { presets: [] }])
})

test("portal favorites preserve full presets and fall back to routes for partial or malformed presets", () => {
  assert.deepEqual(favorite.parse({ ...pick, extra: true }), pick)
  for (const partial of [{ effort: "high" }, { speed: "fast" }, { effort: null, speed: "fast" }]) {
    assert.deepEqual(favorite.parse({ provider: "p", model: "m", ...partial }), { provider: "p", model: "m" })
  }
  rejects(favorite, [{ ...pick, model: "" }, { ...pick, provider: null }, {}])
})

const choice = { provider: "", model: "", providers: [{ provider: "p", label: "P", models: ["m"] }] }
test("portal model choice accepts empty selection and optional controls without relaxing their types", () => {
  assert.deepEqual(modelChoice.parse(choice), choice)
  const full = { ...choice, effort: "", speed: "fast", efforts: ["high"], speeds: [], overridden: false }
  assert.deepEqual(modelChoice.parse(full), full)
  rejects(modelChoice, [{ ...choice, effort: null }, { ...choice, overridden: 0 }, { ...choice, providers: [{ ...choice.providers[0], models: [1] }] }, { ...choice, efforts: [null] }])
})

test("portal sign-off extends model choice with a required boolean", () => {
  assert.deepEqual(signOff.parse({ ...choice, on: false }), { ...choice, on: false })
  rejects(signOff, [choice, { ...choice, on: 0 }, { ...choice, on: null }])
})

test("portal usage accepts nullable notes and reset strings without imposing date or percentage ranges", () => {
  const account = { label: "", windows: [{ label: "week", used_percent: -10.5, resets_at: "not a date" }], note: null }
  const input = { providers: [{ provider: "p", label: "P", accounts: [account] }] }
  assert.deepEqual(usage.parse(input), input)
  const change = edits => ({ providers: [{ ...input.providers[0], accounts: [{ ...account, ...edits }] }] })
  assert.equal(usage.parse(change({ windows: [{ ...account.windows[0], used_percent: 150, resets_at: null }], note: "" })).providers[0].accounts[0].note, "")
  rejects(usage, [change({ note: undefined }), change({ windows: [{ label: "week", used_percent: 0 }] }), change({ windows: [{ ...account.windows[0], used_percent: Infinity }] })])
})

test("portal session creation/selection and model warnings retain exact optional/required rules", () => {
  assert.deepEqual(created.parse({ session: "", extra: true }), { session: "" })
  assert.deepEqual(created.parse({ session: "s", confirmation: "", message: "" }), { session: "s", confirmation: "", message: "" })
  rejects(created, [{}, { session: 1 }, { session: "s", message: null }])
  assert.deepEqual(selected.parse({ extra: true }), {})
  rejects(selected, [{ confirmation: null }])
  assert.deepEqual(warning.parse({ confirmation: "", message: "", extra: true }), { confirmation: "", message: "" })
  rejects(warning, [{ confirmation: "c" }, { confirmation: 1, message: "m" }])
})

test("decoder inference enforces required, optional, nullable, default, enum, union and extended types", () => {
  execFileSync(process.execPath, [new URL("../node_modules/typescript/bin/tsc", import.meta.url).pathname,
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2023", "--module", "ESNext", "--moduleResolution", "bundler",
    "--allowImportingTsExtensions", new URL("./decode-types.ts", import.meta.url).pathname], { stdio: "pipe", cwd: new URL(".", import.meta.url) })
})
