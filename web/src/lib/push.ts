import { api, unb64url } from "./api"

// The Android app's own alerts (a native notification service), exposed by its shell.
type AppBridge = { notifications(): "on" | "off"; openNotificationSettings(): void }
const appBridge = (): AppBridge | undefined => (window as unknown as { NakoApp?: AppBridge }).NakoApp

/** Inside the Android app: "on"/"off" from the app, "app" from a shell too old to say. Else null. */
export function appAlerts(): "on" | "off" | "app" | null {
  const bridge = appBridge()
  if (bridge) return bridge.notifications()
  return /NakoAndroid\//.test(navigator.userAgent) ? "app" : null
}

export const openAppNotificationSettings = () => appBridge()?.openNotificationSettings()

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
