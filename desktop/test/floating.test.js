import assert from "node:assert/strict"
import { test } from "node:test"

import { GAP, PANEL, STICKER, Statuses, inside, nearest, panelSpot, rest } from "../src/floating.js"

const main = { x: 0, y: 0, width: 1920, height: 1040 }
const left = { x: -1280, y: 0, width: 1280, height: 984 }

test("with nothing saved she starts on the main screen's right edge, a third down", () => {
  const spot = rest(undefined, [main, left])
  assert.deepEqual(spot, { x: 1920 - STICKER - GAP, y: Math.round(1040 * 0.3) })
})

test("she comes back where she was left", () => {
  assert.deepEqual(rest({ x: 700, y: 400 }, [main, left]), { x: 700, y: 400 })
  assert.deepEqual(rest({ x: -900, y: 100 }, [main, left]), { x: -900, y: 100 })
})

test("a spot on a screen that's gone or shrank pulls her onto the nearest screen", () => {
  // The left screen was unplugged.
  assert.deepEqual(rest({ x: -900, y: 100 }, [main]), { x: 0, y: 100 })
  // Saved below where the screen now ends.
  assert.deepEqual(rest({ x: 300, y: 2000 }, [main]), { x: 300, y: 1040 - STICKER })
})

test("let go half off the screen, she's pulled back fully on it", () => {
  assert.deepEqual(inside(1900, -20, main), { x: 1920 - STICKER, y: 0 })
  assert.equal(nearest(-50, 500, [main, left]), left)
  assert.equal(nearest(-STICKER / 2 + 5, 500, [main, left]), main)
})

test("the panel opens beside her toward the roomier side, and she never moves", () => {
  // On the right edge, top half: to her left, level with her top.
  const right = panelSpot(1830, 200, main)
  assert.deepEqual(right, { x: 1830 - GAP - PANEL.width, y: 200, width: PANEL.width, height: PANEL.height })
  // On the left edge, bottom half: to her right, level with her bottom.
  const low = panelSpot(10, 900, main)
  assert.deepEqual(low, { x: 10 + STICKER + GAP, y: 900 + STICKER - PANEL.height, width: PANEL.width, height: PANEL.height })
})

test("the panel stays on her screen and shrinks to fit a small one", () => {
  const small = { x: 0, y: 0, width: 1024, height: 600 }
  const spot = panelSpot(950, 0, small)
  assert.equal(spot.height, 600 - GAP * 2)
  assert.equal(spot.y, GAP)
  assert.ok(spot.x + spot.width <= small.width - GAP)
  // On a second screen left of the main one, the panel lands on that screen.
  const there = panelSpot(-1270, 100, left)
  assert.ok(there.x >= left.x && there.x + there.width <= left.x + left.width)
})

test("she works while any chat runs and wants you when any chat waits on you", () => {
  const statuses = new Statuses()
  assert.equal(statuses.mood, "idle")
  assert.ok(statuses.apply(JSON.stringify({ kind: "status", session: "a", status: "working" })))
  assert.equal(statuses.mood, "working")
  statuses.apply(JSON.stringify({ kind: "status", session: "b", status: "needs you" }))
  assert.equal(statuses.mood, "needs-you")
  statuses.apply(JSON.stringify({ kind: "status", session: "b", status: "done" }))
  statuses.apply(JSON.stringify({ kind: "status", session: "a", status: "done" }))
  assert.equal(statuses.mood, "idle")
})

test("frames that aren't statuses leave her mood alone", () => {
  const statuses = new Statuses()
  statuses.apply(JSON.stringify({ kind: "status", session: "a", status: "working" }))
  for (const frame of ["junk", "null", JSON.stringify({ kind: "alert", title: "x" }), JSON.stringify({ kind: "status", session: 4, status: "done" })]) {
    assert.equal(statuses.apply(frame), false, frame)
  }
  assert.equal(statuses.mood, "working")
})
