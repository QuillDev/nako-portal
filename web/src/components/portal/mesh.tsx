import { useEffect, useState } from "react"
import { LaptopIcon, MessageSquareIcon, MonitorIcon, PlusIcon, ServerIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import { navigate } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { health, type Health, loadMesh, machineKind, machineState, useMesh } from "@/lib/mesh"
import type { Machine } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PageHeader } from "./header"

const KIND_ICON = { laptop: LaptopIcon, desktop: MonitorIcon, server: ServerIcon }
const DOT: Record<Health, string> = { online: "bg-emerald-500", degraded: "bg-amber-500", offline: "bg-muted-foreground/40" }
const RING: Record<Health, string> = { online: "border-emerald-500/60", degraded: "border-amber-500/60", offline: "border-border border-dashed" }

// Where each machine sits around the hub, as percentages of the map: evenly on an ellipse, first at the top.
function spot(index: number, count: number) {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(count, 1)
  return { x: 50 + 36 * Math.cos(angle), y: 50 + 34 * Math.sin(angle) }
}

/** The hub in the middle, every machine around it, a line to each: solid when it's connected,
 * moving while it works, dashed while it's away. Calls between machines go through the hub. */
function MeshMap({ hubName, machines, selected, pick }: { hubName: string; machines: Machine[]; selected: string | null; pick: (name: string | null) => void }) {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-xl select-none sm:aspect-[4/3]">
      <svg aria-hidden className="absolute inset-0 size-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {machines.map((m, i) => {
          const { x, y } = spot(i, machines.length)
          const state = health(m)
          return (
            <line
              className={cn(
                state === "online" ? "stroke-emerald-500/60" : state === "degraded" ? "stroke-amber-500/60" : "stroke-muted-foreground/30",
                m.working > 0 && "mesh-flow",
              )}
              key={m.name}
              strokeDasharray={state === "offline" ? "4 5" : m.working > 0 ? "6 4" : undefined}
              strokeLinecap="round"
              strokeWidth={selected === m.name ? 2.5 : 1.5}
              vectorEffect="non-scaling-stroke"
              x1={50}
              x2={x}
              y1={50}
              y2={y}
            />
          )
        })}
      </svg>
      <button
        className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 flex flex-col items-center gap-1.5 outline-none"
        onClick={() => pick(null)}
        type="button"
      >
        <img alt="" className="size-14 rounded-full border-2 border-emerald-500/60 bg-card shadow-sm" src="/icon-192.png" />
        <span className="font-medium text-sm">{hubName}</span>
      </button>
      {machines.map((m, i) => {
        const { x, y } = spot(i, machines.length)
        const Icon = KIND_ICON[machineKind(m)]
        const state = health(m)
        return (
          <button
            aria-pressed={selected === m.name}
            className="group -translate-x-1/2 -translate-y-1/2 absolute flex w-28 flex-col items-center gap-1 outline-none"
            key={m.name}
            onClick={() => pick(selected === m.name ? null : m.name)}
            style={{ left: `${x}%`, top: `${y}%` }}
            type="button"
          >
            <span
              className={cn(
                "relative flex size-12 items-center justify-center rounded-full border-2 bg-card shadow-sm transition-colors group-hover:bg-accent group-aria-pressed:bg-accent",
                RING[state],
                state === "offline" && "text-muted-foreground",
              )}
            >
              <Icon className="size-5" />
              <span className={cn("absolute right-0 bottom-0 size-3 rounded-full border-2 border-background", DOT[state])} />
            </span>
            <span className="max-w-full truncate font-medium text-sm">{m.name}</span>
            <span className="max-w-full truncate text-muted-foreground text-xs">{machineState(m)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** One machine, picked on the map: what it is, its chats here, and removing it. */
function MachineCard({ machine, portal, close, onError }: { machine: Machine; portal: Portal; close: () => void; onError: (m: string) => void }) {
  const chats = portal.sessions.filter(s => s.machine === machine.name)
  const remove = async () => {
    if (!confirm(`Remove ${machine.name}? It disconnects now and needs a new setup line to come back.`)) return
    try {
      await api(`/api/mesh/machines/${encodeURIComponent(machine.name)}/remove`, { method: "POST" })
      close()
      await loadMesh()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            <span className={cn("size-2 rounded-full", DOT[health(machine)])} />
            {machine.name}
          </div>
          <div className="truncate text-muted-foreground text-xs">{[machine.hostname, machine.os].filter(Boolean).join(" · ") || "not connected yet"}</div>
        </div>
        <Button aria-label="Close" onClick={close} size="icon" variant="ghost">
          <XIcon />
        </Button>
      </div>
      {chats.length > 0 && (
        <div className="flex flex-col">
          {chats.map(s => (
            <button
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              key={s.id}
              onClick={() => navigate(`#/c/${s.id}`)}
              type="button"
            >
              <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {s.status === "working" && <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <Button className="text-destructive hover:text-destructive" onClick={remove} size="sm" variant="ghost">
          Remove machine
        </Button>
      </div>
    </div>
  )
}

const PLATFORMS = [
  { id: "mac", label: "macOS", line: "unix", where: "Terminal" },
  { id: "linux", label: "Linux", line: "unix", where: "a terminal" },
  { id: "windows", label: "Windows", line: "windows", where: "PowerShell" },
] as const
type PlatformId = (typeof PLATFORMS)[number]["id"]
type Lines = { unix: string; windows: string }

function savedPlatform(): PlatformId {
  const saved = localStorage.getItem("mesh:platform")
  return PLATFORMS.some(p => p.id === saved) ? (saved as PlatformId) : "mac"
}

/** Adding a machine: its name and OS, then the one line to paste in a terminal there. */
function AddMachine({ close, onError }: { close: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("")
  const [platform, setPlatform] = useState<PlatformId>(savedPlatform)
  const [lines, setLines] = useState<Lines | null>(null)
  const [copied, setCopied] = useState(false)
  const chosen = PLATFORMS.find(p => p.id === platform) ?? PLATFORMS[0]
  const pick = (id: PlatformId) => {
    setPlatform(id)
    setCopied(false)
    localStorage.setItem("mesh:platform", id)
  }
  const add = async () => {
    try {
      const made = await api<{ lines: Lines }>("/api/mesh/machines", { method: "POST", body: { name } })
      setLines(made.lines)
      await loadMesh()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const line = lines?.[chosen.line]
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{lines ? `Set up ${name}` : "Add a machine"}</span>
        <Button aria-label="Close" className="-my-1" onClick={close} size="icon" variant="ghost">
          <XIcon />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="radiogroup">
        {PLATFORMS.map(p => (
          <button
            aria-checked={platform === p.id}
            className="rounded-md py-1.5 text-muted-foreground text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm"
            key={p.id}
            onClick={() => pick(p.id)}
            role="radio"
            type="button"
          >
            {p.label}
          </button>
        ))}
      </div>
      {line === undefined ? (
        <form
          className="flex items-center gap-2"
          onSubmit={e => {
            e.preventDefault()
            if (name) void add()
          }}
        >
          <Input
            aria-label="Machine name"
            autoFocus
            className="h-9 flex-1"
            onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            placeholder="machine name, e.g. macbook"
            value={name}
          />
          <Button disabled={!name} type="submit">
            Get setup line
          </Button>
        </form>
      ) : (
        <>
          <p className="text-muted-foreground">Paste this in {chosen.where} on {name}. It installs Hermes if needed, has you sign in to a model once, then joins the mesh.</p>
          <p className="rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{line}</p>
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-muted-foreground text-xs">works for a day</span>
            <Button onClick={close} variant="ghost">
              Done
            </Button>
            <Button onClick={() => navigator.clipboard.writeText(line).then(() => setCopied(true), () => onError("couldn't copy"))} variant="outline">
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export function MeshPage({ portal }: { portal: Portal }) {
  const mesh = useMesh(portal.machinesSeen)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState("")
  // "seen 5m ago" keeps moving while the page is open.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])
  const machines = mesh?.machines ?? []
  const picked = machines.find(m => m.name === selected)
  return (
    <>
      <PageHeader title="Mesh">
        {mesh?.hub && !adding && (
          <Button
            onClick={() => {
              setAdding(true)
              setSelected(null)
            }}
            size="sm"
            variant="ghost"
          >
            <PlusIcon />
            Add machine
          </Button>
        )}
      </PageHeader>
      <section className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 overflow-y-auto px-4 pb-6">
        {mesh && !mesh.hub && <p className="py-10 text-center text-muted-foreground text-sm">This portal isn't a mesh hub.</p>}
        {mesh?.hub && (
          <>
            <MeshMap hubName={mesh.name ?? "hub"} machines={machines} pick={setSelected} selected={selected} />
            {machines.length === 0 && !adding && (
              <p className="text-center text-muted-foreground text-sm">No machines yet. Add one to hand it tasks from here.</p>
            )}
            {adding && <AddMachine close={() => setAdding(false)} onError={setError} />}
            {picked && <MachineCard close={() => setSelected(null)} machine={picked} onError={setError} portal={portal} />}
          </>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}
      </section>
    </>
  )
}
