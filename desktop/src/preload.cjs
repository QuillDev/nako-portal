// Runs before every page the app shows itself (the connect page and the portal). It hands the page
// one way to ask the app for things; the app checks who's asking.
const { contextBridge, ipcRenderer } = require("electron")

const desktop = { invoke: (command, args) => ipcRenderer.invoke("nako", command, args ?? {}) }
contextBridge.exposeInMainWorld("nakoDesktop", desktop)
// Portal bundles from before this app ask the earlier (Tauri) app's way.
contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", desktop)

contextBridge.executeInMainWorld({
  func: controls => {
    // Windows and Linux: no system title bar, so pages draw minimize/maximize/close.
    if (controls) window.nakoWindow = { controls: true }
  },
  args: [process.platform !== "darwin"],
})
