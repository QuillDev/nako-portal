import { CheckIcon, CopyIcon, CornerDownLeftIcon, FileIcon, ForwardIcon, ImageOffIcon, LoaderIcon, XIcon } from "lucide-react"
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { downloadUrl, fileUrl } from "@/lib/api"
import { SharedSecret } from "./secrets"
import { markdownComponents } from "./markdown-link"
import { copyReplyText, isHtml, isImage, splitReply, splitUserTurn } from "@/lib/media"
import { type ReplyPart, splitSecrets } from "@/lib/secrets"
import { CHAT_HREF, linkSessionRefs, useChatTitle } from "@/lib/session-refs"
import { dayLabel, dayOf, fullTime, timeOf } from "@/lib/times"
import type { HistoryMessage, Live, Sender } from "@/lib/types"

import { HtmlThumb, HtmlViewer } from "./html-viewer"
import { ImageViewer } from "./image-viewer"

const LINK_SAFETY = { enabled: false }

type Step = { key: string; name: string; context: string; state: "done" | "running" | "failed"; summary?: string }

type Block =
  | { kind: "user"; key: string; text: string; at?: number; images?: string[]; steered?: boolean }
  | { kind: "assistant"; key: string; text: string; at?: number; reasoning?: string; label?: string; sender?: Sender; steered?: boolean }
  | { kind: "day"; key: string; at: number }
  | { kind: "tools"; key: string; steps: Step[] }
  | { kind: "note"; key: string; text: string }

// A command's output, placed after the message it followed (`at` counts from messages[0]).
export type Note = { at: number; text: string; key: string }

// For each row, whether it ended its turn: nothing she did follows it before the next prompt.
// Rows a tool call or another message came after were her working along the way. The hub marks
// `ended` too, from rows the app never gets (a background job's notice also starts a turn).
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
  let day: number | undefined
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
    if (quiet && m.role === "assistant" && (!m.text.trim() || (!m.label && !m.post && !m.ended && !ends[i]))) return
    flush()
    const key = String(m.row_id ?? i)
    const at = m.timestamp
    // A line where a new day starts.
    if (at !== undefined && dayOf(at) !== day) {
      day = dayOf(at)
      out.push({ kind: "day", key: `day-${key}`, at })
    }
    // Another thread's message is Nako's own words, so it reads as hers, under that thread's name.
    if (m.role === "user" && m.sender) out.push({ kind: "assistant", key, text: m.text, at, sender: m.sender, steered: m.steered })
    else out.push(m.role === "user" ? { kind: "user", key, text: m.text, at, images: m.images, steered: m.steered } : { kind: "assistant", key, text: m.text, at, reasoning: quiet ? undefined : m.reasoning, label: m.label })
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

// `download` is missing for a picture that is still being sent: it isn't on the server yet.
type Item = { url: string; name: string; path: string; download?: string }

function Thumb({ item, onOpen, onBroken }: { item: Item; onOpen: () => void; onBroken: () => void }) {
  const [ready, setReady] = useState(false)
  return (
    <button aria-label={`Open ${item.name}`} className="relative h-48 w-64 max-w-full cursor-zoom-in rounded-md outline-none" onClick={onOpen} type="button">
      <img alt={item.name} className="size-full rounded-md border object-contain" loading="lazy" onLoad={() => setReady(true)} onError={onBroken} src={item.url} />
      {!ready && <Skeleton role="status" aria-label="Loading image" className="absolute inset-0" />}
    </button>
  )
}

function Files({ urls }: { urls: Item[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set())
  const [open, setOpen] = useState<number | null>(null)
  const [htmlOpen, setHtmlOpen] = useState<Item | null>(null)
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
              <span className="inline-flex h-48 w-64 max-w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs" key={url}>
                <ImageOffIcon className="size-4" />
                {name} is no longer on disk
              </span>
            )
          return <Thumb item={item} key={url} onBroken={() => setBroken(b => new Set(b).add(url))} onOpen={() => setOpen(pictures.indexOf(item))} />
        }
        if (isHtml(path)) {
          if (broken.has(url))
            return (
              <span className="inline-flex h-60 w-96 max-w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs" key={url}>
                <FileIcon className="size-4" />
                {name} is no longer on disk
              </span>
            )
          return <HtmlThumb item={item} key={url} onBroken={() => setBroken(b => new Set(b).add(url))} onOpen={() => setHtmlOpen(item)} />
        }
        if (/\.(mp3|m4a|ogg|wav|opus|flac)$/i.test(path)) return <audio className="w-full" controls key={url} src={url} />
        if (/\.(mp4|webm|mov)$/i.test(path)) return <video className="aspect-video w-full max-w-xl rounded-md object-contain" controls key={url} src={url} />
        return (
          <a className="inline-flex items-center gap-2 text-sm underline" download={name} href={item.download ?? url} key={url}>
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
                download={shown.download}
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
      <Dialog onOpenChange={o => !o && setHtmlOpen(null)} open={htmlOpen != null}>
        <DialogContent
          className="top-0 left-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-transparent p-0 shadow-none sm:max-w-none"
          showCloseButton={false}
        >
          {htmlOpen && (
            <>
              <DialogTitle className="sr-only">{htmlOpen.name}</DialogTitle>
              <HtmlViewer download={htmlOpen.download} key={htmlOpen.url} name={htmlOpen.name} src={htmlOpen.url} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

const named = (path: string) => path.split(/[\\/]/).pop() || path

const sessionFile = (session: string, path: string): Item => ({ url: fileUrl(session, path), name: named(path), path, download: downloadUrl(session, path) })

// The time under a message; hovering (or tapping, on a phone) shows the day too, beside it so
// it covers no text.
function Stamp({ at, children }: { at: number; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip onOpenChange={setOpen} open={open}>
        <TooltipTrigger asChild>
          <button
            className="flex w-fit items-center gap-1 text-muted-foreground text-xs group-[.is-user]:ml-auto"
            onClick={e => {
              e.preventDefault()
              setOpen(o => !o)
            }}
            type="button"
          >
            {children}
            {timeOf(at)}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>{fullTime(at)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function Day({ at }: { at: number }) {
  return (
    <p className="flex items-center gap-3 text-muted-foreground text-xs before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">{dayLabel(at)}</p>
  )
}

const User = memo(function User({ session, text, at, images, steered }: { session: string; text: string; at?: number; images?: string[]; steered?: boolean }) {
  const turn = splitUserTurn(text)
  const shown = [...(images || []).map(url => ({ url, name: "image", path: "image.png" })), ...turn.images.map(path => sessionFile(session, path))]
  return (
    <Message from="user">
      <MessageContent className="whitespace-pre-wrap" data-find-text>
        <Files urls={shown} />
        {turn.body}
      </MessageContent>
      {at !== undefined ? (
        <Stamp at={at}>
          {steered && (
            <>
              <CornerDownLeftIcon aria-hidden className="size-3" />
              steered ·
            </>
          )}
        </Stamp>
      ) : (
        steered && (
          <p className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
            <CornerDownLeftIcon aria-hidden className="size-3" />
            steered
          </p>
        )
      )}
    </Message>
  )
})

// Which thread a message came from, as a break in the chat that links to it; the chat list's
// title once it has one. The message under it carries a pink rule down its side.
function From({ sender, steered }: { sender: Sender; steered?: boolean }) {
  const title = useChatTitle(sender.session) || sender.title || "another thread"
  return (
    <p className="flex min-w-0 items-center gap-1.5 font-medium text-primary text-xs">
      <ForwardIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">from</span>
      <a className="min-w-0 truncate underline decoration-primary/45 underline-offset-2" data-chat-link={sender.session} href={`${CHAT_HREF}${sender.session}`}>
        {title}
      </a>
      {steered && <span className="shrink-0">· steered</span>}
      <span aria-hidden className="ml-1 h-px min-w-6 flex-1 bg-primary/35" />
    </p>
  )
}

function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <>
    <button type="button" className="copy-reply rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-ring" aria-label={copied ? "Copied" : "Copy reply"} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text)
        setFailed(false)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      } catch { setFailed(true) }
    }}>
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
    {failed && <span role="status" className="text-xs text-muted-foreground">Couldn’t copy. Select the reply to copy it.</span>}
  </>
}

const Assistant = memo(function Assistant({
  session,
  text,
  at,
  reasoning,
  label,
  sender,
  steered,
  streaming,
}: { session: string; text: string; at?: number; reasoning?: string; label?: string; sender?: Sender; steered?: boolean; streaming?: boolean }) {
  const { body: raw, files } = splitReply(text)
  // A shared secret's card sits where its SECRET: line was, between the text around it.
  const parts = useMemo(() => splitSecrets(raw, streaming).map((p): ReplyPart => (p.text === undefined ? p : { text: linkSessionRefs(p.text) })), [raw, streaming])
  const body = parts.length === 1 ? (parts[0].text ?? "") : raw
  const copyable = useMemo(() => copyReplyText(text), [text])
  const stopScroll = useContext(StopScroll)
  return (
    <Message from="assistant">
      <MessageContent className="w-full" data-find-text>
        {label && <p className="text-muted-foreground text-xs">{label}</p>}
        {sender && <From sender={sender} steered={steered} />}
        {/* Another thread's message: a pink rule down its side, however long it runs. */}
        <div className={sender ? "flex min-w-0 flex-col gap-2 border-primary border-l-2 pl-3.5" : "contents"}>
          {reasoning && (
            <Reasoning defaultOpen={false} isStreaming={streaming && !body}>
              <ReasoningTrigger onClick={stopScroll} />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          )}
          {body &&
            parts.map((part, i) =>
              part.secret !== undefined ? (
                <div data-find-ignore key={`${i}:${part.secret}`}><SharedSecret name={part.secret} /></div>
              ) : (
                <MessageResponse
                  components={markdownComponents}
                  isAnimating={streaming && i === parts.length - 1}
                  key={i}
                  linkSafety={LINK_SAFETY}
                  mode={streaming ? "streaming" : "static"}
                >
                  {part.text}
                </MessageResponse>
              ),
            )}
          <Files urls={files.map(path => sessionFile(session, path))} />
        </div>
      </MessageContent>
      {(at !== undefined || (!streaming && copyable)) && <div className="flex min-h-6 items-center gap-2">
        {at !== undefined && <Stamp at={at} />}
        {!streaming && copyable && <CopyReply text={copyable} />}
      </div>}
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
          <User at={b.at} images={b.images} key={b.key} session={session} steered={b.steered} text={b.text} />
        ) : b.kind === "day" ? (
          <Day at={b.at} key={b.key} />
        ) : b.kind === "assistant" ? (
          <Assistant at={b.at} key={b.key} label={b.label} reasoning={b.reasoning} sender={b.sender} session={session} steered={b.steered} text={b.text} />
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
