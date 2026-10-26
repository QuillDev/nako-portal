// Runs before every page the app shows itself (the connect page, the portal, the browser's
// toolbar). It hands the page one way to ask the app for things; the app checks who's asking.
const { contextBridge, ipcRenderer } = require("electron")

const desktop = { invoke: (command, args) => ipcRenderer.invoke("nako", command, args ?? {}) }
contextBridge.exposeInMainWorld("nakoDesktop", desktop)
// Portal bundles from before this app ask the earlier (Tauri) app's way.
contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", desktop)

contextBridge.executeInMainWorld({
  func: controls => {
    // Windows and Linux: no system title bar, so pages draw minimize/maximize/close.
    if (controls) window.nakoWindow = { controls: true }
    // The in-app browser: per-chat tabs the chat header can open, searching with Settings' engine.
    window.nakoBrowser = { search: true, toggle: true, open: false }
    // Reports the chat on screen, so the browser shows that chat's tabs.
    let last
    const send = () => {
      if (!/^https?:/.test(location.protocol)) return
      const chat = (location.hash.match(/^#\/c\/([\w.-]+)/) || [])[1] || null
      if (chat === last) return
      last = chat
      window.nakoDesktop.invoke("pane_chat", { chat }).catch(() => {})
    }
    addEventListener("hashchange", send)
    addEventListener("DOMContentLoaded", send)
  },
  args: [process.platform !== "darwin"],
})
