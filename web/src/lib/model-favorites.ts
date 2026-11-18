import { z } from "zod"

const route = z.object({ provider: z.string().min(1), model: z.string().min(1) })
const preset = route.extend({ effort: z.string(), speed: z.string() })
const favorite = z.union([preset, route])
export type ModelFavorite = z.infer<typeof favorite>
const key = "portal:model-favorites"

export function favoriteId(model: ModelFavorite) {
  return JSON.stringify([model.provider, model.model, ...("effort" in model ? [model.effort, model.speed] : [])])
}

export function readModelFavorites(): ModelFavorite[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "[]")
    return Array.isArray(saved) ? saved.flatMap(entry => {
      const result = favorite.safeParse(entry)
      return result.success ? [result.data] : []
    }) : []
  } catch {
    return []
  }
}

export function toggleModelFavorite(model: ModelFavorite) {
  const favorites = readModelFavorites()
  const id = favoriteId(model)
  const next = favorites.some(entry => favoriteId(entry) === id)
    ? favorites.filter(entry => favoriteId(entry) !== id)
    : [...favorites, model]
  localStorage.setItem(key, JSON.stringify(next))
  return next
}
