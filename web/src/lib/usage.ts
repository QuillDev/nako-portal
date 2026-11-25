import { useEffect, useState } from "react"
import { d, type Infer } from "@/lib/decode"
import { api, ApiError } from "@/lib/api"

const resetOption = d.object({
  id: d.string(),
  label: d.string(),
  available: d.number(),
  usable: d.boolean(),
  expires_at: d.string().nullable().optional(),
})
const resets = d.object({
  available: d.number(),
  usable: d.boolean(),
  account: d.string().optional(),
  options: d.array(resetOption).optional(),
})
const usage = d.object({
  providers: d.array(d.object({
    provider: d.string(),
    label: d.string(),
    accounts: d.array(d.object({
      label: d.string(),
      windows: d.array(d.object({ label: d.string(), used_percent: d.number(), resets_at: d.string().nullable() })),
      note: d.string().nullable(),
      resets: resets.optional(),
    })),
  })),
})
export type Usage = Infer<typeof usage>
// How much of each signed-in plan is used. "unsupported" when model-controls can't say, so Settings drops the page.
export function useUsage(onError: (message: string) => void) {
  const [state, setState] = useState<Usage | null | "unsupported" | "failed">(null)
  useEffect(() => {
    let active = true
    api<unknown>("/api/usage")
      .then(raw => active && setState(usage.parse(raw)))
      .catch(e => {
        if (!active) return
        if (e instanceof ApiError && e.status === 404) return setState("unsupported")
        setState("failed")
        onError(e instanceof Error ? e.message : String(e))
      })
    return () => { active = false }
  }, [onError])
  return [state, setState] as const
}

export async function redeemUsageReset(provider: string, account = "", force = true, grant = ""): Promise<Usage> {
  const body: Record<string, unknown> = { provider, account, force }
  if (grant) body.grant = grant
  const raw = await api<unknown>("/api/usage/reset", { method: "POST", body })
  return usage.parse(raw)
}

