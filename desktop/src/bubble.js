// The floating Nako: her sticker in a small always-on-top window you can drag anywhere, and a click
// on her opens the portal in a panel beside her, to switch chats or answer one without leaving what
// you're doing. Like the Android app's, she shows only while the app's own window is out of sight.
import { BrowserWindow, Menu, screen } from "electron"

import { STICKER, Statuses, inside, nearest, panelSpot, rest } from "./floating.js"
import { toSystemBrowser } from "./links.js"

const MAC = process.platform === "darwin"
/** A click on her this soon after the panel closed itself (on losing focus) was meant to close it. */
const REOPEN_GUARD = 400
/** The panel's corner radius: the window is see-through and the page is clipped to a rounded card. */
const RADIUS = 14
// Rounded on every OS (Windows and Linux draw frameless windows square): the window is see-through,
// the page's own background moves onto its root, which is clipped round, with a hairline edge so a
// light panel doesn't melt into a white page behind it.
const ROUNDED = `html, body { background: transparent !important }
#root { background: var(--background); height: 100vh; overflow: hidden; border-radius: ${RADIUS}px; clip-path: inset(0 round ${RADIUS}px) }
html::after { content: ""; position: fixed; inset: 0; border: 1px solid var(--border, rgb(127 127 127 / 0.3)); border-radius: ${RADIUS}px; pointer-events: none; z-index: 2147483647 }`

export class FloatingNako {
  /**
   * `page`/`preload`: the sticker's local page and its preload; `panelPreload`: the panel's.
   * `portalUrl(chat)` the page to open the panel on, `opensInPortal(url)` whether a link stays in it,
   * `userAgent` the panel's agent, `saved`/`keep` her remembered spot, `openInApp(chat)`, `openLink(url)`,
   * `openExternally(url)` for Cmd/Ctrl-clicked links,
   * `signIn()`, and `putAway()`/`quit()` for her menu.
   */
  constructor(options) {
    this.options = options
    this.sticker = null
    this.panel = null
    this.statuses = new Statuses()
    this.mood = "idle"
    this.counts = { working: 0, finished: 0 }
    this.dot = false
    this.unreadChat = null
    this.closedAt = 0
    this.dragTimer = null
    this.spot = null
  }

  get isShown() {
    return Boolean(this.sticker?.isVisible())
  }

  owns(contents) {
    if (this.sticker && contents === this.sticker.webContents) return "sticker"
    if (this.panel && contents === this.panel.webContents) return "panel"
    return null
  }

  show() {
    if (!this.sticker) this.#build()
    if (!this.sticker.isVisible()) {
      this.#place()
      this.sticker.showInactive()
    }
  }

  hide() {
    this.#stopDrag()
    this.collapse()
    this.sticker?.hide()
  }

  destroy() {
    this.#stopDrag()
    this.panel?.destroy()
    this.sticker?.destroy()
    this.panel = null
    this.sticker = null
  }

  /** A new alert: a dot on her, and the panel opens on that chat next time. */
  alert(chat) {
    this.unreadChat = chat ?? this.unreadChat
    this.dot = true
    this.#send()
  }

  /** Every socket frame; status frames change what she shows. */
  frame(text) {
    if (!this.statuses.apply(text)) return
    const mood = this.statuses.mood
    const counts = this.statuses.counts
    if (mood === this.mood && counts.working === this.counts.working && counts.finished === this.counts.finished) return
    if (mood === "needs-you" && this.mood !== mood) this.dot = true
    this.mood = mood
    this.counts = counts
    this.#send()
  }

  /** What the sticker page asks: a click, the start and end of a drag, or her menu. */
  command(name, args) {
    switch (name) {
      case "click":
        return this.toggle()
      case "drag":
        return this.#startDrag(Number(args.x) || 0, Number(args.y) || 0)
      case "drop":
        return this.#drop()
      case "menu":
        return this.#menu()
    }
  }

  toggle() {
    if (Date.now() - this.closedAt < REOPEN_GUARD) return
    if (this.panel?.isVisible()) this.collapse()
    else this.expand()
  }

  expand() {
    if (!this.sticker) return
    const panel = this.panel ?? this.#buildPanel()
    const [x, y] = this.sticker.getPosition()
    const area = screen.getDisplayMatching(this.sticker.getBounds()).workArea
    // She stays where you left her; the panel opens beside her, toward the roomier side.
    panel.setBounds(panelSpot(x, y, area))
    const chat = this.unreadChat
    this.unreadChat = null
    this.dot = false
    this.#send()
    const url = panel.webContents.getURL()
    if (!url || !this.options.opensInPortal(url)) panel.loadURL(this.options.portalUrl(chat))
    else if (chat) panel.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/c/${chat}`)}`).catch(() => {})
    panel.show()
    panel.focus()
    // Keep her above her own panel.
    this.sticker.moveTop()
  }

  collapse() {
    if (this.panel?.isVisible()) this.panel.hide()
  }

  /** The chat the panel shows, if it's on one. */
  panelChat() {
    const url = this.panel?.webContents.getURL() ?? ""
    return (url.match(/#\/c\/([\w.-]+)/) || [])[1] || null
  }

  /** The portal moved (signed out, a new address): the panel starts over next time. */
  reset() {
    this.panel?.destroy()
    this.panel = null
  }

  #build() {
    this.sticker = new BrowserWindow({
      width: STICKER.width,
      height: STICKER.height,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#00000000",
      ...(MAC ? { type: "panel" } : {}),
      webPreferences: { preload: this.options.preload, sandbox: true, contextIsolation: true },
    })
    this.#floatEverywhere(this.sticker)
    this.sticker.loadFile(this.options.page)
    this.sticker.webContents.on("did-finish-load", () => this.#send())
    // Every display change (a screen unplugged, a resolution change) keeps her on a screen.
    for (const event of ["display-removed", "display-metrics-changed"]) screen.on(event, () => this.sticker?.isVisible() && this.#place())
  }

  #buildPanel() {
    const panel = new BrowserWindow({
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      backgroundColor: "#00000000",
      ...(MAC ? { type: "panel" } : {}),
      webPreferences: { preload: this.options.panelPreload, sandbox: true, contextIsolation: true },
    })
    this.#floatEverywhere(panel)
    const page = panel.webContents
    page.setUserAgent(this.options.userAgent)
    const route = (event, url) => {
      if (this.options.opensInPortal(url)) {
        if (new URL(url).pathname !== "/desktop/sign-in") return
        event.preventDefault()
        this.collapse()
        return void this.options.signIn()
      }
      event.preventDefault()
      this.collapse()
      this.options.openLink(url)
    }
    page.on("will-navigate", event => route(event, event.url))
    page.setWindowOpenHandler(({ url, disposition }) => {
      if (toSystemBrowser(url, disposition, this.options.opensInPortal)) {
        this.options.openExternally(url)
        return { action: "deny" }
      }
      route({ preventDefault() {} }, url)
      return { action: "deny" }
    })
    page.on("dom-ready", () => page.insertCSS(ROUNDED).catch(() => {}))
    page.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault()
        this.collapse()
      }
    })
    // A click anywhere else puts the panel away, like tapping outside it on the phone.
    panel.on("blur", () => {
      if (!panel.isVisible()) return
      this.closedAt = Date.now()
      panel.hide()
    })
    this.panel = panel
    return panel
  }

  #floatEverywhere(window) {
    if (MAC) window.setAlwaysOnTop(true, "floating")
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }

  #areas() {
    const primary = screen.getPrimaryDisplay()
    return [primary, ...screen.getAllDisplays().filter(d => d.id !== primary.id)].map(d => d.workArea)
  }

  #place() {
    const { x, y } = rest(this.spot ?? this.options.saved(), this.#areas())
    this.spot = { x, y }
    this.sticker.setBounds({ x, y, ...STICKER })
  }

  #startDrag(grabX, grabY) {
    this.#stopDrag()
    this.collapse()
    // Follows the pointer from the app's side: the page's own pointer positions jump around as its
    // window moves under them, and across screens with different scaling.
    this.dragTimer = setInterval(() => {
      const point = screen.getCursorScreenPoint()
      this.sticker?.setBounds({ x: Math.round(point.x - grabX), y: Math.round(point.y - grabY), ...STICKER })
    }, 16)
  }

  #stopDrag() {
    clearInterval(this.dragTimer)
    this.dragTimer = null
  }

  #drop() {
    this.#stopDrag()
    if (!this.sticker) return
    const [x, y] = this.sticker.getPosition()
    // She stays where she's let go, only pulled back if part of her hangs off the screen.
    this.spot = inside(x, y, nearest(x, y, this.#areas()))
    this.sticker.setBounds({ ...this.spot, ...STICKER })
    this.options.keep(this.spot)
  }

  #menu() {
    Menu.buildFromTemplate([
      { label: "Open Nako", click: () => this.options.openInApp(null) },
      { label: "Put Nako away", click: () => this.options.putAway() },
      { type: "separator" },
      { label: "Quit", click: () => this.options.quit() },
    ]).popup({ window: this.sticker })
  }

  #send() {
    this.sticker?.webContents.send("nako-floating-state", { mood: this.mood, dot: this.dot, ...this.counts })
  }
}
