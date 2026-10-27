import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { ServerOrigin } from "../src/origin.js"
import { BREW, Updater, brewVersion, findBrew, platformKey } from "../src/update.js"

const publicKey = readFileSync(new URL("../pubkey.txt", import.meta.url), "utf8")

test("Homebrew's Mac app updates through brew; other Mac apps don't update themselves", () => {
  assert.equal(platformKey({}, "darwin", true, "/opt/homebrew/Cellar/nako/0.3.1/Nako.app/Contents/MacOS/Nako"), BREW)
  assert.equal(platformKey({}, "darwin", true, "/usr/local/Cellar/nako/0.3.1/Nako.app/Contents/MacOS/Nako"), BREW)
  assert.equal(platformKey({}, "darwin", true, "/Applications/Nako.app/Contents/MacOS/Nako"), null)
  assert.equal(platformKey({}, "darwin", false, "/opt/homebrew/Cellar/nako/x/Nako.app"), null, "a dev run")
  assert.equal(findBrew(path => path === "/usr/local/bin/brew"), "/usr/local/bin/brew")
  assert.equal(findBrew(path => true), "/opt/homebrew/bin/brew", "Apple silicon first")
  assert.equal(findBrew(() => false), null)
  assert.equal(brewVersion("nako 0.3.2\n"), "0.3.2")
  assert.equal(brewVersion(""), null)
})

/** A portal publishing desktop `version`, for a signed-in app. */
async function portal(version) {
  const server = createServer((request, response) => {
    if (request.url !== "/api/desktop/release" || request.headers.cookie !== "portal=good") return response.writeHead(401).end()
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ version, platforms: { "linux-x86_64": { url: "x", signature: "y" } } }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { origin: ServerOrigin.parse(`http://127.0.0.1:${server.address().port}`), close: () => (server.close(), server.closeAllConnections()) }
}

function macApp({ brewHas }) {
  const calls = []
  const notes = []
  const events = { ready: [], reopened: [], quit: 0, shown: [] }
  const updater = new Updater({
    version: "0.3.0",
    platform: BREW,
    publicKey,
    cookie: async () => "portal=good",
    onReady: version => events.ready.push(version),
    onStatus: status => events.shown.push(status),
    settleAfter: 20,
    notify: (title, body) => notes.push(`${title}: ${body}`),
    quit: () => events.quit++,
    brew: () => "/opt/homebrew/bin/brew",
    runBrew: async (brew, args) => {
      calls.push(args.join(" "))
      if (args[0] === "--repo") return { ok: true, output: "/opt/homebrew/Library/Taps/quilldev/homebrew-tap\n" }
      return { ok: true, output: args[0] === "list" ? `nako ${brewHas}\n` : "" }
    },
    reopen: app => events.reopened.push(app),
  })
  return { updater, calls, notes, events }
}

test("a newer release shows the arrow on the Mac, and clicking it upgrades through brew and reopens", async () => {
  const server = await portal("0.3.1")
  const { updater, calls, notes, events } = macApp({ brewHas: "0.3.1" })
  updater.origin = server.origin
  assert.equal(updater.automatic, false, "waits for a click, never installs on blur")
  assert.equal(await updater.run(false), "found")
  assert.deepEqual(events.ready, ["0.3.1"])
  assert.deepEqual(calls, [], "nothing downloaded or built before the click")
  await updater.install(false)
  assert.deepEqual(calls, [
    "update --quiet",
    "--repo quilldev/tap",
    "-C /opt/homebrew/Library/Taps/quilldev/homebrew-tap pull --ff-only --quiet",
    "upgrade nako",
    "list --versions nako",
  ])
  assert.deepEqual(events.reopened, ["/opt/homebrew/opt/nako/Nako.app"])
  assert.equal(events.quit, 1)
  assert.match(notes[0], /^Updating Nako/)
  assert.deepEqual(events.shown.at(-1), { state: "installing", version: "0.3.1", brew: true }, "the page shows it's updating until the app reopens")
  server.close()
})

test("the Mac app stays up and says so when brew doesn't have the release yet", async () => {
  const server = await portal("0.3.1")
  const { updater, notes, events } = macApp({ brewHas: "0.3.0" })
  updater.origin = server.origin
  await updater.run(false)
  await updater.install(false)
  assert.equal(events.quit, 0)
  assert.equal(notes.at(-1), "Couldn't update Nako: Homebrew doesn't have 0.3.1 yet")
  assert.ok(updater.pending, "the arrow stays, to try again later")
  assert.equal(events.shown.at(-2).state, "installing")
  assert.deepEqual(events.shown.at(-1), { state: "ready", version: "0.3.1", error: "Homebrew doesn't have 0.3.1 yet" }, "the updating screen goes away")
  server.close()
})

test("clicking the version checks: up to date shows briefly, a newer release shows the update button", async () => {
  const current = await portal("0.3.0")
  const { updater, events } = macApp({ brewHas: "0.3.0" })
  updater.origin = current.origin
  await updater.check()
  assert.deepEqual(events.shown, [{ state: "checking" }, { state: "latest" }])
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(events.shown.at(-1), { state: "idle" }, "then the version shows again")
  current.close()

  const newer = await portal("0.3.1")
  updater.origin = newer.origin
  await updater.check()
  assert.deepEqual(events.shown.slice(-2), [{ state: "checking" }, { state: "ready", version: "0.3.1" }])
  assert.equal(events.quit, 0, "nothing installs until the update button is clicked")
  newer.close()
})

test("a failed check says why, then goes back to the version", async () => {
  const server = await portal("0.3.1")
  const { updater, events } = macApp({ brewHas: "0.3.0" })
  updater.origin = server.origin
  updater.cookie = async () => null
  await updater.check()
  assert.deepEqual(events.shown, [{ state: "checking" }, { state: "error", error: "Sign in to the portal first" }])
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(events.shown.at(-1), { state: "idle" })
  server.close()
})

test("the Mac app finds nothing when it's already on the release", async () => {
  const server = await portal("0.3.0")
  const { updater, events } = macApp({ brewHas: "0.3.0" })
  updater.origin = server.origin
  assert.equal(await updater.run(false), "none")
  assert.deepEqual(events.ready, [])
  server.close()
})
