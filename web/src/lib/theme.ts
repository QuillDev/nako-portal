// Light, dark, or follow the device. public/theme.js applies the same choice before first paint.
import { useSyncExternalStore } from "react"

export type Theme = "system" | "light" | "dark"

const KEY = "theme"
const LIGHT = "(prefers-color-scheme: light)"
const listeners = new Set<() => void>()

function stored(): Theme {
  const value = localStorage.getItem(KEY)
  return value === "light" || value === "dark" ? value : "system"
}

function apply() {
  const theme = stored()
  const light = theme === "light" || (theme === "system" && matchMedia(LIGHT).matches)
  const root = document.documentElement
  root.classList.toggle("light", light)
  root.classList.toggle("dark", !light)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#fbfbfc" : "#09090b")
}

matchMedia(LIGHT).addEventListener("change", apply)

export function setTheme(theme: Theme) {
  if (theme === "system") localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, theme)
  apply()
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useTheme = () => useSyncExternalStore(subscribe, stored)
