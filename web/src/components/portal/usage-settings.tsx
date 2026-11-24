import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { Provider } from "@/lib/providers"
import type { Usage } from "@/lib/usage"
import { UsageSkeleton } from "./usage-skeleton"
import { cn } from "@/lib/utils"

type Window = Usage["providers"][number]["accounts"][number]["windows"][number]

const dateFormat = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const hour = 3600_000
function period(label: string) {
  const match = /^(?:(?!current\s)(.+?)\s+)?(current session|session|5[- ]?h(?:ours?)?|current week|weekly|week|7[- ]?d(?:ays?)?)$/i.exec(label.trim())
  if (!match) return null
  const weekly = /week|7/i.test(match[2])
  return { group: match[1] ?? "", label: weekly ? "Weekly" : "5-hour", length: weekly ? 168 * hour : 5 * hour }
}

const brands: Record<string, [string, string]> = {
  "openai-codex": ["ChatGPT / Codex", "openai"],
  "claude-subscription-directsdk-experimental": ["Claude", "claude-color"],
  "antigravity-oauth": ["Google Antigravity", "antigravity-color"],
}

// Share of the window already gone and where usage lands at reset if it keeps the same rate (both 0-100).
function pace(window: Window, used: number, now: number, length: number) {
  const reset = window.resets_at ? Date.parse(window.resets_at) : NaN
  if (!Number.isFinite(reset) || reset <= now) return null
  const elapsed = Math.min(1, Math.max(0, 1 - (reset - now) / length))
  if (elapsed < 0.02) return null
  const projected = used / elapsed
  const runoutAt = projected > 100 ? reset - length * (1 - 100 / projected) : null
  return { elapsed: elapsed * 100, projected: Math.min(100, projected), runoutAt }
}

function Limit({ window, label, length, now }: { window: Window; label: string; length: number; now: number }) {
  const used = Math.min(100, Math.max(0, window.used_percent))
  const full = used >= 100
  const reset = window.resets_at ? new Date(window.resets_at) : null
  const estimate = full ? null : pace(window, used, now, length)
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_5rem] items-center gap-x-3 gap-y-1 text-sm" data-usage-window={window.label}>
      <span>{label}</span>
      <div className="relative">
        <div className="relative h-1 overflow-hidden rounded-full bg-muted">
          {estimate && estimate.projected > used && (
            <div className="absolute inset-y-0 bg-primary/30" title={`Projected at reset: ${Math.round(estimate.projected)}%`} data-usage-projected style={{ left: `${used}%`, width: `${estimate.projected - used}%` }} />
          )}
          <div className={cn("absolute inset-y-0 left-0 rounded-full", full ? "bg-destructive" : "bg-primary")} style={{ width: `${used}%` }} />
        </div>
        {estimate && (
          <div className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground/55" data-usage-elapsed style={{ left: `${estimate.elapsed}%` }} />
        )}
      </div>
      <span className={cn("text-right tabular-nums", full && "text-destructive")}>{Math.round(used)}% used</span>
      {reset && !Number.isNaN(reset.getTime()) && (
        <div className={cn("col-span-full flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums", full ? "text-destructive" : "text-muted-foreground")}>
          <span>Resets {dateFormat.format(reset)}</span>
          {estimate?.runoutAt != null && <span>Est. runout {dateFormat.format(estimate.runoutAt)}</span>}
        </div>
      )}
    </div>
  )
}

export function UsageSettings({ state, providers, session }: { state: Usage | null; providers: Provider[] | null; session?: string }) {
  const [selection, setSelection] = useState<{ session?: string; provider: string } | null>(null)
  useEffect(() => {
    let active = true
    const path = session ? `/api/sessions/${encodeURIComponent(session)}/model` : "/api/model"
    api<{ provider: string }>(path).then(({ provider }) => { if (active) setSelection({ session, provider }) }).catch(() => {})
    return () => { active = false }
  }, [session])
  const active = selection?.session === session ? selection?.provider : undefined
  const now = Date.now()
  if (!state) return <UsageSkeleton />
  const sections = state.providers.flatMap(provider => {
    const identities = providers?.find(p => p.slug === provider.provider)?.accounts
    const [title, mark] = brands[provider.provider] ?? [provider.label, null]
    const accounts = provider.accounts.flatMap((account, index) => {
      const groups = new Map<string, { window: Window; label: string; length: number }[]>()
      for (const window of account.windows) {
        const p = period(window.label)
        if (!p) continue
        const rows = groups.get(p.group) ?? []
        rows.push({ window, label: p.label, length: p.length })
        groups.set(p.group, rows)
      }
      if (!groups.size) return []
      const identity = identities?.find(a => a.id === account.label || a.label === account.label)
      const label = identity?.email || (/^(primary|secondary)$/i.test(account.label) ? `Account ${index + 1}` : account.label)
      return <div key={account.label || index} className="space-y-3" data-usage-account={account.label}>
        {label && <p className="break-words font-medium text-sm">{label}</p>}
        {Array.from(groups, ([group, rows]) => <div className="space-y-3" key={group}>
          {group && <p className="font-medium text-sm">{group}</p>}
          {rows.sort((a, b) => a.length - b.length).map(row => <Limit key={row.window.label} {...row} now={now} />)}
        </div>)}
      </div>
    })
    if (!accounts.length) return []
    return [{ slug: provider.provider, view: <section key={provider.provider} data-usage-provider={provider.provider} className="space-y-4 border-b pb-5 last:border-0">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold text-lg">
        {mark && <img alt="" className={cn("size-5 shrink-0", mark === "openai" && "dark:invert")} src={`/provider-marks/${mark}.svg`} />}
        {title}{provider.provider === active && <span className="font-normal text-muted-foreground text-xs">{session ? "This chat" : "Profile default"}</span>}
      </h2>
      {accounts}
    </section> }]
  })
  if (!sections.length) return <p className="text-muted-foreground text-sm">No five-hour or weekly limits reported.</p>
  return <div className="space-y-5">{sections.sort((a, b) => Number(b.slug === active) - Number(a.slug === active)).map(s => s.view)}</div>
}
