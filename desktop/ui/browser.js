// The in-app browser's toolbar. The shell calls window.nakoPane({url, title, active, tabs}) as
// the page changes and as tabs open and close; each chat has its own tabs.
const invoke = (command, args) => window.nakoDesktop.invoke(command, args)

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

window.nakoPane = ({ url, title, active, tabs }) => {
  shown = url || ""
  address.title = title && url ? `${title}\n${url}` : shown
  if (document.activeElement !== address) address.value = shown
  showTabs(tabs || [], active)
}

window.nakoFocusAddress = () => address.focus()

// A row of tabs under the toolbar, once there's more than one.
const strip = document.getElementById("tabs")
function showTabs(tabs, active) {
  strip.hidden = tabs.length < 2
  strip.replaceChildren(
    ...tabs.map(({ id, name }) => {
      const tab = document.createElement("div")
      tab.className = "tab"
      tab.title = name
      if (id === active) tab.setAttribute("aria-current", "page")
      const pick = document.createElement("button")
      pick.type = "button"
      pick.className = "name"
      pick.textContent = name
      pick.addEventListener("click", () => invoke("pane", { action: "select", target: String(id) }))
      tab.addEventListener("auxclick", event => {
        if (event.button === 1) invoke("pane", { action: "close-tab", target: String(id) })
      })
      const close = document.createElement("button")
      close.type = "button"
      close.className = "shut"
      close.setAttribute("aria-label", `Close ${name}`)
      close.innerHTML = '<svg viewBox="0 0 16 16"><path d="m5 5 6 6M11 5l-6 6" /></svg>'
      close.addEventListener("click", () => invoke("pane", { action: "close-tab", target: String(id) }))
      tab.append(pick, close)
      return tab
    }),
  )
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
