// Elsewhere: sessions that came in another way (Slack, Discord, cron, the CLI), latest first.
// Each opens read-only; the portal only watches them.
import { useCallback, useEffect, useRef, useState } from "react"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { sourceName } from "@/lib/outside"
import { age, timeOf } from "@/lib/times"
import type { OutsideRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useDrawer } from "./drawer"
import { LoadingRows } from "./screen-loading"
import { PageHeader } from "./header"
import { appendPage, isCurrentRequest } from "@/lib/portal-state"

// What the server sends a page of; a shorter page is the last one.
const PAGE = 50

// "9:41 AM" today, "Yesterday", "Fri" this week, else "Nov 10"; the same days the list's labels count.
function when(at: number) {
  const label = age(at)
  if (label === "today") return timeOf(at)
  if (label === "yesterday") return "Yesterday"
  return new Date(at * 1000).toLocaleDateString([], label === "this week" ? { weekday: "short" } : { month: "short", day: "numeric" })
}

function query(source: string | null, offset: number) {
  const params = new URLSearchParams()
  if (source) params.set("source", source)
  if (offset) params.set("offset", String(offset))
  const text = params.toString()
  return `/api/outside${text ? `?${text}` : ""}`
}

export function Elsewhere({ portal }: { portal: Portal }) {
  const { go } = useDrawer()
  const { sources, running } = portal.outside
  const [source, setSource] = useState<string | null>(null)
  const [rows, setRows] = useState<OutsideRow[] | null>(null)
  const [more, setMore] = useState(false)
  const loading = useRef(false)
  const generation = useRef({ request: 0, turn: 0 })
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<{ message: string; page: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const end = useRef<HTMLDivElement>(null)
  const shown = source && sources.includes(source) ? source : null

  // The first page again (on open, on a filter, when something starts or stops running), keeping
  // any later pages already loaded below it.
  const runningKey = running.join(" ")
  useEffect(() => {
    const ticket = { ...generation.current, request: ++generation.current.request }
    const valid = () => isCurrentRequest(ticket, generation.current)
    loading.current = true
    setPending(true)
    setError(null)
    api<OutsideRow[]>(query(shown, 0)).then(
      page => {
        if (!valid()) return
        setRows(old => {
          const kept = old && old.length > PAGE ? old.slice(PAGE).filter(r => !shown || r.source === shown) : []
          return appendPage(page, kept)
        })
        setMore(page.length === PAGE)
      },
      e => { if (valid()) setError({ message: (e as Error).message, page: false }) },
    ).finally(() => {
      if (!valid()) return
      loading.current = false
      setPending(false)
    })
    return () => { generation.current.request += 1 }
  }, [shown, runningKey, retry])

  const loadMore = useCallback(async () => {
    if (loading.current || !rows || !more) return
    const ticket = { ...generation.current }
    const valid = () => isCurrentRequest(ticket, generation.current)
    loading.current = true
    setPending(true)
    setError(null)
    try {
      const page = await api<OutsideRow[]>(query(shown, rows.length))
      if (!valid()) return
      setRows(old => appendPage(old || [], page))
      setMore(page.length === PAGE)
    } catch (e) {
      if (valid()) setError({ message: (e as Error).message, page: true })
    } finally {
      if (valid()) {
        loading.current = false
        setPending(false)
      }
    }
  }, [rows, shown, more])

  // The next page loads as the end of the list scrolls into view.
  useEffect(() => {
    const el = end.current
    if (!el || !more || pending || error) return
    const observer = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && loadMore(), { rootMargin: "400px" })
    observer.observe(el)
    return () => observer.disconnect()
  }, [more, loadMore, pending, error])

  const pick = (next: string | null) => {
    if (next === shown) return
    generation.current.request += 1
    setError(null)
    setPending(true)
    setRows(null)
    setMore(false)
    setSource(next)
  }

  const live = new Set(running)
  let bucket = ""
  return (
    <>
      <PageHeader title="Elsewhere" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-2 pb-6 md:px-4">
          <div className="min-h-10">{sources.length > 1 && (
            <div className="flex overflow-x-auto gap-1.5 px-2 pt-1 pb-2">
              {[null, ...sources].map(s => (
                <button
                  aria-pressed={shown === s}
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 text-muted-foreground text-xs hover:text-foreground",
                    shown === s && "border-input bg-accent text-foreground",
                  )}
                  key={s ?? ""}
                  onClick={() => pick(s)}
                  type="button"
                >
                  {s ? sourceName(s) : "All"}
                </button>
              ))}
            </div>
          )}</div>
          {pending && !rows && <div aria-hidden="true" className="h-8" />}
          {rows?.length === 0 && <p className="px-2 py-1 text-muted-foreground text-xs">nothing here yet</p>}
          {rows?.map(row => {
            const label = age(row.last_active)
            const head = label !== bucket
            bucket = label
            return (
              <div key={row.id}>
                {head && <p className="px-2 pt-3 pb-1 text-muted-foreground text-xs">{label}</p>}
                <button
                  className="flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => go(`#/c/${row.id}`)}
                  onFocus={() => portal.prefetch(row.id)}
                  onPointerDown={() => portal.prefetch(row.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate">{row.title}</span>
                  <span className="w-16 shrink-0 truncate text-muted-foreground text-xs">{sourceName(row.source)}</span>
                  <span className="w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{when(row.last_active)}</span>
                  <span className={cn("size-2 shrink-0 rounded-full", live.has(row.id) && "animate-pulse bg-primary")} title={live.has(row.id) ? "working" : undefined} />
                </button>
              </div>
            )
          })}
          {pending && (!rows || more) && <LoadingRows label="Loading sessions…" columns count={rows ? 2 : 6} />}
          {error && <div className="flex items-center gap-2 px-2 py-2 text-sm" role="alert">
            <span>{error.message}</span>
            <button className="underline" type="button" onClick={() => error.page ? void loadMore() : setRetry(n => n + 1)}>Retry</button>
          </div>}
          <div aria-hidden ref={end} />
        </div>
      </div>
    </>
  )
}
