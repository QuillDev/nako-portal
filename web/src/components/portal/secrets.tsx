import { ArrowUpIcon, CheckIcon, ChevronRightIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react"
import { memo, type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { recheckSecret, reloadSecrets, revealSecret, type SecretInfo, secretPath, useSecrets } from "@/lib/secrets"
import type { PortalRequest } from "@/lib/types"

// Long enough for the check in the save button to draw, then for the "saved" line to be read.
const CHECK_MS = 450
const SAVED_MS = 1100

/** A check that draws itself in, for a secret that just saved. */
function SavedCheck({ className }: { className?: string }) {
  return <CheckIcon className={cn("secret-check", className)} />
}

/** Nako asking for a secret: the composer turns into a masked field for it, and she only ever gets its name. */
const SecretComposer = memo(function SecretComposer({ request, answer, onStart, onEnd }: { request: PortalRequest; answer: Portal["answer"]; onStart: () => void; onEnd: () => void }) {
  const { name = "", note, replace } = request.params
  const [value, setValue] = useState("")
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<"ask" | "check" | "saved">("ask")
  const decline = async () => {
    setBusy(true)
    try {
      await answer(request.id, { declined: true })
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!value || busy) return
    setBusy(true)
    // Held on screen through the animation, even once the request is gone.
    onStart()
    if (!(await answer(request.id, { value }))) {
      setBusy(false)
      onEnd()
      return
    }
    setPhase("check")
    setTimeout(() => setPhase("saved"), CHECK_MS)
    setTimeout(onEnd, CHECK_MS + SAVED_MS)
  }
  if (phase === "saved")
    return (
      <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="fade-in-0 slide-in-from-bottom-1 flex h-12 animate-in items-center gap-2.5 rounded-[22px] border bg-card px-4 text-[13px] duration-200" role="status">
          <span className="grid size-5 place-items-center rounded-full bg-primary/15 text-primary">
            <CheckIcon className="size-3 stroke-[2.6]" />
          </span>
          <span className="truncate">
            <span className="font-medium font-mono">{name}</span> <span className="text-muted-foreground">saved</span>
          </span>
        </div>
      </div>
    )
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <form
        className="flex flex-col rounded-[22px] border border-primary/35 bg-card py-1.5 pr-1.5 pl-4 has-[input:focus-visible]:border-primary/60"
        data-secret-request={name}
        onSubmit={e => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex h-8 items-center gap-2 text-[13px]">
          <KeyRoundIcon className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 truncate font-medium font-mono" title={note || undefined}>
            {name}
          </span>
          {replace && <span className="shrink-0 text-muted-foreground">new value</span>}
          <span className="flex-1" />
          <Button aria-label="Not now" className="rounded-full text-muted-foreground" disabled={busy} onClick={decline} size="icon-sm" title="Not now" type="button" variant="ghost">
            <XIcon />
          </Button>
        </div>
        <div className="flex items-center gap-1 pl-6">
          <input
            aria-label={name}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-1p-ignore
            onChange={e => setValue(e.target.value)}
            placeholder="Paste the secret"
            readOnly={phase !== "ask"}
            spellCheck={false}
            type={shown ? "text" : "password"}
            value={value}
          />
          <Button aria-label={shown ? "Hide" : "Show"} className="rounded-full text-muted-foreground" onClick={() => setShown(s => !s)} size="icon-sm" type="button" variant="ghost">
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <Button aria-label={phase === "ask" ? "Save" : "Saved"} className="rounded-full disabled:opacity-100" disabled={!value || busy} size="icon-sm" type="submit">
            {phase === "ask" ? <ArrowUpIcon /> : <SavedCheck />}
          </Button>
        </div>
      </form>
    </div>
  )
})

/** The chat's composer, or the secret Nako is waiting on in its place (kept through the save animation). */
export function SecretDock({ request, answer, children }: { request: PortalRequest | undefined; answer: Portal["answer"]; children: ReactNode }) {
  const [held, setHeld] = useState<PortalRequest | null>(null)
  const shown = held ?? request
  if (!shown) return children
  return <SecretComposer answer={answer} key={shown.id} onEnd={() => setHeld(null)} onStart={() => setHeld(shown)} request={shown} />
}

// Copy without showing: the value is fetched, copied and dropped.
function useCopy(name: string, onError: (message: string) => void) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await revealSecret(name))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      onError((e as Error).message || "couldn't copy")
    }
  }
  return { copied, copy }
}

function useReveal(name: string, onError: (message: string) => void) {
  const [value, setValue] = useState<string | null>(null)
  const toggle = async () => {
    if (value !== null) return setValue(null)
    try {
      setValue(await revealSecret(name))
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return { value, toggle }
}

function SecretActions({ name, onError, reveal }: { name: string; onError: (m: string) => void; reveal: ReturnType<typeof useReveal> }) {
  const { copied, copy } = useCopy(name, onError)
  return (
    <div className="flex shrink-0 items-center">
      <Button aria-label={reveal.value === null ? `Show ${name}` : `Hide ${name}`} onClick={reveal.toggle} size="icon-sm" variant="ghost">
        {reveal.value === null ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
      </Button>
      <Button aria-label={`Copy ${name}`} onClick={copy} size="icon-sm" variant="ghost">
        {copied ? <CheckIcon className="size-4 text-primary" /> : <CopyIcon className="size-4" />}
      </Button>
    </div>
  )
}

function Value({ value }: { value: string | null }) {
  return value === null ? (
    <p aria-hidden className="select-none text-muted-foreground text-sm tracking-[0.2em]">
      ••••••••••••
    </p>
  ) : (
    <p className="select-all whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-5">{value}</p>
  )
}

/** A secret Nako shared in a reply: hidden until you ask, and copyable without showing it. */
export function SharedSecret({ name }: { name: string }) {
  const secrets = useSecrets()
  const [error, setError] = useState("")
  const reveal = useReveal(name, setError)
  const info = secrets ? secrets.find(s => s.name === name) : undefined
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (secrets === null || info) return
    const pending = recheckSecret(name)
    if (pending) void pending.then(() => setChecked(true))
    else setChecked(true)
  }, [secrets, info, name])
  if (secrets === false) return <p className="text-muted-foreground text-sm">{name} is in the agent's secrets.</p>
  if (secrets && !info && checked) return <p className="text-muted-foreground text-sm">{name} is no longer stored.</p>
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5" data-shared-secret={name}>
      <KeyRoundIcon className="mt-1.5 size-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
        <p className="text-sm">
          <span className="font-medium">{name}</span>
          {info?.note && <span className="text-muted-foreground"> · {info.note}</span>}
        </p>
        <Value value={reveal.value} />
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
      <SecretActions name={name} onError={setError} reveal={reveal} />
    </div>
  )
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const fullFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })

// "Nov 7" this year, "Nov 7, 2025" before it.
function shortDate(seconds: number) {
  const d = new Date(seconds * 1000)
  return (d.getFullYear() === new Date().getFullYear() ? dayFormat : fullFormat).format(d)
}

const NAME_CHARS = /[^A-Za-z0-9_]/g

// Search text with case and underscores folded, so "resend api" finds RESEND_API_KEY.
const words = (text: string) => text.toLowerCase().replace(/[_\s]+/g, " ").trim()

// A bottom sheet on phones, a centered panel on wider screens.
const PANEL =
  "gap-3 rounded-[22px] bg-card p-4 sm:max-w-[440px] max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1.75rem,env(safe-area-inset-bottom))] max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom"

// The value field, shaped like the chat composer's secret request: masked input, eye, round save.
function ValueComposer({ label, onSave, busy, done = false, focus = true }: { label: string; onSave: (value: string) => void; busy: boolean; done?: boolean; focus?: boolean }) {
  const [value, setValue] = useState("")
  const [shown, setShown] = useState(false)
  return (
    <form
      className="flex items-center gap-1 rounded-[22px] border border-primary/35 bg-background py-1.5 pr-1.5 pl-4 has-[input:focus-visible]:border-primary/60"
      data-secret-request={label}
      onSubmit={e => {
        e.preventDefault()
        if (value && !busy) onSave(value)
      }}
    >
      <input
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        autoFocus={focus}
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        data-1p-ignore
        data-autofocus={focus ? "" : undefined}
        onChange={e => setValue(e.target.value)}
        placeholder="Paste the value"
        spellCheck={false}
        type={shown ? "text" : "password"}
        value={value}
      />
      <Button aria-label={shown ? "Hide" : "Show"} className="rounded-full text-muted-foreground" onClick={() => setShown(s => !s)} size="icon-sm" type="button" variant="ghost">
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button aria-label={done ? "Saved" : "Save"} className="rounded-full disabled:opacity-100" disabled={!value || busy || done} size="icon-sm" type="submit">
        {done ? <SavedCheck /> : <ArrowUpIcon />}
      </Button>
    </form>
  )
}

function useSave(onError: (m: string) => void) {
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await reloadSecrets()
      return true
    } catch (e) {
      onError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
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

/** One stored secret: its value (hidden until asked), note, and replace or delete. */
function SecretPanel({ secret, onClose, onError }: { secret: SecretInfo; onClose: () => void; onError: (m: string) => void }) {
  const reveal = useReveal(secret.name, onError)
  const { copied, copy } = useCopy(secret.name, onError)
  const [replacing, setReplacing] = useState(false)
  const [done, setDone] = useState(false)
  const { busy, run } = useSave(onError)
  const replace = async (value: string) => {
    if (!(await run(() => api(secretPath(secret.name), { method: "POST", body: { value } })))) return
    setDone(true)
    setTimeout(() => {
      setDone(false)
      setReplacing(false)
    }, CHECK_MS + 150)
  }
  const remove = async () => {
    if (!confirm(`Delete ${secret.name}? Nako won't be able to use it any more.`)) return
    if (await run(() => api(`${secretPath(secret.name)}/remove`, { method: "POST" }))) onClose()
  }
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <KeyRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="min-w-0 flex-1 truncate font-medium font-mono text-sm leading-8">{secret.name}</DialogTitle>
        <CloseButton />
      </DialogHeader>
      {replacing ? (
        <ValueComposer busy={busy} done={done} label={`New value for ${secret.name}`} onSave={replace} />
      ) : (
        <div className="flex items-start gap-1 rounded-[22px] border bg-background py-1.5 pr-1.5 pl-4">
          <div className="min-w-0 flex-1 py-1.5">
            <Value value={reveal.value} />
          </div>
          <Button aria-label={reveal.value === null ? "Show" : "Hide"} className="rounded-full text-muted-foreground" onClick={reveal.toggle} size="icon-sm" variant="ghost">
            {reveal.value === null ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
          <Button aria-label="Copy" className="rounded-full text-muted-foreground" onClick={copy} size="icon-sm" variant="ghost">
            {copied ? <CheckIcon className="text-primary" /> : <CopyIcon />}
          </Button>
        </div>
      )}
      {secret.note && <DialogDescription className="wrap-anywhere px-4 text-foreground">{secret.note}</DialogDescription>}
      <p className="px-4 text-muted-foreground text-xs">Updated {fullFormat.format(new Date(secret.updated_at * 1000))}</p>
      <div className="flex items-center gap-2 pt-1">
        <Button className="px-2 text-destructive hover:text-destructive" disabled={busy} onClick={remove} size="sm" variant="ghost">
          <Trash2Icon />
          Delete
        </Button>
        <span className="flex-1" />
        {replacing ? (
          <Button onClick={() => setReplacing(false)} size="sm" variant="ghost">
            Cancel
          </Button>
        ) : (
          <Button className="rounded-full" onClick={() => setReplacing(true)} size="sm" variant="outline">
            Replace value
          </Button>
        )}
      </div>
    </>
  )
}

/** A new secret: name and note as plain lines, the value in the composer-style field. */
function NewSecretPanel({ initialName, onClose, onError }: { initialName: string; onClose: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState(initialName)
  const [note, setNote] = useState("")
  const [done, setDone] = useState(false)
  const { busy, run } = useSave(onError)
  const save = async (value: string) => {
    if (!name) return onError("Give it a name first")
    if (!(await run(() => api(secretPath(name), { method: "POST", body: { value, note } })))) return
    setDone(true)
    setTimeout(onClose, CHECK_MS + 150)
  }
  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 text-left">
        <KeyRoundIcon className="size-4 shrink-0 text-primary" />
        <DialogTitle className="sr-only">New secret</DialogTitle>
        <input
          aria-label="Name"
          autoCapitalize="off"
          autoComplete="off"
          data-autofocus={initialName ? undefined : ""}
          className="h-8 min-w-0 flex-1 bg-transparent font-medium font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
          maxLength={64}
          onChange={e => setName(e.target.value.replace(NAME_CHARS, "_"))}
          placeholder="SECRET_NAME"
          spellCheck={false}
          value={name}
        />
        <CloseButton />
      </DialogHeader>
      <DialogDescription className="sr-only">Name it, say what it's for, then paste the value</DialogDescription>
      <input
        aria-label="Note"
        className="-mt-2 h-7 bg-transparent pl-6 text-muted-foreground text-sm outline-none placeholder:text-muted-foreground/70"
        maxLength={500}
        onChange={e => setNote(e.target.value)}
        placeholder="What it's for"
        value={note}
      />
      <ValueComposer busy={busy} done={done} focus={!!initialName} label={name ? `Value for ${name}` : "Value"} onSave={save} />
    </>
  )
}

type Open = { kind: "secret"; name: string } | { kind: "new"; name: string } | null

/** Settings > Secrets: search what's stored, open one to see or change it, add new ones. */
export function SecretsSettings({ onError }: { onError: (m: string) => void }) {
  const secrets = useSecrets()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Open>(null)
  if (!secrets) return null
  const typed = words(query)
  const shown = typed ? secrets.filter(s => words(`${s.name} ${s.note}`).includes(typed)) : secrets
  const current = open?.kind === "secret" ? secrets.find(s => s.name === open.name) : undefined
  // A search that matches no name starts the new secret with it.
  const startNew = () => setOpen({ kind: "new", name: secrets.some(s => words(s.name) === typed) ? "" : query.trim().replace(NAME_CHARS, "_").toUpperCase() })
  const close = () => setOpen(null)
  return (
    <>
      <div className="flex items-center gap-2 pb-1">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card px-3.5 has-[input:focus-visible]:border-ring">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input aria-label="Search secrets" className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" onChange={e => setQuery(e.target.value)} enterKeyHint="search" placeholder="Search secrets" spellCheck={false} value={query} />
        </label>
        <Button aria-label="Add secret" className="size-10 rounded-full" onClick={startNew} size="icon" title="Add secret">
          <PlusIcon className="size-[18px]" />
        </Button>
      </div>
      <div className="flex flex-col">
        {shown.map(s => (
          <button
            className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-secret-row={s.name}
            key={s.name}
            onClick={() => setOpen({ kind: "secret", name: s.name })}
            type="button"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium font-mono text-[13px] leading-5">{s.name}</span>
              {s.note && <span className="truncate text-muted-foreground text-xs leading-4">{s.note}</span>}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs">{shortDate(s.updated_at)}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {!shown.length && <p className="py-4 text-muted-foreground text-sm">{typed ? `No secrets match "${query.trim()}".` : "No secrets yet."}</p>}
      </div>
      <Dialog onOpenChange={o => !o && close()} open={open !== null && (open.kind === "new" || !!current)}>
        <DialogContent
          className={PANEL}
          // Start in the field you'd type in (the value, or the name when there's none yet), never on the close button.
          onOpenAutoFocus={e => {
            e.preventDefault()
            const target = e.currentTarget instanceof HTMLElement ? e.currentTarget.querySelector<HTMLElement>("[data-autofocus]") : null
            if (target) target.focus()
            else if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus()
          }}
          showCloseButton={false}
        >
          {open?.kind === "new" && <NewSecretPanel initialName={open.name} onClose={close} onError={onError} />}
          {current && <SecretPanel key={current.name} onClose={close} onError={onError} secret={current} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
