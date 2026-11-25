import { Skullet } from "@/components/ui/skeleton"
import { SearchableDropdown } from "@/components/ui/searchable-dropdown"
import { id } from "@/lib/id"
import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { EllipsisIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { type ModelPreset, presetDetails, presetMatches, putModelPreset, removeModelPreset, useModelPresets, usePicksLoadState } from "@/lib/model-presets"
import { type ModelChoice, PresetIcon } from "./model-picker"
import { PresetEmoji } from "./preset-emoji"

const SAMPLE_PRESETS: ModelPreset[] = [
  { id: "sample", name: "Daily coding", icon: "✨", pick: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", speed: "" } },
]

export function ModelPresetSettings({ value }: { value: ModelChoice }) {
  const presets = useModelPresets()
  const loadState = usePicksLoadState()
  const [editing, setEditing] = useState<ModelPreset | null>(null)
  const [error, setError] = useState("")
  const active = presets.find(item => presetMatches(item, value))
  const edit = (preset?: ModelPreset) => {
    setError("")
    setEditing(preset ?? {
      id: id(), name: "", icon: "",
      pick: { provider: value.provider, model: value.model, effort: value.effort ?? "", speed: value.speed ?? "" },
    })
  }
  return <section aria-label="Model presets" className="mt-2 space-y-1 border-t pt-3 text-sm">
    <div className="flex items-center justify-between">
      <h2 className="font-medium">Model presets</h2>
      <Button type="button" size="sm" variant="outline" onClick={() => edit()}><PlusIcon />Add preset</Button>
    </div>
    {loadState === "failed" && <p className="text-muted-foreground">Could not load presets.</p>}
    <Skullet id="settings-presets" label="Loading presets…" loading={loadState === "pending"}>
      <div>
        {loadState === "ready" && !presets.length && <p className="py-1 text-muted-foreground">No presets yet.</p>}
        {(loadState === "pending" ? SAMPLE_PRESETS : presets).map(preset => <div key={preset.id} className="flex min-h-14 items-center gap-2 border-b last:border-0">
          <PresetIcon icon={preset.icon} />
          <div className="min-w-0 flex-1"><div className="truncate">{preset.name}</div><div className="truncate text-xs text-muted-foreground">{presetDetails(preset)}</div></div>
          {active?.id === preset.id && <span className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">Default</span>}
          <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={`Options for ${preset.name}`}><EllipsisIcon /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => edit(preset)}>Edit preset</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => {
                setError("")
                removeModelPreset(preset.id).catch(e => setError(e instanceof Error ? e.message : String(e)))
              }}>Remove preset</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>)}
      </div>
    </Skullet>
    {!editing && error && <p role="alert" className="text-destructive">{error}</p>}
    {editing && <Dialog open onOpenChange={open => { if (!open) { setEditing(null); setError("") } }}>
      <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-sm" aria-describedby={undefined}>
        <DialogTitle>{presets.some(preset => preset.id === editing.id) ? "Edit preset" : "Add preset"}</DialogTitle>
        <PresetForm value={value} preset={editing} error={error} onCancel={() => { setEditing(null); setError("") }} onSave={preset => {
          putModelPreset(preset).then(() => { setEditing(null); setError("") }, e => setError(e instanceof Error ? e.message : String(e)))
        }} />
      </DialogContent>
    </Dialog>}
  </section>
}

function PresetForm({ value, preset, error, onCancel, onSave }: { value: ModelChoice; preset: ModelPreset; error: string; onCancel: () => void; onSave: (preset: ModelPreset) => void }) {
  const [draft, setDraft] = useState(preset)
  const { pick } = draft
  const routes = value.providers.flatMap(({ provider, label, models }) => models.map(model => ({ provider, model, label })))
  const route = (provider: string, model: string) => JSON.stringify([provider, model])
  const selected = route(pick.provider, pick.model)
  const available = routes.some(item => route(item.provider, item.model) === selected)
  const current = pick.provider === value.provider && pick.model === value.model
  const [preview, setPreview] = useState<{ route: string; efforts?: string[]; speeds?: string[]; error?: string } | null>(null)
  useEffect(() => {
    if (current || !available) return
    let active = true
    const query = new URLSearchParams({ provider: pick.provider, model: pick.model })
    api<{ efforts: string[]; speeds: string[] }>(`/api/model/options?${query}`).then(
      result => { if (active) setPreview({ ...result, route: selected }) },
      () => { if (active) setPreview({ route: selected, error: "Could not load tuning options for this model." }) },
    )
    return () => { active = false }
  }, [available, current, pick.model, pick.provider, selected])
  const loaded = !current && preview?.route === selected ? preview : null
  const choices = current ? value : loaded
  const options = (known: string[] | undefined, saved: string) => [...new Set([...(known ?? []), ...(saved ? [saved] : [])])]
  const tuning = (fieldName: "effort" | "speed", values: string[]) => {
    const label = fieldName === "effort" ? "Effort" : "Speed"
    return <div className="grid min-w-0 gap-1.5">
      <span>{label}</span>
      <SearchableDropdown label={label} value={pick[fieldName]} className="h-9 w-full"
        options={[{ value: "", label: "Default" }, ...values.map(value => ({ value, label: value }))]}
        onPick={value => setDraft({ ...draft, pick: { ...pick, [fieldName]: value } })} />
    </div>
  }
  return <form className="grid gap-3 text-sm" onSubmit={e => { e.preventDefault(); if (draft.name.trim() && available) onSave(draft) }}>
    <div className="grid gap-1.5">
      <label htmlFor="preset-name">Name</label>
      <div className="flex items-center gap-2">
        <PresetEmoji value={draft.icon} onPick={icon => setDraft(current => ({ ...current, icon }))} />
        <Input id="preset-name" value={draft.name} required maxLength={40} placeholder="Quick replies" onChange={e => setDraft({ ...draft, name: e.target.value })} />
      </div>
    </div>
    <div className="grid min-w-0 gap-1.5">
      <span>Model</span>
      <SearchableDropdown label="Model" value={selected} placeholder="Choose an available model" className="h-9 w-full"
        options={routes.map(({ provider, model, label }) => ({ value: route(provider, model), label: model, detail: label }))}
        onPick={choice => {
          if (choice === selected) return
          const next = routes.find(item => route(item.provider, item.model) === choice)
          if (next) setDraft({ ...draft, pick: { provider: next.provider, model: next.model, effort: "", speed: "" } })
        }} />
    </div>
    <div className="grid grid-cols-2 gap-3">{tuning("effort", options(choices?.efforts, pick.effort))}{tuning("speed", options(choices?.speeds, pick.speed))}</div>
    {loaded?.error && <p role="alert" className="text-destructive">{loaded.error}</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!draft.name.trim() || !available}>Save preset</Button></div>
  </form>
}
