import { BrainIcon, CheckIcon, ChevronDownIcon, StarIcon, ZapIcon } from "lucide-react"
import { Popover } from "radix-ui"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, ApiError } from "@/lib/api"
import { favoriteId, type ModelFavorite, readModelFavorites, toggleModelFavorite } from "@/lib/model-favorites"

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
  const otherRoute = selection.model !== undefined && (selection.model !== defaults.model || selection.provider !== defaults.provider)
  return <ModelPicker label="this chat" session canSavePreset={!otherRoute} value={{ ...defaults, ...selection, overridden: Object.keys(selection).length > 0 }} onPick={async pick => {
    if (pick.reset) onPick({})
    else if (pick.model !== undefined) onPick(pick)
    else onPick({ ...selection, ...pick })
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

export function ModelPicker({ value, onPick, label = "Model", disabled = false, session = false, canSavePreset = true }: {
  value: ModelChoice; onPick: (pick: Pick) => Promise<unknown>; label?: string; disabled?: boolean; session?: boolean; canSavePreset?: boolean;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [favorites, setFavorites] = useState(readModelFavorites)
  const search = useRef<HTMLInputElement>(null)
  const catalog = new Map(value.providers.map(provider => [provider.provider, provider]))
  const supportsTuning = value.efforts !== undefined || value.speeds !== undefined
  const preset = {
    provider: value.provider, model: value.model,
    effort: value.efforts?.includes(value.effort ?? "") ? value.effort ?? "" : "",
    speed: value.speeds?.includes(value.speed ?? "") ? value.speed ?? "" : "",
  }
  const starred = new Set(favorites.map(favoriteId))
  const filter = query.trim().toLowerCase()
  const matches = (model: string, provider: string, tuning = "") => `${provider} ${model} ${tuning}`.toLowerCase().includes(filter)
  const details = (favorite: ModelFavorite) => "effort" in favorite ? [favorite.effort, favorite.speed].filter(Boolean).join(" · ") : ""
  const shownFavorites = favorites.filter(favorite => {
    const provider = catalog.get(favorite.provider)
    return provider?.models.includes(favorite.model) && (supportsTuning || !("effort" in favorite)) && matches(favorite.model, provider.label, details(favorite))
  })
  const toggle = (favorite: ModelFavorite) => {
    setError("")
    try { setFavorites(toggleModelFavorite(favorite)) }
    catch { setError("Couldn't save favorites on this device.") }
  }
  const show = (next: boolean) => {
    if (next) setFavorites(readModelFavorites())
    setOpen(next)
  }
  const save = async (pick: Pick) => {
    setSaving(true)
    setError("")
    try { await onPick(pick) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }
  const renderRow = (pick: ModelFavorite, description?: string) => {
    const id = favoriteId(pick)
    const active = pick.provider === value.provider && pick.model === value.model &&
      (!("effort" in pick) || (pick.effort === preset.effort && pick.speed === preset.speed))
    const name = `${pick.model} on ${catalog.get(pick.provider)?.label}${description ? `, ${description}` : ""}`
    return <div key={id} className="flex items-stretch rounded-sm hover:bg-accent focus-within:bg-accent">
      <CommandItem className="min-h-9 min-w-0 flex-1 max-sm:min-h-11" disabled={saving} value={id} onSelect={() => void save(pick)}>
        <span className="min-w-0">
          <span className="block truncate">{pick.model}</span>
          {description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}
        </span>
        {active && <CheckIcon className="ml-auto size-4 shrink-0" />}
      </CommandItem>
      <button type="button" aria-label={`Favorite ${name}`} aria-pressed={starred.has(id)} title={starred.has(id) ? "Remove favorite" : "Add favorite"}
        className="grid w-9 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground aria-pressed:text-primary max-sm:w-11"
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation() }}
        onClick={event => {
          // The row moves between groups. Keep keyboard focus in the picker.
          if (event.currentTarget === document.activeElement) search.current?.focus({ preventScroll: true })
          toggle(pick)
        }}>
        <StarIcon className="size-4" fill={starred.has(id) ? "currentColor" : "none"} />
      </button>
    </div>
  }
  return <Popover.Root open={open} onOpenChange={show}>
    <Popover.Trigger asChild><Button aria-label={label} disabled={disabled} className="max-w-48 justify-between gap-2 font-normal" size="sm" variant={session ? "ghost" : "outline"}>
      <span className="truncate">{value.model || "automatic"}</span><ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
    </Button></Popover.Trigger>
    <Popover.Portal><Popover.Content align={session ? "start" : "end"} side={session ? "top" : "bottom"} collisionPadding={8} sideOffset={8} onCloseAutoFocus={e => e.preventDefault()}
      className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg" aria-label={label}>
      <div className="flex items-center justify-between px-3 pt-3 text-xs text-muted-foreground"><span>{label}</span>
        {session && <button disabled={saving || !value.overridden} className="disabled:opacity-40 hover:text-foreground" onClick={() => void save({ reset: true })}>use default</button>}
      </div>
      <Command shouldFilter={false} className="bg-transparent">
        <CommandInput ref={search} onValueChange={setQuery} placeholder="Search models" value={query} />
        <CommandList className="max-h-[min(46vh,20rem)]">
          <CommandEmpty>No model matches.</CommandEmpty>
          {shownFavorites.length > 0 && <CommandGroup heading="Favorites" className="mb-1 border-b pb-2">
            {shownFavorites.map(pick => renderRow(pick, [catalog.get(pick.provider)?.label, details(pick)].filter(Boolean).join(" · ")))}
          </CommandGroup>}
          {value.providers.map(p => {
            const shown = p.models.map(model => ({ provider: p.provider, model }))
              .filter(pick => !starred.has(favoriteId(pick)) && matches(pick.model, p.label))
            return shown.length ? <CommandGroup heading={p.label} key={p.provider}>{shown.map(pick => renderRow(pick))}</CommandGroup> : null
          })}
        </CommandList>
      </Command>
      {supportsTuning && <fieldset disabled={saving} className="flex items-center gap-1 border-t p-1.5">
        {value.efforts && <Option label="effort" value={value.effort || ""} values={value.efforts} onPick={effort => void save({ effort })} />}
        {value.speeds && value.speeds.length > 1 && <Option label="speed" value={value.speed || ""} values={value.speeds} onPick={speed => void save({ speed })} />}
        {canSavePreset && (preset.effort || preset.speed) && catalog.get(preset.provider)?.models.includes(preset.model) &&
          <button type="button" aria-pressed={starred.has(favoriteId(preset))}
            className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent aria-pressed:text-primary max-sm:min-h-11"
            onClick={() => toggle(preset)}><StarIcon className="size-3.5" fill={starred.has(favoriteId(preset)) ? "currentColor" : "none"} /> {starred.has(favoriteId(preset)) ? "Preset saved" : "Save preset"}</button>}
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
