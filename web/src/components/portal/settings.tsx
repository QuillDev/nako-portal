import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { cancelled, register } from "@/lib/passkeys"
import { enablePush, pushState } from "@/lib/push"
import { setTheme, type Theme, useTheme } from "@/lib/theme"
import type { Passkey } from "@/lib/types"
import { PageHeader } from "./header"

const THEMES: Theme[] = ["system", "light", "dark"]

const PUSH_LABEL = { unsupported: "unsupported here", on: "on", blocked: "blocked in browser settings", off: "turn on" }

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span>{label}</span>
      {children}
    </div>
  )
}

export function Settings({ portal }: { portal: Portal }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [push, setPush] = useState(pushState())
  const [error, setError] = useState("")
  const theme = useTheme()
  const load = useCallback(() => api<Passkey[]>("/api/passkeys").then(setPasskeys, () => {}), [])
  useEffect(() => void load(), [load])

  const attempt = (fn: () => Promise<unknown>) => async () => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(cancelled(e) ? "Cancelled." : (e as Error).message)
    }
  }

  return (
    <>
      <PageHeader title="Settings" />
      <section className="mx-auto w-full max-w-xl overflow-y-auto px-4 py-2">
        <h3 className="pt-4 pb-1 font-medium text-muted-foreground text-xs">Appearance</h3>
        <Row label="Theme">
          <div className="flex gap-1">
            {THEMES.map(t => (
              <Button aria-pressed={theme === t} key={t} onClick={() => setTheme(t)} size="sm" variant={theme === t ? "secondary" : "ghost"}>
                {t}
              </Button>
            ))}
          </div>
        </Row>
        <h3 className="pt-4 pb-1 font-medium text-muted-foreground text-xs">Passkeys</h3>
        {passkeys.map(k => (
          <Row key={k.id} label={`${k.label}${k.current ? " (this device)" : ""}`}>
            {!k.current && (
              <Button
                onClick={attempt(async () => {
                  if (!confirm("Remove this passkey? That device will be signed out.")) return
                  await api(`/api/passkeys/${encodeURIComponent(k.id)}/remove`, { method: "POST" })
                  await load()
                })}
                size="sm"
                variant="ghost"
              >
                remove
              </Button>
            )}
          </Row>
        ))}
        <Row label="Add a passkey on this device">
          <Button
            onClick={attempt(async () => {
              await register(null)
              await load()
            })}
            size="sm"
            variant="ghost"
          >
            add
          </Button>
        </Row>
        <h3 className="pt-4 pb-1 font-medium text-muted-foreground text-xs">Notifications</h3>
        <Row label="Alerts when a turn finishes or needs you">
          <Button
            disabled={push !== "off"}
            onClick={attempt(async () => {
              try {
                await enablePush()
              } finally {
                setPush(pushState())
              }
            })}
            size="sm"
            variant="ghost"
          >
            {PUSH_LABEL[push]}
          </Button>
        </Row>
        <h3 className="pt-4 pb-1 font-medium text-muted-foreground text-xs">Account</h3>
        <Row label="Sign out of this device">
          <Button
            onClick={attempt(async () => {
              await api("/api/logout", { method: "POST" })
              location.replace("/")
            })}
            size="sm"
            variant="ghost"
          >
            sign out
          </Button>
        </Row>
        {(error || portal.error) && <p className="text-destructive text-sm">{error || portal.error}</p>}
      </section>
    </>
  )
}
