// Nako Portal's desktop app: the portal's own web app in a window, plus the glue a browser tab
// can't do (a server prompt, browser sign-in, notifications, an in-app browser, self-updates).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { BaseWindow, Menu, Notification, Tray, WebContentsView, app, ipcMain, nativeImage, session, shell } from "electron"

import { listen } from "./alerts.js"
import { ServerOrigin } from "./origin.js"
import { Pane } from "./pane.js"
import { begin } from "./signin.js"
import { Updater, announcement, platformKey, readPublicKey } from "./update.js"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const IDENTIFIER = "moe.nakode.portal"
const MAC = process.platform === "darwin"
const log = message => console.error(`nako: ${message}`)

// Settings live where the earlier app kept them, so an update keeps the portal address.
app.setPath("userData", join(app.getPath("appData"), IDENTIFIER))
if (!app.requestSingleInstanceLock()) app.exit(0)

const hidden = process.argv.includes("--hidden")
let window = null
let portal = null
let pane = null
let tray = null
let origin = null
let listener = null
let signIn = null
let quitting = false

const icon = name => nativeImage.createFromPath(join(root, "icons", name))

// ---- the portal address ----

const settingsPath = () => join(app.getPath("userData"), "settings.json")

function savedOrigin() {
  try {
    return ServerOrigin.parse(JSON.parse(readFileSync(settingsPath(), "utf8")).origin)
  } catch {
    return null
  }
}

function saveOrigin(origin) {
  mkdirSync(dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ origin: origin.value }, null, 2))
}

async function reachable(origin) {
  let me
  try {
    const response = await fetch(origin.page("/api/me"), { signal: AbortSignal.timeout(10_000) })
    me = await response.json().catch(() => null)
  } catch (error) {
    log(`${origin.value}: ${error.message}`)
    throw new Error(`Can't reach ${origin.value}`)
  }
  if (!me || !("signed_in" in me)) throw new Error(`${origin.value} isn't a Nako portal`)
}

const localPage = query => portal.webContents.loadFile(join(root, "ui", "index.html"), { search: query })

function openPortal(next) {
  const changed = origin?.value !== next.value
  origin = next
  if (changed || !listener) {
    listener?.stop()
    listener = listen({ origin, cookie: cookieHeader, onAlert: showAlert, log })
    updater.watch(origin)
    if (changed) pane?.reset()
  }
  portal.webContents.loadURL(origin.url)
}

async function cookieHeader() {
  if (!origin) return null
  const cookies = await session.defaultSession.cookies.get({ url: origin.url })
  const header = cookies.map(c => `${c.name}=${c.value}`).join("; ")
  return header || null
}

const onPortal = url => Boolean(origin?.opensInApp(url))

// ---- what pages may ask ----

/** Commands, and who may send them: the app's own pages (file://), the portal, or the browser's toolbar. */
const COMMANDS = {
  start: ["local"],
  connect: ["local"],
  pane: ["bar"],
  pane_chat: ["portal"],
  pane_search: ["portal"],
  pane_toggle: ["portal"],
  "plugin:window|minimize": ["local", "portal", "bar"],
  "plugin:window|toggle_maximize": ["local", "portal", "bar"],
  "plugin:window|internal_toggle_maximize": ["local", "portal", "bar"],
  "plugin:window|close": ["local", "portal", "bar"],
}

function sender(event) {
  const url = event.senderFrame?.url ?? ""
  if (pane?.bar && event.sender === pane.bar.webContents) return url.startsWith("file:") ? "bar" : null
  if (event.sender !== portal?.webContents) return null
  if (url.startsWith("file:")) return "local"
  return onPortal(url) ? "portal" : null
}

ipcMain.handle("nako", async (event, command, args = {}) => {
  if (!COMMANDS[command]?.includes(sender(event))) throw new Error(`${command} not allowed`)
  switch (command) {
    case "start": {
      const saved = savedOrigin()
      if (!saved) return { kind: "ask", origin: null }
      if (args.change) return { kind: "ask", origin: saved.value }
      try {
        await reachable(saved)
      } catch (error) {
        return { kind: "unreachable", origin: saved.value, error: error.message }
      }
      openPortal(saved)
      return { kind: "open" }
    }
    case "connect": {
      const next = ServerOrigin.parse(args.address)
      if (!next) throw new Error("Enter an address like https://portal.example.com")
      await reachable(next)
      saveOrigin(next)
      openPortal(next)
      return null
    }
    case "pane":
      return pane.action(String(args.action), args.target == null ? null : String(args.target))
    case "pane_chat":
      return pane.chat(typeof args.chat === "string" ? args.chat : null)
    case "pane_search":
      return pane.search(String(args.engine))
    case "pane_toggle":
      return pane.toggle()
    case "plugin:window|minimize":
      return window.minimize()
    case "plugin:window|toggle_maximize":
    case "plugin:window|internal_toggle_maximize":
      return window.isMaximized() ? window.unmaximize() : window.maximize()
    case "plugin:window|close":
      return window.close()
  }
})

// ---- the portal's view ----

/** Same-origin pages stay in the app; other web pages open in the in-app browser, everything else goes to the system. */
function navigate(event, url) {
  if (url.startsWith("file:")) return
  if (!onPortal(url)) {
    event.preventDefault()
    if (/^https?:/i.test(url)) pane.open(url)
    else external(url)
    return
  }
  const path = new URL(url).pathname
  // The sign-in page's button for the desktop app.
  if (path === "/desktop/sign-in") {
    event.preventDefault()
    startSignIn()
  }
  // The portal's update button, shown once an update is downloaded.
  if (path === "/desktop/update") {
    event.preventDefault()
    updater.install(false)
  }
}

async function startSignIn() {
  signIn?.cancel()
  const handoff = await begin(origin)
  signIn = handoff
  external(handoff.browserUrl)
  const finish = await handoff.wait(300_000)
  if (finish && signIn === handoff) {
    portal.webContents.loadURL(finish)
    showMain()
  }
}

/** Tells the portal whether its window buttons belong to it (the pane's toolbar has them while open) and whether the browser is open. */
function tellPortal() {
  const open = Boolean(pane?.isOpen)
  const controls = MAC ? "" : `if (window.nakoWindow) { window.nakoWindow.controls = ${!open}; window.dispatchEvent(new Event("nako-window")) }`
  const browser = `if (window.nakoBrowser) { window.nakoBrowser.open = ${open}; window.dispatchEvent(new Event("nako-browser")) }`
  if (onPortal(portal.webContents.getURL())) portal.webContents.executeJavaScript(controls + browser).catch(() => {})
}

// The portal marks its title bar strips for the earlier app's drag regions; Chromium drags by CSS.
const DRAG = `[data-tauri-drag-region] { -webkit-app-region: drag }
[data-tauri-drag-region] :is(button, a, input, select, textarea, [role="button"], [role="menuitem"], [data-radix-collection-item]) { -webkit-app-region: no-drag }`

/** Chromium's agent without the Electron and app tokens some sites refuse to sign in with. */
const browserAgent = () => app.userAgentFallback.replace(/ Electron\/\S+/, "").replace(/ nako\/\S+/i, "")

function createWindow() {
  window = new BaseWindow({
    title: "Nako",
    width: 1100,
    height: 780,
    minWidth: 380,
    minHeight: 480,
    show: !hidden,
    // Windows and Linux drop the system title bar for the page's own controls (macOS keeps its native one).
    frame: MAC,
    backgroundColor: "#0d0a11",
    icon: MAC ? undefined : icon("icon.png"),
  })
  portal = new WebContentsView({ webPreferences: { preload: join(root, "src", "preload.cjs"), sandbox: true, contextIsolation: true } })
  portal.setBackgroundColor("#0d0a11")
  window.contentView.addChildView(portal)
  const page = portal.webContents
  // Tagged so the portal offers browser sign-in instead of passkeys.
  page.setUserAgent(`${browserAgent()} NakoDesktop/${app.getVersion()}`)
  page.on("will-navigate", event => navigate(event, event.url))
  page.setWindowOpenHandler(({ url }) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    navigate(event, url)
    if (!event.defaultPrevented) page.loadURL(url)
    return { action: "deny" }
  })
  page.on("dom-ready", () => {
    if (!MAC) page.insertCSS(DRAG).catch(() => {})
  })
  page.on("did-finish-load", () => {
    if (!onPortal(page.getURL())) return
    // Chromium writes cookies to disk every so often; a sign-in shouldn't wait for that.
    session.defaultSession.cookies.flushStore().catch(() => {})
    listener?.wake()
    if (updater.pending) page.executeJavaScript(announcement(updater.pending.version)).catch(() => {})
    updater.checkIfDue()
    tellPortal()
  })

  pane = new Pane({
    window,
    portal,
    opensInPortal: onPortal,
    toPortal: url => page.loadURL(url),
    external,
    barPage: join(root, "ui", "browser.html"),
    barPreload: join(root, "src", "preload.cjs"),
    userAgent: browserAgent(),
    changed: tellPortal,
  })
  pane.layout()
  window.on("resize", () => pane.layout())
  window.on("close", event => {
    // Closing hides to the tray, so alerts keep coming.
    if (!quitting && tray) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on("blur", () => {
    if (updater.pending) updater.install(!window.isVisible())
  })
  window.on("focus", () => updater.checkIfDue())
  localPage("")
}

function showMain() {
  window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
  // Reopened from the tray or the launcher: it may have sat there through a release.
  updater.checkIfDue()
}

/** A clicked notification opens its chat, without reloading the page when it's already the portal. */
function openChat(session) {
  const page = origin?.chatPage(session)
  if (!page) return
  showMain()
  if (onPortal(portal.webContents.getURL())) portal.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/c/${session}`)}`)
  else portal.webContents.loadURL(page)
}

function external(url) {
  shell.openExternal(url).catch(error => log(`couldn't open ${url}: ${error.message}`))
}

// ---- notifications ----

/** The notification shown for each chat: a newer alert replaces it. */
const shown = new Map()

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return null
  const note = new Notification({ title, body, icon: icon("128x128.png"), silent: false })
  if (onClick) note.on("click", onClick)
  note.show()
  return note
}

function showAlert(alert) {
  // Nothing to tell someone already looking at the app.
  if (window.isVisible() && window.isFocused()) return
  if (!alert.session) return void notify(alert.title, alert.body)
  shown.get(alert.session)?.close()
  const note = notify(alert.title, alert.body, () => openChat(alert.session))
  if (note) shown.set(alert.session, note)
}

// ---- tray, updates, downloads ----

const updater = new Updater({
  version: app.getVersion(),
  platform: platformKey(process.env, process.platform, app.isPackaged),
  publicKey: readPublicKey(join(root, "pubkey.txt")),
  cookie: cookieHeader,
  onReady: version => {
    portal.webContents.executeJavaScript(announcement(version)).catch(() => {})
    if (!window.isFocused()) updater.install(!window.isVisible())
  },
  notify: (title, body) => notify(title, body),
  quit: () => {
    quitting = true
    app.quit()
  },
  log,
})

function createTray() {
  tray = new Tray(icon(MAC ? "32x32.png" : "128x128.png").resize({ width: 32, height: 32 }))
  tray.setToolTip("Nako")
  const items = [
    { label: "Open Nako", click: showMain },
    {
      label: "Change server",
      click: () => {
        pane.close()
        localPage("change=1")
        showMain()
      },
    },
    // Only installs that replace themselves; the .deb and Homebrew update through their package manager.
    ...(updater.enabled ? [{ label: "Check for updates", click: () => updater.checkNow() }] : []),
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.on("click", showMain)
}

app.on("second-instance", () => showMain())
// Clicking the Dock icon brings back a window that was closed to the menu bar.
app.on("activate", () => window && showMain())
app.on("before-quit", () => {
  quitting = true
  session.defaultSession.cookies.flushStore().catch(() => {})
})
app.on("window-all-closed", () => {})

app.whenReady().then(() => {
  app.setAppUserModelId(IDENTIFIER)
  // Downloads from the portal or the in-app browser go to the Downloads folder.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(join(app.getPath("downloads"), item.getFilename()))
    item.once("done", (_e, state) => {
      if (state === "completed") notify(`Saved ${item.getFilename()}`, "In your Downloads folder")
    })
  })
  try {
    createTray()
  } catch (error) {
    log(`no tray: ${error.message}`)
    tray = null
  }
  createWindow()
  if (hidden && !tray) window.show()
})

