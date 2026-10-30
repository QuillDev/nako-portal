import { CheckIcon, CornerDownLeftIcon, FileIcon, ImageOffIcon, LoaderIcon, XIcon } from "lucide-react"
import { createContext, memo, useContext, useMemo, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { fileUrl } from "@/lib/api"
import { ImageViewer } from "./image-viewer"
import { markdownComponents } from "./markdown-link"
import { isImage, splitReply, splitUserTurn } from "@/lib/media"
import { linkSessionRefs } from "@/lib/session-refs"
import type { HistoryMessage, Live } from "@/lib/types"

type Step = { key: string; name: string; context: string; state: "done" | "running" | "failed"; summary?: string }

type Block =
  | { kind: "user"; key: string; text: string; images?: string[]; steered?: boolean }
  | { kind: "assistant"; key: string; text: string; reasoning?: string; label?: string }
  | { kind: "tools"; key: string; steps: Step[] }
  | { kind: "note"; key: string; text: string }

// A command's output, placed after the message it followed (`at` counts from messages[0]).
export type Note = { at: number; text: string; key: string }

// For each row, whether it ended its turn: nothing she did follows it before the next prompt.
// Rows a tool call or another message came after were her working along the way.
function turnEnds(messages: HistoryMessage[]) {
  const ends: boolean[] = new Array(messages.length)
  let clear = true
  for (let i = messages.length - 1; i >= 0; i--) {
    ends[i] = clear
    const m = messages[i]
    if (m.role === "user") clear = true
    else if (m.role === "tool" || m.text.trim()) clear = false
  }
  return ends
}

// quiet: Nako's presence shows the work as it happens, so the chat keeps only prompts and the
// replies that ended each turn (and posts), not tool calls, thoughts or messages along the way.
function blocks(messages: HistoryMessage[], notes: Note[] = [], quiet = false): Block[] {
  const out: Block[] = []
  const ends = quiet ? turnEnds(messages) : []
  let steps: Step[] = []
  const flush = () => {
    if (steps.length) out.push({ kind: "tools", key: `tools-${out.length}`, steps })
    steps = []
  }
  const notesAt = (i: number) => {
    const here = notes.filter(n => (i < messages.length ? n.at === i : n.at >= i))
    if (!here.length) return
    flush()
    for (const n of here) out.push({ kind: "note", key: n.key, text: n.text })
  }
  messages.forEach((m, i) => {
    notesAt(i)
    if (m.role === "tool") {
      if (quiet) return
      steps.push({ key: m.tool_call_id || String(i), name: m.name || "tool", context: oneLine(m.context), state: "done" })
      return
    }
    if (m.role === "assistant" && !m.text.trim() && !m.reasoning) return
    if (quiet && m.role === "assistant" && (!m.text.trim() || (!m.label && !m.post && !ends[i]))) return
    flush()
    const key = String(m.row_id ?? i)
    out.push(m.role === "user" ? { kind: "user", key, text: m.text, images: m.images, steered: m.steered } : { kind: "assistant", key, text: m.text, reasoning: quiet ? undefined : m.reasoning, label: m.label })
  })
  notesAt(messages.length)
  flush()
  return out
}

// Stops following the bottom while a disclosure opens, so its header stays under the finger. The
// scroller's own context changes as it scrolls; this one never does, so rows can skip rendering.
const StopScroll = createContext<() => void>(() => {})

// Shown in the chat like Desktop's command lines: the invocation, then what it printed.
const CommandNote = memo(function CommandNote({ text }: { text: string }) {
  const [invocation, ...output] = text.split("\n")
  return (
    <div className="flex flex-col gap-1 text-muted-foreground text-xs">
      <span className="font-medium text-foreground">{invocation}</span>
      {output.length > 0 && <pre className="whitespace-pre-wrap break-words font-sans text-sm">{output.join("\n")}</pre>}
    </div>
  )
})

function oneLine(text?: string) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

const Steps = memo(function Steps({ steps }: { steps: Step[] }) {
  const stopScroll = useContext(StopScroll)
  const label = `${steps.length} tool ${steps.length === 1 ? "call" : "calls"}`
  return (
    <ChainOfThought className="-my-2" defaultOpen={false}>
      <ChainOfThoughtHeader className="w-fit" onClick={stopScroll}>{label}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {steps.map(s => (
          <ChainOfThoughtStep
            description={s.summary}
            icon={s.state === "running" ? LoaderIcon : s.state === "failed" ? XIcon : CheckIcon}
            key={s.key}
            label={
              <span className="break-words">
                <span className="font-medium">{s.name}</span>
                {s.context && <span className="text-muted-foreground"> {s.context}</span>}
              </span>
            }
            status={s.state === "running" ? "active" : "complete"}
          />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  )
})

type Item = { url: string; name: string; path: string }

function Thumb({ item, onOpen, onBroken }: { item: Item; onOpen: () => void; onBroken: () => void }) {
  return (
    <button aria-label={`Open ${item.name}`} className="w-fit cursor-zoom-in rounded-md outline-none" onClick={onOpen} type="button">
      <img alt={item.name} className="max-h-80 max-w-full rounded-md border object-contain" loading="lazy" onError={onBroken} src={item.url} />
    </button>
  )
}

function Files({ urls }: { urls: Item[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<number | null>(null)
  if (!urls.length) return null
  // One viewer per message: swiping and the arrows move between this message's images that still load.
  const pictures = urls.filter(u => isImage(u.path) && !broken.has(u.url))
  const shown = open === null ? null : pictures[Math.min(open, pictures.length - 1)]
  const step = (by: number) => setOpen(i => (i === null ? i : Math.min(pictures.length - 1, Math.max(0, i + by))))
  return (
    <div className="flex flex-wrap items-start gap-2">
      {urls.map(item => {
        const { url, name, path } = item
        if (isImage(path)) {
          if (broken.has(url))
            return (
              <span className="inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs" key={url}>
                <ImageOffIcon className="size-4" />
                {name} is no longer on disk
              </span>
            )
          return <Thumb item={item} key={url} onBroken={() => setBroken(b => new Set(b).add(url))} onOpen={() => setOpen(pictures.indexOf(item))} />
        }
        if (/\.(mp3|m4a|ogg|wav|opus|flac)$/i.test(path)) return <audio className="w-full" controls key={url} src={url} />
        if (/\.(mp4|webm|mov)$/i.test(path)) return <video className="max-h-96 rounded-md" controls key={url} src={url} />
        return (
          <a className="inline-flex items-center gap-2 text-sm underline" download href={url} key={url}>
            <FileIcon className="size-4" />
            {name}
          </a>
        )
      })}
      <Dialog onOpenChange={o => !o && setOpen(null)} open={shown != null}>
        <DialogContent
          className="top-0 left-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
          showCloseButton={false}
        >
          {shown && (
            <>
              <DialogTitle className="sr-only">{shown.name}</DialogTitle>
              <ImageViewer
                key={shown.url}
                name={shown.name}
                onNext={open! < pictures.length - 1 ? () => step(1) : undefined}
                onPrev={open! > 0 ? () => step(-1) : undefined}
                src={shown.url}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

const named = (path: string) => path.split("/").pop() || path

const User = memo(function User({ session, text, images, steered }: { session: string; text: string; images?: string[]; steered?: boolean }) {
  const turn = splitUserTurn(text)
  const shown = [...(images || []).map(url => ({ url, name: "image", path: "image.png" })), ...turn.images.map(path => ({ url: fileUrl(session, path), name: named(path), path }))]
  return (
    <Message from="user">
      <MessageContent className="whitespace-pre-wrap">
        <Files urls={shown} />
        {turn.body}
      </MessageContent>
      {steered && (
        <p className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
          <CornerDownLeftIcon aria-hidden className="size-3" />
          steered
        </p>
      )}
    </Message>
  )
})

const Assistant = memo(function Assistant({ session, text, reasoning, label, streaming }: { session: string; text: string; reasoning?: string; label?: string; streaming?: boolean }) {
  const { body: raw, files } = splitReply(text)
  const body = useMemo(() => linkSessionRefs(raw), [raw])
  const stopScroll = useContext(StopScroll)
  return (
    <Message from="assistant">
      <MessageContent className="w-full">
        {label && <p className="text-muted-foreground text-xs">{label}</p>}
        {reasoning && (
          <Reasoning defaultOpen={false} isStreaming={streaming && !body}>
            <ReasoningTrigger onClick={stopScroll} />
            <ReasoningContent>{reasoning}</ReasoningContent>
          </Reasoning>
        )}
        {body && (
          <MessageResponse components={markdownComponents} isAnimating={streaming} linkSafety={{ enabled: false }} mode={streaming ? "streaming" : "static"}>
            {body}
          </MessageResponse>
        )}
        <Files urls={files.map(path => ({ url: fileUrl(session, path), name: named(path), path }))} />
      </MessageContent>
    </Message>
  )
})

export function Transcript({
  session,
  messages,
  live,
  running,
  notes,
  quiet = false,
}: { session: string; messages: HistoryMessage[]; live: Live | null; running: boolean; notes?: Note[]; quiet?: boolean }) {
  const shown = useMemo(() => blocks(messages, notes, quiet), [messages, notes, quiet])
  const { stopScroll } = useStickToBottomContext()
  const latest = useRef(stopScroll)
  latest.current = stopScroll
  const [stop] = useState(() => () => latest.current())
  // A message the turn already saved is in the transcript; a chat reread mid-turn has both.
  const saved = useMemo(() => {
    const turn = messages.slice(messages.findLastIndex(m => m.role === "user") + 1)
    return new Set(turn.filter(m => m.role === "assistant").map(m => m.text.trim()))
  }, [messages])
  const written = live?.messages.filter(m => m.text.trim() && !saved.has(m.text.trim())) ?? []
  // Quiet: only text she's written since her last tool call, which may be the reply.
  const pending = quiet ? written.filter(m => (m.after ?? 0) >= (live?.tools.length ?? 0)).slice(-1) : written
  return (
    <StopScroll.Provider value={stop}>
      {shown.map(b =>
        b.kind === "user" ? (
          <User images={b.images} key={b.key} session={session} steered={b.steered} text={b.text} />
        ) : b.kind === "assistant" ? (
          <Assistant key={b.key} label={b.label} reasoning={b.reasoning} session={session} text={b.text} />
        ) : b.kind === "note" ? (
          <CommandNote key={b.key} text={b.text} />
        ) : (
          <Steps key={b.key} steps={b.steps} />
        ),
      )}
      {pending.map((m, i) => (
        <Assistant key={m.id} session={session} streaming={running && i === pending.length - 1} text={m.text} />
      ))}
      {!quiet && running && !pending.length && <Shimmer className="text-sm">working…</Shimmer>}
    </StopScroll.Provider>
  )
}
