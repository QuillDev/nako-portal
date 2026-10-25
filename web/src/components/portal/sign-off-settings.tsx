import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"

type Provider = { provider: string; label: string; models: string[] }
type SignOff = { on: boolean; provider: string; model: string; providers: Provider[] }

// Plain substring match on the model or provider name.
const matches = (query: string, ...texts: string[]) => texts.some(t => t.toLowerCase().includes(query.trim().toLowerCase()))

function ModelPicker({ value, onPick }: { value: SignOff; onPick: (provider: string, model: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const current = value.providers.find(p => p.provider === value.provider)
  return (
    <>
      <Button className="max-w-56 justify-between gap-2" onClick={() => setOpen(true)} size="sm" variant="ghost">
        <span className="truncate">{value.model ? `${value.model} · ${current?.label ?? value.provider}` : "automatic"}</span>
        <ChevronsUpDownIcon className="text-muted-foreground" />
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
          <DialogTitle className="sr-only">Sign-off model</DialogTitle>
          <Command shouldFilter={false}>
            <CommandInput onValueChange={setQuery} placeholder="Search models" value={query} />
            <CommandList className="max-h-[60vh]">
              <CommandEmpty>No model matches.</CommandEmpty>
              {value.providers.map(p => {
                const shown = p.models.filter(m => matches(query, m, p.label))
                if (!shown.length) return null
                return (
                  <CommandGroup heading={p.label} key={p.provider}>
                    {shown.map(m => (
                      <CommandItem
                        key={m}
                        onSelect={() => {
                          setOpen(false)
                          setQuery("")
                          onPick(p.provider, m)
                        }}
                        value={`${p.provider}/${m}`}
                      >
                        <span className="truncate">{m}</span>
                        {p.provider === value.provider && m === value.model && <CheckIcon className="ml-auto" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )
              })}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}

// Nako's line after a turn: whether she says it, and which model writes it. Kept on the server,
// so every device and Desktop's Models page agree.
export function SignOffSettings({ Row, onError }: { Row: (props: { label: string; children: React.ReactNode }) => React.ReactNode; onError: (message: string) => void }) {
  const [state, setState] = useState<SignOff | null>(null)
  useEffect(() => void api<SignOff>("/api/signoff").then(setState, e => onError((e as Error).message)), [onError])
  const save = (body: Partial<SignOff>) => api<SignOff>("/api/signoff", { method: "POST", body }).then(setState, e => onError((e as Error).message))
  if (!state) return null
  return (
    <>
      <Row label="Say a line when a turn ends">
        <Button aria-pressed={state.on} onClick={() => save({ on: !state.on })} size="sm" variant="ghost">
          {state.on ? "on" : "off"}
        </Button>
      </Row>
      {state.on && (
        <Row label="Model for it">
          <ModelPicker onPick={(provider, model) => save({ provider, model })} value={state} />
        </Row>
      )}
    </>
  )
}
