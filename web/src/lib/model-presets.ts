import { useSyncExternalStore } from "react"
import { z } from "zod"

const selection = z.object({ provider: z.string().min(1), model: z.string().min(1), effort: z.string(), speed: z.string() })
const preset = z.object({ id: z.string(), name: z.string().trim().min(1).max(40), icon: z.string().max(32), pick: selection })
export type ModelPreset = z.infer<typeof preset>
const key = "portal:model-presets"
const changed = "portal:model-presets-changed"

function subscribe(update: () => void) {
  window.addEventListener(changed, update)
  window.addEventListener("storage", update)
  return () => {
    window.removeEventListener(changed, update)
    window.removeEventListener("storage", update)
  }
}

let raw: string | null = null
let entries: ModelPreset[] = []
function read() {
  try {
    const saved = localStorage.getItem(key)
    if (saved !== raw) {
      const decoded: unknown = JSON.parse(saved ?? "[]")
      entries = Array.isArray(decoded) ? decoded.flatMap(item => {
        const parsed = preset.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }) : []
      raw = saved
    }
  } catch { /* Leave the last readable list in place. */ }
  return entries
}

export function useModelPresets() {
  return useSyncExternalStore(subscribe, read)
}

export function putModelPreset(value: ModelPreset) {
  const current = read()
  const next = preset.parse(value)
  write(current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [...current, next])
}

export function removeModelPreset(id: string) {
  write(read().filter(item => item.id !== id))
}

function write(next: ModelPreset[]) {
  localStorage.setItem(key, JSON.stringify(next))
  window.dispatchEvent(new Event(changed))
}

export function presetMatches(preset: ModelPreset, value: { provider: string; model: string; effort?: string; speed?: string }) {
  const { pick } = preset
  return pick.provider === value.provider && pick.model === value.model &&
    pick.effort === (value.effort || "") && (pick.speed || "normal") === (value.speed || "normal")
}

export function presetDetails({ pick }: ModelPreset) {
  return [pick.model, pick.effort && `${pick.effort} effort`, pick.speed].filter(Boolean).join(" · ")
}
