import { BrainIcon, CheckIcon, ChevronDownIcon, ZapIcon } from "lucide-react"
import { Popover } from "radix-ui"
import { useEffect, useState } from "react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, ApiError } from "@/lib/api"

export const modelChoice = z.object({
  provider: z.string(), model: z.string(),
  providers: z.array(z.object({ provider: z.string(), label: z.string(), models: z.array(z.string()) })),
  effort: z.string().optional(), speed: z.string().optional(),
  efforts: z.array(z.string()).optional(), speeds: z.array(z.string()).optional(), overridden: z.boolean().optional(),
})
export type ModelChoice = z.infer<typeof modelChoice>
export type ModelSelection = { provider?: string; model?: string; effort?: string; speed?: string; reset?: true }
type Pick = ModelSelection

export function NewChatModel({ selection, onPick }: { selection: ModelSelection; onPick: (pick: ModelSelection) => void }) {
  const [defaults, setDefaults] = useState<ModelChoice | null>(null)
  useEffect(() => {
    let active = true
    void api<unknown>("/api/model").then(raw => { if (active) setDefaults(modelChoice.parse(raw)) }).catch(() => {})
    return () => { active = false }
  }, [])
  if (!defaults) return null
  return <ModelPicker label="this chat" session value={{ ...defaults, ...selection, overridden: Object.keys(selection).length > 0 }} onPick={async pick => {
    onPick(pick.reset ? {} : { ...selection, ...pick })
  }} />
}

function Option({ label, value, values, onPick }: { label: string; value: string; values: string[]; onPick: (value: string) => void }) {
  const Icon = label === "effort" ? BrainIcon : ZapIcon
  return <div className="min-w-0 flex-1">
    <Select value={value || "inherit"} onValueChange={v => onPick(v === "inherit" ? "" : v)}>
      <SelectTrigger aria-label={label} title={label} className="h-9 w-full gap-2 rounded-lg border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent focus-visible:ring-0 dark:bg-transparent dark:hover:bg-accent">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-left"><SelectValue /></span>
      </SelectTrigger>
      <SelectContent onCloseAutoFocus={e => e.preventDefault()}>
        <div className="px-2 py-1.5 text-xs text-muted-foreground">{label}</div>
        <SelectItem value="inherit">default</SelectItem>
        {values.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
      </SelectContent>
    </Select></div>
}

export function ModelPicker({ value, onPick, label = "Model", disabled = false, session = false }: {
  value: ModelChoice; onPick: (pick: Pick) => Promise<unknown>; label?: string; disabled?: boolean; session?: boolean;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const save = async (pick: Pick) => {
    setSaving(true)
    setError("")
    try { await onPick(pick) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><Button aria-label={label} disabled={disabled} className="max-w-48 justify-between gap-2 font-normal" size="sm" variant={session ? "ghost" : "outline"}>
      <span className="truncate">{value.model || "automatic"}</span><ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
    </Button></Popover.Trigger>
    <Popover.Portal><Popover.Content align={session ? "start" : "end"} side={session ? "top" : "bottom"} collisionPadding={8} sideOffset={8} onCloseAutoFocus={e => e.preventDefault()}
      className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg" aria-label={label}>
      <div className="flex items-center justify-between px-3 pt-3 text-xs text-muted-foreground"><span>{label}</span>
        {session && <button disabled={saving || !value.overridden} className="disabled:opacity-40 hover:text-foreground" onClick={() => void save({ reset: true })}>use default</button>}
      </div>
      <Command shouldFilter={false} className="bg-transparent">
        <CommandInput onValueChange={setQuery} placeholder="Search models" value={query} />
        <CommandList className="max-h-[min(36vh,18rem)]">
          <CommandEmpty>No model matches.</CommandEmpty>
          {value.providers.map(p => {
            const shown = p.models.filter(m => `${p.label} ${m}`.toLowerCase().includes(query.trim().toLowerCase()))
            return shown.length ? <CommandGroup heading={p.label} key={p.provider}>{shown.map(m => <CommandItem disabled={saving} key={m} value={`${p.provider}/${m}`}
              onSelect={() => void save({ provider: p.provider, model: m })}>
              <span className="truncate">{m}</span>{p.provider === value.provider && m === value.model && <CheckIcon className="ml-auto shrink-0 size-4" />}
            </CommandItem>)}</CommandGroup> : null
          })}
        </CommandList>
      </Command>
      {(value.efforts || value.speeds) && <fieldset disabled={saving} className="flex items-center gap-1 border-t p-1.5">
        {value.efforts && <Option label="effort" value={value.effort || ""} values={value.efforts} onPick={effort => void save({ effort })} />}
        {value.speeds && value.speeds.length > 1 && <Option label="speed" value={value.speed || ""} values={value.speeds} onPick={speed => void save({ speed })} />}
      </fieldset>}
      {error && <p role="alert" className="px-3 pb-3 text-xs text-destructive">{error}</p>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}

export function SessionModel({ session, running }: { session: string; running: boolean }) {
  const [value, setValue] = useState<ModelChoice | null>(null)
  const path = `/api/sessions/${session}/model`
  useEffect(() => {
    let active = true
    const read = () => api<unknown>(path).then(raw => { if (active) setValue(modelChoice.parse(raw)) }).catch(e => {
      if (active && e instanceof ApiError && e.status === 404) setValue(null)
    })
    void read()
    const timer = window.setInterval(read, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [path, running])
  if (!value) return null
  return <ModelPicker label="this chat" session disabled={running} value={value} onPick={async body => {
    let raw = await api<unknown>(path, { method: "POST", body })
    const warning = z.object({ confirmation: z.string(), message: z.string() }).safeParse(raw)
    if (warning.success) {
      if (!window.confirm(warning.data.message)) return
      raw = await api<unknown>(path, { method: "POST", body: { ...body, confirm: warning.data.confirmation } })
    }
    setValue(modelChoice.parse(raw))
  }} />
}
