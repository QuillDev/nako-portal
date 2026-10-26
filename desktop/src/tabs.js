// Which tabs the in-app browser holds for each chat, and which one is on screen. No views here:
// pane.js builds, shows, freezes and drops them to match. `null` is everything that isn't a chat
// (the list, settings).

/** How many chats keep their pages loaded. Older chats keep only their tabs' addresses and load them again on return. */
export const LIVE_CHATS = 3

/** What the tab strip calls a tab: the page's title, else its host. */
export function tabName(tab) {
  const title = tab.title?.trim()
  if (title) return title
  try {
    return new URL(tab.url).host || "New tab"
  } catch {
    return "New tab"
  }
}

export class Tabs {
  #chats = new Map()
  #current = null
  #next = 0
  #clock = 0

  #chat() {
    let chat = this.#chats.get(this.#current)
    if (!chat) this.#chats.set(this.#current, (chat = { tabs: [], active: 0, open: false, used: 0 }))
    chat.used = ++this.#clock
    return chat
  }

  /** Moves to chat `to`; false when it's already the one on screen. */
  switch(to) {
    if (to === this.#current) return false
    this.#current = to
    this.#chat()
    return true
  }

  #push(url) {
    const chat = this.#chat()
    const tab = { id: ++this.#next, url, title: null, live: false }
    chat.tabs.push(tab)
    chat.active = chat.tabs.length - 1
    chat.open = true
    return tab.id
  }

  /** A link clicked in the chat: a new tab in this chat's browser, or the tab already showing it. */
  openLink(url) {
    const chat = this.#chat()
    const i = chat.tabs.findIndex(t => t.url === url)
    if (i < 0) return this.#push(url)
    chat.active = i
    chat.open = true
    return chat.tabs[i].id
  }

  newTab() {
    return this.#push(null)
  }

  select(id) {
    const chat = this.#chat()
    const i = chat.tabs.findIndex(t => t.id === id)
    if (i >= 0) chat.active = i
  }

  /** Closes tab `id` in the chat on screen; the browser closes with its last tab. */
  closeTab(id) {
    const chat = this.#chat()
    const i = chat.tabs.findIndex(t => t.id === id)
    if (i < 0) return false
    chat.tabs.splice(i, 1)
    if (i < chat.active || chat.active >= chat.tabs.length) chat.active = Math.max(0, chat.active - 1)
    if (!chat.tabs.length) chat.open = false
    return true
  }

  /** The header's browser button: puts this chat's browser away, or brings it back (with a new tab when it has none). */
  toggle() {
    const chat = this.#chat()
    if (!chat.tabs.length) this.newTab()
    else chat.open = !chat.open
  }

  /** Puts this chat's browser away, keeping its tabs. */
  hide() {
    this.#chat().open = false
  }

  get isOpen() {
    return this.shown() !== null
  }

  /** The tab on screen, if this chat's browser is open. */
  shown() {
    const chat = this.#chats.get(this.#current)
    return (chat?.open && chat.tabs[chat.active]) || null
  }

  /** This chat's tabs, for the tab strip. */
  strip() {
    return this.#chats.get(this.#current)?.tabs ?? []
  }

  tab(id) {
    for (const chat of this.#chats.values()) {
      const tab = chat.tabs.find(t => t.id === id)
      if (tab) return tab
    }
    return null
  }

  /** Unloads the pages of every chat but the `keep` most recently used (the one on screen always stays). Returns the tabs whose views should go. */
  discard(keep = LIVE_CHATS) {
    const loaded = [...this.#chats.entries()]
      .filter(([, chat]) => chat.tabs.some(t => t.live))
      .sort(([a, x], [b, y]) => (a === this.#current ? -1 : b === this.#current ? 1 : y.used - x.used))
    return loaded.slice(Math.max(1, keep)).flatMap(([, chat]) =>
      chat.tabs.filter(t => t.live).map(t => {
        t.live = false
        return t.id
      }),
    )
  }
}
