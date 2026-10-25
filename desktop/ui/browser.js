// The in-app browser's toolbar. The shell calls window.nakoPane({url, title}) as the page changes.
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)

document.querySelectorAll("[data-pane]").forEach(button =>
  button.addEventListener("click", () => invoke("pane", { action: button.dataset.pane })),
)

// Windows and Linux: the window has no system title bar, and the pane's toolbar sits where its
// buttons belong.
if (window.nakoWindow?.controls) {
  document.getElementById("window").hidden = false
  document.querySelectorAll("[data-window]").forEach(button =>
    button.addEventListener("click", () => invoke(`plugin:window|${button.dataset.window}`, { label: "main" })),
  )
}

const host = document.getElementById("host")
const path = document.getElementById("path")
const address = document.getElementById("address")

window.nakoPane = ({ url, title }) => {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  host.textContent = parsed.host
  path.textContent = parsed.pathname === "/" && !parsed.search ? "" : parsed.pathname + parsed.search
  address.title = title ? `${title}\n${url}` : url
}

invoke("pane", { action: "status" })
