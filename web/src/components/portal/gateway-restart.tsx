import { useEffect, useState } from "react"
import { Skullet } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"

type Thread = { title: string; turn?: string; tool?: string; status?: string }
type View = { phase: string; online: boolean; work: Thread[]; threads: Record<string, Thread>; error?: string }
const path = "/api/gateway/restart"
const SAMPLE_VIEW: View = { phase: "idle", online: true, work: [], threads: {} }

export function GatewayRestart() {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const result = await api<View>(path); if (active) setView(result) }
      catch (e) { if (active) setError((e as Error).message) }
      if (active) timer = setTimeout(refresh, 1800)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [])
  const act = async (action: string, turn?: string) => {
    if (action === "pause-all" && !window.confirm("Pause all active portal threads and resume them after restart?")) return
    setBusy(true); setError("")
    try { setView(await api<View>(path, { method: "POST", body: { action, turn } })) }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const renderBody = (v: View | null) => {
    const waiting = v?.phase === "waiting"
    const rows = v ? [...v.work.filter(r => !r.turn || !v.threads[r.turn]), ...Object.values(v.threads)] : []
    return <div className="space-y-4">
      <div role="status">{!v ? "Status unavailable" : ({waiting: "Waiting for active threads", restarting: "Restarting gateway…", resuming: "Gateway back online · Resuming threads…", done: "Gateway back online", failed: "Restart needs attention"}[v.phase] ?? (v.online ? "Gateway online" : "Gateway offline"))}</div>
      <div className="flex min-h-8 flex-wrap gap-2">{v && ["idle", "done", "failed"].includes(v.phase) && <Button disabled={busy || !v.online} onClick={() => act("start")}>Start restart</Button>}
        {waiting && v?.work.some(r => r.turn && !v.threads[r.turn]) && <Button disabled={busy} onClick={() => act("pause-all")}>Pause all &amp; restart</Button>}
        {waiting && !Object.keys(v!.threads).length && <Button variant="outline" disabled={busy} onClick={() => act("cancel")}>Cancel restart</Button>}</div>
      {rows.map((r, i) => <div key={r.turn ?? i} className="flex items-center justify-between gap-3 border-t py-2"><div className="min-w-0 break-words">{r.title}<div className="text-xs text-muted-foreground">{r.status ?? r.tool ?? "Working"}</div></div>
        {waiting && r.turn && !r.status && <Button variant="outline" size="sm" disabled={busy} onClick={() => act("pause", r.turn)}>Pause &amp; resume</Button>}</div>)}
    </div>
  }
  return <section className="space-y-4 pt-3 text-sm"><h2 className="text-lg font-semibold">Restart gateway</h2>
    <Skullet id="settings-gateway" label="Loading gateway status…" loading={!view && !error}>
      {renderBody(view ?? (error ? null : SAMPLE_VIEW))}
    </Skullet>
    {(error || view?.error) && <p role="alert">{error || view?.error}</p>}
  </section>
}
