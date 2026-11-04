import { useEffect, useState } from "react"
import { z } from "zod"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"

const usage = z.object({
  providers: z.array(z.object({
    provider: z.string(),
    label: z.string(),
    accounts: z.array(z.object({
      label: z.string(),
      windows: z.array(z.object({ label: z.string(), used_percent: z.number(), resets_at: z.string().nullable() })),
      note: z.string().nullable(),
    })),
  })),
})
export type Usage = z.infer<typeof usage>
type Window = Usage["providers"][number]["accounts"][number]["windows"][number]

const resetFormat = new Intl.DateTimeFormat([], { weekday: "short", hour: "numeric", minute: "2-digit" })

function Limit({ window }: { window: Window }) {
  const used = Math.min(100, Math.max(0, window.used_percent))
  const full = used >= 100
  return (
    <div className="flex flex-col gap-1 text-sm" data-usage-window={window.label}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate">{window.label}</span>
        <span className={cn("shrink-0 tabular-nums", full ? "text-destructive" : "text-muted-foreground")}>
          {full && window.resets_at ? `resets ${resetFormat.format(new Date(window.resets_at))}` : `${Math.round(used)}%`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", full ? "bg-destructive" : "bg-primary")} style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

// How much of each signed-in plan is used. "unsupported" when model-controls can't say, so Settings drops the page.
export function useUsage(onError: (message: string) => void) {
  const [state, setState] = useState<Usage | null | "unsupported">(null)
  useEffect(() => {
    let active = true
    api<unknown>("/api/usage")
      .then(raw => active && setState(usage.parse(raw)))
      .catch(e => {
        if (!active) return
        if (e instanceof ApiError && e.status === 404) return setState("unsupported")
        onError(e instanceof Error ? e.message : String(e))
      })
    return () => { active = false }
  }, [onError])
  return state
}

// One block per account.
export function UsageSettings({ state }: { state: Usage | null }) {
  return state === null ? (
    <p className="text-muted-foreground text-sm">checking…</p>
  ) : state.providers.length === 0 ? (
    <p className="text-muted-foreground text-sm">no plan limits reported</p>
  ) : (
    state.providers.map(provider => (
      <div className="flex flex-col gap-3 py-1" data-usage-provider={provider.provider} key={provider.provider}>
        <p className="font-medium text-muted-foreground text-xs">{provider.label}</p>
        {provider.accounts.map((account, index) => (
          <div className="flex flex-col gap-2" data-usage-account={account.label} key={account.label || index}>
            {account.label && <p className="font-medium text-sm">{account.label}</p>}
            {account.windows.map(window => <Limit key={window.label} window={window} />)}
            {account.note && <p className="text-muted-foreground text-sm">{account.note}</p>}
          </div>
        ))}
      </div>
    ))
  )
}
