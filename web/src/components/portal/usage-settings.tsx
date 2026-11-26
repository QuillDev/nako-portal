import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { ChevronsRightIcon, XIcon } from "lucide-react"
import { useDrawer } from "./drawer"
import { Skullet } from "@/components/ui/skeleton"
import { api } from "@/lib/api"
import type { Provider } from "@/lib/providers"
import { redeemUsageReset, type Usage } from "@/lib/usage"
import { ProviderMark } from "./provider-mark"
import { cn } from "@/lib/utils"

const SAMPLE_RESET = new Date(Date.now() + 3 * 3600_000).toISOString()
const SAMPLE_WEEK = new Date(Date.now() + 96 * 3600_000).toISOString()
const SAMPLE_USAGE: Usage = {
  providers: [
    {
      provider: "claude-subscription-directsdk-experimental",
      label: "Claude",
      accounts: [{
        label: "alex@example.test",
        note: null,
        windows: [
          { label: "Current session", used_percent: 24, resets_at: SAMPLE_RESET },
          { label: "Current week", used_percent: 42, resets_at: SAMPLE_WEEK },
        ],
      }],
    },
    {
      provider: "openai-codex",
      label: "ChatGPT / Codex",
      accounts: [{
        label: "alex@example.test",
        note: null,
        windows: [
          { label: "Current session", used_percent: 12, resets_at: SAMPLE_RESET },
          { label: "Current week", used_percent: 18, resets_at: SAMPLE_WEEK },
        ],
      }],
    },
  ],
}

type Account = Usage["providers"][number]["accounts"][number]
type Resets = NonNullable<Account["resets"]>
type Window = Account["windows"][number]

const dateFormat = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

const hour = 3600_000
function period(label: string) {
  const match = /^(?:(?!current\s)(.+?)\s+)?(current session|session|5[- ]?h(?:ours?)?|current week|weekly|week|7[- ]?d(?:ays?)?)$/i.exec(label.trim())
  if (!match) return null
  const weekly = /week|7/i.test(match[2])
  return { group: match[1] ?? "", label: weekly ? "Weekly" : "5-hour", length: weekly ? 168 * hour : 5 * hour }
}

const titles: Record<string, string> = {
  "openai-codex": "ChatGPT / Codex",
  "claude-subscription-directsdk-experimental": "Claude",
  "antigravity-oauth": "Google Antigravity",
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

// The reset date as shown, or null when the row has none.
function resetText(window: Window) {
  const reset = window.resets_at ? new Date(window.resets_at) : null
  return reset && !Number.isNaN(reset.getTime()) ? dateFormat.format(reset) : null
}

// A 5-hour row shows only its bar; a weekly row shows its reset unless a row above already said the same one.
function Limit({ window, label, length, now, showReset }: { window: Window; label: string; length: number; now: number; showReset: boolean }) {
  const used = Math.min(100, Math.max(0, window.used_percent))
  const full = used >= 100
  const weekly = length > 5 * hour
  const reset = showReset ? resetText(window) : null
  const estimate = full ? null : pace(window, used, now, length)
  const runout = weekly ? estimate?.runoutAt ?? null : null
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)_5rem] items-center gap-x-3 gap-y-1 text-sm" data-usage-window={window.label}>
      <span>{label}</span>
      <div className="relative" {...{ "skullet-block": "" }}>
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
      {(reset || runout != null) && (
        <div className={cn("col-span-full flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums", full ? "text-destructive" : "text-muted-foreground")}>
          {reset && <span>Resets {reset}</span>}
          {runout != null && <span>Est. runout {dateFormat.format(runout)}</span>}
        </div>
      )}
    </div>
  )
}

// A bottom sheet on phones, a centered panel on wider screens.
const PANEL = "gap-4 rounded-[22px] bg-card p-4 sm:max-w-[400px]"
const SHEET = "gap-4 top-auto bottom-0 max-w-full translate-y-0 rounded-[22px] rounded-b-none bg-card p-4 pb-[max(1.75rem,env(safe-area-inset-bottom))] data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom"

// Drag the knob to the end of the track to confirm; letting go early springs it back.
function SlideToConfirm({ label, disabled, onConfirm }: { label: string; disabled: boolean; onConfirm: () => void }) {
  const [offset, setOffset] = useState(0)
  const [drag, setDrag] = useState<{ start: number; max: number } | null>(null)
  const done = (max: number, at: number) => {
    setDrag(null)
    if (at >= max * 0.9) {
      setOffset(max)
      onConfirm()
    } else setOffset(0)
  }
  return (
    <div className={cn("relative h-12 select-none rounded-full bg-muted touch-none", disabled && "opacity-50")} data-usage-reset-slide>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pl-10 text-muted-foreground text-sm" style={{ opacity: drag ? 1 - offset / drag.max : 1 }}>{label}</span>
      <button
        aria-label={label}
        className={cn("absolute top-1 left-1 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm", !drag && "transition-transform")}
        disabled={disabled}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onConfirm() } }}
        onPointerDown={e => {
          const track = e.currentTarget.parentElement
          if (!track) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ start: e.clientX - offset, max: track.clientWidth - e.currentTarget.offsetWidth - 8 })
        }}
        onPointerMove={e => drag && setOffset(Math.min(drag.max, Math.max(0, e.clientX - drag.start)))}
        onPointerUp={() => drag && done(drag.max, offset)}
        onPointerCancel={() => { setDrag(null); setOffset(0) }}
        style={{ transform: `translateX(${offset}px)` }}
        type="button"
      >
        <ChevronsRightIcon className="size-5" />
      </button>
    </div>
  )
}

function ResetRow({ provider, targetLabel, resets, windows, maxUsed, onUpdate, onError }: {
  provider: string; targetLabel: string; resets: Resets; windows: Window[]; maxUsed: number;
  onUpdate: (next: Usage) => void; onError: (message: string) => void;
}) {
  const { phone } = useDrawer()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // A model's own reset is judged by that model's limit; anything else by the account's.
  const usedFor = (kind: string) => {
    const own = windows.find(w => w.scope === "model" && w.label.toLowerCase().startsWith(`${kind.toLowerCase()} `))
    return own ? Math.round(own.used_percent) : maxUsed
  }
  const items = (resets.options && resets.options.length > 0
    ? resets.options.map(option => {
        const kind = option.label.replace(/\s*reset$/i, "")
        const used = usedFor(kind)
        return { key: option.id, grant: option.id, available: option.available, usable: option.usable, kind,
                 note: used >= 100 ? null : `${kind.charAt(0).toUpperCase() + kind.slice(1)} is at ${used}% used. A reset now replaces what's left of it.` }
      })
    : [{ key: "default", grant: "", available: resets.available, usable: resets.usable, kind: "weekly",
         note: maxUsed >= 100
           ? "Your limits reset immediately and your new weekly window starts on your next request."
           : `You're at ${maxUsed}% used. A reset now replaces your remaining allowance and restarts your weekly window.` }]
  ).filter(item => item.available > 0)
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = items.find(item => item.key === picked && item.usable) ?? items.find(item => item.usable)
  const total = items.reduce((sum, item) => sum + item.available, 0)
  const summary = total === 0
    ? "No resets available"
    : `${items.map(item => `${item.available} ${item.kind}`).join(", ")} ${total === 1 ? "reset" : "resets"} available`

  const redeem = async () => {
    if (busy || !chosen) return
    setBusy(true)
    onError("")
    try {
      onUpdate(await redeemUsageReset(provider, resets.account ?? "", true, chosen.grant))
      setOpen(false)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 pt-1 text-xs" data-usage-resets={resets.available}>
      <span className="text-muted-foreground tabular-nums">{summary}</span>
      {items.length > 0 && (
        <Button size="sm" variant="outline" disabled={!chosen} onClick={() => { setPicked(null); setOpen(true) }}>Use reset</Button>
      )}
      <Dialog open={open} onOpenChange={next => !busy && setOpen(next)}>
        <DialogContent
          className={phone ? SHEET : PANEL}
          data-usage-reset-dialog
          // Start on the picked reset, never on the close button.
          onOpenAutoFocus={e => {
            e.preventDefault()
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>("[aria-checked=true]")?.focus()
          }}
          showCloseButton={false}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <DialogTitle className="font-medium text-base">Use a reset</DialogTitle>
              <DialogDescription className="break-words text-xs">{targetLabel}</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button aria-label="Close" className="rounded-full text-muted-foreground" size="icon-sm" variant="ghost"><XIcon /></Button>
            </DialogClose>
          </div>
          <div className="space-y-1.5" role="radiogroup" aria-label="Reset">
            {items.map(item => (
              <button
                aria-checked={chosen?.key === item.key}
                className={cn("flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left text-sm disabled:opacity-50",
                  chosen?.key === item.key ? "border-foreground/40 bg-muted" : "hover:bg-muted/60")}
                data-usage-reset-option={item.grant || undefined}
                disabled={!item.usable || busy}
                key={item.key}
                onClick={() => setPicked(item.key)}
                role="radio"
                type="button"
              >
                <span className="flex-1">{item.kind.charAt(0).toUpperCase() + item.kind.slice(1)} reset</span>
                <span className="text-muted-foreground text-xs tabular-nums">{item.available} available</span>
              </button>
            ))}
          </div>
          {chosen?.note && <p className="text-muted-foreground text-xs">{chosen.note}</p>}
          {phone
            ? <SlideToConfirm key={`${open}-${chosen?.key}`} label={busy ? "Resetting…" : "Slide to use reset"} disabled={!chosen || busy} onConfirm={() => void redeem()} />
            : <div className="flex justify-end gap-2">
                <DialogClose asChild><Button size="sm" variant="ghost" disabled={busy}>Cancel</Button></DialogClose>
                <Button size="sm" disabled={!chosen || busy} onClick={() => void redeem()}>{busy ? "Resetting…" : "Use reset"}</Button>
              </div>}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function UsageSettings({ state, providers, session, onUpdate, onError }: {
  state: Usage | null; providers: Provider[] | null; session?: string;
  onUpdate: (next: Usage) => void; onError: (message: string) => void;
}) {
  const [selection, setSelection] = useState<{ session?: string; provider: string } | null>(null)
  useEffect(() => {
    let active = true
    const path = session ? `/api/sessions/${encodeURIComponent(session)}/model` : "/api/model"
    api<{ provider: string }>(path).then(({ provider }) => { if (active) setSelection({ session, provider }) }).catch(() => {})
    return () => { active = false }
  }, [session])
  const active = selection?.session === session ? selection?.provider : undefined
  const now = Date.now()
  return (
    <Skullet data={state} id="settings-usage" label="Loading usage limits…" sample={SAMPLE_USAGE}>
      {data => {
        const sections = data.providers.flatMap(provider => {
          const identities = providers?.find(p => p.slug === provider.provider)?.accounts
          const title = Object.hasOwn(titles, provider.provider) ? titles[provider.provider] : provider.label
          const accounts = provider.accounts.flatMap((account, index) => {
            const groups = new Map<string, { window: Window; label: string; length: number }[]>()
            const shownResets = new Set<string>()
            const firstReset = (window: Window) => {
              const text = resetText(window)
              if (text === null || shownResets.has(text)) return false
              shownResets.add(text)
              return true
            }
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
            const maxUsed = Math.max(0, ...account.windows.filter(w => w.scope !== "model").map(w => Math.round(w.used_percent)))
            return <div key={account.label || index} className="space-y-3" data-usage-account={account.label}>
              {label && <p className="break-words font-medium text-sm">{label}</p>}
              {Array.from(groups, ([group, rows]) => <div className="space-y-3" key={group}>
                {group && <p className="font-medium text-sm">{group}</p>}
                {rows.sort((a, b) => a.length - b.length).map(row => <Limit key={row.window.label} {...row} now={now} showReset={row.length > 5 * hour && firstReset(row.window)} />)}
              </div>)}
              {account.resets && (
                <ResetRow
                  provider={provider.provider}
                  targetLabel={label ? `${title} (${label})` : title}
                  resets={{ ...account.resets, account: account.resets.account ?? account.label }}
                  windows={account.windows}
                  maxUsed={maxUsed}
                  onUpdate={onUpdate}
                  onError={onError}
                />
              )}
            </div>
          })
          if (!accounts.length) return []
          return [{ slug: provider.provider, view: <section key={provider.provider} data-usage-provider={provider.provider} className="space-y-4 border-b pb-5 last:border-0">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold text-lg">
              <ProviderMark slug={provider.provider} />
              {title}{provider.provider === active && <span className="font-normal text-muted-foreground text-xs">{session ? "This chat" : "Profile default"}</span>}
            </h2>
            {accounts}
          </section> }]
        })
        if (!sections.length) return <p className="text-muted-foreground text-sm">No five-hour or weekly limits reported.</p>
        return <div className="space-y-5">{sections.sort((a, b) => Number(b.slug === active) - Number(a.slug === active)).map(s => s.view)}</div>
      }}
    </Skullet>
  )
}
