import { ArrowUpIcon, CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, XIcon } from "lucide-react"
import { memo, type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { Portal } from "@/hooks/use-portal"
import { cn } from "@/lib/utils"
import { recheckSecret, revealSecret, useSecrets } from "@/lib/secrets"
import type { PortalRequest } from "@/lib/types"

// Long enough for the check in the save button to draw, then for the "saved" line to be read.
export const CHECK_MS = 450
const SAVED_MS = 1100

/** A check that draws itself in, for a secret that just saved. */
export function SavedCheck({ className }: { className?: string }) {
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
export function useCopy(name: string, onError: (message: string) => void) {
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

export function useReveal(name: string, onError: (message: string) => void) {
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

export function Value({ value }: { value: string | null }) {
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
