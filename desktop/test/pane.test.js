import assert from "node:assert/strict"
import { test } from "node:test"

import { BROWSER_PARTITION, restrictBrowserSession } from "../src/browser-session.js"
import { setPageVisibility } from "../src/page-visibility.js"

test("external sessions deny every permission request, check and device grant", () => {
  const handlers = {}
  const session = {
    setPermissionRequestHandler: handler => handlers.request = handler,
    setPermissionCheckHandler: handler => handlers.check = handler,
    setDevicePermissionHandler: handler => handlers.device = handler,
  }
  assert.equal(restrictBrowserSession(session), session)
  assert.equal(BROWSER_PARTITION, "persist:external-browser")
  for (const permission of ["media", "camera", "microphone", "geolocation", "notifications", "midi", "midiSysex", "clipboard-read", "clipboard-sanitized-write", "hid", "usb", "serial", "display-capture", "unknown-future-permission"]) {
    for (const origin of ["https://example.com", "https://portal.example", "file://", ""]) {
      let answer
      handlers.request(null, permission, value => answer = value, { requestingUrl: origin })
      assert.equal(answer, false, `${permission} at ${origin}`)
      assert.equal(handlers.check(null, permission, origin, {}), false)
      assert.equal(handlers.device({ deviceType: permission, origin }), false)
    }
  }
})

function page() {
  const commands = []
  const pauses = []
  let destroyed = false
  const view = {
    setVisible: visible => view.visible = visible,
    webContents: {
      isDestroyed: () => destroyed,
      executeJavaScript: () => new Promise((resolve, reject) => pauses.push({ resolve, reject })),
      debugger: {
        isAttached: () => true,
        sendCommand: async (_name, { state }) => commands.push(state),
      },
    },
  }
  return { view, commands, pauses, destroy: () => destroyed = true }
}

test("a quick hide/show cannot freeze the visible tab when media pausing finishes late", async () => {
  const { view, commands, pauses } = page()
  const hiding = setPageVisibility(view, false)
  await setPageVisibility(view, true)
  pauses[0].resolve()
  await hiding
  assert.equal(view.visible, true)
  assert.deepEqual(commands, ["active"])
})

test("only the latest hide can freeze a tab, even when earlier pauses fail", async () => {
  const { view, commands, pauses, destroy } = page()
  const first = setPageVisibility(view, false)
  await setPageVisibility(view, true)
  const second = setPageVisibility(view, false)
  pauses[1].resolve()
  await second
  pauses[0].reject(new Error("navigation interrupted media pause"))
  await first
  assert.deepEqual(commands, ["active", "frozen"])
  const last = setPageVisibility(view, false)
  destroy()
  pauses[2].resolve()
  await last
  assert.deepEqual(commands, ["active", "frozen"], "destroyed pages are ignored")
})
