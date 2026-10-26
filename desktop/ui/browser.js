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

// The address bar: shows where the page is, and takes an address or a search on Enter.
const address = document.getElementById("address")
let shown = ""

window.nakoPane = ({ url, title }) => {
  shown = url
  address.title = title ? `${title}\n${url}` : url
  if (document.activeElement !== address) address.value = url
}

document.getElementById("go").addEventListener("submit", event => {
  event.preventDefault()
  const target = address.value.trim()
  if (!target) return
  invoke("pane", { action: "go", target })
  address.blur()
})
// Clicking into the bar selects the whole address, like a browser's; the click's own mouseup
// would otherwise drop the selection and leave a caret mid-address.
let selecting = false
address.addEventListener("mousedown", () => (selecting = document.activeElement !== address))
address.addEventListener("mouseup", event => {
  if (selecting) event.preventDefault()
  selecting = false
})
address.addEventListener("focus", () => address.select())
address.addEventListener("keydown", event => {
  if (event.key !== "Escape") return
  address.value = shown
  address.blur()
})
address.addEventListener("blur", () => {
  if (address.value.trim() === "") address.value = shown
})

invoke("pane", { action: "status" })
