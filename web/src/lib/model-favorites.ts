import { z } from "zod"

const route = z.object({ provider: z.string().min(1), model: z.string().min(1) })
const preset = route.extend({ effort: z.string(), speed: z.string() })
export const favorite = z.union([preset, route])
export type ModelFavorite = z.infer<typeof favorite>

export function favoriteId(model: ModelFavorite) {
  return JSON.stringify([model.provider, model.model, ...("effort" in model ? [model.effort, model.speed] : [])])
}
