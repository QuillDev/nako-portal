import assert from "node:assert/strict"
import { test } from "node:test"
import { deferred, loadModule } from "./load-module.mjs"
import { hookHarness } from "./hook-harness.mjs"
const draftState = await loadModule("../src/lib/draft-state.ts")
const reloadState = await loadModule("../src/lib/reload-state.ts")
let sequence = 0

async function setup(t) {
  const provider = hookHarness()
  const form = hookHarness()
  let active = provider
  const contexts = []
  const storage = new Map([["draft:A", "submitted"]])
  const name = `__promptTest${++sequence}`
  globalThis[name] = {
    ...draftState, ...reloadState,
    ...Object.fromEntries(Object.keys(provider.hooks).map(key => [key, (...args) => active.hooks[key](...args)])),
    createContext(value) { const context = { value }; context.Provider = context; contexts.push(context); return context },
    cn: (...args) => args.filter(Boolean).join(" "),
    validateAttachments: files => files,
    attachmentDataUrl: async file => `data:text/plain;base64,${file.name}`,
    nanoid: () => `file-${++sequence}`,
    InputGroup: "div",
  }
  const originalURL = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL }
  URL.createObjectURL = file => `blob:${file.name}`
  URL.revokeObjectURL = () => {}
  const module = await loadModule("../src/components/ai-elements/prompt-input.tsx", source => {
    source = source.replace(/^import[\s\S]*?from ["'][^"']+["'];?\n/gm, "")
    return `const { ${Object.keys(globalThis[name]).join(", ")} } = globalThis.${name};\n${source}`
  })
  provider.mount(() => module.PromptInputProvider({ initialInput: storage.get("draft:A"), onInputChange: value => value ? storage.set("draft:A", value) : storage.delete("draft:A") }))
  const sync = async () => {
    active = provider
    await provider.flush()
    contexts[0].value = provider.value.props.value
    contexts[1].value = provider.value.props.value.attachments
  }
  await sync()
  t.after(() => { provider.cleanup(); form.cleanup(); Object.assign(URL, originalURL); delete globalThis[name] })
  return {
    storage, sync,
    get controller() { return contexts[0].value },
    async submit(onSubmit) {
      active = form
      form.mount(() => module.PromptInput({ onSubmit }))
      const element = form.value.props.children[1]
      return { send: () => element.props.onSubmit({ preventDefault() {}, currentTarget: {} }) }
    },
  }
}

test("provider persists programmatic slash completions and submission clearing immediately", async t => {
  const env = await setup(t)
  env.controller.textInput.setInput("/undo")
  assert.equal(env.storage.get("draft:A"), "/undo")
  const submitted = env.controller.textInput.snapshot()
  assert.equal(env.controller.textInput.clearSubmitted(submitted), true)
  assert.equal(env.storage.has("draft:A"), false)
  env.controller.textInput.setInput("undo prefill")
  assert.equal(env.storage.get("draft:A"), "undo prefill")
})

test("actual prompt submission preserves edits and added files through deferred success", async t => {
  const env = await setup(t)
  env.controller.attachments.add([{ name: "first" }])
  await env.sync()
  const post = deferred()
  let sent
  const submit = await env.submit(message => { sent = message; return post.promise })
  const sending = submit.send()
  env.controller.textInput.setInput("next draft")
  env.controller.attachments.add([{ name: "second" }])
  await env.sync()
  post.resolve()
  await sending
  await env.sync()
  assert.equal(sent.text, "submitted")
  assert.equal(sent.files[0].filename, "first")
  assert.equal(env.controller.textInput.value, "next draft")
  assert.equal(env.storage.get("draft:A"), "next draft")
  assert.deepEqual(env.controller.attachments.files.map(file => file.filename), ["second"])
})

test("actual prompt clears an untouched draft and persists command prefill", async t => {
  const env = await setup(t)
  const submit = await env.submit(async () => "restored undo text")
  await submit.send()
  await env.sync()
  assert.equal(env.controller.textInput.value, "restored undo text")
  assert.equal(env.storage.get("draft:A"), "restored undo text")
})

test("actual command prefill cannot overwrite edits made while command was pending", async t => {
  const env = await setup(t)
  const post = deferred()
  const submit = await env.submit(() => post.promise)
  const sending = submit.send()
  env.controller.textInput.setInput("different")
  env.controller.textInput.setInput("submitted")
  post.resolve("old undo prefill")
  await sending
  await env.sync()
  assert.equal(env.storage.get("draft:A"), "submitted")
})

test("failed submission retains both draft and submitted attachment", async t => {
  const env = await setup(t)
  env.controller.attachments.add([{ name: "first" }])
  await env.sync()
  const submit = await env.submit(async () => { throw new Error("offline") })
  await submit.send()
  await env.sync()
  assert.equal(env.controller.textInput.value, "submitted")
  assert.equal(env.storage.get("draft:A"), "submitted")
  assert.deepEqual(env.controller.attachments.files.map(file => file.filename), ["first"])
})
