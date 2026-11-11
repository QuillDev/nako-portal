import { useCallback, useEffect, useState } from "react"
import { BellIcon, BoxesIcon, ChartLineIcon, ChevronRightIcon, KeyRoundIcon, type LucideIcon, BlocksIcon, NetworkIcon, PlugIcon, SlidersHorizontalIcon, SparklesIcon, UserIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { navigate, type Portal } from "@/hooks/use-portal"
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
import { cn } from "@/lib/utils"
import type { Passkey } from "@/lib/types"
import { PageHeader } from "./header"
import { McpSettings } from "./mcp"
import { ProvidersSettings } from "./providers"
import { SecretsSettings } from "./secrets"
import { SignOffSettings } from "./sign-off-settings"
import { EnvironmentsSettings } from "./environments"
import { MeshSettings } from "./mesh"
import { UsageSettings, useUsage } from "./usage-settings"
import { type ModelChoice, modelChoice, ModelPicker } from "./model-picker"

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
    api<unknown>("/api/model").then(raw => setModel(modelChoice.parse(raw))).catch(e => {
      if (!(e instanceof ApiError && e.status === 404)) fail(e)
    })
  }, [shown, fail])
  if (!state) return null
  const pick = (profile: string) => profile !== state.profile && api<Profiles>("/api/profile", { method: "POST", body: { profile } }).then(setState, fail)
  const pickModel = async (body: { provider?: string; model?: string; effort?: string; speed?: string }) => setModel(modelChoice.parse(await api<unknown>("/api/model", { method: "POST", body })))
  return (
    <>
      {state.profiles.length > 1 && <ProfileRow onPick={pick} state={state} />}
      {model && <Row label="Default model"><ModelPicker label="default model" onPick={pickModel} value={model} /></Row>}
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
function SearchEngineRow() {
  const engine = useSearchEngine()
  if (!canPickSearch()) return null
  return (
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
  )
}

type Page = { id: string; label: string; icon: LucideIcon }
type Bucket = { label: string; pages: Page[] }

// The settings menu: the page list beside the open page on wide screens, its own screen on phones.
function SettingsMenu({ buckets, current }: { buckets: Bucket[]; current: string | null }) {
  // Phones show the menu on its own, so no row there reads as the open page.
  return (
    <nav aria-label="Settings" className="flex flex-col px-2 pb-6 md:w-52 md:shrink-0">
      {buckets.map((bucket, index) => (
        <div className="flex flex-col" key={bucket.label || index}>
          {bucket.label ? <p className="px-2 pt-3 pb-1 text-muted-foreground text-xs">{bucket.label}</p> : <div className="h-3" />}
          {bucket.pages.map(page => (
            <button
              aria-current={page.id === current ? "page" : undefined}
              className="flex select-none items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-muted-foreground text-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:aria-[current=page]:bg-accent md:aria-[current=page]:text-foreground md:py-2"
              key={page.id}
              onClick={() => navigate(`#/settings/${page.id}`)}
              type="button"
            >
              <page.icon className="size-4" />
              <span className="flex-1 truncate">{page.label}</span>
              <ChevronRightIcon className="size-4 md:hidden" />
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

export function Settings({ portal, page }: { portal: Portal; page: string | null }) {
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

  const usage = useUsage(setError)
  const secrets = useSecrets()
  const providers = useProviders()
  const mcp = useMcp()
  const mesh = useMesh(portal.machinesSeen)
  const environments = useEnvironments(Boolean(portal.me?.environments)).data
  const buckets: Bucket[] = [
    { label: "App", pages: [{ id: "general", label: "General", icon: SlidersHorizontalIcon }, { id: "notifications", label: "Notifications", icon: BellIcon }] },
    {
      label: "Nako",
      pages: [
        { id: "nako", label: "Model & profile", icon: SparklesIcon },
        ...(usage !== "unsupported" ? [{ id: "usage", label: "Usage", icon: ChartLineIcon }] : []),
        ...(providers ? [{ id: "providers", label: "Providers", icon: PlugIcon }] : []),
        ...(secrets ? [{ id: "secrets", label: "Secrets", icon: KeyRoundIcon }] : []),
        ...(mcp ? [{ id: "mcp", label: "MCP servers", icon: BlocksIcon }] : []),
      ],
    },
    {
      label: "Machines",
      pages: [
        ...(mesh?.hub ? [{ id: "mesh", label: "Mesh", icon: NetworkIcon }] : []),
        ...(portal.me?.environments ? [{ id: "environments", label: environments?.title ?? "Environments", icon: BoxesIcon }] : []),
      ],
    },
    { label: "", pages: [{ id: "account", label: "Account", icon: UserIcon }] },
  ].filter(bucket => bucket.pages.length > 0)
  // Wide screens always show a page beside the menu; phones show the menu until one is picked.
  const shown = page ?? "general"
  const label = buckets.flatMap(b => b.pages).find(p => p.id === shown)?.label ?? ""

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
        <ProfileRows onError={setError} />
        <Row label="Sticker while she works">
          <Switch checked={presence} label="Sticker while she works" onCheckedChange={setPresence} />
        </Row>
        <SignOffSettings onError={setError} />
      </>
    ),
    usage: usage !== "unsupported" && <UsageSettings state={usage} />,
    providers: <ProvidersSettings onError={setError} />,
    secrets: <SecretsSettings onError={setError} />,
    mcp: <McpSettings onError={setError} />,
    mesh: <MeshSettings portal={portal} />,
    environments: <EnvironmentsSettings />,
    account: (
      <>
        <p className="pt-1 pb-1 text-muted-foreground text-xs">Passkeys</p>
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
        <p className="pt-5 pb-1 text-muted-foreground text-xs">Session</p>
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
      </>
    ),
  }

  return (
    <>
      <PageHeader
        back={page ? () => navigate("#/settings") : undefined}
        title={
          page ? (
            <>
              <span className="md:hidden">{label}</span>
              <span className="hidden md:inline">Settings</span>
            </>
          ) : (
            "Settings"
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("w-full overflow-y-auto md:block md:w-auto", page && "hidden")}>
          <SettingsMenu buckets={buckets} current={shown} />
        </div>
        <section className={cn("min-w-0 flex-1 overflow-y-auto md:block md:border-l", !page && "hidden")}>
          <div className="flex w-full max-w-xl flex-col gap-2 px-4 pb-6 md:px-6">
            <h3 className="hidden pt-1.5 pb-2 font-semibold text-[15px] md:block">{label}</h3>
            {pages[shown] ?? pages.general}
            {(error || portal.error) && <p className="pt-4 text-destructive text-sm">{error || portal.error}</p>}
          </div>
        </section>
      </div>
    </>
  )
}
