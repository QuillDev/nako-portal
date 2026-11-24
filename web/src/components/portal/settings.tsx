import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { SearchableDropdown } from "@/components/ui/searchable-dropdown"
import { Switch } from "@/components/ui/switch"
import { GatewayRestart } from "./gateway-restart"
import { type Portal } from "@/hooks/use-portal"
import { api, ApiError } from "@/lib/api"
import { canPickSearch, SEARCH_ENGINES, type SearchEngine, setSearchEngine, useSearchEngine } from "@/lib/desktop-browser"
import { cancelled, register } from "@/lib/passkeys"
import { appAlerts, appBubble, enablePush, openAppNotificationSettings, pushState, setAppBubble } from "@/lib/push"
import { setPresence, usePresence } from "@/lib/presence"
import { setTheme, type Theme, useTheme } from "@/lib/theme"
import { useEnvironments } from "@/lib/environments"
import { useMesh } from "@/lib/mesh"
import { useMcp } from "@/lib/mcp"
import { useProviders } from "@/lib/providers"
import { useSecrets } from "@/lib/secrets"
import type { Passkey } from "@/lib/types"
import { SettingsFrame, SettingsPlaceholder } from "./settings-frame"
import { SettingsLoading } from "./settings-loading"
import { useUsage } from "@/lib/usage"
import { type ModelChoice, modelChoice, ModelPicker } from "./model-picker"

const McpSettings = lazy(() => import("./mcp").then(m => ({ default: m.McpSettings })))
const ProvidersSettings = lazy(() => import("./providers").then(m => ({ default: m.ProvidersSettings })))
const SignOffSettings = lazy(() => import("./sign-off-settings").then(m => ({ default: m.SignOffSettings })))
const EnvironmentsSettings = lazy(() => import("./environments").then(m => ({ default: m.EnvironmentsSettings })))
const MeshSettings = lazy(() => import("./mesh").then(m => ({ default: m.MeshSettings })))
const UsageSettings = lazy(() => import("./usage-settings").then(m => ({ default: m.UsageSettings })))
const ModelPresetSettings = lazy(() => import("./model-preset-settings").then(m => ({ default: m.ModelPresetSettings })))
const SecretsSettings = lazy(() => import("./secrets-settings").then(m => ({ default: m.SecretsSettings })))

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
          className="rounded-md px-2.5 py-1 text-muted-foreground text-xs outline-none aria-pressed:bg-accent aria-pressed:text-foreground"
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
  const [model, setModel] = useState<ModelChoice | null | false>(null)
  const [profileFailed, setProfileFailed] = useState(false)
  const fail = useCallback((e: unknown) => onError((e as Error).message), [onError])
  useEffect(() => {
    let active = true
    api<Profiles>("/api/profile").then(value => { if (active) setState(value) }, e => { if (active) { setProfileFailed(true); fail(e) } })
    return () => { active = false }
  }, [fail])
  const shown = state?.profile
  useEffect(() => {
    if (!shown) return
    let active = true
    setModel(null)
    api<unknown>("/api/model").then(raw => { if (active) setModel(modelChoice.parse(raw)) }).catch(e => {
      if (!active) return
      setModel(false)
      if (!(e instanceof ApiError && e.status === 404)) fail(e)
    })
    return () => { active = false }
  }, [shown, fail])
  if (!state) return profileFailed ? null : <SettingsLoading page="profile" rows={2} />
  const pick = (profile: string) => profile !== state.profile && api<Profiles>("/api/profile", { method: "POST", body: { profile } }).then(setState, fail)
  const pickModel = async (body: { provider?: string; model?: string; effort?: string; speed?: string }) => setModel(modelChoice.parse(await api<unknown>("/api/model", { method: "POST", body })))
  return (
    <>
      {state.profiles.length > 1 && <ProfileRow onPick={pick} state={state} />}
      {model === null && <Row label="Default model"><Skeleton className="h-8 w-40 motion-reduce:animate-none" /></Row>}
      {model && <>
        <Row label="Default model"><ModelPicker label="default model" named onPick={pickModel} value={model} /></Row>
        <Suspense fallback={<SettingsLoading page="presets" rows={1} />}><ModelPresetSettings value={model} /></Suspense>
      </>}
    </>
  )
}

function ProfileRow({ state, onPick: pick }: { state: Profiles; onPick: (profile: string) => void }) {
  return (
    <Row label="Profile">
      <SearchableDropdown label="Profile" value={state.profile} onPick={pick} className="w-40" align="end"
        options={state.profiles.map(profile => ({ value: profile, label: profile }))} />
    </Row>
  )
}

// The desktop app's in-app browser: what the address bar searches with.
function SearchEngineRow() {
  const engine = useSearchEngine()
  if (!canPickSearch()) return null
  return (
    <Row label="Search engine">
      <SearchableDropdown label="Search engine" value={engine} onPick={setSearchEngine} className="w-40" align="end"
        options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map(value => ({ value, label: SEARCH_ENGINES[value] }))} />
    </Row>
  )
}

export function Settings({ portal, page }: { portal: Portal; page: string | null }) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
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
  const load = useCallback(() => api<Passkey[]>("/api/passkeys").then(setPasskeys, e => { setPasskeys(previous => previous ?? []); setError(e instanceof Error ? e.message : String(e)) }), [])
  useEffect(() => void load(), [load])

  const attempt = (fn: () => Promise<unknown>) => async () => {
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(cancelled(e) ? "Cancelled." : (e as Error).message)
    }
  }

  const usage = useUsage(setError)
  const secrets = useSecrets()
  const providers = useProviders()
  const mcp = useMcp()
  const mesh = useMesh(portal.machinesSeen)
  const environments = useEnvironments(Boolean(portal.me?.environments)).data
  const pages: Record<string, React.ReactNode> = {
    general: (
      <>
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
        <SearchEngineRow />
      </>
    ),
    notifications: (
      <>
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
      </>
    ),
    nako: (
      <>
        <Row label="Sticker while she works">
          <Switch checked={presence} label="Sticker while she works" onCheckedChange={setPresence} />
        </Row>
        <div className="flex min-h-20 flex-col gap-2"><Suspense fallback={<SettingsLoading page="signoff" rows={2} />}><SignOffSettings onError={setError} /></Suspense></div>
        <ProfileRows onError={setError} />
      </>
    ),
    usage: usage !== "unsupported" && usage !== "failed" && <UsageSettings state={usage} providers={providers || null} session={portal.route.view === "settings" ? portal.route.fromChat : undefined} />,
    providers: <ProvidersSettings onError={setError} />,
    secrets: <SecretsSettings onError={setError} />,
    mcp: <McpSettings onError={setError} />,
    gateway: <GatewayRestart />,
    mesh: mesh === null ? <SettingsLoading page="mesh" /> : <MeshSettings portal={portal} />,
    environments: <EnvironmentsSettings />,
    account: (
      <>
        <p className="pt-1 pb-1 text-muted-foreground text-xs">Session</p>
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
        <p className="pt-5 pb-1 text-muted-foreground text-xs">Passkeys</p>
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
        {passkeys === null ? <SettingsLoading page="account" rows={1} /> : passkeys.map(k => (
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
      </>
    ),
  }

  const shown = page ?? "general"
  return <SettingsFrame page={page} hasEnvironments={Boolean(portal.me?.environments)} environmentsTitle={environments?.title}
    unavailable={{ usage: usage === "unsupported", providers: providers === false, secrets: secrets === false, mcp: mcp === false, mesh: mesh !== null && (!mesh || !mesh.hub) }}
    error={error || portal.error}>
    <Suspense fallback={<SettingsPlaceholder page={page} />}>{pages[shown] ?? pages.general}</Suspense>
  </SettingsFrame>
}
