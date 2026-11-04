import { ArrowUpIcon, CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, Trash2Icon } from "lucide-react"
import { memo, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { recheckSecret, reloadSecrets, revealSecret, type SecretInfo, secretPath, useSecrets } from "@/lib/secrets"
import type { PortalRequest } from "@/lib/types"

// A masked field with a show/hide eye; the value never leaves this component until it's saved.
function SecretField({ value, onChange, onEnter, label, autoFocus }: { value: string; onChange: (v: string) => void; onEnter?: () => void; label: string; autoFocus?: boolean }) {
  const [shown, setShown] = useState(false)
  return (
    <InputGroup className="h-9">
      <InputGroupInput
        aria-label={label}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        autoFocus={autoFocus}
        data-1p-ignore
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => e.key === "Enter" && onEnter?.()}
        placeholder="Paste or type it"
        spellCheck={false}
        type={shown ? "text" : "password"}
        value={value}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton aria-label={shown ? "Hide" : "Show"} onClick={() => setShown(s => !s)} size="icon-xs">
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

/** Nako asking for a secret: the composer turns into a masked field for it, and she only ever gets its name. */
export const SecretComposer = memo(function SecretComposer({ request, answer }: { request: PortalRequest; answer: Portal["answer"] }) {
  const { name = "", note, replace } = request.params
  const [value, setValue] = useState("")
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const send = async (result: Record<string, unknown>) => {
    setBusy(true)
    try {
      await answer(request.id, result)
    } finally {
      setBusy(false)
    }
  }
  const save = () => value && !busy && send({ value })
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <form
        className="flex flex-col gap-1 rounded-[22px] border border-primary/35 bg-card py-2.5 pr-2.5 pl-4 has-[input:focus-visible]:border-primary/60"
        data-secret-request={name}
        onSubmit={e => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-wrap items-start gap-x-2 text-[13px] leading-7">
          <KeyRoundIcon className="mt-1.5 size-4 shrink-0 text-primary" />
          <span className="font-medium font-mono">{name}</span>
          {replace && <span className="text-muted-foreground">new value</span>}
          {note && <span className="order-last min-w-0 basis-full py-1 pl-6 leading-5 text-muted-foreground sm:order-none sm:basis-0 sm:flex-1 sm:pl-0">{note}</span>}
          <Button className="ml-auto h-7 px-2 text-[13px] text-muted-foreground sm:ml-0" disabled={busy} onClick={() => send({ declined: true })} size="sm" type="button" variant="ghost">
            Not now
          </Button>
        </div>
        <div className="flex items-center gap-1">
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
            spellCheck={false}
            type={shown ? "text" : "password"}
            value={value}
          />
          <Button aria-label={shown ? "Hide" : "Show"} className="rounded-full text-muted-foreground" onClick={() => setShown(s => !s)} size="icon-sm" type="button" variant="ghost">
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
          <Button aria-label="Save" className="rounded-full" disabled={!value || busy} size="icon-sm" type="submit">
            <ArrowUpIcon />
          </Button>
        </div>
      </form>
    </div>
  )
})

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

function SecretRow({ secret, onError }: { secret: SecretInfo; onError: (m: string) => void }) {
  const reveal = useReveal(secret.name, onError)
  const remove = async () => {
    if (!confirm(`Delete ${secret.name}? Nako won't be able to use it any more.`)) return
    try {
      await api(`${secretPath(secret.name)}/remove`, { method: "POST" })
      await reloadSecrets()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <div className="flex items-start gap-3 py-1.5 text-sm" data-secret-row={secret.name}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1.5">
        <p className="truncate">
          <span className="font-medium">{secret.name}</span>
          {secret.note && <span className="text-muted-foreground"> · {secret.note}</span>}
        </p>
        {reveal.value !== null && <Value value={reveal.value} />}
      </div>
      <SecretActions name={secret.name} onError={onError} reveal={reveal} />
      <Button aria-label={`Delete ${secret.name}`} className="-ml-1" onClick={remove} size="icon-sm" variant="ghost">
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  )
}

function AddSecret({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [note, setNote] = useState("")
  const save = async () => {
    if (!name || !value) return
    try {
      await api(secretPath(name.trim()), { method: "POST", body: { value, note } })
      await reloadSecrets()
      onDone()
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <Input aria-label="Name" autoCapitalize="off" autoComplete="off" className="h-9" onChange={e => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))} placeholder="NAME_LIKE_THIS" spellCheck={false} value={name} />
      <SecretField label="Value" onChange={setValue} onEnter={save} value={value} />
      <Input aria-label="Note" className="h-9" maxLength={500} onChange={e => setNote(e.target.value)} placeholder="What it's for" value={note} />
      <div className="flex justify-end gap-2">
        <Button onClick={onDone} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button disabled={!name || !value} onClick={save} size="sm">
          Save
        </Button>
      </div>
    </div>
  )
}

/** Settings > Secrets: everything stored, revealed one at a time. */
export function SecretsSettings({ onError }: { onError: (m: string) => void }) {
  const secrets = useSecrets()
  const [adding, setAdding] = useState(false)
  if (!secrets) return null
  return (
    <>
      {secrets.map(s => (
        <SecretRow key={s.name} onError={onError} secret={s} />
      ))}
      {adding ? (
        <AddSecret onDone={() => setAdding(false)} onError={onError} />
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            Add secret
          </Button>
        </div>
      )}
    </>
  )
}
