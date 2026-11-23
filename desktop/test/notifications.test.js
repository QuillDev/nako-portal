import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { trackNotification } from "../src/notifications.js"

test("dismissed, clicked and failed notifications are no longer retained across chats", () => {
  const shown = new Map()
  for (const event of ["close", "click", "failed"]) {
    const note = new EventEmitter()
    note.close = () => {}
    trackNotification(shown, event, note)
    note.emit(event)
    assert.equal(shown.size, 0)
  }
})

test("a replacement survives late close and click events from the old notification", () => {
  const shown = new Map()
  const old = new EventEmitter()
  let closed = 0
  old.close = () => closed++
  const replacement = new EventEmitter()
  trackNotification(shown, "chat", old)
  trackNotification(shown, "chat", replacement)
  assert.equal(closed, 1)
  old.emit("close")
  old.emit("click")
  assert.equal(shown.get("chat"), replacement)
  replacement.emit("close")
  assert.equal(shown.size, 0)
})
