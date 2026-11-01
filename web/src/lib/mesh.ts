import { useEffect, useSyncExternalStore } from "react"
import { api } from "@/lib/api"
import type { Machine, Mesh } from "@/lib/types"

// The mesh as this portal last read it, shared by the sidebar row and the Mesh page.
let current: Mesh | null = null
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

export function loadMesh(): Promise<void> {
  loading ??= api<Mesh>("/api/mesh")
    .then(
      mesh => {
        current = mesh
        for (const listener of listeners) listener()
      },
      () => {},
    )
    .finally(() => {
      loading = null
    })
  return loading
}

/** The mesh, reread whenever `seen` changes (the socket's `machines.changed`). Null until the first read. */
export function useMesh(seen: number): Mesh | null {
  const mesh = useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
  useEffect(() => void loadMesh(), [seen])
  return mesh
}

export type MachineKind = "laptop" | "desktop" | "server"

/** What a machine looks like on the map, from its OS. */
export function machineKind(m: Machine): MachineKind {
  const os = (m.os ?? "").toLowerCase()
  if (os.startsWith("darwin")) return "laptop"
  if (os.startsWith("windows")) return "desktop"
  return "server"
}

export function ago(seconds: number) {
  const s = Math.max(0, Date.now() / 1000 - seconds)
  if (s < 90) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function machineState(m: Machine) {
  if (!m.online) return m.last_seen ? `seen ${ago(m.last_seen)}` : "never connected"
  if (!m.gateway) return "hermes offline"
  return m.working ? `working on ${m.working}` : "online"
}

export type Health = "online" | "degraded" | "offline"

export function health(m: Machine): Health {
  return m.online ? (m.gateway ? "online" : "degraded") : "offline"
}
