import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import type { BackgroundProcess } from "@/lib/types"
import { since } from "./processes"

// How often an open log re-reads a running process.
const TAIL_MS = 2000

type Log = { lines: string[]; total_chars: number }

function useTail(session: string, proc: BackgroundProcess | null) {
  const [log, setLog] = useState<Log | null>(null)
  const [gone, setGone] = useState(false)
  // Keyed on id and state, not the object: the chat's list re-reads every few seconds.
  const id = proc?.id
  const running = proc?.running
  useEffect(() => {
    setLog(null)
    setGone(false)
    if (!id) return
    let live = true
    const read = () =>
      api<Log>(`/api/sessions/${session}/processes/${id}/log`)
        .then(l => live && setLog(l))
        .catch(() => live && setGone(true))
    read()
    const timer = running ? setInterval(read, TAIL_MS) : undefined
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [session, id, running])
  return { log, gone }
}

function state(p: BackgroundProcess) {
  const now = Date.now() / 1000
  if (p.running) return `running ${since(now - p.started_at)}`
  if (p.ended === "killed") return "stopped"
  if (p.exit_code) return `failed (${p.exit_code})`
  return p.exited_at ? `exited ${since(now - p.exited_at)} ago` : "exited"
}

// One background process's latest output, kept at the bottom as it grows.
export function ProcessLog({ session, proc, onClose }: { session: string; proc: BackgroundProcess | null; onClose: () => void }) {
  const { log, gone } = useTail(session, proc)
  const box = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(proc)}>
      {proc && (
        <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-2xl" data-process-log onOpenAutoFocus={e => e.preventDefault()}>
          <div className="flex min-w-0 flex-col gap-1 pr-8">
            <DialogTitle className="truncate font-medium text-sm leading-6">{proc.label}</DialogTitle>
            <p className="text-muted-foreground text-xs">
              {state(proc)}
              {proc.notify && proc.running && " · nako hears when it ends"}
              {proc.cwd && ` · ${proc.cwd}`}
            </p>
          </div>
          {proc.command !== proc.label && <p className="break-all text-muted-foreground text-xs">{proc.command}</p>}
          <pre
            className="min-h-40 flex-1 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed"
            onScroll={e => {
              const el = e.currentTarget
              pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
            }}
            ref={box}
          >
            {gone ? "this process is no longer tracked" : log ? log.lines.join("\n") || "no output yet" : ""}
          </pre>
        </DialogContent>
      )}
    </Dialog>
  )
}
