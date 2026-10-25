import { CheckIcon, FileIcon, LoaderIcon, XIcon } from "lucide-react"
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { fileUrl } from "@/lib/api"
import type { HistoryMessage, Live, LiveTool } from "@/lib/types"

const MEDIA = /^MEDIA:(\/[^\r\n]+)$/gm

type Step = { key: string; name: string; context: string; state: "done" | "running" | "failed"; summary?: string }

type Block =
  | { kind: "user"; key: string; text: string }
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
    out.push(m.role === "user" ? { kind: "user", key, text: m.text } : { kind: "assistant", key, text: m.text, reasoning: m.reasoning })
  })
  flush()
  return out
}

function oneLine(text?: string) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

function liveSteps(tools: LiveTool[]): Step[] {
  return tools.map(t => ({ key: t.id, name: t.name, context: oneLine(t.context), state: t.failed ? "failed" : t.done ? "done" : "running", summary: t.summary }))
}

function Steps({ steps, live }: { steps: Step[]; live?: boolean }) {
  const label = `${steps.length} tool ${steps.length === 1 ? "call" : "calls"}`
  return (
    <ChainOfThought defaultOpen={false}>
      <ChainOfThoughtHeader className="w-fit">{live && steps.at(-1)?.state === "running" ? `${steps.at(-1)!.name}…` : label}</ChainOfThoughtHeader>
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

function Media({ session, text }: { session: string; text: string }) {
  const paths = [...text.matchAll(MEDIA)].map(m => m[1])
  if (!paths.length) return null
  return (
    <div className="flex flex-col gap-2">
      {paths.map(path => {
        const url = fileUrl(session, path)
        const name = path.split("/").pop()
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path))
          return (
            <a href={url} key={path} rel="noopener" target="_blank">
              <img alt={name} className="max-h-96 rounded-md border" src={url} />
            </a>
          )
        if (/\.(mp3|m4a|ogg|wav|opus)$/i.test(path)) return <audio controls key={path} src={url} />
        if (/\.(mp4|webm|mov)$/i.test(path)) return <video className="max-h-96 rounded-md" controls key={path} src={url} />
        return (
          <a className="inline-flex items-center gap-2 text-sm underline" download href={url} key={path}>
            <FileIcon className="size-4" />
            {name}
          </a>
        )
      })}
    </div>
  )
}

function Assistant({ session, text, reasoning, streaming }: { session: string; text: string; reasoning?: string; streaming?: boolean }) {
  const body = text.replace(MEDIA, "").trim()
  return (
    <Message from="assistant">
      <MessageContent className="w-full">
        {reasoning && (
          <Reasoning defaultOpen={false} isStreaming={streaming && !body}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoning}</ReasoningContent>
          </Reasoning>
        )}
        {body && (
          <MessageResponse isAnimating={streaming} linkSafety={{ enabled: false }} mode={streaming ? "streaming" : "static"}>
            {body}
          </MessageResponse>
        )}
        <Media session={session} text={text} />
      </MessageContent>
    </Message>
  )
}

export function Transcript({ session, messages, live, running }: { session: string; messages: HistoryMessage[]; live: Live | null; running: boolean }) {
  return (
    <>
      {blocks(messages).map(b =>
        b.kind === "user" ? (
          <Message from="user" key={b.key}>
            <MessageContent className="whitespace-pre-wrap">{b.text}</MessageContent>
          </Message>
        ) : b.kind === "assistant" ? (
          <Assistant key={b.key} reasoning={b.reasoning} session={session} text={b.text} />
        ) : (
          <Steps key={b.key} steps={b.steps} />
        ),
      )}
      {running && live && (
        <>
          {live.tools.length > 0 && <Steps live steps={liveSteps(live.tools)} />}
          {(live.text || live.reasoning) && <Assistant reasoning={live.reasoning} session={session} streaming text={live.text} />}
          {!live.text && !live.reasoning && <Shimmer className="text-sm">working…</Shimmer>}
        </>
      )}
    </>
  )
}
