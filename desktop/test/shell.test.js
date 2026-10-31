import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { request } from "node:http"
import { test } from "node:test"

import { browserAgent, signInAgent } from "../src/agent.js"
import { addressOrSearch } from "../src/address.js"
import { backoff, parseAlert } from "../src/alerts.js"
import { blake2b512, parsePublicKey, verifySignature } from "../src/minisign.js"
import { ServerOrigin } from "../src/origin.js"
import { begin } from "../src/signin.js"
import { DIVIDER_WIDTH, dragRange, shareFor, split } from "../src/layout.js"
import { LIVE_CHATS, Tabs, tabName } from "../src/tabs.js"
import { toSystemBrowser } from "../src/links.js"
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

test("each chat has its own browser", () => {
  const tabs = new Tabs()
  tabs.switch("a")
  const a = tabs.openLink("https://one.example/")
  tabs.switch("b")
  assert.equal(tabs.shown(), null, "b has opened nothing")
  tabs.openLink("https://two.example/")
  tabs.switch("a")
  assert.equal(tabs.shown().id, a, "a gets its own tab back")
  assert.equal(tabs.strip().length, 1)
})

test("links open new tabs and reuse one already showing the page", () => {
  const tabs = new Tabs()
  tabs.switch("a")
  const one = tabs.openLink("https://one.example/")
  const two = tabs.openLink("https://two.example/")
  assert.equal(tabs.shown().id, two)
  assert.equal(tabs.openLink("https://one.example/"), one)
  assert.equal(tabs.strip().length, 2, "no duplicate tab")
})

test("closing tabs moves to a neighbour and the last one closes the browser", () => {
  const tabs = new Tabs()
  tabs.switch("a")
  const one = tabs.openLink("https://one.example/")
  const two = tabs.newTab()
  const three = tabs.newTab()
  tabs.select(two)
  assert.ok(tabs.closeTab(two))
  assert.equal(tabs.shown().id, three)
  assert.ok(tabs.closeTab(three))
  assert.equal(tabs.shown().id, one)
  assert.ok(tabs.closeTab(one))
  assert.equal(tabs.isOpen, false)
})

test("the browser button hides and brings back the same tabs", () => {
  const tabs = new Tabs()
  tabs.switch("a")
  tabs.toggle()
  const blank = tabs.shown()
  assert.equal(blank.url, null)
  assert.equal(tabName(blank), "New tab")
  tabs.toggle()
  assert.equal(tabs.isOpen, false)
  tabs.toggle()
  assert.equal(tabs.shown().id, blank.id, "same tab, no second blank one")
})

test("a chat left with its browser closed stays closed", () => {
  const tabs = new Tabs()
  tabs.switch("a")
  tabs.openLink("https://one.example/")
  tabs.hide()
  tabs.switch("b")
  tabs.switch("a")
  assert.equal(tabs.isOpen, false)
  assert.equal(tabs.strip().length, 1, "tabs kept")
})

test("only recent chats keep their pages loaded, and the one on screen always does", () => {
  const tabs = new Tabs()
  const ids = ["a", "b", "c", "d"].map(name => {
    tabs.switch(name)
    const id = tabs.openLink(`https://${name}.example/`)
    tabs.tab(id).live = true
    return id
  })
  assert.deepEqual(tabs.discard(LIVE_CHATS), [ids[0]], "a is the oldest")
  assert.deepEqual(tabs.discard(LIVE_CHATS), [], "already unloaded")
  tabs.switch("a")
  assert.equal(tabs.shown().live, false, "a's page loads again")
  assert.equal(tabs.shown().url, "https://a.example/")
  tabs.shown().live = true
  assert.ok(!tabs.discard(0).includes(tabs.shown().id))
})

test("tabs are named by title then host", () => {
  assert.equal(tabName({ url: "https://docs.example/a", title: "  " }), "docs.example")
  assert.equal(tabName({ url: "https://docs.example/a", title: "Docs" }), "Docs")
})

test("the address bar takes addresses with or without a scheme, and searches the rest", () => {
  assert.equal(addressOrSearch("https://github.com/QuillDev", null), "https://github.com/QuillDev")
  assert.equal(addressOrSearch("  example.com/a?b=1 ", null), "https://example.com/a?b=1")
  assert.equal(addressOrSearch("localhost:3000", null), "https://localhost:3000/")
  assert.equal(addressOrSearch("", null), null)
  assert.equal(addressOrSearch("nako app", null), "https://www.google.com/search?q=nako+app")
  for (const text of ["tauri", "file:///etc/passwd", "javascript:alert(1)"]) {
    const url = new URL(addressOrSearch(text, "duckduckgo"))
    assert.equal(url.origin + url.pathname, "https://duckduckgo.com/", text)
    assert.equal(url.searchParams.get("q"), text)
  }
  assert.ok(addressOrSearch("x y", "https://evil.example/?q=").startsWith("https://www.google.com/"), "only the listed engines")
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

test("pages see Chrome without the Electron and app tokens, and Google's sign-in sees Firefox", () => {
  const fallback = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) nako/0.3.0 Chrome/146.0.0.0 Electron/45.0.0 Safari/537.36"
  assert.equal(browserAgent(fallback), "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
  assert.match(signInAgent("darwin"), /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10\.15; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/)
  assert.match(signInAgent("win32"), /\(Windows NT 10\.0; Win64; x64; rv:/)
  assert.match(signInAgent("linux"), /\(X11; Linux x86_64; rv:/)
})

test("the browser takes 45% of the window beside the chat until the divider is dragged", () => {
  const [portal, x, pane] = split(1100, true)
  assert.equal(pane, 495)
  assert.equal(x, 1100 - 495)
  assert.equal(portal + DIVIDER_WIDTH + pane, 1100)
  assert.deepEqual(split(1100, false), [1100, 1100, 0])
  // Too narrow to share: the browser gets the window.
  assert.deepEqual(split(700, true), [0, 0, 700])
})

test("a dragged divider is kept as a share of the window and survives a resize", () => {
  const share = shareFor(1200, 400)
  const [portal, , pane] = split(1200, true, share)
  assert.equal(portal + DIVIDER_WIDTH / 2, 400)
  // The same share in a wider window keeps the same proportions.
  const [, , wider] = split(1800, true, share)
  assert.equal(wider, Math.round(1800 * share))
  assert.ok(pane > 700)
})

test("the divider stops before either side gets too narrow", () => {
  const [least, most] = dragRange(1200)
  for (const x of [0, 50, least, most, 1190, 5000]) {
    const [portal, , pane] = split(1200, true, shareFor(1200, x))
    assert.ok(portal >= 380, `portal ${portal} at ${x}`)
    assert.ok(pane >= 360, `pane ${pane} at ${x}`)
  }
  // A window just wide enough to share still fits both minimums.
  const [portal, , pane] = split(760, true, 0.9)
  assert.ok(portal >= 380 && pane >= 360)
})

test("cmd/ctrl-clicked outside web links go to the system browser, others stay in the app", () => {
  const onPortal = url => url.startsWith("https://portal.example.com")
  assert.equal(toSystemBrowser("https://example.org/a", "background-tab", onPortal), true)
  assert.equal(toSystemBrowser("https://example.org/a", "foreground-tab", onPortal), false)
  assert.equal(toSystemBrowser("https://portal.example.com/chat/1", "background-tab", onPortal), false)
  assert.equal(toSystemBrowser("mailto:me@example.org", "background-tab", onPortal), false)
})
