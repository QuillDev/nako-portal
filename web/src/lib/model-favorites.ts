import { d, type Infer } from "@/lib/decode"

const route = d.object({ provider: d.string().min(1), model: d.string().min(1) })
const preset = route.extend({ effort: d.string(), speed: d.string() })
export const favorite = d.union([preset, route])
export type ModelFavorite = Infer<typeof favorite>

export function favoriteId(model: ModelFavorite) {
  return JSON.stringify([model.provider, model.model, ...("effort" in model ? [model.effort, model.speed] : [])])
}
