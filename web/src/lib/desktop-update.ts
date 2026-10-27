import { useSyncExternalStore } from "react"
import { desktopApp } from "./desktop-window"

/**
 * Where the desktop app's updating stands. Apps that update themselves set window.nakoUpdate on
 * every portal load and whenever it changes, and fire "nako-update"; browsers never set it.
 * Apps from before in-app checks set only `{ version }`, once an update is downloaded.
 */
export type UpdateStatus = {
  state: "idle" | "checking" | "latest" | "error" | "ready" | "installing"
  version?: string
  error?: string
  /** Homebrew is building it (macOS), which takes minutes. */
  brew?: boolean
}

declare global {
  interface Window {
    nakoUpdate?: Partial<UpdateStatus>
  }
}

const subscribe = (changed: () => void) => {
  window.addEventListener("nako-update", changed)
  return () => window.removeEventListener("nako-update", changed)
}

const snapshot = () => window.nakoUpdate ?? null

/** The app's update status; null in a browser or an app that doesn't update itself. */
export function useDesktopUpdate(): UpdateStatus | null {
  const status = useSyncExternalStore(subscribe, snapshot, () => null)
  if (!status) return null
  if (status.state) return status as UpdateStatus
  return status.version ? { state: "ready", version: status.version } : null
}

/** Whether the app takes checks from the page; older apps only announce a download. */
export const canCheck = () => Boolean(window.nakoUpdate?.state && desktopApp())

export function checkForUpdate() {
  desktopApp()?.invoke("update", { action: "check" }).catch(() => {})
}

/** The app shows that it's updating, installs the update and restarts. */
export function installDesktopUpdate() {
  if (canCheck()) desktopApp()?.invoke("update", { action: "install" }).catch(() => {})
  // Older apps catch this navigation instead.
  else window.location.assign("/desktop/update")
}

/** The installed desktop or Android app's version, from the agent the app tags; null in a browser. */
export const appVersion = navigator.userAgent.match(/Nako(?:Desktop|Android)\/(\d+\.\d+\.\d+)/)?.[1] ?? null
