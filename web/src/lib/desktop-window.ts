// The desktop app on Windows and Linux has no system title bar: it sets window.nakoWindow and
// lets the portal move, resize and close the window. Browsers and older apps never set it.
declare global {
  interface Window {
    nakoWindow?: { controls: boolean }
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
  }
}

export const hasWindowControls = Boolean(window.nakoWindow?.controls)

export function windowAction(action: "minimize" | "toggle_maximize" | "close") {
  void window.__TAURI_INTERNALS__?.invoke(`plugin:window|${action}`, { label: "main" })
}
