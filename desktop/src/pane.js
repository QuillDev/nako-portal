// The in-app browser: links from the portal open in a pane on the right of the window, a toolbar
// (the app's own `ui/browser.html`) over the page. The portal keeps the rest of the window.
//
// Every chat has a browser of its own, with tabs (tabs.js). Each tab is a view of its own; only the
// one on screen is shown, the rest are hidden and frozen, and chats left a while ago are unloaded.
import { WebContentsView } from "electron"

import { addressOrSearch, isEngine } from "./address.js"
import { DEFAULT_SHARE, DIVIDER_WIDTH, dragRange, shareFor, split } from "./layout.js"
import { LIVE_CHATS, Tabs, tabName } from "./tabs.js"

const BAR_HEIGHT = 40
/** The row of tabs under the toolbar, shown once a chat has more than one. */
const STRIP_HEIGHT = 32
/** What the toolbar is told: the tab on screen and this chat's tab strip. */
export function status(shown, strip) {
  return {
    url: shown?.url ?? null,
    title: shown?.title ?? null,
    active: shown?.id ?? null,
    tabs: strip.map(t => ({ id: t.id, name: tabName(t) })),
  }
}

const PAUSE_MEDIA = "document.querySelectorAll('video, audio').forEach(m => m.pause())"

export class Pane {
  tabs = new Tabs()
  /** Tab id → its view. */
  views = new Map()
  bar = null
  /** The strip between the portal and the pane; covers the whole window while it's dragged. */
  divider = null
  dragging = false
  /** The tab last put on screen. */
  visible = null
  engine = "google"

  /**
   * `window` holds the views, `portal` is the portal's view, `opensInPortal(url)` says whether a
   * link belongs to the portal, `toPortal(url)` / `external(url)` send links there or to the
   * system, `barPreload` is the toolbar's preload, `changed()` runs after every change.
   */
  /**
   * `share` is how much of the window the pane takes (from the last drag) and `keepShare(share)`
   * saves a new one; `dividerPage` is the divider's page.
   */
  constructor({ window, portal, opensInPortal, toPortal, external, barPage, barPreload, dividerPage, userAgent, share, keepShare, changed }) {
    Object.assign(this, { window, portal, opensInPortal, toPortal, external, barPage, barPreload, dividerPage, userAgent, keepShare, changed })
    this.share = Number.isFinite(share) ? share : DEFAULT_SHARE
  }

  get isOpen() {
    return this.tabs.isOpen
  }

  /** The portal moved to another chat (or off chats): the browser beside it follows. */
  chat(id) {
    if (this.tabs.switch(id ?? null)) this.sync()
  }

  /** A link clicked in the chat: a new tab in this chat's browser, or the tab already showing it. */
  open(url) {
    this.tabs.openLink(url)
    this.sync()
  }

  /** The chat header's browser button. */
  toggle() {
    this.tabs.toggle()
    this.sync()
    this.#focusAddressIfBlank()
  }

  /** Puts the browser away; its tabs stay for when it comes back. */
  close() {
    this.tabs.hide()
    this.sync()
    this.portal.webContents.focus()
  }

  search(engine) {
    if (isEngine(engine)) this.engine = engine
  }

  /**
   * The divider: `start` when it's grabbed (it then covers the window, so only the line moves
   * while dragging), `end` with where it was let go, which resizes the portal and the page once.
   */
  drag(action, target) {
    const { width } = this.window.getContentBounds()
    if (action === "start") {
      if (!this.divider || !this.#shownView()) return null
      this.dragging = true
      this.layout()
      const [, x] = split(width, true, this.share)
      const [least, most] = dragRange(width)
      return { x: x - DIVIDER_WIDTH / 2, least, most }
    }
    if (action !== "end" || !this.dragging) return null
    this.dragging = false
    const x = Number(target)
    if (Number.isFinite(x)) {
      this.share = shareFor(width, x)
      this.keepShare(this.share)
    }
    this.layout()
    return null
  }

  /** The toolbar's buttons and tabs. */
  action(action, target) {
    const id = Number(target)
    switch (action) {
      case "new":
        this.tabs.newTab()
        this.sync()
        this.#focusAddressIfBlank()
        return
      case "select":
        this.tabs.select(id)
        this.sync()
        return
      case "close-tab":
        if (this.tabs.closeTab(id)) {
          this.#drop(id)
          this.sync()
        }
        return
      case "close":
        this.close()
        return
      case "status":
        this.#report()
        return
    }
    const page = this.#shownView()?.webContents
    if (!page) return
    switch (action) {
      case "back":
        if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack()
        break
      case "forward":
        if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward()
        break
      case "reload":
        page.reload()
        break
      case "external": {
        const url = page.getURL()
        if (/^https?:/.test(url)) this.external(url)
        break
      }
      case "go": {
        const url = addressOrSearch(target, this.engine)
        if (url) page.loadURL(url)
        break
      }
    }
  }

  #shownView() {
    const shown = this.tabs.shown()
    return shown ? this.views.get(shown.id) : null
  }

  #drop(id) {
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    this.window.contentView.removeChildView(view)
    view.webContents.close()
    if (this.visible === id) this.visible = null
  }

  /** Builds, shows, freezes and drops views to match the tabs. */
  sync() {
    for (const id of this.tabs.discard(LIVE_CHATS)) this.#drop(id)
    const shown = this.tabs.shown()
    if (shown) {
      this.#ensureBar()
      if (!this.views.has(shown.id)) this.views.set(shown.id, this.#page(shown))
      shown.live = true
    }
    const before = this.visible
    this.visible = shown?.id ?? null
    for (const [id, view] of this.views) {
      if (id === this.visible) {
        view.setVisible(true)
        thaw(view)
      } else if (id === before) {
        view.setVisible(false)
        freeze(view)
      }
    }
    this.bar?.setVisible(Boolean(shown))
    this.layout()
    this.#report()
    this.changed()
  }

  #ensureBar() {
    if (this.bar) return
    this.bar = new WebContentsView({ webPreferences: { preload: this.barPreload, sandbox: true, contextIsolation: true } })
    this.bar.setBackgroundColor("#09090b")
    this.window.contentView.addChildView(this.bar)
    this.bar.webContents.loadFile(this.barPage)
    this.divider = new WebContentsView({ webPreferences: { preload: this.barPreload, sandbox: true, contextIsolation: true } })
    // Clear, so the window shows through while it covers everything during a drag.
    this.divider.setBackgroundColor("#00000000")
    this.window.contentView.addChildView(this.divider)
    this.divider.webContents.loadFile(this.dividerPage)
  }

  /** A view for `tab`, loading its address (a new tab starts blank). */
  #page(tab) {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    view.setBackgroundColor("#ffffff")
    const page = view.webContents
    page.setUserAgent(this.userAgent)
    page.on("will-navigate", event => {
      if (!this.#staysInPane(event.url)) event.preventDefault()
    })
    // Pages that open a window (target=_blank, window.open) get a new tab.
    page.setWindowOpenHandler(({ url }) => {
      if (this.#staysInPane(url)) setImmediate(() => this.open(url))
      return { action: "deny" }
    })
    const remember = title => this.#remember(tab.id, page.getURL(), title)
    page.on("did-navigate", () => remember(null))
    page.on("did-navigate-in-page", (_event, _url, mainFrame) => mainFrame && remember(null))
    page.on("page-title-updated", (_event, title) => remember(title))
    page.on("render-process-gone", () => {
      // A crashed page closes its tab's view; coming back to it loads it again.
      this.#drop(tab.id)
      const crashed = this.tabs.tab(tab.id)
      if (crashed) crashed.live = false
      this.sync()
    })
    this.window.contentView.addChildView(view)
    // The divider stays on top of every page, for when it's dragged across one.
    if (this.divider) this.window.contentView.addChildView(this.divider)
    view.setVisible(false)
    page.loadURL(tab.url ?? "about:blank")
    return view
  }

  /** Web pages browse on in the pane; the portal's own pages go back to the portal, and anything that isn't a web page goes to the system. */
  #staysInPane(url) {
    if (url.startsWith("about:")) return true
    if (this.opensInPortal(url)) {
      this.toPortal(url)
      return false
    }
    if (!/^https?:/i.test(url)) {
      this.external(url)
      return false
    }
    return true
  }

  /** Keeps a tab's address and title as its page moves on, for the strip and for reloading it after it was unloaded. */
  #remember(id, url, title) {
    const tab = this.tabs.tab(id)
    // A new tab's blank page has no address worth keeping.
    if (!tab || !url || url.startsWith("about:")) return
    if (url !== tab.url && title == null) tab.title = null
    tab.url = url
    if (title != null) tab.title = title
    this.#report()
  }

  #report() {
    if (!this.bar) return
    const detail = JSON.stringify(status(this.tabs.shown(), this.tabs.strip()))
    this.bar.webContents.executeJavaScript(`window.nakoPane && window.nakoPane(${detail})`).catch(() => {})
    this.layout()
  }

  #focusAddressIfBlank() {
    const shown = this.tabs.shown()
    if (!shown || shown.url || !this.bar) return
    this.bar.webContents.focus()
    this.bar.webContents.executeJavaScript("window.nakoFocusAddress && window.nakoFocusAddress()").catch(() => {})
  }

  /** Puts the portal and the pane where `split` says, for the window's current size. */
  layout() {
    const { width, height } = this.window.getContentBounds()
    // Mid-drag only the divider's line moves; everything resizes once it's let go.
    if (this.dragging) {
      this.divider.setBounds({ x: 0, y: 0, width, height })
      return
    }
    const shown = this.#shownView()
    const [portalWidth, x, paneWidth] = split(width, Boolean(shown), this.share)
    const bar = this.tabs.strip().length > 1 ? BAR_HEIGHT + STRIP_HEIGHT : BAR_HEIGHT
    this.portal.setBounds({ x: 0, y: 0, width: portalWidth, height })
    this.portal.setVisible(portalWidth > 0)
    if (shown) {
      this.bar.setBounds({ x, y: 0, width: paneWidth, height: bar })
      shown.setBounds({ x, y: bar, width: paneWidth, height: Math.max(0, height - bar) })
    }
    const side = Boolean(shown) && portalWidth > 0
    this.divider?.setVisible(side)
    if (side) this.divider.setBounds({ x: portalWidth, y: 0, width: DIVIDER_WIDTH, height })
  }

  /** Drops every page, for when the portal changes. */
  reset() {
    for (const id of [...this.views.keys()]) this.#drop(id)
    this.tabs = new Tabs()
    this.sync()
  }
}

// A tab out of sight stops: its videos pause and Chromium freezes the page (no scripts, no timers)
// until it's shown again.
function lifecycle(view, state) {
  const page = view.webContents
  if (page.isDestroyed()) return
  try {
    if (!page.debugger.isAttached()) page.debugger.attach("1.3")
    page.debugger.sendCommand("Page.setWebLifecycleState", { state }).catch(() => {})
  } catch {}
}

function freeze(view) {
  view.webContents
    .executeJavaScript(PAUSE_MEDIA)
    .catch(() => {})
    .finally(() => lifecycle(view, "frozen"))
}

function thaw(view) {
  lifecycle(view, "active")
}
