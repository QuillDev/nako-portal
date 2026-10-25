import { useCallback, useEffect, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { cancelled, register } from "@/lib/passkeys"
import { enablePush, pushState } from "@/lib/push"
import { setPresence, usePresence } from "@/lib/presence"
import { setTheme, type Theme, useTheme } from "@/lib/theme"
import type { Passkey } from "@/lib/types"
import { PageHeader } from "./header"
import { SignOffSettings } from "./sign-off-settings"

const THEMES: Theme[] = ["system", "light", "dark"]

const PUSH_NOTE = { unsupported: "unsupported here", blocked: "blocked in browser settings" }

export function Row({ label, children }: { label: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-4 text-sm">
      <span className="min-w-0">{label}</span>
      {children}
    </div>
  )
}

// One settings group: a title row that folds its rows away.
function Section({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <Collapsible className="group/section border-b" defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full items-center py-4 text-left font-semibold text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {title}
        <ChevronRightIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]/section:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function Settings({ portal }: { portal: Portal }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>([])
  const [push, setPush] = useState(pushState())
  const [error, setError] = useState("")
  const theme = useTheme()
  const presence = usePresence()
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
      <section className="mx-auto w-full max-w-xl overflow-y-auto px-4 pb-6">
        <Section defaultOpen title="Appearance">
          <Row label="Theme">
            <div className="inline-flex gap-0.5 rounded-lg border bg-card p-0.5">
              {THEMES.map(t => (
                <button
                  aria-pressed={theme === t}
                  className="rounded-md px-2.5 py-1 text-muted-foreground text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-accent aria-pressed:text-foreground"
                  key={t}
                  onClick={() => setTheme(t)}
                  type="button"
                >
                  {t}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Your name">
            <Input
              aria-label="Your name"
              className="h-8 w-40"
              defaultValue={portal.me?.name || ""}
              key={portal.me?.name}
              maxLength={40}
              onBlur={e => e.currentTarget.value.trim() !== (portal.me?.name || "") && attempt(() => portal.setName(e.currentTarget.value))()}
              onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
              placeholder="for the greeting"
            />
          </Row>
        </Section>
        <Section defaultOpen title="Nako">
          <Row label="Sticker while she works">
            <Switch checked={presence} label="Sticker while she works" onCheckedChange={setPresence} />
          </Row>
          <SignOffSettings onError={setError} />
        </Section>
        <Section title="Notifications">
          <Row label="Push alerts">
            {push === "unsupported" || push === "blocked" ? (
              <span className="text-muted-foreground text-xs">{PUSH_NOTE[push]}</span>
            ) : (
              <Switch
                checked={push === "on"}
                disabled={push === "on"}
                label="Push alerts"
                onCheckedChange={attempt(async () => {
                  try {
                    await enablePush()
                  } finally {
                    setPush(pushState())
                  }
                })}
              />
            )}
          </Row>
        </Section>
        <Section title="Passkeys">
          {passkeys.map(k => (
            <Row
              key={k.id}
              label={
                <span className="flex items-center gap-2">
                  <span className="truncate">{k.label}</span>
                  {k.current && <span className="rounded-md border px-1.5 text-muted-foreground text-xs">this device</span>}
                </span>
              }
            >
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
                  Remove
                </Button>
              )}
            </Row>
          ))}
          <div className="flex justify-end">
            <Button
              onClick={attempt(async () => {
                await register(null)
                await load()
              })}
              size="sm"
              variant="outline"
            >
              Add passkey
            </Button>
          </div>
        </Section>
        <Section title="Account">
          <Row label="Sign out of this device">
            <Button
              className="border-destructive/40 text-destructive hover:text-destructive"
              onClick={attempt(async () => {
                await api("/api/logout", { method: "POST" })
                location.replace("/")
              })}
              size="sm"
              variant="outline"
            >
              Sign out
            </Button>
          </Row>
        </Section>
        {(error || portal.error) && <p className="pt-4 text-destructive text-sm">{error || portal.error}</p>}
      </section>
    </>
  )
}
