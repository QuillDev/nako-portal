import { useCallback, useEffect, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { canPickSearch, SEARCH_ENGINES, type SearchEngine, setSearchEngine, useSearchEngine } from "@/lib/desktop-browser"
import { cancelled, register } from "@/lib/passkeys"
import { appAlerts, enablePush, openAppNotificationSettings, pushState } from "@/lib/push"
import { setPresence, usePresence } from "@/lib/presence"
import { setTheme, type Theme, useTheme } from "@/lib/theme"
import type { Passkey } from "@/lib/types"
import { PageHeader } from "./header"
import { type ModelChoice, ModelPicker, SignOffSettings } from "./sign-off-settings"

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

// Pick one of a few short options, e.g. the theme.
function Segmented<T extends string>({ options, value, onPick }: { options: readonly T[]; value: T; onPick: (option: T) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border bg-card p-0.5">
      {options.map(option => (
        <button
          aria-pressed={value === option}
          className="rounded-md px-2.5 py-1 text-muted-foreground text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-pressed:bg-accent aria-pressed:text-foreground"
          key={option}
          onClick={() => onPick(option)}
          type="button"
        >
          {option}
        </button>
      ))}
    </div>
  )
}

type Profiles = { profile: string; profiles: string[] }

// Which Hermes profile the portal shows, and the model that profile runs on. Switching
// profiles swaps every chat for that profile's; the model belongs to the profile shown.
function ProfileRows({ onError }: { onError: (message: string) => void }) {
  const [state, setState] = useState<Profiles | null>(null)
  const [model, setModel] = useState<ModelChoice | null>(null)
  const fail = useCallback((e: unknown) => onError((e as Error).message), [onError])
  useEffect(() => void api<Profiles>("/api/profile").then(setState, fail), [fail])
  const shown = state?.profile
  useEffect(() => {
    if (!shown) return
    setModel(null)
    api<ModelChoice>("/api/model").then(setModel, fail)
  }, [shown, fail])
  if (!state) return null
  const pick = (profile: string) => profile !== state.profile && api<Profiles>("/api/profile", { method: "POST", body: { profile } }).then(setState, fail)
  const pickModel = (provider: string, chosen: string) => api<ModelChoice>("/api/model", { method: "POST", body: { provider, model: chosen } }).then(setModel, fail)
  return (
    <>
      {state.profiles.length > 1 && <ProfileRow onPick={pick} state={state} />}
      <Row label="Model">{model && <ModelPicker onPick={pickModel} value={model} />}</Row>
    </>
  )
}

function ProfileRow({ state, onPick: pick }: { state: Profiles; onPick: (profile: string) => void }) {
  return (
    <Row label="Profile">
      <Select onValueChange={pick} value={state.profile}>
        <SelectTrigger aria-label="Profile" className="w-40" size="sm">
          <SelectValue />
        </SelectTrigger>
        {/* Radix refocuses the trigger on close, which Chrome paints as a keyboard focus ring. */}
        <SelectContent onCloseAutoFocus={e => e.preventDefault()}>
          {state.profiles.map(profile => (
            <SelectItem key={profile} value={profile}>
              {profile}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

// The desktop app's in-app browser: what the address bar searches with.
function BrowserSection() {
  const engine = useSearchEngine()
  if (!canPickSearch()) return null
  return (
    <Section title="Browser">
      <Row label="Search engine">
        <Select onValueChange={value => setSearchEngine(value as SearchEngine)} value={engine}>
          <SelectTrigger aria-label="Search engine" className="w-40" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent onCloseAutoFocus={e => e.preventDefault()}>
            {Object.entries(SEARCH_ENGINES).map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Section>
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
  const [app, setApp] = useState(appAlerts())
  // Coming back from the phone's notification settings shows what was picked there.
  useEffect(() => {
    const reread = () => document.visibilityState === "visible" && setApp(appAlerts())
    document.addEventListener("visibilitychange", reread)
    return () => document.removeEventListener("visibilitychange", reread)
  }, [])
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
            <Segmented onPick={setTheme} options={THEMES} value={theme} />
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
          <ProfileRows onError={setError} />
          <Row label="Sticker while she works">
            <Switch checked={presence} label="Sticker while she works" onCheckedChange={setPresence} />
          </Row>
          <SignOffSettings onError={setError} />
        </Section>
        <BrowserSection />
        <Section title="Notifications">
          {app ? (
            <Row label="Alerts">
              {app === "app" ? (
                <span className="text-muted-foreground text-xs">handled by the app</span>
              ) : (
                <Switch checked={app === "on"} label="Alerts" onCheckedChange={openAppNotificationSettings} />
              )}
            </Row>
          ) : (
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
          )}
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
