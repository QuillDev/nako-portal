import { useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { Row } from "./settings"
import { modelChoice, ModelPicker } from "./model-picker"
import { z } from "zod"

const signOff = modelChoice.extend({ on: z.boolean() })
type SignOff = z.infer<typeof signOff>

// Nako's line after a turn: whether she says it, and which model writes it. Kept on the server,
// so every device and Desktop's Models page agree.
export function SignOffSettings({ onError }: { onError: (message: string) => void }) {
  const [state, setState] = useState<SignOff | null>(null)
  useEffect(() => void api<unknown>("/api/signoff").then(raw => setState(signOff.parse(raw))).catch(e => onError(e instanceof Error ? e.message : String(e))), [onError])
  const save = async (body: Partial<SignOff>) => setState(signOff.parse(await api<unknown>("/api/signoff", { method: "POST", body })))
  if (!state) return null
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
