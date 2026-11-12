import { ArrowUpIcon, CheckIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, PlusIcon, UserRoundIcon, SearchIcon, TerminalIcon, XIcon } from "lucide-react"
import { memo, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  type Account,
  type AccountResult,
  type AccountSignIn,
  cancelAccountSignIn,
  finishAccountSignIn,
  pollAccountSignIn,
  pollSignIn,
  removeProviderKey,
  reloadProviders,
  setProviderKey,
  startAccountSignIn,
  startSignIn,
  type Provider,
  type SignIn,
  useProviders,
} from "@/lib/providers"

// Long enough for the check in the save button to draw, then for the "saved" line to be read.
const CHECK_MS = 450
const SAVED_MS = 1100

const PANEL =
  "gap-3 rounded-[22px] bg-card p-4 sm:max-w-[440px] max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1.75rem,env(safe-area-inset-bottom))] max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom"

const words = (text: string) => text.toLowerCase().replace(/[_\-./]+/g, " ").trim()

/** A check that draws itself in, for something that just saved. */
function SavedCheck({ className }: { className?: string }) {
  return <CheckIcon className={cn("secret-check", className)} />
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

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      aria-label={label}
      className="rounded-full text-muted-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      size="icon-sm"
      variant="ghost"
    >
      {copied ? <CheckIcon className="text-primary" /> : <CopyIcon />}
    </Button>
  )
}

/** The key field, shaped like the chat composer's secret request: masked, eye, round save. */
function KeyField({ label, onSave, busy, done = false, placeholder = "Paste your API key" }: { label: string; onSave: (value: string) => void; busy: boolean; done?: boolean; placeholder?: string }) {
  const [value, setValue] = useState("")
  const [shown, setShown] = useState(false)
  return (
    <form
      className="flex items-center gap-1 rounded-[22px] border border-primary/35 bg-background py-1.5 pr-1.5 pl-4 has-[input:focus-visible]:border-primary/60"
      data-secret-request={label}
      onSubmit={e => {
        e.preventDefault()
        if (value.trim() && !busy) onSave(value.trim())
      }}
    >
      <input
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        autoFocus
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        data-1p-ignore
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        type={shown ? "text" : "password"}
        value={value}
      />
      <Button aria-label={shown ? "Hide" : "Show"} className="rounded-full text-muted-foreground" onClick={() => setShown(s => !s)} size="icon-sm" type="button" variant="ghost">
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button aria-label={done ? "Saved" : "Save"} className="rounded-full disabled:opacity-100" disabled={!value.trim() || busy || done} size="icon-sm" type="submit">
        {done ? <SavedCheck /> : <ArrowUpIcon />}
      </Button>
    </form>
  )
}

/** Waiting on the provider's own page: the code to type there, and nothing to do until it's done. */
const SignInPanel = memo(function SignInPanel({ provider, onDone, onError }: { provider: Provider; onDone: () => void; onError: (message: string) => void }) {
  const [started, setStarted] = useState<SignIn | null>(null)
  const [status, setStatus] = useState<"starting" | "pending" | "error">("starting")
  const [message, setMessage] = useState("")
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    startSignIn(provider.slug).then(
      signIn => {
        if (!live) return
        setStarted(signIn)
        setStatus("pending")
      },
      (e: Error) => {
        if (!live) return
        setStatus("error")
        setMessage(e.message)
        onError(e.message)
      },
    )
    return () => {
      live = false
    }
  }, [provider.slug, onError])

  // Poll while it's pending: the gateway's worker saves the login the moment the page approves it.
  useEffect(() => {
    if (!started || status !== "pending") return
    const every = Math.max(2, started.poll_interval || 5) * 1000
    timer.current = window.setInterval(() => {
      pollSignIn(provider.slug, started.session_id).then(
        state => {
          if (state.status === "approved") {
            setStatus("error")
            setMessage("")
            void reloadProviders().then(onDone)
          } else if (state.status !== "pending") {
            setStatus("error")
            setMessage(state.error || `The sign-in ${state.status}. Try again.`)
          }
        },
        e => {
          setStatus("error")
          setMessage((e as Error).message)
        },
      )
    }, every)
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [started, status, provider.slug, onDone])

  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <KeyRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-sm leading-8">{provider.label}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      {status === "pending" && started ? (
        <>
          <DialogDescription className="px-1 text-foreground">Enter this code on the sign-in page. The account is shared by every profile.</DialogDescription>
          <div className="flex h-16 items-center justify-center gap-2 rounded-[22px] border bg-background font-mono font-medium text-2xl tracking-[0.12em]">
            {started.user_code}
            <CopyButton label="Copy code" value={started.user_code} />
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="size-2 rounded-full bg-primary/70" />
              Waiting for you to approve
            </span>
            <span className="flex-1" />
            <Button asChild className="rounded-full" size="sm">
              <a href={started.verification_url} rel="noreferrer" target="_blank">
                Open sign-in page
                <ExternalLinkIcon />
              </a>
            </Button>
          </div>
        </>
      ) : status === "error" && !message ? (
        <p className="flex items-center gap-2 px-1 text-sm">
          <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-primary">
            <CheckIcon className="size-3 stroke-[2.6]" />
          </span>
          <span>
            <span className="font-medium">{provider.label}</span> <span className="text-muted-foreground">connected</span>
          </span>
        </p>
      ) : status === "error" ? (
        <p className="px-1 text-destructive text-sm">{message}</p>
      ) : (
        <p className="px-1 text-muted-foreground text-sm">Asking {provider.label} for a code…</p>
      )}
    </>
  )
})

/** A provider that signs in from a terminal: the command to run, and nothing to wait for. */
function CommandPanel({ provider }: { provider: Provider }) {
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <TerminalIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-sm leading-8">{provider.label}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      <DialogDescription className="px-1 text-foreground">{provider.label} signs in from a terminal on this machine.</DialogDescription>
      <div className="flex items-center gap-1 rounded-[22px] border bg-background py-1.5 pr-1.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{provider.command}</code>
        <CopyButton label="Copy command" value={provider.command} />
      </div>
    </>
  )
}

/** A key already saved: where it lives, and the two things you can do to it. */
function KeyPanel({ provider, onClose, onError }: { provider: Provider; onClose: () => void; onError: (message: string) => void }) {
  const [replacing, setReplacing] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const replace = async (value: string) => {
    setBusy(true)
    try {
      await setProviderKey(provider.slug, value)
      await reloadProviders()
      setDone(true)
      setTimeout(() => {
        setDone(false)
        setReplacing(false)
      }, CHECK_MS + 150)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Remove this key? ${provider.label} stops working until you add another.`)) return
    setBusy(true)
    try {
      await removeProviderKey(provider.slug)
      await reloadProviders()
      onClose()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <KeyRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-sm leading-8">{provider.label}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      {replacing ? (
        <KeyField busy={busy} done={done} label={`New key for ${provider.label}`} onSave={replace} />
      ) : (
        <p className="px-1 text-muted-foreground text-sm">An API key is saved for this profile.</p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button className="px-2 text-destructive hover:text-destructive" disabled={busy} onClick={remove} size="sm" variant="ghost">
          Remove
        </Button>
        <span className="flex-1" />
        {replacing ? (
          <Button onClick={() => setReplacing(false)} size="sm" variant="ghost">
            Cancel
          </Button>
        ) : (
          <Button className="rounded-full" onClick={() => setReplacing(true)} size="sm" variant="outline">
            Replace key
          </Button>
        )}
      </div>
    </>
  )
}

/** A key for a provider that has none yet: paste it, and it's done. */
function NewKeyPanel({ provider, onClose, onError }: { provider: Provider; onClose: () => void; onError: (message: string) => void }) {
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async (value: string) => {
    setBusy(true)
    try {
      await setProviderKey(provider.slug, value)
      await reloadProviders()
      setDone(true)
      setTimeout(onClose, CHECK_MS + SAVED_MS)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <KeyRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-sm leading-8">{provider.label}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      <DialogDescription className="px-1 text-foreground">
        {done ? "Saved." : "Paste your API key. It's saved to the profile you're using."}
      </DialogDescription>
      <KeyField busy={busy} done={done} label={`Key for ${provider.label}`} onSave={save} />
      {!done && provider.signup_url && (
        <p className="px-1 text-muted-foreground text-xs">
          Get one at{" "}
          <a className="text-foreground underline underline-offset-3 decoration-input" href={provider.signup_url} rel="noreferrer" target="_blank">
            {provider.signup_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </a>
        </p>
      )}
    </>
  )
}

const accountTitle = (a: Account) => a.email || a.label
const accountLine = (a: Account) =>
  [a.email && a.label !== a.email ? a.label : "", a.plan, a.signed_in ? "signed in" : "signed out"].filter(Boolean).join(" · ")

type AccountView = { kind: "list"; notice?: AccountResult } | { kind: "signin"; target?: string }

/** A provider that can hold several accounts: each one, signing one in again, and adding another. */
function AccountsPanel({ provider, onError }: { provider: Provider; onError: (message: string) => void }) {
  const [view, setView] = useState<AccountView>({ kind: "list" })
  const accounts = provider.accounts ?? []
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <UserRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium text-sm leading-8">{provider.label}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      {view.kind === "signin" ? (
        <AccountSignInFlow
          key={view.target ?? "new"}
          onDone={result => setView({ kind: "list", notice: result })}
          onError={onError}
          provider={provider}
          target={view.target}
        />
      ) : (
        <>
          {view.notice && (
            <p className="flex items-center gap-2 px-1 text-sm" data-account-notice={view.notice.outcome}>
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                <CheckIcon className="size-3 stroke-[2.6]" />
              </span>
              <span className="min-w-0">
                {view.notice.outcome === "added" ? "Added " : "Refreshed "}
                <span className="font-medium">{view.notice.email || view.notice.label}</span>
                {view.notice.outcome === "added"
                  ? view.notice.plan
                    ? ` (${view.notice.plan})`
                    : ""
                  : ". It was already here, so nothing was added."}
              </span>
            </p>
          )}
          <div className="flex flex-col">
            {accounts.map(a => (
              <div className="flex items-center gap-3 px-1 py-2" data-account={a.id} key={a.id}>
                <span className={cn("size-2 shrink-0 rounded-full", a.signed_in ? "bg-primary" : "border-[1.5px] border-muted-foreground")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{accountTitle(a)}</span>
                  <span className="block truncate text-muted-foreground text-xs">{accountLine(a)}</span>
                </span>
                <Button
                  className={cn("rounded-full", a.signed_in && "text-muted-foreground")}
                  onClick={() => setView({ kind: "signin", target: a.id })}
                  size="sm"
                  variant={a.signed_in ? "ghost" : "outline"}
                >
                  {a.signed_in ? "Sign in again" : "Sign in"}
                </Button>
              </div>
            ))}
            {accounts.length === 0 && <p className="px-1 py-2 text-muted-foreground text-sm">No accounts yet.</p>}
          </div>
          <div className="flex justify-end pt-1">
            <Button className="rounded-full" onClick={() => setView({ kind: "signin" })} size="sm" variant="outline">
              <PlusIcon />
              Add an account
            </Button>
          </div>
        </>
      )}
    </>
  )
}

/** One sign-in: a link and the code it shows (paste), or a code to enter on the provider's page. */
function AccountSignInFlow({
  provider,
  target,
  onDone,
  onError,
}: {
  provider: Provider
  target?: string
  onDone: (result: AccountResult) => void
  onError: (message: string) => void
}) {
  const [started, setStarted] = useState<AccountSignIn | null>(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const finished = useRef(false)
  const reportError = useRef(onError)
  reportError.current = onError

  useEffect(() => {
    let live = true
    let attempt = ""
    startAccountSignIn(provider.slug, target).then(
      signIn => {
        attempt = signIn.attempt
        if (live) setStarted(signIn)
        else void cancelAccountSignIn(provider.slug, attempt).catch(() => {})
      },
      (e: Error) => {
        if (!live) return
        setMessage(e.message)
        reportError.current(e.message)
      },
    )
    return () => {
      live = false
      // Closing the panel mid-way stops the sign-in on the gateway too.
      if (attempt && !finished.current) void cancelAccountSignIn(provider.slug, attempt).catch(() => {})
    }
  }, [provider.slug, target])

  const done = (result: AccountResult) => {
    finished.current = true
    void reloadProviders().then(() => onDone(result))
  }

  // A code sign-in finishes on the provider's page: poll until the gateway has linked it.
  useEffect(() => {
    if (!started || started.mode !== "code") return
    const every = Math.max(2, started.poll_interval || 5) * 1000
    const timer = window.setInterval(() => {
      pollAccountSignIn(provider.slug, started.attempt).then(
        state => {
          if (state.status === "done" && state.result) {
            window.clearInterval(timer)
            done(state.result)
          } else if (state.status !== "pending") {
            window.clearInterval(timer)
            finished.current = true
            setMessage(state.error || `The sign-in ${state.status}. Try again.`)
          }
        },
        e => {
          window.clearInterval(timer)
          setMessage((e as Error).message)
        },
      )
    }, every)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, provider.slug])

  const redeem = async (code: string) => {
    if (!started) return
    setBusy(true)
    setMessage("")
    try {
      done(await finishAccountSignIn(provider.slug, started.attempt, code))
    } catch (e) {
      finished.current = true
      setMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (message) return <p className="px-1 text-destructive text-sm">{message}</p>
  if (!started) return <p className="px-1 text-muted-foreground text-sm">Asking {provider.label} for a sign-in link…</p>
  const open = (
    <Button asChild className="rounded-full" size="sm">
      <a href={started.mode === "paste" ? started.url : started.verification_url} rel="noreferrer" target="_blank">
        Open sign-in page
        <ExternalLinkIcon />
      </a>
    </Button>
  )
  if (started.mode === "code") {
    return (
      <>
        <DialogDescription className="px-1 text-foreground">Enter this code on the sign-in page.</DialogDescription>
        <div className="flex h-16 items-center justify-center gap-2 rounded-[22px] border bg-background font-mono font-medium text-2xl tracking-[0.12em]">
          {started.user_code}
          <CopyButton label="Copy code" value={started.user_code ?? ""} />
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="size-2 rounded-full bg-primary/70" />
            Waiting for you to sign in
          </span>
          <span className="flex-1" />
          {open}
        </div>
      </>
    )
  }
  return (
    <>
      <DialogDescription className="px-1 text-foreground">Sign in with the account to add or refresh, then paste the code it shows you.</DialogDescription>
      <div className="flex justify-end">{open}</div>
      <KeyField busy={busy} label={`Sign-in code for ${provider.label}`} onSave={redeem} placeholder="Paste the code" />
      <p className="px-1 text-muted-foreground text-xs">An account that's already here gets its sign-in refreshed. A new one is added.</p>
    </>
  )
}

/** The picker: everything Hermes offers that this page can set up, searched by name. */
function AddPanel({ rows, onPick }: { rows: Provider[]; onPick: (provider: Provider) => void }) {
  const [query, setQuery] = useState("")
  const typed = words(query)
  const shown = typed ? rows.filter(r => words(`${r.label} ${r.slug} ${r.description}`).includes(typed)) : rows
  const accounts = shown.filter(r => r.kind !== "key")
  const keys = shown.filter(r => r.kind === "key")
  const row = (provider: Provider) => (
    <button className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent" key={provider.slug} onClick={() => onPick(provider)} type="button">
      <span className="min-w-0 flex-1 truncate">{provider.label}</span>
      {provider.connected && <CheckIcon className="size-4 text-primary" />}
      <ChevronRightIcon className="size-4 text-muted-foreground" />
    </button>
  )
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <DialogTitle className="min-w-0 flex-1 font-medium text-sm leading-8">Add a provider</DialogTitle>
        <CloseButton />
      </DialogHeader>
      <label className="flex h-10 items-center gap-2 rounded-full border border-input bg-background px-3.5 has-[input:focus-visible]:border-ring">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          aria-label="Search providers"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={e => setQuery(e.target.value)}
          placeholder="Search providers"
          spellCheck={false}
          value={query}
        />
      </label>
      <div className="-mx-4 max-h-[60vh] overflow-y-auto px-4">
        {accounts.length > 0 && <p className="pt-1 pb-1 text-muted-foreground text-xs">Sign in with an account</p>}
        {accounts.map(row)}
        {keys.length > 0 && <p className="pt-3 pb-1 text-muted-foreground text-xs">API key</p>}
        {keys.map(row)}
        {shown.length === 0 && <p className="py-3 text-muted-foreground text-sm">Nothing matches {query.trim()}.</p>}
      </div>
    </>
  )
}

type Open = { kind: "provider"; slug: string } | { kind: "add" } | null

/** Settings > Providers: what Hermes can run on, what's set up, and adding the rest. */
export function ProvidersSettings({ onError }: { onError: (message: string) => void }) {
  const providers = useProviders()
  const [open, setOpen] = useState<Open>(null)
  if (!providers) return null
  const connected = providers.filter(p => p.connected || (p.accounts?.length ?? 0) > 0)
  const current = open?.kind === "provider" ? providers.find(p => p.slug === open.slug) : undefined
  const close = () => setOpen(null)
  return (
    <>
      <p className="pb-1 text-muted-foreground text-xs">Accounts and keys this profile can run on</p>
      <div className="flex flex-col">
        {connected.map(p => (
          <button
            className="flex w-full items-center gap-3 rounded-md px-1 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
            key={p.slug}
            onClick={() => setOpen({ kind: "provider", slug: p.slug })}
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{p.label}</span>
              <span className="block truncate text-muted-foreground text-xs">{p.kind === "key" ? "API key" : p.accounts?.some(a => !a.signed_in) ? "needs sign-in" : "signed in"}</span>
            </span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </button>
        ))}
        {connected.length === 0 && <p className="px-1 py-2 text-muted-foreground text-sm">Nothing set up yet.</p>}
        <div className="flex justify-end pt-2">
          <Button onClick={() => setOpen({ kind: "add" })} size="sm" variant="outline">
            <PlusIcon />
            Add a provider
          </Button>
        </div>
      </div>
      <Dialog onOpenChange={next => !next && close()} open={open !== null}>
        <DialogContent className={PANEL} data-provider-panel={open?.kind === "add" ? "add" : current?.slug || ""} onOpenAutoFocus={e => e.preventDefault()} showCloseButton={false}>
          {open?.kind === "add" ? (
            <AddPanel
              onPick={provider => setOpen({ kind: "provider", slug: provider.slug })}
              rows={providers}
            />
          ) : current ? (
            current.accounts ? (
              <AccountsPanel key={current.slug} onError={onError} provider={current} />
            ) : current.kind === "key" ? (
              current.connected ? (
                <KeyPanel key={current.slug} onClose={close} onError={onError} provider={current} />
              ) : (
                <NewKeyPanel key={current.slug} onClose={close} onError={onError} provider={current} />
              )
            ) : current.kind === "signin" ? (
              <SignInPanel key={current.slug} onDone={close} onError={onError} provider={current} />
            ) : (
              <CommandPanel key={current.slug} provider={current} />
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
