import { CheckIcon, FileIcon, ImageOffIcon, LoaderIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { fileUrl } from "@/lib/api"
import { isImage, splitReply, splitUserTurn } from "@/lib/media"
import type { HistoryMessage, Live, LiveTool } from "@/lib/types"

type Step = { key: string; name: string; context: string; state: "done" | "running" | "failed"; summary?: string }

type Block =
  | { kind: "user"; key: string; text: string; images?: string[] }
  | { kind: "assistant"; key: string; text: string; reasoning?: string }
  | { kind: "tools"; key: string; steps: Step[] }

function blocks(messages: HistoryMessage[]): Block[] {
  const out: Block[] = []
  let steps: Step[] = []
  const flush = () => {
    if (steps.length) out.push({ kind: "tools", key: `tools-${out.length}`, steps })
    steps = []
  }
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      steps.push({ key: m.tool_call_id || String(i), name: m.name || "tool", context: oneLine(m.context), state: "done" })
      return
    }
    if (m.role === "assistant" && !m.text.trim() && !m.reasoning) return
    flush()
    const key = String(m.row_id ?? i)
    out.push(m.role === "user" ? { kind: "user", key, text: m.text, images: m.images } : { kind: "assistant", key, text: m.text, reasoning: m.reasoning })
  })
  flush()
  return out
}

function oneLine(text?: string) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

// A refresh mid-turn brings in the calls Hermes has already saved; live keeps only the rest.
function liveSteps(tools: LiveTool[], messages: HistoryMessage[]): Step[] {
  const saved = new Set(messages.flatMap(m => (m.role === "tool" && m.tool_call_id ? [m.tool_call_id] : [])))
  return tools.filter(t => !saved.has(t.id)).map(t => ({ key: t.id, name: t.name, context: oneLine(t.context), state: t.failed ? "failed" : t.done ? "done" : "running", summary: t.summary }))
}

function Steps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const { stopScroll } = useStickToBottomContext()
  const label = `${steps.length} tool ${steps.length === 1 ? "call" : "calls"}`
  return (
    <ChainOfThought className="-my-2" defaultOpen={false}>
      <ChainOfThoughtHeader className="w-fit" onClick={stopScroll}>{live && steps.at(-1)?.state === "running" ? `${steps.at(-1)!.name}…` : label}</ChainOfThoughtHeader>
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
}

function Picture({ src, name }: { src: string; name: string }) {
  const [broken, setBroken] = useState(false)
  if (broken)
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
        <ImageOffIcon className="size-4" />
        {name} is no longer on disk
      </span>
    )
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button aria-label={`Open ${name}`} className="w-fit cursor-zoom-in rounded-md outline-none" type="button">
          <img alt={name} className="max-h-80 max-w-full rounded-md border object-contain" loading="lazy" onError={() => setBroken(true)} src={src} />
        </button>
      </DialogTrigger>
      <DialogContent className="flex w-[calc(100vw-2rem)] max-w-none justify-center border-0 bg-transparent p-0 shadow-none sm:max-w-none">
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <img alt={name} className="max-h-[calc(100dvh-2rem)] max-w-full rounded-md object-contain" src={src} />
      </DialogContent>
    </Dialog>
  )
}

function Files({ urls }: { urls: { url: string; name: string; path: string }[] }) {
  if (!urls.length) return null
  return (
    <div className="flex flex-wrap items-start gap-2">
      {urls.map(({ url, name, path }) => {
        if (isImage(path)) return <Picture key={url} name={name} src={url} />
        if (/\.(mp3|m4a|ogg|wav|opus|flac)$/i.test(path)) return <audio className="w-full" controls key={url} src={url} />
        if (/\.(mp4|webm|mov)$/i.test(path)) return <video className="max-h-96 rounded-md" controls key={url} src={url} />
        return (
          <a className="inline-flex items-center gap-2 text-sm underline" download href={url} key={url}>
            <FileIcon className="size-4" />
            {name}
          </a>
        )
      })}
    </div>
  )
}

const named = (path: string) => path.split("/").pop() || path

function User({ session, text, images }: { session: string; text: string; images?: string[] }) {
  const turn = splitUserTurn(text)
  const shown = [...(images || []).map(url => ({ url, name: "image", path: "image.png" })), ...turn.images.map(path => ({ url: fileUrl(session, path), name: named(path), path }))]
  return (
    <Message from="user">
      <MessageContent className="whitespace-pre-wrap">
        <Files urls={shown} />
        {turn.body}
      </MessageContent>
    </Message>
  )
}

function Assistant({ session, text, reasoning, streaming }: { session: string; text: string; reasoning?: string; streaming?: boolean }) {
  const { body, files } = splitReply(text)
  const { stopScroll } = useStickToBottomContext()
  return (
    <Message from="assistant">
      <MessageContent className="w-full">
        {reasoning && (
          <Reasoning defaultOpen={false} isStreaming={streaming && !body}>
            <ReasoningTrigger onClick={stopScroll} />
            <ReasoningContent>{reasoning}</ReasoningContent>
          </Reasoning>
        )}
        {body && (
          <MessageResponse isAnimating={streaming} linkSafety={{ enabled: false }} mode={streaming ? "streaming" : "static"}>
            {body}
          </MessageResponse>
        )}
        <Files urls={files.map(path => ({ url: fileUrl(session, path), name: named(path), path }))} />
      </MessageContent>
    </Message>
  )
}

export function Transcript({ session, messages, live, running }: { session: string; messages: HistoryMessage[]; live: Live | null; running: boolean }) {
  const shown = blocks(messages)
  let steps = running && live ? liveSteps(live.tools, messages) : []
  // The saved run at the end belongs to the running turn, so the live calls continue it as one group.
  const last = shown.at(-1)
  if (steps.length && last?.kind === "tools") {
    shown.pop()
    steps = [...last.steps, ...steps]
  }
  return (
    <>
      {shown.map(b =>
        b.kind === "user" ? (
          <User images={b.images} key={b.key} session={session} text={b.text} />
        ) : b.kind === "assistant" ? (
          <Assistant key={b.key} reasoning={b.reasoning} session={session} text={b.text} />
        ) : (
          <Steps key={b.key} steps={b.steps} />
        ),
      )}
      {running && live && (
        <>
          {steps.length > 0 && <Steps live steps={steps} />}
          {(live.text || live.reasoning) && <Assistant reasoning={live.reasoning} session={session} streaming text={live.text} />}
          {!live.text && !live.reasoning && <Shimmer className="text-sm">working…</Shimmer>}
        </>
      )}
    </>
  )
}
