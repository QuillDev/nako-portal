import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { Row } from "./settings"
import { modelChoice, ModelPicker } from "./model-picker"
import { d, type Infer } from "@/lib/decode"

const signOff = modelChoice.extend({ on: d.boolean() })
type SignOff = Infer<typeof signOff>

// Nako's line after a turn: whether she says it, and which model writes it. Kept on the server,
// so every device and Desktop's Models page agree.
export function SignOffSettings({ onError }: { onError: (message: string) => void }) {
  const [state, setState] = useState<SignOff | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    api<unknown>("/api/signoff").then(raw => { if (active) setState(signOff.parse(raw)) }).catch(e => {
      if (active) { setFailed(true); onError(e instanceof Error ? e.message : String(e)) }
    })
    return () => { active = false }
  }, [onError])
  const save = async (body: Partial<SignOff>) => setState(signOff.parse(await api<unknown>("/api/signoff", { method: "POST", body })))
  if (!state) return failed ? null : <>
    <Row label="Sign-off line"><Skeleton className="h-5 w-9 motion-reduce:animate-none" /></Row>
    <Row label="Sign-off model"><Skeleton className="h-8 w-32 motion-reduce:animate-none" /></Row>
  </>
  return (
    <>
      <Row label="Sign-off line">
        <Switch checked={state.on} label="Sign-off line" onCheckedChange={on => void save({ on }).catch(e => onError(e instanceof Error ? e.message : String(e)))} />
      </Row>
      {state.on && state.providers.length > 0 && (
        <Row label="Sign-off model">
          <ModelPicker label="Sign-off model" onPick={body => save(body)} value={state} />
        </Row>
      )}
    </>
  )
}
