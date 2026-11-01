import { useCallback, useEffect, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { canPickSearch, SEARCH_ENGINES, type SearchEngine, setSearchEngine, useSearchEngine } from "@/lib/desktop-browser"
import { cancelled, register } from "@/lib/passkeys"
import { appAlerts, appBubble, enablePush, openAppNotificationSettings, pushState, setAppBubble } from "@/lib/push"
import { setPresence, usePresence } from "@/lib/presence"
import { setTheme, type Theme, useTheme } from "@/lib/theme"
import type { Machine, Mesh, Passkey } from "@/lib/types"
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

function ago(seconds: number) {
  const s = Math.max(0, Date.now() / 1000 - seconds)
  if (s < 90) return "just now"
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function machineState(m: Machine) {
  if (!m.online) return m.last_seen ? `seen ${ago(m.last_seen)}` : "never connected"
  if (!m.gateway) return "hermes offline"
  return m.working ? `working on ${m.working}` : "online"
}

// Other machines' Hermes, reached through this portal: who's there, adding one, removing one.
// Only a mesh hub shows it.
function MachinesSection({ seen, onError }: { seen: number; onError: (message: string) => void }) {
  const [mesh, setMesh] = useState<Mesh | null>(null)
  const [name, setName] = useState("")
  const [added, setAdded] = useState<{ name: string; prompt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const load = useCallback(() => api<Mesh>("/api/mesh").then(setMesh, e => onError((e as Error).message)), [onError])
  useEffect(() => void load(), [load, seen])
  // "seen 5m ago" keeps moving while the page is open.
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])
  if (!mesh?.hub) return null
  const add = async () => {
    try {
      const made = await api<{ name: string; prompt: string }>("/api/mesh/machines", { method: "POST", body: { name } })
      setAdded(made)
      setCopied(false)
      setName("")
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const remove = async (machine: string) => {
    if (!confirm(`Remove ${machine}? It disconnects now and needs a new token to come back.`)) return
    try {
      await api(`/api/mesh/machines/${encodeURIComponent(machine)}/remove`, { method: "POST" })
      if (added?.name === machine) setAdded(null)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <Section defaultOpen title="Machines">
      {mesh.machines.map(m => (
        <Row
          key={m.name}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn("size-2 shrink-0 rounded-full", m.online && m.gateway ? "bg-emerald-500" : m.online ? "bg-amber-500" : "bg-muted-foreground/40")}
              />
              <span className="truncate">{m.name}</span>
              {m.os && <span className="truncate text-muted-foreground text-xs">{m.os}</span>}
            </span>
          }
        >
          <span className="flex shrink-0 items-center gap-2">
            <span className="text-muted-foreground text-xs">{machineState(m)}</span>
            <Button onClick={() => remove(m.name)} size="sm" variant="ghost">
              Remove
            </Button>
          </span>
        </Row>
      ))}
      {added && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <span>Send this to Hermes on {added.name}. It sets everything up. Works for a day, shown once.</span>
          <code className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{added.prompt}</code>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setAdded(null)} size="sm" variant="ghost">
              Done
            </Button>
            <Button
              onClick={() => navigator.clipboard.writeText(added.prompt).then(() => setCopied(true), () => onError("couldn't copy"))}
              size="sm"
              variant="outline"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={e => {
          e.preventDefault()
          if (name.trim()) void add()
        }}
      >
        <Input
          aria-label="New machine name"
          className="h-8 flex-1"
          onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          placeholder="machine name"
          value={name}
        />
        <Button disabled={!name.trim()} size="sm" type="submit" variant="outline">
          Add machine
        </Button>
      </form>
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
  const [bubble, setBubble] = useState(appBubble())
  // Coming back from the phone's notification or overlay settings shows what was picked there.
  useEffect(() => {
    const reread = () => {
      if (document.visibilityState !== "visible") return
      setApp(appAlerts())
      setBubble(appBubble())
    }
    // The desktop app says when its floating Nako is turned on or off from its tray menu.
    const floating = () => setBubble(appBubble())
    document.addEventListener("visibilitychange", reread)
    window.addEventListener("nako-floating", floating)
    return () => {
      document.removeEventListener("visibilitychange", reread)
      window.removeEventListener("nako-floating", floating)
    }
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
        <MachinesSection onError={setError} seen={portal.machinesSeen} />
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
          {bubble && (
            <Row label="Floating Nako">
              <Switch
                checked={bubble === "on"}
                label="Floating Nako"
                onCheckedChange={on => {
                  setAppBubble(on)
                  setBubble(appBubble())
                }}
              />
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
