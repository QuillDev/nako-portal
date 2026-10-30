// The floating Nako: drag her anywhere, click her for the panel, right-click for her menu.
const SLOP = 4
const nako = document.getElementById("nako")
const img = nako.querySelector("img")
const dot = document.getElementById("dot")
const app = window.nakoFloating

app.on(state => {
  const src = state.mood === "working" ? "floating/working.webp" : "floating/idle.png"
  if (!img.src.endsWith(src)) img.src = src
  dot.hidden = !state.dot
})

let press = null

nako.addEventListener("pointerdown", event => {
  if (event.button !== 0) return
  nako.setPointerCapture(event.pointerId)
  press = { x: event.screenX, y: event.screenY, grabX: event.clientX, grabY: event.clientY, moving: false }
})

nako.addEventListener("pointermove", event => {
  if (!press || press.moving) return
  if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < SLOP) return
  press.moving = true
  // The app moves the window with the pointer from here on, keeping this spot under it.
  app.invoke("drag", { x: press.grabX, y: press.grabY })
})

const release = () => {
  if (!press) return
  app.invoke(press.moving ? "drop" : "click")
  press = null
}
nako.addEventListener("pointerup", release)
nako.addEventListener("pointercancel", release)
nako.addEventListener("contextmenu", event => {
  event.preventDefault()
  app.invoke("menu")
})
nako.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") app.invoke("click")
})
