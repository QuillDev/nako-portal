import assert from "node:assert/strict"
import { test } from "node:test"
import { deferred, loadModule } from "./load-module.mjs"
const { editDraft, submittedDraftIsCurrent, remainingAttachments } = await loadModule("../src/lib/draft-state.ts")
const { holdReload, reloadPending } = await loadModule("../src/lib/reload-state.ts")

test("typing and adding attachments during a deferred submission preserves the next draft", async () => {
  let draft = { value: "submitted", revision: 0 }
  const submitted = draft
  const sentFiles = [{ id: "sent" }]
  let files = sentFiles
  const post = deferred()
  const sending = post.promise.then(() => {
    if (submittedDraftIsCurrent(draft, submitted)) draft = editDraft(draft, "")
    files = remainingAttachments(files, sentFiles)
  })
  draft = editDraft(draft, "next message")
  files = [...files, { id: "new" }]
  post.resolve()
  await sending
  assert.equal(draft.value, "next message")
  assert.deepEqual(files, [{ id: "new" }])
})

test("editing back to identical text is still a new revision", () => {
  const submitted = { value: "same", revision: 1 }
  const current = editDraft(editDraft(submitted, "changed"), "same")
  assert.equal(submittedDraftIsCurrent(current, submitted), false)
})

test("untouched submitted text clears while later attachment IDs remain", () => {
  const draft = { value: "sent", revision: 5 }
  assert.equal(submittedDraftIsCurrent(draft, draft), true)
  const current = [{ id: "later" }, { id: "sent" }]
  assert.deepEqual(remainingAttachments(current, [{ id: "sent" }]), [{ id: "later" }])
  assert.equal(current.length, 2)
})

test("slash completion and undo prefill follow the same revision transitions as typing", () => {
  const initial = { value: "/un", revision: 0 }
  const completion = editDraft(initial, "/undo")
  const prefill = editDraft(editDraft(completion, ""), "previous message")
  assert.deepEqual(prefill, { value: "previous message", revision: 3 })
  assert.equal(submittedDraftIsCurrent(prefill, completion), false)
})

test("reload waits for every attachment and submission blocker, with idempotent cleanup", () => {
  assert.equal(reloadPending(), false)
  const files = holdReload()
  const sending = holdReload()
  files()
  files()
  assert.equal(reloadPending(), true)
  sending()
  assert.equal(reloadPending(), false)
})
