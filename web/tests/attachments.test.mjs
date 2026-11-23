import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { transformWithOxc } from "vite"

const source = await readFile(new URL("../src/lib/attachments.ts", import.meta.url), "utf8")
const compiled = await transformWithOxc(source, "attachments.ts")
const { attachmentDataUrl, validateAttachments } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`)

const MAX_FILE = 25 * 1024 * 1024
const file = (name, size, type = "text/plain") => ({ name, size, type })

test("rejects oversized files while retaining valid files at the size boundary", () => {
  const errors = []
  const valid = file("valid.txt", MAX_FILE)
  const oversized = file("large.txt", MAX_FILE + 1)
  assert.deepEqual(validateAttachments([oversized, valid], 0, {
    maxFileSize: MAX_FILE, onError: error => errors.push(error.code),
  }), [valid])
  assert.deepEqual(errors, ["max_file_size"])
})

test("count limits include files already attached", () => {
  const errors = []
  const incoming = [file("a.txt", 1), file("b.txt", 1)]
  assert.deepEqual(validateAttachments(incoming, 1, {
    maxFiles: 2, onError: error => errors.push(error.code),
  }), [incoming[0]])
  assert.deepEqual(errors, ["max_files"])
  assert.deepEqual(validateAttachments(incoming, 2, { maxFiles: 2 }), [])
})

test("accept handles MIME wildcards, exact MIME types and file extensions", () => {
  const incoming = [file("photo.png", 1, "image/png"), file("notes.TXT", 1, ""), file("data.json", 1, "application/json"), file("movie.mp4", 1, "video/mp4")]
  assert.deepEqual(validateAttachments(incoming, 0, { accept: "image/*, .txt, application/json" }), incoming.slice(0, 3))
})

test("failed and aborted file reads reject instead of returning a blob URL", async () => {
  const original = globalThis.FileReader
  try {
    for (const failure of ["onerror", "onabort"]) {
      globalThis.FileReader = class {
        readAsDataURL() { this[failure]() }
      }
      await assert.rejects(attachmentDataUrl(file("broken.txt", 1)), /Couldn't read broken.txt/)
    }
    globalThis.FileReader = class {
      result = "blob:unconverted"
      readAsDataURL() { this.onload() }
    }
    await assert.rejects(attachmentDataUrl(file("broken.txt", 1)), /Couldn't read/)
  } finally { globalThis.FileReader = original }
})

test("successful file reads return their data URL, including legitimate empty files", async () => {
  const original = globalThis.FileReader
  try {
    globalThis.FileReader = class {
      result = "data:text/plain;base64,"
      readAsDataURL() { this.onload() }
    }
    assert.equal(await attachmentDataUrl(file("empty.txt", 0)), "data:text/plain;base64,")
  } finally { globalThis.FileReader = original }
})
