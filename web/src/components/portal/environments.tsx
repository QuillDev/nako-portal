import { LoaderCircleIcon, MessageSquareIcon, RotateCwIcon, SquareIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { type Environment, loadEnvironments, STATUS_DOT, stopEnvironment, useEnvironments } from "@/lib/environments"
import { gigabytes } from "@/lib/machine-load"
import { useChatTitle } from "@/lib/session-refs"
import { cn } from "@/lib/utils"

// The chat this environment belongs to, by its title.
function ChatLink({ session, className }: { session: string; className?: string }) {
  const title = useChatTitle(session)
  return (
    <a className={cn("flex min-w-0 shrink items-center gap-1 text-muted-foreground text-xs hover:text-foreground", className)} href={`#/c/${session}`} title={title || session}>
      <MessageSquareIcon className="size-3 shrink-0" />
      <span className="max-w-48 truncate">{title || "chat"}</span>
    </a>
  )
}

function Row({
  env,
  onStop,
  stopping = false,
  stopError,
}: {
  env: Environment
  onStop?: (env: Environment) => void
  stopping?: boolean
  stopError?: string
}) {
  const up = env.status !== "stopped"
  // Memory and Stop take the row's end; on phones the chat link then moves down beside the links.
  const crowded = up && (env.memory !== undefined || onStop !== undefined)
  return (
    <li className="flex flex-col gap-2 py-3" data-environment={env.name}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[env.status])} title={env.status} />
        <span className={cn("truncate text-sm", up ? "font-medium" : "text-muted-foreground")}>{env.name}</span>
        {env.detail && <span className="truncate text-muted-foreground text-xs">{env.detail}</span>}
        <span className="flex-1" />
        {env.session && <ChatLink className={cn(crowded && "max-sm:hidden")} session={env.session} />}
        {up && env.memory !== undefined && (
          <span className="w-14 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{gigabytes(env.memory)}</span>
        )}
        {up && onStop && (
          <Button
            aria-busy={stopping || undefined}
            aria-label={stopping ? `Stopping ${env.name}` : `Stop ${env.name}`}
            className="size-7 shrink-0 text-muted-foreground"
            disabled={stopping}
            onClick={() => onStop(env)}
            size="icon"
            title={stopping ? "Stopping…" : "Stop"}
            variant="outline"
          >
            {stopping ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <SquareIcon className="size-2.5 fill-current" />}
          </Button>
        )}
      </div>
      {up && (env.links.length > 0 || (crowded && env.session)) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-[18px]">
          {env.links.map(link => (
            <a
              className="rounded-md border px-2 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              href={link.url}
              key={link.url}
              rel="noreferrer"
              target="_blank"
            >
              {link.label}
            </a>
          ))}
          {crowded && env.session && <ChatLink className="ml-auto sm:hidden" session={env.session} />}
        </div>
      )}
      {stopError && (
        <p className="pl-[18px] text-destructive text-xs" role="alert">
          {stopError}
        </p>
      )}
    </li>
  )
}

/** Settings > Environments: whatever the owner's command says runs on this machine, with links to open each. */
export function EnvironmentsSettings() {
  const { data, error, stopping, stopErrors } = useEnvironments(true, 10_000)
  const [busy, setBusy] = useState(false)
  const onStop = data?.can_stop ? (env: Environment) => void stopEnvironment(env.name) : undefined
  const live = data?.environments.filter(env => env.status !== "stopped") ?? []
  const stopped = data?.environments.filter(env => env.status === "stopped") ?? []
  return (
    <div className="flex flex-col">
      {error && <p className="py-3 text-destructive text-sm">{error}</p>}
      {data && data.environments.length === 0 && <p className="py-10 text-center text-muted-foreground text-sm">Nothing here yet.</p>}
      {live.length > 0 && (
        <ul className="divide-y">
          {live.map(env => (
            <Row env={env} key={env.name} onStop={onStop} stopError={stopErrors[env.name]} stopping={stopping.has(env.name)} />
          ))}
        </ul>
      )}
      {stopped.length > 0 && (
        <>
          <p className="pt-6 pb-1 text-muted-foreground text-xs">Stopped</p>
          <ul className="divide-y">{stopped.map(env => <Row env={env} key={env.name} />)}</ul>
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1 pt-4">
        {data?.links.map(link => (
          <Button asChild key={link.url} size="sm" variant="ghost">
            <a href={link.url} rel="noreferrer" target="_blank">
              {link.label}
            </a>
          </Button>
        ))}
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void loadEnvironments(true).finally(() => setBusy(false))
          }}
          size="sm"
          variant="outline"
        >
          <RotateCwIcon className={cn(busy && "animate-spin")} />
          Refresh
        </Button>
      </div>
    </div>
  )
}
