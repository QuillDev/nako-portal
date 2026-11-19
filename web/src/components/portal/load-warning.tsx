import { CpuIcon, MemoryStickIcon, type LucideIcon } from "lucide-react"
import { useState } from "react"
import { Popover } from "radix-ui"
import { Button } from "@/components/ui/button"
import { STATUS_DOT, useEnvironments } from "@/lib/environments"
import { CRITICAL_AT, gigabytes, loadWarning, type MachineLoad, useMachineLoad } from "@/lib/machine-load"
import type { Me } from "@/lib/types"
import { cn } from "@/lib/utils"

// How many of the biggest environments the popover lists.
const BIGGEST = 4

function tone(percent: number, warnAt: number) {
  return percent >= CRITICAL_AT ? "critical" : percent >= warnAt ? "warn" : "ok"
}

function Meter({ icon: Icon, label, value, percent, warnAt }: { icon: LucideIcon; label: string; value: string; percent: number; warnAt: number }) {
  const level = tone(percent, warnAt)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <Icon className="size-3.5 text-muted-foreground" />
        <span>{label}</span>
        <span className="ml-auto text-muted-foreground text-xs tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", level === "critical" ? "bg-destructive" : level === "warn" ? "bg-amber-500" : "bg-muted-foreground")}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  )
}

function Details({ load, me, open, go }: { load: MachineLoad; me: Me | null; open: boolean; go: (hash: string) => void }) {
  const { data } = useEnvironments(open && Boolean(me?.environments), 10_000)
  const biggest = (data?.environments ?? [])
    .filter(env => env.status !== "stopped" && env.memory !== undefined)
    .sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0))
    .slice(0, BIGGEST)
  return (
    <div className="flex flex-col gap-3">
      <Meter
        icon={MemoryStickIcon}
        label="Memory"
        percent={load.memory.percent}
        value={`${Math.round(load.memory.used / 1024 ** 3)} / ${Math.round(load.memory.total / 1024 ** 3)} GB`}
        warnAt={load.warn_at}
      />
      {load.cpu.percent !== null && (
        <Meter icon={CpuIcon} label="CPU" percent={load.cpu.percent} value={`${load.cpu.percent}%`} warnAt={load.warn_at} />
      )}
      {biggest.length > 0 && (
        <div className="flex flex-col">
          <p className="pb-0.5 text-muted-foreground text-xs">Using the most</p>
          {biggest.map(env => (
            <div className="flex items-center gap-2 py-1 text-sm" key={env.name}>
              <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[env.status])} />
              <span className="min-w-0 flex-1 truncate">{env.name}</span>
              <span className="text-muted-foreground text-xs tabular-nums">{gigabytes(env.memory ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      {me?.environments && data && (
        <Button className="w-full" onClick={() => go("#/settings/environments")} size="sm" variant="outline">
          Open {data.title.toLowerCase()}
        </Button>
      )}
    </div>
  )
}

/** A small pill by Settings while memory or CPU runs high; tapping it shows what's using the machine. */
export function LoadWarning({ me, go }: { me: Me | null; go: (hash: string) => void }) {
  const load = useMachineLoad(Boolean(me?.machine_load))
  const [open, setOpen] = useState(false)
  const warning = loadWarning(load)
  if (!load || (!warning && !open)) return null
  const shown = warning ?? { label: "RAM", percent: load.memory.percent }
  const critical = shown.percent >= CRITICAL_AT
  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label={`${shown.label} at ${shown.percent}%`}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs tabular-nums",
          critical ? "bg-destructive/12 text-destructive" : "bg-amber-500/12 text-amber-700 dark:text-amber-400",
        )}
      >
        {shown.label === "CPU" ? <CpuIcon className="size-3.5" /> : <MemoryStickIcon className="size-3.5" />}
        {shown.label} {shown.percent}%
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          aria-label="Machine load"
          className="z-50 w-[256px] max-w-[calc(100vw-1rem)] rounded-xl border bg-popover p-3.5 shadow-lg"
          collisionPadding={8}
          onCloseAutoFocus={event => event.preventDefault()}
          side="top"
          sideOffset={8}
        >
          <Details
            go={hash => {
              setOpen(false)
              go(hash)
            }}
            load={load}
            me={me}
            open={open}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
