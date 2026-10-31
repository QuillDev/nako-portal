import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Shimmer } from "@/components/ai-elements/shimmer"
import type { Live, Status } from "@/lib/types"

export type Activity = "idle" | "thinking" | "tools" | "replying"

// A running tool wins; then reply text written since the last tool; then the last tool she ran,
// while she works out the next step; otherwise she's thinking.
export function activity(live: Live | null): Exclude<Activity, "idle"> {
  const tools = live?.tools ?? []
  if (tools.some(t => t.state === "running")) return "tools"
  if (live?.messages.some(m => m.text.trim() && (m.after ?? 0) >= tools.length)) return "replying"
  return tools.length ? "tools" : "thinking"
}

const SAYS = { idle: "ready when you are", thinking: "hmm, let me think", replying: "writing it up" }
// Said while the sign-off line is on its way, when none comes back in time, and after a failed turn.
const WRAPPING_UP = "wrapping up"
const DONE = "done."
const FAILED = "hmm, that didn't work"
// How long to wait for the model's line, and how long a sign-off stays up.
const SIGN_OFF_WAIT_MS = 5000
const SIGN_OFF_MS = 8000

// What she says once the turn she was working on ends: the model's line about it when it comes,
// "done." if it doesn't, then back to waiting.
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
  // She keeps her happy face while she signs off, and only waves for the next message after.
  // The render a turn ends in, before the effect above moves on: already signing off, so the
  // bubble doesn't flash the waiting line first.
  const ending = phase === "none" && was.current && !running
  if (ending && outcome === "failed") return { text: FAILED, waiting: false, proud: false }
  if (phase === "waiting" || ending) return { text: "", waiting: true, proud: true }
  if (phase === "shown") return { text: (fallback === FAILED ? "" : line) || fallback, waiting: false, proud: fallback !== FAILED }
  return { text: "", waiting: false, proud: false }
}

// The busy stickers are animations of a few hundred kB each. Fetching them while she's idle means
// the first turn shows her thinking at once instead of an empty frame while the file downloads.
let warmed = false
function warmStickers() {
  if (warmed) return
  warmed = true
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches
  const load = () => {
    for (const state of ["thinking", "tools", "replying"] satisfies Activity[]) new Image().src = `/nako/${state}${still ? "-still.png" : ".webp"}`
  }
  if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: 3000 })
  else setTimeout(load, 1500)
}

type Shown = { id: string; node: ReactNode }

// Swaps what's inside when `id` changes: the old line slides up and out as the new one rises in.
function Swap({ id, children }: { id: string; children: ReactNode }) {
  const shown = useRef<Shown>({ id, node: children })
  const [leaving, setLeaving] = useState<Shown | null>(null)
  useLayoutEffect(() => {
    if (shown.current.id !== id) setLeaving(shown.current)
  }, [id])
  useLayoutEffect(() => {
    shown.current = { id, node: children }
  })
  return (
    <span className="-my-1 grid min-w-0 overflow-hidden py-1">
      {leaving && (
        <span aria-hidden className="presence-out col-start-1 row-start-1 min-w-0" key={`out-${leaving.id}`} onAnimationEnd={() => setLeaving(null)}>
          {leaving.node}
        </span>
      )}
      <span className="presence-in col-start-1 row-start-1 min-w-0" key={id}>
        {children}
      </span>
    </span>
  )
}

// Nako docked above the composer, thinking out loud. During a turn her sticker shows what she's
// doing and the bubble says it (the tool she's on, one at a time); afterwards she signs off and
// waits, and stays while the person types. Bare: the floating panel, where her sticker already
// floats outside, so only the bubble shows.
export function Presence({
  live,
  running,
  outcome,
  signOff: line,
  bare = false,
}: { live: Live | null; running: boolean; outcome?: Status | null; signOff: string; bare?: boolean }) {
  const signOff = useSignOff(running, outcome, line)
  useEffect(() => {
    if (!bare) warmStickers()
  }, [bare])
  const now: Activity = running ? activity(live) : signOff.proud ? "replying" : "idle"
  const tool = now === "tools" ? (live?.tools.findLast(t => t.state === "running") ?? live?.tools.at(-1)) : undefined
  const busy = running || signOff.waiting
  const said = tool
    ? `${tool.name}${tool.context ? ` ${tool.context}` : ""}`
    : running
      ? SAYS[now as keyof typeof SAYS]
      : signOff.waiting
        ? WRAPPING_UP
        : signOff.text || SAYS.idle
  return (
    <div aria-live="polite" className={`mx-auto flex w-full max-w-3xl items-end gap-2.5 pb-1 ${bare ? "px-3" : "px-4"}`} data-activity={now}>
      {!bare && (
        <picture className="-ml-1.5 size-[76px] shrink-0">
          <source media="(prefers-reduced-motion: reduce)" srcSet={`/nako/${now}-still.png`} />
          <img alt="" className="size-full" src={`/nako/${now}.webp`} />
        </picture>
      )}
      {/* A thought bubble: raised beside her head, with two puffs trailing down to her. Bare, it sits
          on the composer with no puffs, since there's no her to trail to. */}
      <div className={`relative min-w-0 max-w-[17rem] rounded-3xl border bg-card px-4 py-2 text-sm ${bare ? "mb-1" : "mb-[50px] -ml-2"}`} data-bubble>
        {!bare && (
          <>
            <span aria-hidden className="absolute -bottom-4 left-1 size-3 rounded-full border bg-card" />
            <span aria-hidden className="absolute bottom-[-29px] -left-1.5 size-[7px] rounded-full border bg-card" />
          </>
        )}
        <Swap id={tool ? `tool:${tool.id || tool.name}` : said}>
          {busy ? (
            <Shimmer as="span" className={tool ? "block truncate" : undefined}>
              {said}
            </Shimmer>
          ) : (
            said
          )}
        </Swap>
      </div>
    </div>
  )
}
