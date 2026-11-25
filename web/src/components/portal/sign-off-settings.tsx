import { useEffect, useState } from "react"
import { Skullet } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { Row } from "./settings"
import { modelChoice, ModelPicker } from "./model-picker"
import { d, type Infer } from "@/lib/decode"

const signOff = modelChoice.extend({ on: d.boolean() })
type SignOff = Infer<typeof signOff>

const SAMPLE_SIGNOFF: SignOff = {
  on: true,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  providers: [{ provider: "anthropic", label: "Anthropic", models: ["claude-haiku-5-5"] }],
}

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
  if (!state && failed) return null
  return (
    <Skullet data={state} id="settings-signoff" label="Loading sign-off settings…" sample={SAMPLE_SIGNOFF}>
      {data => (
        <div className="flex flex-col gap-2">
          <Row label="Sign-off line">
            <Switch checked={data.on} label="Sign-off line" onCheckedChange={on => void save({ on }).catch(e => onError(e instanceof Error ? e.message : String(e)))} />
          </Row>
          {data.on && data.providers.length > 0 && (
            <Row label="Sign-off model">
              <div className="flex min-w-0 justify-end"><ModelPicker label="Sign-off model" onPick={body => save(body)} value={data} /></div>
            </Row>
          )}
        </div>
      )}
    </Skullet>
  )
}
