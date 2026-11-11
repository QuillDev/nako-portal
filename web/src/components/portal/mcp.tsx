import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import {
  addMcp,
  cancelMcpSignIn,
  installMcp,
  mcpCatalog,
  type McpCatalogEntry,
  type McpServer,
  type McpTest,
  pollMcpSignIn,
  reloadMcp,
  removeMcp,
  setMcpEnabled,
  setMcpTools,
  startMcpSignIn,
  testMcp,
  useMcp,
} from "@/lib/mcp"
import { cn } from "@/lib/utils"

const PANEL =
  "gap-3 rounded-[22px] bg-card p-4 sm:max-w-[440px] max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1.75rem,env(safe-area-inset-bottom))] max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom"

const FIELD = "h-10 w-full min-w-0 rounded-full border border-input bg-background px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"

const words = (text: string) => text.toLowerCase().replace(/[_\-./]+/g, " ").trim()

const host = (url: string) => url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "")

const runs = (s: { url: string; command: string; args: string[] }) => s.url || [s.command, ...s.args].join(" ")

/** Arguments typed on one line, split the way a shell would for plain words and quotes. */
function splitArgs(line: string) {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** KEY=value lines into a map; blank lines are skipped. */
function parseEnv(text: string) {
  const env: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const at = line.indexOf("=")
    if (at < 1) throw new Error(`"${line}" isn't KEY=value`)
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return env
}

function CloseButton() {
  return (
    <DialogClose asChild>
      <Button aria-label="Close" className="rounded-full text-muted-foreground" size="icon-sm" variant="ghost">
        <XIcon />
      </Button>
    </DialogClose>
  )
}

/** What a row says under the name: trouble first, then what it is. */
function Subline({ server }: { server: McpServer }) {
  if (server.installing) return <span className="truncate text-muted-foreground text-xs">Installing…</span>
  if (server.status === "failed" && !server.url && !server.command) return <span className="truncate text-destructive text-xs">{server.error || "The install failed"}</span>
  if (server.enabled && !server.signed_in) return <span className="truncate text-destructive text-xs">Sign in</span>
  if (server.enabled && server.status === "failed") return <span className="truncate text-destructive text-xs">Didn't connect</span>
  if (server.plugin) return <span className="truncate text-muted-foreground text-xs">From the {server.plugin} plugin</span>
  return <span className="truncate text-muted-foreground text-xs">{server.url ? host(server.url) : runs(server)}</span>
}

function Checkbox({ on }: { on: boolean }) {
  return (
    <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border border-input", on && "border-primary bg-primary text-primary-foreground")}>
      {on && <CheckIcon className="size-3 stroke-[3]" />}
    </span>
  )
}

/** A browser sign-in: open the server's page, then wait here until it says yes. */
function SignIn({ server, onDone, onError }: { server: McpServer; onDone: () => void; onError: (m: string) => void }) {
  const [flow, setFlow] = useState<{ id: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try {
      const started = await startMcpSignIn(server.name)
      if (!started.authorization_url) throw new Error(started.error || "The server didn't give a sign-in page")
      setFlow({ id: started.flow_id, url: started.authorization_url })
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!flow) return
    const timer = window.setInterval(() => {
      pollMcpSignIn(flow.id).then(
        state => {
          if (state.status === "approved") {
            setFlow(null)
            onDone()
          } else if (state.status === "error" || state.status === "cancelled") {
            setFlow(null)
            if (state.status === "error") onError(state.error || "The sign-in didn't finish")
          }
        },
        e => {
          setFlow(null)
          onError((e as Error).message)
        },
      )
    }, 2000)
    return () => window.clearInterval(timer)
  }, [flow, onDone, onError])
  useEffect(() => () => void (flow && cancelMcpSignIn(flow.id).catch(() => {})), [flow])
  if (!flow)
    return (
      <Button disabled={busy} onClick={start} size="sm" variant="ghost">
        {server.signed_in ? "Sign in again" : "Sign in"}
      </Button>
    )
  return (
    <Button asChild className="rounded-full" size="sm">
      <a href={flow.url} rel="noreferrer" target="_blank">
        Open sign-in page
        <ExternalLinkIcon />
      </a>
    </Button>
  )
}

/** One server: what it runs, whether it connects, its tools, and the ways to change it. */
function ServerPanel({ server, onClose, onError }: { server: McpServer; onClose: () => void; onError: (m: string) => void }) {
  const [test, setTest] = useState<McpTest | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setChecking(true)
    try {
      setTest(await testMcp(server.name))
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message, tools: [] })
    } finally {
      setChecking(false)
    }
  }, [server.name])
  useEffect(() => {
    if (!server.installing) void run()
  }, [run, server.installing])
  const own = !server.plugin
  const toggleTool = async (tool: string) => {
    if (!test || !own) return
    const tools = test.tools.map(t => (t.name === tool ? { ...t, on: !t.on } : t))
    setTest({ ...test, tools })
    try {
      await setMcpTools(server.name, tools.map(t => t.name), tools.filter(t => t.on).map(t => t.name))
    } catch (e) {
      setTest(test)
      onError((e as Error).message)
    }
  }
  const remove = async () => {
    if (!confirm(`Remove ${server.name}? Nako loses its tools until you add it again.`)) return
    setBusy(true)
    try {
      await removeMcp(server.name)
      await reloadMcp()
      onClose()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const signedIn = useCallback(() => {
    void reloadMcp()
    void run()
  }, [run])
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <DialogTitle className="min-w-0 flex-1 truncate font-medium font-mono text-sm leading-8">{server.name}</DialogTitle>
        {own && !server.installing && (
          <Switch checked={server.enabled} label={`Use ${server.name}`} onCheckedChange={on => void setMcpEnabled(server.name, on).then(reloadMcp, e => onError((e as Error).message))} />
        )}
        <CloseButton />
      </DialogHeader>
      {(server.url || server.command) && (
        <div className="truncate rounded-[22px] border bg-background px-4 py-2.5 font-mono text-muted-foreground text-xs" title={runs(server)}>
          {runs(server)}
        </div>
      )}
      {server.plugin && <DialogDescription className="px-1">From the {server.plugin} plugin, so it's changed there.</DialogDescription>}
      {server.installing ? (
        <p className="px-1 text-muted-foreground text-sm">Installing…</p>
      ) : !server.url && !server.command ? (
        <p className="px-1 text-destructive text-sm">{server.error || "The install failed"}</p>
      ) : checking && !test ? (
        <p className="px-1 text-muted-foreground text-xs">Connecting…</p>
      ) : test?.ok ? (
        <p className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
          <span className="size-2 rounded-full bg-emerald-500" />
          Connected
        </p>
      ) : test ? (
        <p className="px-1 text-destructive text-xs">{test.error}</p>
      ) : null}
      {server.codex && <p className="px-1 text-muted-foreground text-xs">{server.codex}</p>}
      {test?.ok && test.tools.length > 0 && (
        <div className="-mx-4 max-h-[44vh] overflow-y-auto px-4">
          <p className="px-1 pb-1 text-muted-foreground text-xs">Tools</p>
          {test.tools.map(t => (
            <button
              className="flex w-full items-start gap-2.5 rounded-md px-1 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:hover:bg-transparent"
              disabled={!own}
              key={t.name}
              onClick={() => void toggleTool(t.name)}
              role="checkbox"
              aria-checked={t.on}
              type="button"
            >
              <Checkbox on={t.on} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px]">{t.name}</span>
                {t.description && <span className="line-clamp-2 text-muted-foreground text-xs">{t.description}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 pt-1">
        {(own || !server.url) && (
          <Button className="px-2 text-destructive hover:text-destructive" disabled={busy || server.installing} onClick={remove} size="sm" variant="ghost">
            Remove
          </Button>
        )}
        <span className="flex-1" />
        {own && server.auth === "oauth" && <SignIn key={server.name} onDone={signedIn} onError={onError} server={server} />}
        {(server.url || server.command) && !server.installing && (
          <Button className="rounded-full" disabled={checking} onClick={() => void run()} size="sm" variant="outline">
            Test
          </Button>
        )}
      </div>
    </>
  )
}

function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div aria-label={label} className="flex gap-1 rounded-full bg-muted p-[3px]" role="tablist">
      {options.map(([id, text]) => (
        <button
          aria-selected={value === id}
          className="flex-1 rounded-full py-1.5 font-medium text-[13px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-selected:bg-card aria-selected:text-foreground"
          key={id}
          onClick={() => onChange(id)}
          role="tab"
          type="button"
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function KeyInput({ label, secret, value, onChange, saved }: { label: string; secret: boolean; value: string; onChange: (v: string) => void; saved?: boolean }) {
  const [shown, setShown] = useState(!secret)
  return (
    <label className="flex h-10 items-center gap-1 rounded-full border border-input bg-background pr-1 pl-3.5 has-[input:focus-visible]:border-ring">
      <input
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        data-1p-ignore
        onChange={e => onChange(e.target.value)}
        placeholder={saved ? `${label} (saved)` : label}
        spellCheck={false}
        type={shown ? "text" : "password"}
        value={value}
      />
      {secret && (
        <Button aria-label={shown ? "Hide" : "Show"} className="rounded-full text-muted-foreground" onClick={() => setShown(s => !s)} size="icon-sm" type="button" variant="ghost">
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      )}
    </label>
  )
}

/** A catalog server before it's added: what it runs, the keys it needs, and its setup notes. */
function InstallPanel({ entry, onBack, onDone, onError }: { entry: McpCatalogEntry; onBack: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const missing = entry.env.some(e => e.required && !e.saved && !values[e.name]?.trim())
  const install = async () => {
    setBusy(true)
    try {
      await installMcp(entry.name, values)
      await reloadMcp()
      onDone()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <DialogTitle className="min-w-0 flex-1 truncate font-medium font-mono text-sm leading-8">{entry.name}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      {entry.description && <DialogDescription className="px-1 text-foreground">{entry.description}</DialogDescription>}
      <div className="truncate rounded-[22px] border bg-background px-4 py-2.5 font-mono text-muted-foreground text-xs" title={runs(entry)}>
        {runs(entry)}
      </div>
      {entry.source && <p className="truncate px-1 text-muted-foreground text-xs">Downloads and builds {entry.source.replace(/^https?:\/\//, "")}</p>}
      {entry.env.map(e => (
        <KeyInput
          key={e.name}
          label={e.prompt || e.name}
          onChange={v => setValues(old => ({ ...old, [e.name]: v }))}
          saved={e.saved}
          secret={e.secret}
          value={values[e.name] ?? ""}
        />
      ))}
      {entry.auth === "oauth" && <p className="px-1 text-muted-foreground text-xs">Sign in from its page once it's added.</p>}
      {entry.post_install && <p className="whitespace-pre-line px-1 text-muted-foreground text-xs">{entry.post_install}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={onBack} size="sm" variant="ghost">
          Back
        </Button>
        <span className="flex-1" />
        <Button className="rounded-full" disabled={busy || missing} onClick={install} size="sm">
          Add
        </Button>
      </div>
    </>
  )
}

function CatalogList({ onPick, onError }: { onPick: (entry: McpCatalogEntry) => void; onError: (m: string) => void }) {
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null)
  const [query, setQuery] = useState("")
  useEffect(() => {
    mcpCatalog().then(setEntries, e => {
      setEntries([])
      onError((e as Error).message)
    })
  }, [onError])
  const typed = words(query)
  const shown = (entries ?? []).filter(e => !typed || words(`${e.name} ${e.description}`).includes(typed))
  return (
    <>
      <label className="flex h-10 items-center gap-2 rounded-full border border-input bg-background px-3.5 has-[input:focus-visible]:border-ring">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input aria-label="Search catalog" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" onChange={e => setQuery(e.target.value)} placeholder="Search catalog" spellCheck={false} value={query} />
      </label>
      <div className="-mx-4 max-h-[52vh] overflow-y-auto px-4">
        {entries === null && <p className="py-3 text-muted-foreground text-sm">Loading…</p>}
        {shown.map(e => (
          <button
            className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:hover:bg-transparent"
            disabled={e.installed}
            key={e.name}
            onClick={() => onPick(e)}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium font-mono text-[13px]">{e.name}</span>
              <span className="line-clamp-2 text-muted-foreground text-xs">{e.description}</span>
            </span>
            {e.installed ? <span className="text-muted-foreground text-xs">Added</span> : <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
          </button>
        ))}
        {entries !== null && shown.length === 0 && <p className="py-3 text-muted-foreground text-sm">Nothing matches {query.trim()}.</p>}
      </div>
    </>
  )
}

/** A server the catalog doesn't have: a URL (open, with a token, or signed in) or a command. */
function CustomForm({ onAdded, onError }: { onAdded: (name: string) => void; onError: (m: string) => void }) {
  const [name, setName] = useState("")
  const [kind, setKind] = useState<"url" | "command">("url")
  const [url, setUrl] = useState("")
  const [auth, setAuth] = useState<"none" | "token" | "oauth">("none")
  const [token, setToken] = useState("")
  const [command, setCommand] = useState("")
  const [args, setArgs] = useState("")
  const [env, setEnv] = useState("")
  const [busy, setBusy] = useState(false)
  const ready = name.trim() && (kind === "url" ? url.trim() && (auth !== "token" || token.trim()) : command.trim())
  const add = async () => {
    setBusy(true)
    try {
      const added =
        kind === "url"
          ? await addMcp({ name: name.trim(), url: url.trim(), ...(auth === "oauth" ? { auth: "oauth" as const } : {}), ...(auth === "token" ? { token: token.trim() } : {}) })
          : await addMcp({ name: name.trim(), command: command.trim(), args: splitArgs(args), env: parseEnv(env) })
      await reloadMcp()
      onAdded(added.name)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={e => {
        e.preventDefault()
        if (ready && !busy) void add()
      }}
    >
      <input aria-label="Name" autoCapitalize="off" className={cn(FIELD, "font-mono placeholder:font-sans")} onChange={e => setName(e.target.value)} placeholder="Name" spellCheck={false} value={name} />
      <Tabs label="Runs as" onChange={setKind} options={[["url", "URL"], ["command", "Command"]]} value={kind} />
      {kind === "url" ? (
        <>
          <input aria-label="URL" autoCapitalize="off" className={cn(FIELD, "font-mono placeholder:font-sans")} inputMode="url" onChange={e => setUrl(e.target.value)} placeholder="https://…/mcp" spellCheck={false} value={url} />
          <Tabs label="Sign-in" onChange={setAuth} options={[["none", "No sign-in"], ["token", "Token"], ["oauth", "Browser"]]} value={auth} />
          {auth === "token" && <KeyInput label="Token" onChange={setToken} secret value={token} />}
        </>
      ) : (
        <>
          <input aria-label="Command" autoCapitalize="off" className={cn(FIELD, "font-mono placeholder:font-sans")} onChange={e => setCommand(e.target.value)} placeholder="npx" spellCheck={false} value={command} />
          <input aria-label="Arguments" autoCapitalize="off" className={cn(FIELD, "font-mono placeholder:font-sans")} onChange={e => setArgs(e.target.value)} placeholder="Arguments" spellCheck={false} value={args} />
          <textarea
            aria-label="Environment"
            autoCapitalize="off"
            className="min-h-16 w-full resize-y rounded-[18px] border border-input bg-background px-3.5 py-2 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring"
            onChange={e => setEnv(e.target.value)}
            placeholder="KEY=value, one per line"
            spellCheck={false}
            value={env}
          />
        </>
      )}
      <div className="flex justify-end pt-1">
        <Button className="rounded-full" disabled={!ready || busy} size="sm" type="submit">
          Add and test
        </Button>
      </div>
    </form>
  )
}

function AddPanel({ onAdded, onClose, onError }: { onAdded: (name: string) => void; onClose: () => void; onError: (m: string) => void }) {
  const [tab, setTab] = useState<"catalog" | "custom">("catalog")
  const [picked, setPicked] = useState<McpCatalogEntry | null>(null)
  if (picked) return <InstallPanel entry={picked} onBack={() => setPicked(null)} onDone={onClose} onError={onError} />
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <DialogTitle className="min-w-0 flex-1 font-medium text-sm leading-8">Add server</DialogTitle>
        <CloseButton />
      </DialogHeader>
      <Tabs label="Add from" onChange={setTab} options={[["catalog", "Catalog"], ["custom", "Custom"]]} value={tab} />
      {tab === "catalog" ? <CatalogList onError={onError} onPick={setPicked} /> : <CustomForm onAdded={onAdded} onError={onError} />}
    </>
  )
}

type Open = { kind: "server"; name: string } | { kind: "add" } | null

/** Settings > MCP servers: what this profile connects to, each one's tools, and adding more. */
export function McpSettings({ onError }: { onError: (m: string) => void }) {
  const mcp = useMcp()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Open>(null)
  // A server still installing gets reread until it's done.
  const installing = !!mcp && mcp.servers.some(s => s.installing)
  useEffect(() => {
    if (!installing) return
    const timer = window.setInterval(() => void reloadMcp(), 3000)
    return () => window.clearInterval(timer)
  }, [installing])
  if (!mcp) return null
  const typed = words(query)
  const shown = typed ? mcp.servers.filter(s => words(`${s.name} ${s.url} ${s.command}`).includes(typed)) : mcp.servers
  const current = open?.kind === "server" ? mcp.servers.find(s => s.name === open.name) : undefined
  const close = () => setOpen(null)
  return (
    <>
      <div className="flex items-center gap-2 pb-1">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card px-3.5 has-[input:focus-visible]:border-ring">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input aria-label="Search servers" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" enterKeyHint="search" onChange={e => setQuery(e.target.value)} placeholder="Search servers" spellCheck={false} value={query} />
        </label>
        <Button aria-label="Add server" className="size-10 rounded-full" onClick={() => setOpen({ kind: "add" })} size="icon" title="Add server">
          <PlusIcon className="size-[18px]" />
        </Button>
      </div>
      <div className="flex flex-col">
        {shown.map(s => (
          <div className="-mx-2 flex items-center gap-3 rounded-md px-2 hover:bg-accent" data-mcp-row={s.name} key={s.name}>
            <button className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => setOpen({ kind: "server", name: s.name })} type="button">
              <span className={cn("flex min-w-0 flex-1 flex-col", !s.enabled && !s.installing && s.status !== "failed" && "opacity-55")}>
                <span className="truncate font-medium font-mono text-[13px] leading-5">{s.name}</span>
                <Subline server={s} />
              </span>
            </button>
            {!s.plugin && !s.installing && (s.url || s.command) && (
              <Switch checked={s.enabled} label={`Use ${s.name}`} onCheckedChange={on => void setMcpEnabled(s.name, on).then(reloadMcp, e => onError((e as Error).message))} />
            )}
            <button aria-label={`Open ${s.name}`} className="py-2 outline-none" onClick={() => setOpen({ kind: "server", name: s.name })} tabIndex={-1} type="button">
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
        ))}
        {!shown.length && <p className="py-4 text-muted-foreground text-sm">{typed ? `No servers match "${query.trim()}".` : "No servers yet."}</p>}
      </div>
      <Dialog onOpenChange={o => !o && close()} open={open !== null && (open.kind === "add" || !!current)}>
        <DialogContent className={PANEL} data-mcp-panel={open?.kind === "add" ? "add" : current?.name || ""} onOpenAutoFocus={e => e.preventDefault()} showCloseButton={false}>
          {open?.kind === "add" && <AddPanel onAdded={name => setOpen({ kind: "server", name })} onClose={close} onError={onError} />}
          {current && <ServerPanel key={current.name} onClose={close} onError={onError} server={current} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
