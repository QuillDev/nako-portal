import { useSyncExternalStore } from "react"

// The desktop app on Windows and Linux has no system title bar: it sets window.nakoWindow and
// lets the portal move, resize and close the window. Browsers and older apps never set it.
declare global {
  interface Window {
    nakoWindow?: { controls: boolean }
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
  }
}

// While the app's in-app browser is open, its toolbar holds the window buttons: the app sets
// controls to false and fires "nako-window", and back again when the browser closes.
const subscribe = (changed: () => void) => {
  window.addEventListener("nako-window", changed)
  return () => window.removeEventListener("nako-window", changed)
}

const controls = () => Boolean(window.nakoWindow?.controls)

export function useWindowControls() {
  return useSyncExternalStore(subscribe, controls, () => false)
}

export function windowAction(action: "minimize" | "toggle_maximize" | "close") {
  void window.__TAURI_INTERNALS__?.invoke(`plugin:window|${action}`, { label: "main" })
}
