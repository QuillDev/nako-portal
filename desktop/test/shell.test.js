import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { request } from "node:http"
import { test } from "node:test"

import { browserAgent } from "../src/agent.js"
import { backoff, parseAlert } from "../src/alerts.js"
import { blake2b512, parsePublicKey, verifySignature } from "../src/minisign.js"
import { ServerOrigin } from "../src/origin.js"
import { begin } from "../src/signin.js"
import { announcement, due, newer, platformKey, reason } from "../src/update.js"

const origin = input => ServerOrigin.parse(input)?.value ?? null

test("addresses normalize to a bare origin", () => {
  assert.equal(origin("portal.example.com"), "https://portal.example.com")
  assert.equal(origin("  HTTPS://Portal.Example.com/ "), "https://portal.example.com")
  assert.equal(origin("https://portal.example.com:443"), "https://portal.example.com")
  assert.equal(origin("http://10.0.0.5:8797"), "http://10.0.0.5:8797")
})

test("anything but a bare http origin is refused", () => {
  for (const input of ["", "https://portal.example.com/chat", "https://me:pw@portal.example.com", "https://portal.example.com/?a=1", "https://portal.example.com/#x", "ftp://portal.example.com", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.equal(origin(input), null, input)
  }
})

test("only the portal itself stays in the app", () => {
  const portal = ServerOrigin.parse("https://portal.example.com")
  assert.ok(portal.opensInApp("https://portal.example.com/#/c/abc"))
  assert.ok(portal.opensInApp("https://PORTAL.example.com:443/api/file?x=1"))
  assert.ok(!portal.opensInApp("http://portal.example.com/"))
  assert.ok(!portal.opensInApp("https://portal.example.com.evil.example/"))
  assert.ok(!portal.opensInApp("mailto:someone@example.com"))
})

test("notifications open their chat and nothing else", () => {
  const portal = ServerOrigin.parse("http://localhost:8851")
  assert.equal(portal.chatPage("20261024_090000_aaaaaa"), "http://localhost:8851/#/c/20261024_090000_aaaaaa")
  assert.equal(portal.chatPage("../settings"), null)
  assert.equal(portal.chatPage(""), null)
  assert.equal(portal.socketUrl, "ws://localhost:8851/ws")
  assert.equal(ServerOrigin.parse("portal.example.com").socketUrl, "wss://portal.example.com/ws")
})

test("alert frames become notifications and everything else is ignored", () => {
  assert.deepEqual(parseAlert('{"kind":"alert","title":"Fix the build","body":"done","session":"20261024_020202_bbbbbb"}'), { title: "Fix the build", body: "done", session: "20261024_020202_bbbbbb" })
  assert.equal(parseAlert('{"kind":"alert","title":"Nako","body":"digest","session":null}').session, null)
  assert.equal(parseAlert('{"kind":"status","session":"x"}'), null)
  assert.equal(parseAlert('{"kind":"alert"}'), null)
  assert.equal(parseAlert("not json"), null)
})

test("reconnects back off to five minutes", () => {
  assert.deepEqual([0, 1, 2, 3].map(backoff), [2, 4, 8, 16])
  assert.equal(backoff(20), 300)
})

const get = (port, path) =>
  new Promise((resolve, reject) => request({ host: "127.0.0.1", port, path }, r => resolve(r.statusCode)).on("error", reject).end())

test("the browser hands the code back and the app redeems it with its secret", async () => {
  const handoff = await begin(ServerOrigin.parse("https://portal.example.com"))
  const url = new URL(handoff.browserUrl)
  assert.equal(url.origin, "https://portal.example.com")
  const ask = new URLSearchParams(url.hash.replace("#/desktop?", ""))
  const port = Number(ask.get("port"))
  const waiting = handoff.wait(10_000)
  // Someone else's state (or no code) is turned away, and the app keeps waiting.
  assert.equal(await get(port, "/callback?code=stolen&state=wrong"), 400)
  assert.equal(await get(port, `/callback?state=${ask.get("state")}`), 400)
  assert.equal(await get(port, `/callback?code=c0de&state=${ask.get("state")}`), 200)
  const finish = new URL(await waiting)
  assert.equal(finish.origin + finish.pathname, "https://portal.example.com/api/desktop/session")
  assert.equal(finish.searchParams.get("code"), "c0de")
  // The secret proves this app started the sign-in: it hashes to the challenge the browser saw.
  assert.equal(createHash("sha256").update(finish.searchParams.get("verifier")).digest("base64url"), ask.get("challenge"))
})

test("an abandoned sign-in gives up", async () => {
  const handoff = await begin(ServerOrigin.parse("https://portal.example.com"))
  assert.equal(await handoff.wait(100), null)
})

/** A minisign key pair in the format the release script's signer writes. */
function minisign() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const id = Buffer.from("0123456789abcdef", "hex")
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")
  const pub = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64")
  const signFile = (data, comment = "timestamp:1\tfile:nako.AppImage") => {
    const sig = sign(null, createHash("blake2b512").update(data).digest(), privateKey)
    const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey)
    const text = `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`
    return Buffer.from(text).toString("base64")
  }
  return { pub, signFile }
}

test("an update installs only with a signature from the release key", () => {
  const release = minisign()
  const other = minisign()
  const key = parsePublicKey(release.pub)
  const file = Buffer.from("the new app")
  assert.ok(verifySignature(file, release.signFile(file), key))
  assert.ok(!verifySignature(Buffer.from("the new app!"), release.signFile(file), key), "changed file")
  assert.ok(!verifySignature(file, other.signFile(file), key), "someone else's key")
  const forged = Buffer.from(release.signFile(file), "base64").toString().replace("file:nako.AppImage", "file:other")
  assert.ok(!verifySignature(file, Buffer.from(forged).toString("base64"), key), "edited trusted comment")
  assert.ok(!verifySignature(file, "not a signature", key))
})

test("the app's own BLAKE2b matches Node's, across slice boundaries", () => {
  for (const size of [0, 3, 128, (1 << 20) + 7]) {
    const data = Buffer.alloc(size, 7)
    assert.ok(blake2b512(data).equals(createHash("blake2b512").update(data).digest()), String(size))
  }
})

test("updates go to newer versions, and only on installs that replace themselves", () => {
  assert.ok(newer("0.3.0", "0.2.11"))
  assert.ok(newer("0.2.12", "0.2.11"))
  assert.ok(!newer("0.2.11", "0.2.11"))
  assert.ok(!newer("0.2.9", "0.2.11"))
  assert.equal(platformKey({ APPIMAGE: "/x/Nako.AppImage" }, "linux"), "linux-x86_64")
  assert.equal(platformKey({}, "linux"), null, "the .deb updates through apt")
  assert.equal(platformKey({}, "win32", true), "windows-x86_64")
  assert.equal(platformKey({}, "darwin"), null, "Homebrew's app updates through brew")
})

test("coming back checks again only after a while, and a failed check says what to do", () => {
  const now = Date.now()
  assert.ok(due(null, now))
  assert.ok(!due(now - 60_000, now), "a minute ago")
  assert.ok(due(now - 10 * 60_000, now), "ten minutes ago")
  assert.equal(reason("not signed in"), "Sign in to the portal first")
  assert.equal(reason("no release"), "This portal doesn't offer desktop updates")
  assert.equal(announcement({ state: "ready", version: '1.2.3"; alert(1); "' }), 'window.nakoUpdate = {"state":"ready","version":"1.2.3\\"; alert(1); \\""}; window.dispatchEvent(new Event("nako-update"))')
})

test("pages see Chrome without the Electron and app tokens", () => {
  const fallback = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) nako/0.3.0 Chrome/146.0.0.0 Electron/45.0.0 Safari/537.36"
  assert.equal(browserAgent(fallback), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
})
