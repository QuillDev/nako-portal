import assert from "node:assert/strict"
import { test } from "node:test"
import { loadModule } from "./load-module.mjs"

const { copyReplyText } = await loadModule("../src/lib/media.ts")
const { findTextMatches, nextMatch, chatFindRanges } = await loadModule("../src/lib/chat-find.ts")
const { mergeMessageMatches } = await loadModule("../src/lib/chat-search.ts")

test("copy keeps the full reply and removes secret/media lines and inline file markers", () => {
  assert.equal(copyReplyText("First paragraph.\n\n SECRET:PRIVATE_TOKEN\n\nSecond paragraph.\nMEDIA:/tmp/file.png\nLast."), "First paragraph.\n\nSecond paragraph.\nLast.")
  assert.equal(copyReplyText("See MEDIA:/tmp/file.png, then continue."), "See, then continue.")
  assert.equal(copyReplyText("SECRET:NAME\r\nMEDIA:not-even-a-valid-file\r\n"), "")
  assert.equal(copyReplyText("```\nSECRET:NAME\n```"), "```\n```")
  assert.equal(copyReplyText("  \n"), "")
})

test("find is literal, case insensitive and returns original text offsets", () => {
  assert.deepEqual(findTextMatches("One ONE one", "one"), [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }])
  assert.deepEqual(findTextMatches("a.b a*b", "a.b"), [{ start: 0, end: 3 }])
  assert.deepEqual(findTextMatches("İx ONE 🐱", "one"), [{ start: 3, end: 6 }])
  assert.deepEqual(findTextMatches("aaa", "aa"), [{ start: 0, end: 2 }])
  assert.deepEqual(findTextMatches("anything", "   "), [])
  assert.equal(nextMatch(0, -1, 7), 6)
  assert.equal(nextMatch(6, 1, 7), 0)
  assert.equal(nextMatch(0, 1, 0), -1)
})

test("find ranges cross inline text nodes without changing the document", () => {
  const nodes = [{ data: "An ap", length: 5 }, { data: "ricot reply", length: 11 }]
  const ranges = []
  const root = {
    querySelectorAll: () => [{}],
    ownerDocument: {
      createTreeWalker: () => { let i = 0; return { nextNode() { this.currentNode = nodes[i++]; return this.currentNode }, currentNode: null } },
      createRange: () => { const range = { setStart(node, offset) { this.start = [node, offset] }, setEnd(node, offset) { this.end = [node, offset] } }; ranges.push(range); return range },
    },
  }
  assert.equal(chatFindRanges(root, "apricot").length, 1)
  assert.deepEqual(ranges[0].start, [nodes[0], 3])
  assert.deepEqual(ranges[0].end, [nodes[1], 5])
  assert.equal(nodes.map(node => node.data).join(""), "An apricot reply")
})

test("message results preserve server order and deduplicate title matches and repeated sessions", () => {
  const rows = [{ id: "archived", archived: true }, { id: "visible" }, { id: "other" }, { id: "other" }]
  assert.deepEqual(mergeMessageMatches(rows, [{ id: "visible" }]), [rows[0], rows[2]])
  assert.deepEqual(mergeMessageMatches([], []), [])
})
