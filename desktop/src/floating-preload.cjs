// The floating Nako's sticker page: tells the app about presses and hears what she should show.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("nakoFloating", {
  invoke: (command, args) => ipcRenderer.invoke("nako-floating", command, args ?? {}),
  on: show => ipcRenderer.on("nako-floating-state", (_event, state) => show(state)),
})
