// The app's own first screen: ask for the portal's address, or say it can't be reached.
const { invoke } = window.nakoDesktop
const $ = id => document.getElementById(id)

function ask(origin, error) {
  $("unreachable").hidden = true
  $("ask").hidden = false
  $("message").textContent = error || "Portal address"
  $("message").className = error ? "error" : ""
  if (origin && !$("address").value) $("address").value = origin
  $("address").focus()
}

function unreachable(origin, error) {
  $("ask").hidden = true
  $("unreachable").hidden = false
  $("reason").textContent = error
  $("retry").onclick = () => connect(origin)
  $("change").onclick = () => ask(origin)
}

async function connect(address) {
  for (const button of document.querySelectorAll("main button")) button.disabled = true
  try {
    await invoke("connect", { address })
  } catch (error) {
    if ($("unreachable").hidden) ask(null, String(error))
    else unreachable(address, String(error))
  } finally {
    for (const button of document.querySelectorAll("main button")) button.disabled = false
  }
}

$("ask").addEventListener("submit", event => {
  event.preventDefault()
  connect($("address").value)
})

if (window.nakoWindow?.controls) {
  $("titlebar").hidden = false
  for (const button of document.querySelectorAll("[data-window]")) {
    button.onclick = () => invoke(`plugin:window|${button.dataset.window}`, { label: "main" })
  }
}

const change = new URLSearchParams(location.search).has("change")
const state = await invoke("start", { change })
document.querySelector("main").hidden = state.kind === "open"
if (state.kind === "ask") ask(state.origin)
if (state.kind === "unreachable") unreachable(state.origin, state.error)
