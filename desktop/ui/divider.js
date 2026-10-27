// The divider between the portal and the in-app browser. Grabbing it makes this page cover the
// window, so only the line follows the pointer; letting go resizes the portal and the page once.
const invoke = (command, args) => window.nakoDesktop.invoke(command, args)
const strip = document.getElementById("strip")
const root = document.documentElement
const gap = document.getElementById("gap")
let drag = null

strip.addEventListener("pointerdown", async event => {
  if (event.button !== 0 || drag) return
  strip.setPointerCapture(event.pointerId)
  drag = { moved: null }
  const at = await invoke("pane_divider", { action: "start" }).catch(() => null)
  if (!at || !drag) return void (drag = null)
  Object.assign(drag, at)
  root.classList.add("dragging")
  gap.style.left = strip.style.left = `${at.x - 4}px`
  gap.hidden = false
})

strip.addEventListener("pointermove", event => {
  if (!drag?.least) return
  const x = Math.min(Math.max(event.clientX, drag.least), drag.most)
  drag.moved = x
  strip.style.left = `${x - 4}px`
})

async function release() {
  if (!drag) return
  const { moved } = drag
  drag = null
  await invoke("pane_divider", { action: "end", target: moved == null ? null : String(moved) }).catch(() => {})
  root.classList.remove("dragging")
  gap.hidden = true
  strip.style.left = ""
}

strip.addEventListener("pointerup", release)
strip.addEventListener("pointercancel", release)
strip.addEventListener("lostpointercapture", release)
