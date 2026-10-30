// The floating Nako's panel: the portal in its compact mode (the page keys it off "NakoBubble/" in
// the user agent), with the two buttons its header calls, the same bridge the Android panel has.
const { contextBridge, ipcRenderer } = require("electron")

const ask = command => ipcRenderer.invoke("nako-panel", command).catch(() => {})
contextBridge.exposeInMainWorld("NakoBubble", { openInApp: () => ask("open_in_app"), close: () => ask("close") })
