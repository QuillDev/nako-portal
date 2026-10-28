import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api } from "@/lib/api"
import type { BackgroundProcess } from "@/lib/types"
import { ProcessLog } from "./process-log"

// How often an open chat re-reads its processes; also how often uptimes move.
const REFRESH_MS = 10_000

export function since(seconds: number) {
  const m = Math.floor(seconds / 60)
  if (m < 1) return "<1m"
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// The chat's background processes: read on open, when a turn starts or ends, and on a timer while it's open.
function useProcesses(session: string, running: boolean) {
  const [procs, setProcs] = useState<BackgroundProcess[]>([])
  useEffect(() => {
    let live = true
    const read = () =>
      api<BackgroundProcess[]>(`/api/sessions/${session}/processes`)
        .then(p => live && setProcs(p))
        .catch(() => {})
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [session, running])
  return procs
}

// A quiet "● 2" in the chat header while the chat has background processes running. It opens a
// list of them, and each opens its latest output.
export function Processes({ session, running }: { session: string; running: boolean }) {
  const procs = useProcesses(session, running)
  const [shown, setShown] = useState<string | null>(null)
  const busy = procs.filter(p => p.running).length
  const now = Date.now() / 1000
  if (!busy) return null
  return (
    <>
      <ProcessLog onClose={() => setShown(null)} proc={procs.find(p => p.id === shown) ?? null} session={session} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label={`${busy} running in the background`} className="gap-1.5 px-2.5 text-muted-foreground text-xs" data-processes size="sm" variant="ghost">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            {busy}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1rem))] p-1.5 pt-2">
          <p className="px-2 pb-1 text-muted-foreground text-xs">{busy} running in the background</p>
          {procs.map(p => (
            <DropdownMenuItem className="gap-3 text-xs" key={p.id} onSelect={() => setShown(p.id)} title={p.command}>
              <span className={`min-w-0 flex-1 truncate ${p.running ? "" : "text-muted-foreground"}`}>{p.label}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{p.running ? since(now - p.started_at) : p.exit_code ? `failed (${p.exit_code})` : "exited"}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
