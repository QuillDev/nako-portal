import type { Backends } from "@/lib/types"

/** Whether there's a choice of agent to show: one besides Python is connected or picked. */
export function showsBackends(state: Backends | null): state is Backends {
  return Boolean(state && (state.active !== "python" || state.backends.some(b => b.id !== "python" && b.connected)))
}
