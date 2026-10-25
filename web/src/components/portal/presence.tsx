import { CheckIcon, XIcon } from "lucide-react"
import type { Live } from "@/lib/types"

export type Activity = "thinking" | "tools" | "replying"

// A tool running wins; otherwise a reply that has started streaming; otherwise she's thinking.
export function activity(live: Live | null): Activity {
  if (live?.tools.some(t => t.state === "running")) return "tools"
  if (live?.messages.some(m => m.text.trim())) return "replying"
  return "thinking"
}

const SAYS: Record<Activity, string> = { thinking: "hmm, let me think", tools: "on it", replying: "writing it up" }
const SHOWN_TOOLS = 3

function Dots() {
  return (
    <span aria-hidden className="ml-0.5 inline-flex gap-[3px] align-middle">
      {[0, 1, 2].map(i => (
        <i className="size-1 animate-bounce rounded-full bg-primary/70" key={i} style={{ animationDelay: `${i * 0.15}s`, animationDuration: "1.1s" }} />
      ))}
    </span>
  )
}

// Nako docked above the composer while a turn runs: her sticker for what she's doing, and a
// bubble saying it, with this turn's latest tool calls while she's using them.
export function Presence({ live }: { live: Live | null }) {
  const now = activity(live)
  const tools = now === "tools" ? (live?.tools ?? []).slice(-SHOWN_TOOLS) : []
  return (
    <div aria-live="polite" className="mx-auto flex w-full max-w-3xl items-end gap-2.5 px-4 pb-1" data-activity={now}>
      <picture className="-ml-1.5 size-[76px] shrink-0">
        <source media="(prefers-reduced-motion: reduce)" srcSet={`/nako/${now}-still.png`} />
        <img alt="" className="size-full" src={`/nako/${now}.webp`} />
      </picture>
      <div className="mb-1.5 max-w-[17rem] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2 text-sm">
        {SAYS[now]}
        {now !== "tools" && <Dots />}
        {tools.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1">
            {tools.map(t => (
              <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs" key={t.id || t.name}>
                {t.state === "running" ? (
                  <span className="size-2.5 shrink-0 animate-spin rounded-full border-2 border-primary border-r-transparent" />
                ) : t.state === "failed" ? (
                  <XIcon className="size-3 shrink-0 text-destructive" />
                ) : (
                  <CheckIcon className="size-3 shrink-0 text-emerald-500" />
                )}
                <span className="truncate">
                  <span className="font-medium text-foreground">{t.name}</span>
                  {t.context && ` ${t.context}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
