import { useEffect, useSyncExternalStore } from "react"
import { d, type Infer } from "@/lib/decode"
import { api } from "@/lib/api"

// What the owner's environments command reports (dashboard/portal/environments.py), shared by the
// sidebar row and the page.
const Link = d.object({ label: d.string(), url: d.string() })
const Environment = d.object({
  name: d.string(),
  status: d.enum(["running", "partial", "stopped"]),
  detail: d.string().optional(),
  session: d.string().optional(),
  memory: d.number().optional(),
  links: d.array(Link),
})
export const Environments = d.object({
  title: d.string(),
  environments: d.array(Environment),
  links: d.array(Link),
  can_stop: d.boolean().default(false),
})
export type Environment = Infer<typeof Environment>
export type Environments = Infer<typeof Environments>

export const STATUS_DOT: Record<Environment["status"], string> = {
  running: "bg-emerald-500",
  partial: "bg-amber-500",
  stopped: "bg-muted-foreground/40",
}

type State = {
  data: Environments | null
  error: string
  stopping: ReadonlySet<string>
  stopErrors: Readonly<Record<string, string>>
}

let current: State = { data: null, error: "", stopping: new Set(), stopErrors: {} }
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null
let fetchSeq = 0

function set(next: State) {
  current = next
  for (const listener of listeners) listener()
}

export function loadEnvironments(fresh = false): Promise<void> {
  if (!fresh && loading) return loading
  const seq = ++fetchSeq
  const promise = api<unknown>("/api/environments")
    .then(
      raw => {
        if (seq < fetchSeq) return
        const data = Environments.parse(raw)
        const live = new Set(data.environments.filter(env => env.status !== "stopped").map(env => env.name))
        const stopErrors = Object.fromEntries(Object.entries(current.stopErrors).filter(([name]) => live.has(name)))
        set({ ...current, data, error: "", stopErrors })
      },
      (error: unknown) => {
        if (seq < fetchSeq) return
        set({ ...current, error: error instanceof Error ? error.message : String(error) })
      },
    )
    .finally(() => {
      if (loading === promise) loading = null
    })
  loading = promise
  return promise
}

/** Run the owner's stop command for one environment in the background, then refresh the list. */
export async function stopEnvironment(name: string): Promise<void> {
  if (current.stopping.has(name)) return
  const next = new Set(current.stopping)
  next.add(name)
  const { [name]: _, ...restErrors } = current.stopErrors
  set({ ...current, stopping: next, stopErrors: restErrors })
  try {
    await api(`/api/environments/${encodeURIComponent(name)}/stop`, { method: "POST" })
    await loadEnvironments(true)
    while (loading) await loading
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    set({ ...current, stopErrors: { ...current.stopErrors, [name]: message } })
  } finally {
    const after = new Set(current.stopping)
    after.delete(name)
    set({ ...current, stopping: after })
  }
}

/** The last read, refreshed on mount and every `every` ms while something shows it. */
export function useEnvironments(enabled: boolean, every = 30_000): State {
  const state = useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
  useEffect(() => {
    if (!enabled) return
    void loadEnvironments()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadEnvironments()
    }, every)
    return () => clearInterval(timer)
  }, [enabled, every])
  return state
}
