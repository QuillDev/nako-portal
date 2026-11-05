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

const resetFormat = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

// Window length from its label ("Current week", "Weekly", "Opus week", "Current session"); null when unknown.
function windowLength(label: string) {
  if (/week/i.test(label)) return 7 * 24 * 3600_000
  if (/session/i.test(label)) return 5 * 3600_000
  return null
}

// Share of the window already gone and where usage lands at reset if it keeps the same rate (both 0-100).
function pace(window: Window, used: number, now: number) {
  const length = windowLength(window.label)
  const reset = window.resets_at ? Date.parse(window.resets_at) : NaN
  if (length === null || !Number.isFinite(reset)) return null
  const elapsed = Math.min(1, Math.max(0, 1 - (reset - now) / length))
  if (elapsed < 0.02) return null
  return { elapsed: elapsed * 100, projected: Math.min(100, used / elapsed) }
}

function Limit({ window, now }: { window: Window; now: number }) {
  const used = Math.min(100, Math.max(0, window.used_percent))
  const full = used >= 100
  const reset = window.resets_at ? new Date(window.resets_at) : null
  const estimate = full ? null : pace(window, used, now)
  return (
    <div className="flex flex-col gap-1 text-sm" data-usage-window={window.label}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate">{window.label}</span>
        <span className={cn("shrink-0 tabular-nums", full ? "text-destructive" : "text-muted-foreground")}>{Math.round(used)}%</span>
      </div>
      <div className="relative">
        <div className="relative h-1 overflow-hidden rounded-full bg-muted">
          {estimate && estimate.projected > used && (
            <div className="absolute inset-y-0 bg-primary/30" data-usage-projected style={{ left: `${used}%`, width: `${estimate.projected - used}%` }} />
          )}
          <div className={cn("absolute inset-y-0 left-0 rounded-full", full ? "bg-destructive" : "bg-primary")} style={{ width: `${used}%` }} />
        </div>
        {estimate && (
          <div className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground/55" data-usage-elapsed style={{ left: `${estimate.elapsed}%` }} />
        )}
      </div>
      {reset && !Number.isNaN(reset.getTime()) && (
        <span className={cn("text-xs tabular-nums", full ? "text-destructive" : "text-muted-foreground")}>Resets {resetFormat.format(reset)}</span>
      )}
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
  const now = Date.now()
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
            {account.windows.map(window => <Limit key={window.label} now={now} window={window} />)}
            {account.note && <p className="text-muted-foreground text-sm">{account.note}</p>}
          </div>
        ))}
      </div>
    ))
  )
}
