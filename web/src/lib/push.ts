import { api, unb64url } from "./api"
import { desktopApp } from "./desktop-window"

// The Android app's own alerts (a native notification service), exposed by its shell.
type AppBridge = {
  notifications(): "on" | "off"
  openNotificationSettings(): void
  bubble?(): "on" | "off"
  setBubble?(on: boolean): void
}
const appBridge = (): AppBridge | undefined => (window as unknown as { NakoApp?: AppBridge }).NakoApp

/** Inside the Android app: "on"/"off" from the app, "app" from a shell too old to say. Else null. */
export function appAlerts(): "on" | "off" | "app" | null {
  const bridge = appBridge()
  if (bridge) return bridge.notifications()
  return /NakoAndroid\//.test(navigator.userAgent) ? "app" : null
}

export const openAppNotificationSettings = () => appBridge()?.openNotificationSettings()

// The desktop app's floating Nako: it says whether she's on, and takes the switch as a command.
const desktopFloating = () => (window as unknown as { nakoFloating?: { on: boolean } }).nakoFloating

/** Nako's floating sticker over other apps, in an Android or desktop app new enough to have one. Else null. */
export function appBubble(): "on" | "off" | null {
  const android = appBridge()?.bubble?.()
  if (android) return android
  const desktop = desktopFloating()
  return desktop ? (desktop.on ? "on" : "off") : null
}

export function setAppBubble(on: boolean) {
  const desktop = desktopFloating()
  if (!appBridge()?.setBubble && desktop) {
    desktop.on = on
    void desktopApp()?.invoke("floating", { on }).catch(() => {})
    return
  }
  appBridge()?.setBubble?.(on)
}

export function pushState(): "unsupported" | "on" | "blocked" | "off" {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported"
  if (Notification.permission === "granted") return "on"
  if (Notification.permission === "denied") return "blocked"
  return "off"
}

export async function enablePush() {
  const registration = await navigator.serviceWorker.ready
  const { key } = await api<{ key: string | null }>("/api/push/key")
  if (!key) throw new Error("notifications are not set up on the server")
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("notifications were not allowed")
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(key) })
  await api("/api/push/subscribe", { method: "POST", body: subscription.toJSON() })
}
