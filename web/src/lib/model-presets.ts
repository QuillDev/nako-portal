import { useEffect, useSyncExternalStore } from "react"
import { d, type Infer, type Decoder } from "@/lib/decode"
import { api } from "@/lib/api"
import { favorite, favoriteId, type ModelFavorite } from "@/lib/model-favorites"

const selection = d.object({ provider: d.string().min(1), model: d.string().min(1), effort: d.string(), speed: d.string() })
const preset = d.object({ id: d.string(), name: d.string().trim().min(1).max(40), icon: d.string().max(32), pick: selection })
export type ModelPreset = Infer<typeof preset>
const picks = d.object({ presets: d.array(d.unknown()), favorites: d.array(d.unknown()) })

// Presets and starred models live on the portal server, so every device shows the same ones.
let state: { presets: ModelPreset[]; favorites: ModelFavorite[] } = { presets: [], favorites: [] }
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null
let loadState: "pending" | "ready" | "failed" = "pending"

export const usePicksLoadState = () => useSyncExternalStore(subscribe, () => loadState)

function subscribe(update: () => void) {
  listeners.add(update)
  return () => { listeners.delete(update) }
}

function valid<T>(schema: Decoder<T>, entries: unknown[]) {
  return entries.flatMap(entry => {
    const parsed = schema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function apply(raw: unknown) {
  const parsed = picks.parse(raw)
  loadState = "ready"
  state = { presets: valid(preset, parsed.presets), favorites: valid(favorite, parsed.favorites) }
  listeners.forEach(update => update())
}

// Older builds kept presets and favorites in this browser only. Hand the server any it
// doesn't have yet, then drop the browser copy.
const LEGACY_PRESETS = "portal:model-presets"
const LEGACY_FAVORITES = "portal:model-favorites"
function legacy<T>(schema: Decoder<T>, key: string) {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(saved) ? valid(schema, saved) : []
  } catch {
    return []
  }
}

async function adoptLegacy() {
  const presets = legacy(preset, LEGACY_PRESETS).filter(item => !state.presets.some(saved => saved.id === item.id))
  const starred = new Set(state.favorites.map(favoriteId))
  const favorites = legacy(favorite, LEGACY_FAVORITES).filter(item => !starred.has(favoriteId(item)))
  for (const item of presets) await putModelPreset(item)
  for (const item of favorites) await toggleModelFavorite(item)
  localStorage.removeItem(LEGACY_PRESETS)
  localStorage.removeItem(LEGACY_FAVORITES)
}

// Read the saved picks again, e.g. when the picker opens after another device changed them.
export function refreshModelPicks() {
  loading ??= api<unknown>("/api/model-picks").then(apply).then(adoptLegacy).catch(() => {
    if (loadState !== "ready") { loadState = "failed"; listeners.forEach(update => update()) }
  }).finally(() => { loading = null })
  return loading
}

function useModelPicks() {
  useEffect(() => { void refreshModelPicks() }, [])
  return useSyncExternalStore(subscribe, () => state)
}

export function useModelPresets() {
  return useModelPicks().presets
}

export function useModelFavorites() {
  return useModelPicks().favorites
}

export async function putModelPreset(value: ModelPreset) {
  apply(await api<unknown>("/api/model-picks/presets", { method: "POST", body: preset.parse(value) }))
}

export async function removeModelPreset(id: string) {
  apply(await api<unknown>(`/api/model-picks/presets/${encodeURIComponent(id)}/remove`, { method: "POST" }))
}

export async function toggleModelFavorite(value: ModelFavorite) {
  apply(await api<unknown>("/api/model-picks/favorites", { method: "POST", body: value }))
}

export function presetMatches(preset: ModelPreset, value: { provider: string; model: string; effort?: string; speed?: string }) {
  const { pick } = preset
  return pick.provider === value.provider && pick.model === value.model &&
    pick.effort === (value.effort || "") && (pick.speed || "normal") === (value.speed || "normal")
}

export function presetDetails({ pick }: ModelPreset) {
  return [pick.model, pick.effort && `${pick.effort} effort`, pick.speed].filter(Boolean).join(" · ")
}
