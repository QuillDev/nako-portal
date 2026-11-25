import { BrainIcon, CheckIcon, ChevronDownIcon, GaugeIcon, RabbitIcon, RocketIcon, StarIcon, TurtleIcon } from "lucide-react"
import { Popover } from "radix-ui"
import { useEffect, useRef, useState } from "react"
import { d, type Infer } from "@/lib/decode"
import { Skullet } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from "@/components/ui/command"
import { DropdownContent, DropdownList, SearchableDropdown } from "@/components/ui/searchable-dropdown"
import { api, ApiError } from "@/lib/api"
import { presetDetails, presetMatches, refreshModelPicks, toggleModelFavorite, useModelFavorites, useModelPresets } from "@/lib/model-presets"
import { favoriteId, type ModelFavorite } from "@/lib/model-favorites"

export const modelChoice = d.object({
  provider: d.string(), model: d.string(),
  providers: d.array(d.object({ provider: d.string(), label: d.string(), models: d.array(d.string()) })),
  effort: d.string().optional(), speed: d.string().optional(),
  efforts: d.array(d.string()).optional(), speeds: d.array(d.string()).optional(), overridden: d.boolean().optional(),
})
export type ModelChoice = Infer<typeof modelChoice>
export type ModelSelection = { provider?: string; model?: string; effort?: string; speed?: string; reset?: true }
type Pick = ModelSelection

function ModelPlaceholder() {
  return (
    <Skullet className="inline-block" label="Loading model…" loading>
      <Button className="max-w-48 justify-between gap-2 font-normal" size="sm" type="button" variant="ghost">
        <span className="truncate">claude-sonnet</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </Button>
    </Skullet>
  )
}

export function NewChatModel({ selection, onPick }: { selection: ModelSelection; onPick: (pick: ModelSelection) => void }) {
  const [defaults, setDefaults] = useState<ModelChoice | null | false>(null)
  useEffect(() => {
    let active = true
    void api<unknown>("/api/model").then(raw => { if (active) setDefaults(modelChoice.parse(raw)) }).catch(() => { if (active) setDefaults(false) })
    return () => { active = false }
  }, [])
  if (!defaults) return defaults === null ? <ModelPlaceholder /> : null
  const otherRoute = selection.model !== undefined && (selection.model !== defaults.model || selection.provider !== defaults.provider)
  return <ModelPicker label="this chat" session chips canSavePreset={!otherRoute} value={{ ...defaults, ...selection, overridden: Object.keys(selection).length > 0 }} onPick={async pick => {
    if (pick.reset) onPick({})
    else if (pick.model !== undefined) onPick(pick)
    else onPick({ ...selection, ...pick })
  }} />
}

// Speed tiers read as animals; a tier with no animal keeps a plain gauge.
const SPEED_ICONS: Record<string, typeof GaugeIcon> = { normal: TurtleIcon, fast: RabbitIcon, ultrafast: RocketIcon }
const optionIcon = (label: string, value: string) => label === "effort" ? BrainIcon : SPEED_ICONS[value] ?? GaugeIcon

function Option({ label, value, values, onPick, chip = false }: {
  label: string; value: string; values: string[]; onPick: (value: string) => void; chip?: boolean;
}) {
  const Icon = optionIcon(label, value)
  return <div className={chip ? "shrink-0 data-[fit=out]:invisible data-[fit=out]:absolute data-[fit=out]:top-0 data-[fit=out]:left-0" : "min-w-0 flex-1"} data-tune={chip ? "" : undefined}>
    <SearchableDropdown label={label} value={value || "inherit"} compact={chip} side={chip ? "top" : "bottom"}
      className={chip ? "gap-1.5 px-2 text-xs text-muted-foreground" : "w-full text-xs"}
      icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" />}
      options={[{ value: "inherit", label: "default" }, ...values.map(value => ({ value, label: value }))]}
      onPick={v => onPick(v === "inherit" ? "" : v)} />
  </div>
}

export function PresetIcon({ icon }: { icon?: string }) {
  return icon ? <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center overflow-hidden text-sm leading-none">{icon}</span> : null
}

export function ModelPicker({ value, onPick, label = "Model", disabled = false, session = false, canSavePreset = true, chips = false, named = session }: {
  value: ModelChoice; onPick: (pick: Pick) => Promise<unknown>; label?: string; disabled?: boolean; session?: boolean; canSavePreset?: boolean; named?: boolean;
  // Effort and speed as their own buttons beside the model; the composer hides the ones that don't fit.
  chips?: boolean;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const favorites = useModelFavorites()
  const search = useRef<HTMLInputElement>(null)
  const catalog = new Map(value.providers.map(provider => [provider.provider, provider]))
  const presets = useModelPresets()
  const presetsOnly = named && presets.length > 0
  const activePreset = presetsOnly ? presets.find(item => presetMatches(item, value)) : undefined
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
    toggleModelFavorite(favorite).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  const show = (next: boolean) => {
    if (next) void refreshModelPicks()
    setOpen(next)
  }
  const save = async (pick: Pick) => {
    setSaving(true)
    setError("")
    try { await onPick(pick) } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // A chip has nowhere to say what went wrong; the picker does.
      setOpen(true)
    }
    finally { setSaving(false) }
  }
  // A single speed is no choice, so neither the picker nor a chip offers it.
  const speeds = value.speeds && value.speeds.length > 1 ? value.speeds : undefined
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
  return <><Popover.Root open={open} onOpenChange={show}>
    <Popover.Trigger asChild><Button aria-label={label} disabled={disabled} className="max-w-48 justify-between gap-2 font-normal" size="sm" variant={session ? "ghost" : "outline"}>
      {presetsOnly && <PresetIcon icon={activePreset?.icon} />}
      <span className="truncate">{activePreset?.name || value.model || "automatic"}</span><ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
    </Button></Popover.Trigger>
    <DropdownContent align={session ? "start" : "end"} side={session ? "top" : "bottom"} className="w-80" aria-label={label}>
      <div className="flex items-center justify-between px-3 pt-3 text-xs text-muted-foreground"><span>{label}</span>
        {session && <button disabled={saving || !value.overridden} className="disabled:opacity-40 hover:text-foreground" onClick={() => void save({ reset: true })}>use default</button>}
      </div>
      {presetsOnly ? <>
        <Command label="Model presets" loop>
          <CommandInput aria-label="Search presets" placeholder="Search presets…" />
          <DropdownList className="p-1">
            <CommandEmpty>No preset matches.</CommandEmpty>
            {presets.map(item => {
              const available = catalog.get(item.pick.provider)?.models.includes(item.pick.model)
              return <CommandItem key={item.id} value={`${item.name} ${item.id}`} keywords={[presetDetails(item)]}
                disabled={saving || !available} className="min-h-11" onSelect={() => void save(item.pick)}>
                <PresetIcon icon={item.icon} />
                <span className="min-w-0 flex-1"><span className="block truncate">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{available ? presetDetails(item) : "Model unavailable"}</span></span>
                {activePreset?.id === item.id && <CheckIcon />}
              </CommandItem>
            })}
          </DropdownList>
        </Command>
        {session && <a className="block border-t px-3 py-2 text-xs text-muted-foreground hover:text-foreground" href="#/settings/nako" onClick={() => setOpen(false)}>Manage presets</a>}
      </> : <>
      <Command shouldFilter={false} className="bg-transparent">
        <CommandInput aria-label="Search models" ref={search} onValueChange={setQuery} placeholder="Search models" value={query} />
        <DropdownList>
          <CommandEmpty>No model matches.</CommandEmpty>
          {shownFavorites.length > 0 && <CommandGroup heading="Favorites" className="mb-1 border-b pb-2">
            {shownFavorites.map(pick => renderRow(pick, [catalog.get(pick.provider)?.label, details(pick)].filter(Boolean).join(" · ")))}
          </CommandGroup>}
          {value.providers.map(p => {
            const shown = p.models.map(model => ({ provider: p.provider, model }))
              .filter(pick => !starred.has(favoriteId(pick)) && matches(pick.model, p.label))
            return shown.length ? <CommandGroup heading={p.label} key={p.provider}>{shown.map(pick => renderRow(pick))}</CommandGroup> : null
          })}
        </DropdownList>
      </Command>
      {supportsTuning && <fieldset disabled={saving} className="flex items-center gap-1 border-t p-1.5">
        {value.efforts && <Option label="effort" value={value.effort || ""} values={value.efforts} onPick={effort => void save({ effort })} />}
        {speeds && <Option label="speed" value={value.speed || ""} values={speeds} onPick={speed => void save({ speed })} />}
        {canSavePreset && (preset.effort || preset.speed) && catalog.get(preset.provider)?.models.includes(preset.model) &&
          <button type="button" aria-pressed={starred.has(favoriteId(preset))}
            className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent aria-pressed:text-primary max-sm:min-h-11"
            onClick={() => toggle(preset)}><StarIcon className="size-3.5" fill={starred.has(favoriteId(preset)) ? "currentColor" : "none"} /> {starred.has(favoriteId(preset)) ? "Preset saved" : "Save preset"}</button>}
      </fieldset>}
      </>}
      {error && <p role="alert" className="px-3 pb-3 text-xs text-destructive">{error}</p>}
    </DropdownContent>
  </Popover.Root>
  {chips && !activePreset && <fieldset disabled={disabled || saving} className="contents">
    {value.efforts && <Option chip label="effort" value={value.effort || ""} values={value.efforts} onPick={effort => void save({ effort })} />}
    {speeds && <Option chip label="speed" value={value.speed || ""} values={speeds} onPick={speed => void save({ speed })} />}
  </fieldset>}
  </>
}

export function SessionModel({ session, running }: { session: string; running: boolean }) {
  const [value, setValue] = useState<ModelChoice | null | false>(null)
  const path = `/api/sessions/${session}/model`
  useEffect(() => {
    let active = true
    const read = () => api<unknown>(path).then(raw => { if (active) setValue(modelChoice.parse(raw)) }).catch(e => {
      if (active) setValue(previous => e instanceof ApiError && e.status === 404 ? false : previous ?? false)
    })
    void read()
    const timer = window.setInterval(read, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [path, running])
  if (!value) return value === null ? <ModelPlaceholder /> : null
  return <ModelPicker label="this chat" session chips disabled={running} value={value} onPick={async body => {
    let raw = await api<unknown>(path, { method: "POST", body })
    const warning = d.object({ confirmation: d.string(), message: d.string() }).safeParse(raw)
    if (warning.success) {
      if (!window.confirm(warning.data.message)) return
      raw = await api<unknown>(path, { method: "POST", body: { ...body, confirm: warning.data.confirmation } })
    }
    setValue(modelChoice.parse(raw))
  }} />
}
