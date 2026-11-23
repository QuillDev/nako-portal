import assert from "node:assert/strict"
import { createServer } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { ServerOrigin } from "../src/origin.js"
import { BREW, Updater, brewVersion, findBrew, platformKey } from "../src/update.js"
import { verifyStagedSignature } from "../src/minisign.js"

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

test("changing servers during a poll leaves only the new polling chain", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { updater } = macApp({ brewHas: "0.3.0" })
  const polls = []
  updater.run = () => new Promise(resolve => polls.push({ origin: updater.origin, resolve }))
  updater.watch("old")
  t.mock.timers.tick(20_000)
  assert.equal(polls.length, 1)
  updater.watch("new")
  const timer = updater.timer
  polls[0].resolve("none")
  await Promise.resolve()
  assert.equal(updater.timer, timer, "obsolete completion cannot schedule another timer")
  t.mock.timers.tick(20_000)
  assert.deepEqual(polls.map(poll => poll.origin), ["old", "new"])
  polls[1].resolve("none")
  await Promise.resolve()
  t.mock.timers.tick(6 * 3600_000)
  assert.deepEqual(polls.map(poll => poll.origin), ["old", "new", "new"])
  polls[2].resolve("none")
  updater.watch(null)
})

test("a cancelled old check cannot publish an update or clear the new check's busy state", async t => {
  const server = await portal("0.3.1")
  t.after(server.close)
  const { updater, events } = macApp({ brewHas: "0.3.0" })
  updater.origin = server.origin
  const cookies = []
  updater.cookie = () => new Promise(resolve => cookies.push(resolve))
  const old = updater.run(false)
  const oldSignal = updater.active.controller.signal
  updater.watch(server.origin)
  clearTimeout(updater.timer)
  const current = updater.run(false)
  cookies[0]("portal=good")
  assert.equal(await old, "cancelled")
  assert.equal(oldSignal.aborted, true)
  assert.equal(updater.checking, true)
  assert.deepEqual(events.ready, [])
  cookies[1]("portal=good")
  assert.equal(await current, "found")
  assert.deepEqual(events.ready, ["0.3.1"])
  assert.equal(updater.checking, false)
})

test("manifest fetches time out even after response headers arrive", async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.write('{"version":')
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const { updater } = macApp({ brewHas: "0.3.0" })
  updater.origin = ServerOrigin.parse(`http://127.0.0.1:${server.address().port}`)
  updater.fetchTimeout = 40
  assert.equal(await updater.run(false), "error")
  assert.equal(updater.checking, false)
  assert.equal(updater.pending, null)
})

function signedRelease(data) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const id = Buffer.from("0123456789abcdef", "hex")
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")
  const pub = Buffer.from(`untrusted comment: key\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64")
  const sig = sign(null, createHash("blake2b512").update(data).digest(), privateKey)
  const comment = "timestamp:1\tfile:nako.AppImage"
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey)
  const signature = Buffer.from(`untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64")
  return { pub, signature }
}

test("downloads stream to disk and the worker accepts only a valid signature", async t => {
  const data = Buffer.alloc((1 << 20) + 3, 7)
  const { pub, signature } = signedRelease(data)
  let corrupt = false
  let origin
  const server = createServer((req, res) => {
    if (req.url === "/installer") return res.end(corrupt ? Buffer.from("tampered") : data)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ version: "1.0.0", platforms: { "linux-x86_64": { url: `${origin.value}/installer`, signature } } }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  origin = ServerOrigin.parse(`http://127.0.0.1:${server.address().port}`)
  const updater = new Updater({ version: "0.0.0", platform: "linux-x86_64", publicKey: pub, cookie: async () => "portal=good", onReady: () => {} })
  updater.origin = origin
  assert.equal(await updater.run(false), "found")
  const staged = updater.pending
  t.after(() => rm(staged.directory, { recursive: true, force: true }))
  assert.equal("bytes" in staged, false, "no installer retained in main-process memory")
  assert.deepEqual(readFileSync(staged.path), data)
  updater.watch(null)
  // watch removes the previous origin's staged download.
  for (let tries = 0; tries < 100 && existsSync(staged.path); tries++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(staged.path), false)
  corrupt = true
  updater.origin = origin
  assert.equal(await updater.run(false), "error")
  assert.equal(updater.error, "the download's signature doesn't match")
  assert.equal(updater.pending, null)
})

test("verification yields to the main event loop and can be cancelled", async t => {
  const data = Buffer.alloc(8 << 20, 5)
  const { pub, signature } = signedRelease(data)
  const directory = await mkdtemp(join(tmpdir(), "nako-verifier-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "installer")
  await writeFile(path, data)
  const controller = new AbortController()
  const result = verifyStagedSignature(path, signature, pub, controller.signal)
  const first = await Promise.race([
    result.then(() => "verified"),
    new Promise(resolve => setTimeout(() => resolve("timer"), 0)),
  ])
  assert.equal(first, "timer", "the main thread stays available during hashing")
  controller.abort(new Error("obsolete server"))
  await assert.rejects(result, /obsolete server/)
})

test("a download body that stalls hits its own deadline", async t => {
  let origin
  const server = createServer((req, res) => {
    if (req.url === "/installer") {
      res.writeHead(200)
      res.write("partial installer")
    } else {
      res.end(JSON.stringify({ version: "1.0.0", platforms: { "linux-x86_64": { url: `${origin.value}/installer`, signature: "unused" } } }))
    }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  origin = ServerOrigin.parse(`http://127.0.0.1:${server.address().port}`)
  const updater = new Updater({ version: "0.0.0", platform: "linux-x86_64", publicKey, cookie: async () => "portal=good", onReady: () => assert.fail("partial download became ready"), downloadTimeout: 50 })
  updater.origin = origin
  assert.equal(await updater.run(false), "error")
  assert.equal(updater.pending, null)
  assert.equal(updater.checking, false)
})
