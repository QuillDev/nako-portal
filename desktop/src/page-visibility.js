const generations = new WeakMap()
const PAUSE_MEDIA = "document.querySelectorAll('video, audio').forEach(m => m.pause())"

function lifecycle(view, state) {
  const page = view.webContents
  if (page.isDestroyed()) return
  try {
    if (!page.debugger.isAttached()) page.debugger.attach("1.3")
    page.debugger.sendCommand("Page.setWebLifecycleState", { state }).catch(() => {})
  } catch {}
}

/** A late media-pause completion must not freeze a page shown again in the meantime. */
export async function setPageVisibility(view, visible) {
  const generation = (generations.get(view) ?? 0) + 1
  generations.set(view, generation)
  view.setVisible(visible)
  if (visible) return lifecycle(view, "active")
  try {
    await view.webContents.executeJavaScript(PAUSE_MEDIA)
  } catch {}
  if (generations.get(view) === generation) lifecycle(view, "frozen")
}
