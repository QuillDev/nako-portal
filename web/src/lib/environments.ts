import { useEffect, useSyncExternalStore } from "react"
import { z } from "zod"
import { api } from "@/lib/api"

// What the owner's environments command reports (dashboard/portal/environments.py), shared by the
// sidebar row and the page.
const Link = z.object({ label: z.string(), url: z.string() })
const Environment = z.object({
  name: z.string(),
  status: z.enum(["running", "partial", "stopped"]),
  detail: z.string().optional(),
  session: z.string().optional(),
  links: z.array(Link),
})
export const Environments = z.object({ title: z.string(), environments: z.array(Environment), links: z.array(Link) })
export type Environment = z.infer<typeof Environment>
export type Environments = z.infer<typeof Environments>

export const STATUS_DOT: Record<Environment["status"], string> = {
  running: "bg-emerald-500",
  partial: "bg-amber-500",
  stopped: "bg-muted-foreground/40",
}

type State = { data: Environments | null; error: string }

let current: State = { data: null, error: "" }
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

function set(next: State) {
  current = next
  for (const listener of listeners) listener()
}

export function loadEnvironments(): Promise<void> {
  loading ??= api<unknown>("/api/environments")
    .then(
      raw => set({ data: Environments.parse(raw), error: "" }),
      (error: unknown) => set({ data: current.data, error: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => {
      loading = null
    })
  return loading
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
