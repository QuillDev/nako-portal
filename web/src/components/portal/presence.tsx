import { CheckIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Live, Status } from "@/lib/types"

export type Activity = "idle" | "thinking" | "tools" | "replying"

// A tool running wins; otherwise a reply that has started streaming; otherwise she's thinking.
export function activity(live: Live | null): Exclude<Activity, "idle"> {
  if (live?.tools.some(t => t.state === "running")) return "tools"
  if (live?.messages.some(m => m.text.trim())) return "replying"
  return "thinking"
}

const SAYS = { thinking: "hmm, let me think", tools: "on it", replying: "writing it up" }
// Said when no line comes back from the sign-off model in time, and after a failed turn.
const DONE = "done."
const FAILED = "hmm, that didn't work"
const SHOWN_TOOLS = 3
// How long to wait for the model's line, and how long a sign-off stays up.
const SIGN_OFF_WAIT_MS = 5000
const SIGN_OFF_MS = 6000

function Dots() {
  return (
    <span aria-hidden className="ml-0.5 inline-flex gap-[3px] align-middle">
      {[0, 1, 2].map(i => (
        <i className="size-1 animate-bounce rounded-full bg-primary/70" key={i} style={{ animationDelay: `${i * 0.15}s`, animationDuration: "1.1s" }} />
      ))}
    </span>
  )
}

// What she says once the turn she was working on ends: the model's line about it when it comes
// (dots while waiting), "done." if it doesn't, then quiet.
function useSignOff(running: boolean, outcome: Status | null | undefined, line: string) {
  const [phase, setPhase] = useState<"none" | "waiting" | "shown" | "gone">("none")
  const [fallback, setFallback] = useState("")
  const was = useRef(running)
  useEffect(() => {
    const ended = was.current && !running
    was.current = running
    if (running) return setPhase("none")
    if (!ended) return
    if (outcome === "failed") {
      setFallback(FAILED)
      return setPhase("shown")
    }
    setFallback(DONE)
    setPhase("waiting")
  }, [running, outcome])
  useEffect(() => {
    if (phase === "waiting" && line) setPhase("shown")
    if (phase === "waiting") {
      const timer = setTimeout(() => setPhase("shown"), SIGN_OFF_WAIT_MS)
      return () => clearTimeout(timer)
    }
    if (phase === "shown") {
      const timer = setTimeout(() => setPhase("gone"), SIGN_OFF_MS)
      return () => clearTimeout(timer)
    }
  }, [phase, line])
  if (phase === "waiting") return { text: "", waiting: true }
  if (phase === "shown") return { text: (fallback === FAILED ? "" : line) || fallback, waiting: false }
  return { text: "", waiting: false }
}

// Nako docked above the composer. During a turn her sticker shows what she's doing with a bubble
// saying it (and the latest tool calls); afterwards she signs off and stays, quietly, until the
// person starts typing.
export function Presence({
  live,
  running,
  outcome,
  signOff: line,
  typing,
}: { live: Live | null; running: boolean; outcome?: Status | null; signOff: string; typing: boolean }) {
  const signOff = useSignOff(running, outcome, line)
  if (!running && typing) return null
  const now: Activity = running ? activity(live) : "idle"
  const tools = now === "tools" ? (live?.tools ?? []).slice(-SHOWN_TOOLS) : []
  const said = now === "idle" ? signOff.text : SAYS[now]
  const dots = (running && now !== "tools") || signOff.waiting
  return (
    <div aria-live="polite" className="mx-auto flex w-full max-w-3xl items-end gap-2.5 px-4 pb-1" data-activity={now}>
      <picture className="-ml-1.5 size-[76px] shrink-0">
        <source media="(prefers-reduced-motion: reduce)" srcSet={`/nako/${now}-still.png`} />
        <img alt="" className="size-full" src={`/nako/${now}.webp`} />
      </picture>
      <div
        className={`mb-1.5 max-w-[17rem] rounded-2xl rounded-bl-md border bg-card px-3.5 py-2 text-sm transition-opacity duration-500 ${said || dots ? "opacity-100" : "opacity-0"}`}
      >
        {said || (dots ? "" : " ")}
        {dots && <Dots />}
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
