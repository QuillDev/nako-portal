import { nanoid } from "nanoid"
import { useState } from "react"
import { EllipsisIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { type ModelPreset, presetDetails, presetMatches, putModelPreset, removeModelPreset, useModelPresets } from "@/lib/model-presets"
import { type ModelChoice, PresetIcon } from "./model-picker"
import { PresetEmoji } from "./preset-emoji"
const field = "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"

export function ModelPresetSettings({ value }: { value: ModelChoice }) {
  const presets = useModelPresets()
  const [editing, setEditing] = useState<ModelPreset | null>(null)
  const [error, setError] = useState("")
  const active = presets.find(item => presetMatches(item, value))
  const edit = (preset?: ModelPreset) => {
    setError("")
    setEditing(preset ?? {
      id: nanoid(), name: "", icon: "",
      pick: { provider: value.provider, model: value.model, effort: value.effort ?? "", speed: value.speed ?? "" },
    })
  }
  return <section aria-label="Model presets" className="mt-2 space-y-1 border-t pt-3 text-sm">
    <div className="flex items-center justify-between">
      <h2 className="font-medium">Model presets</h2>
      <Button type="button" size="sm" variant="outline" onClick={() => edit()}><PlusIcon />Add preset</Button>
    </div>
    {!presets.length && <p className="py-1 text-muted-foreground">No presets yet.</p>}
    {presets.map(preset => <div key={preset.id} className="flex min-h-14 items-center gap-2 border-b last:border-0">
      <PresetIcon icon={preset.icon} />
      <div className="min-w-0 flex-1"><div className="truncate">{preset.name}</div><div className="truncate text-xs text-muted-foreground">{presetDetails(preset)}</div></div>
      {active?.id === preset.id && <span className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground">Default</span>}
      <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={`Options for ${preset.name}`}><EllipsisIcon /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => edit(preset)}>Edit preset</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => {
            try { removeModelPreset(preset.id); setError("") }
            catch { setError("Couldn't remove this preset on this device.") }
          }}>Remove preset</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>)}
    {!editing && error && <p role="alert" className="text-destructive">{error}</p>}
    {editing && <Dialog open onOpenChange={open => { if (!open) { setEditing(null); setError("") } }}>
      <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-sm" aria-describedby={undefined}>
        <DialogTitle>{presets.some(preset => preset.id === editing.id) ? "Edit preset" : "Add preset"}</DialogTitle>
        <PresetForm value={value} preset={editing} error={error} onCancel={() => { setEditing(null); setError("") }} onSave={preset => {
          try { putModelPreset(preset); setEditing(null); setError("") }
          catch { setError("Couldn't save this preset on this device.") }
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
  const options = (known: string[] | undefined, saved: string) => [...new Set([...(current ? known ?? [] : []), ...(saved ? [saved] : [])])]
  const tuning = (fieldName: "effort" | "speed", values: string[]) => <label className="grid gap-1.5 capitalize">{fieldName}
    <select className={field} value={pick[fieldName]} onChange={e => setDraft({ ...draft, pick: { ...pick, [fieldName]: e.target.value } })}>
      <option value="">Default</option>{values.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  </label>
  return <form className="grid gap-3 text-sm" onSubmit={e => { e.preventDefault(); if (draft.name.trim() && available) onSave(draft) }}>
    <div className="grid gap-1.5">
      <label htmlFor="preset-name">Name</label>
      <div className="flex items-center gap-2">
        <PresetEmoji value={draft.icon} onPick={icon => setDraft(current => ({ ...current, icon }))} />
        <Input id="preset-name" value={draft.name} required maxLength={40} placeholder="Quick replies" onChange={e => setDraft({ ...draft, name: e.target.value })} />
      </div>
    </div>
    <label className="grid gap-1.5">Model<select className={field} value={selected} onChange={e => {
      const next = routes.find(item => route(item.provider, item.model) === e.target.value)
      if (next) setDraft({ ...draft, pick: { provider: next.provider, model: next.model, effort: "", speed: "" } })
    }}>
      {!available && <option value={selected} disabled>Choose an available model</option>}
      {routes.map(({ provider, model, label }) => <option key={route(provider, model)} value={route(provider, model)}>{model} · {label}</option>)}
    </select></label>
    <div className="grid grid-cols-2 gap-3">{tuning("effort", options(value.efforts, pick.effort))}{tuning("speed", options(value.speeds, pick.speed))}</div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!draft.name.trim() || !available}>Save preset</Button></div>
  </form>
}
