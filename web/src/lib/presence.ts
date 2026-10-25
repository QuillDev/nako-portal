// Whether Nako's animated sticker shows what she's doing during a turn. On unless turned off here.
import { useSyncExternalStore } from "react"

const KEY = "presence"
const listeners = new Set<() => void>()

const stored = () => localStorage.getItem(KEY) !== "off"

export function setPresence(on: boolean) {
  if (on) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, "off")
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const usePresence = () => useSyncExternalStore(subscribe, stored)
