import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule } from "./load-module.mjs"
const { age, daysAgo, dayOf, dayLabel, fullTime } = await loadModule("../src/lib/times.ts")
const seconds = date => date.getTime() / 1000

test("lists and transcript agree immediately after midnight", () => {
  const now = new Date(2026, 10, 23, 0, 5)
  const yesterday = seconds(new Date(2026, 10, 22, 23, 55))
  assert.equal(age(yesterday, now), "yesterday")
  assert.equal(daysAgo(yesterday, now), 1)
  assert.equal(dayLabel(yesterday, now), "Yesterday")
  assert.match(fullTime(yesterday, now), /^Yesterday at /)
  assert.equal(age(seconds(new Date(2026, 10, 23, 0, 0)), now), "today")
})

test("list buckets use calendar dates at every boundary", () => {
  const now = new Date(2026, 10, 30, 0, 5)
  for (const [days, expected] of [[0, "today"], [1, "yesterday"], [2, "this week"], [6, "this week"], [7, "this month"], [29, "this month"], [30, "older"]]) {
    const date = new Date(2026, 10, 30 - days, 23, 55)
    assert.equal(age(seconds(date), now), expected)
  }
})

test("calendar labels survive month, year and leap-day boundaries", () => {
  for (const [now, previous] of [
    [new Date(2027, 0, 1), new Date(2026, 11, 31, 23, 59)],
    [new Date(2028, 2, 1), new Date(2028, 1, 29, 23, 59)],
  ]) {
    assert.equal(age(seconds(previous), now), "yesterday")
    assert.equal(dayOf(seconds(previous)), new Date(previous.getFullYear(), previous.getMonth(), previous.getDate()).getTime())
  }
})

test("DST changes count calendar days rather than 24-hour intervals", () => {
  const previousTZ = process.env.TZ
  process.env.TZ = "America/New_York"
  try {
    const spring = new Date(2026, 2, 9, 0, 5)
    const fall = new Date(2026, 10, 2, 0, 5)
    assert.equal(daysAgo(seconds(new Date(2026, 2, 8, 0, 5)), spring), 1)
    assert.equal(age(seconds(new Date(2026, 2, 7, 23, 55)), spring), "this week")
    assert.equal(daysAgo(seconds(new Date(2026, 10, 1, 0, 5)), fall), 1)
    assert.equal(dayLabel(seconds(new Date(2026, 10, 1, 0, 5)), fall), "Yesterday")
  } finally {
    if (previousTZ === undefined) delete process.env.TZ
    else process.env.TZ = previousTZ
  }
})
