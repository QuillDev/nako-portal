import { useEffect, useSyncExternalStore } from "react"
import { d, type Infer } from "@/lib/decode"
import { api } from "@/lib/api"

// Memory and CPU use of the machine the portal runs on (dashboard/portal/machine_load.py).
export const MachineLoad = d.object({
  memory: d.object({ used: d.number(), total: d.number(), percent: d.number() }),
  cpu: d.object({ percent: d.number().nullable() }),
  warn_at: d.number(),
})
export type MachineLoad = Infer<typeof MachineLoad>

// Past this, the warning turns from amber to red.
export const CRITICAL_AT = 90

let current: MachineLoad | null = null
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= api<unknown>("/api/machine-load")
    .then(
      raw => {
        current = MachineLoad.parse(raw)
        for (const listener of listeners) listener()
      },
      () => {},
    )
    .finally(() => {
      loading = null
    })
  return loading
}

/** The latest reading, refreshed every `every` ms while the page is visible. */
export function useMachineLoad(enabled: boolean, every = 15_000): MachineLoad | null {
  const state = useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
  useEffect(() => {
    if (!enabled) return
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load()
    }, every)
    const visible = () => document.visibilityState === "visible" && void load()
    document.addEventListener("visibilitychange", visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [enabled, every])
  return enabled ? state : null
}

/** The higher of memory and CPU when it's at or past the warning line, else null. */
export function loadWarning(load: MachineLoad | null): { label: string; percent: number } | null {
  if (!load) return null
  const memory = { label: "RAM", percent: load.memory.percent }
  const cpu = { label: "CPU", percent: load.cpu.percent ?? 0 }
  const high = cpu.percent > memory.percent ? cpu : memory
  return high.percent >= load.warn_at ? high : null
}

export function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
