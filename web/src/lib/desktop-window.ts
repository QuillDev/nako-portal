import { useSyncExternalStore } from "react"

type DesktopBridge = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

/** How the page asks the desktop app for things; undefined in a browser. */
export const desktopApp = () => window.nakoDesktop ?? window.__TAURI_INTERNALS__

// The desktop app on Windows and Linux has no system title bar: it sets window.nakoWindow and
// lets the portal move, resize and close the window. Browsers and older apps never set it.
declare global {
  interface Window {
    nakoWindow?: { controls: boolean }
    nakoDesktop?: DesktopBridge
    /** The earlier (Tauri) desktop app's bridge, until every install has updated. */
    __TAURI_INTERNALS__?: DesktopBridge
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
  void desktopApp()?.invoke(`plugin:window|${action}`, { label: "main" })
}
