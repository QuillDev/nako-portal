import { MoreHorizontalIcon } from "lucide-react"
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skullet } from "@/components/ui/skeleton"
import { navigate, type Portal } from "@/hooks/use-portal"
import { retryMarkdown, useMarkdown, useMarkdownError } from "@/lib/markdown"
import { sourceName } from "@/lib/outside"
import { inBubble } from "@/lib/bubble"
import { usePresence } from "@/lib/presence"
import { Composer } from "./composer"
import { ComposerPlaceholder } from "./screen-loading"
import { PageHeader } from "./header"
import { Presence } from "./presence"
import { ChatEnvironments } from "./chat-environments"
import { Processes } from "./processes"
import { Requests } from "./requests"
import { SecretDock } from "./secrets"
import { useGroupPicker } from "./groups"
import { type ChatActions, sessionActions, useRenameDialog } from "./session-actions"
import { Transcript } from "./transcript"
import { ChatFind, FindInChatButton } from "./chat-find"

// The open chat's title, background processes and ⋯ menu; unchanged while a turn streams in below it.
const ChatHeader = memo(function ChatHeader({ title, session, pinned, groupable, actions, running, environments }: { title: string; session: string; pinned: boolean; groupable: boolean; actions: ChatActions; running: boolean; environments: boolean }) {
  return (
    <PageHeader title={title}>
      {/* The floating panel keeps to the chat itself; its full controls are one tap away in the app. */}
      {!inBubble && (
        <>
          {environments && <ChatEnvironments session={session} />}
          <Processes key={session} running={running} session={session} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="More" size="icon" variant="ghost">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {sessionActions(actions, session, pinned, groupable).map(a => (
                <DropdownMenuItem key={a.label} onSelect={a.run}>
                  <a.icon className="size-4 text-muted-foreground" />
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      <FindInChatButton />
    </PageHeader>
  )
})

// Nako floats over the chat's bottom edge, so the transcript scrolls on behind her once you scroll
// up. Only her bubble takes pointer events; the rest lets scrolls and selection through.
function Dock({ children, onHeight }: { children: ReactNode; onHeight: (height: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => onHeight(el.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [onHeight])
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col [&_[data-bubble]]:pointer-events-auto" data-dock ref={box}>
      {children}
    </div>
  )
}

const SAMPLE_TURNS = [
  {
    prompt: "can you check why the staging build failed?",
    reply: "the typecheck caught a missing field on the account payload after the schema update. i patched the decoder and re-ran the check — everything passes now.",
  },
  {
    prompt: "nice, go ahead and open the PR with screenshots",
    reply: "pushed the branch and opened the PR with desktop and phone screenshots attached. CI is running now and i will check back once it is green.",
  },
  {
    prompt: "can we also trim the extra padding on mobile?",
    reply: "trimmed the header spacing on narrow screens and verified it at phone width in both light and dark themes.",
  },
]

// Stand-ins for turns that haven't loaded yet: a prompt on the right, a reply on the left.
function TurnSkeletons({ count }: { count: number }) {
  return (
    <Skullet label="Loading conversation…" loading>
      <div className="flex flex-col gap-6">
        {Array.from({ length: count }, (_, i) => {
          const turn = SAMPLE_TURNS[i % SAMPLE_TURNS.length]
          return (
            <div className="flex flex-col gap-6" key={i}>
              <Message from="user">
                <MessageContent>{turn.prompt}</MessageContent>
              </Message>
              <Message from="assistant">
                <MessageContent>
                  <p className="leading-relaxed">{turn.reply}</p>
                </MessageContent>
              </Message>
            </div>
          )
        })}
      </div>
    </Skullet>
  )
}

// Sits above the loaded turns while older ones remain. Coming near it loads the page before,
// and the view stays on what was being read instead of jumping as that page lands above it.
function OlderTurns({ portal }: { portal: Portal }) {
  const { scrollRef } = useStickToBottomContext()
  const start = portal.current?.start ?? 0
  const top = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const fromBottom = useRef(0)
  const shownStart = useRef<number | null>(null)

  // Opening at the bottom before the first paint, so the chat never shows its top and
  // older pages don't start loading before anyone scrolled. On first mount the scroller's
  // ref isn't attached yet (parents attach after children); StickToBottom.Content renders
  // it as our grandparent (scroller > content > this).
  useLayoutEffect(() => {
    const root = scrollRef.current ?? top.current?.parentElement?.parentElement
    if (!root) return
    if (shownStart.current === null) root.scrollTop = root.scrollHeight
    else if (start < shownStart.current) root.scrollTop = root.scrollHeight - fromBottom.current
    shownStart.current = start
  }, [scrollRef, start])

  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const track = () => {
      fromBottom.current = root.scrollHeight - root.scrollTop
    }
    track()
    root.addEventListener("scroll", track, { passive: true })
    return () => root.removeEventListener("scroll", track)
  }, [scrollRef])

  useEffect(() => {
    const root = scrollRef.current
    const target = sentinel.current
    if (!root || !target) return
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && portal.loadOlder(), { root, rootMargin: "800px 0px 0px 0px" })
    observer.observe(target)
    return () => observer.disconnect()
  }, [scrollRef, start, portal.loadOlder])

  return (
    <div className="-mb-6" ref={top}>
      {start > 0 && (
        <div className="pb-6" ref={sentinel}>
          <TurnSkeletons count={2} />
        </div>
      )}
    </div>
  )
}

// Keeps a chat that was at the bottom there, without animating, when the layout around it changes
// rather than the conversation: the scroller getting shorter (Nako's bubble growing under it) or the
// text rewrapping to a new width (the sidebar opening or closing). StickToBottom only follows content
// growth, smoothly, so the first left the last lines hidden under the bubble and the second scrolled
// the chat up and back down.
function KeepBottom({ dock }: { dock: number }) {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext()
  // StickToBottom's own view of it, which stays true while it eases toward new content.
  const following = useRef(isAtBottom)
  following.current = isAtBottom
  // The dock over the chat grew or shrank (her bubble wrapping, the process list opening): its
  // spacer moved the bottom, so stay on it in the same frame instead of easing there.
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (root && following.current) root.scrollTop = root.scrollHeight
  }, [dock, scrollRef])
  useEffect(() => {
    const root = scrollRef.current
    const content = contentRef.current
    if (!root || !content) return
    let height = root.clientHeight
    let width = content.clientWidth
    const observer = new ResizeObserver(() => {
      const moved = root.clientHeight !== height || content.clientWidth !== width
      height = root.clientHeight
      width = content.clientWidth
      if (moved && following.current) root.scrollTop = root.scrollHeight
    })
    observer.observe(root)
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollRef, contentRef])
  return null
}

function partOfDay(hour: number) {
  return hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
}

// A new chat puts the greeting and the composer together a little above the middle on wide
// screens; on a phone the composer stays at the bottom, under the thumb.
function NewChat({ portal }: { portal: Portal }) {
  const name = portal.me?.name
  return (
    <div className="flex min-h-0 flex-1 flex-col md:justify-center md:pb-[16vh]">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center md:flex-none md:pb-7">
        <h2 className="font-serif text-[2.5rem] leading-[1.1] tracking-[-0.01em] md:text-[2.875rem]">
          good <em className="text-primary">{partOfDay(new Date().getHours())}</em>
          {name && `, ${name}`}
        </h2>
        {portal.error && <p className="text-destructive text-sm">{portal.error}</p>}
      </div>
      <Composer
        command={portal.command}
        commands={portal.commands}
        draftKey="draft:new"
        inChat={false}
        placeholder="what are we working on?"
        running={false}
        send={portal.send}
        setError={portal.setError}
        stop={portal.stop}
      />
    </div>
  )
}

// A session that came in another way (Slack, cron...): its transcript, no composer and no chat
// controls. The portal only watches it; turns there stream nothing here, so it rereads instead.
function ReadOnlyChat({ portal, source, find }: { portal: Portal; source: string; find?: ReactNode }) {
  const c = portal.current!
  const renderer = useMarkdown()
  const markdownError = useMarkdownError()
  const loading = c.loading || (!renderer && !markdownError)
  const running = portal.outside.running.includes(c.session)
  const name = sourceName(source)
  return (
    <>
      <PageHeader
        back={() => navigate("#/elsewhere")}
        title={
          <>
            {c.title || "untitled"}
            <span className="ml-2 font-normal text-muted-foreground text-xs">{name}</span>
          </>
        }
      ><FindInChatButton /></PageHeader>
      {find}
      <Conversation className="min-h-0 flex-1" initial="instant" key={`${c.session}:${loading}`}>
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6" scrollClassName="overflow-y-auto">
          {loading && <TurnSkeletons count={3} />}
          {!loading && <OlderTurns portal={portal} />}
          {!loading && <KeepBottom dock={0} />}
          {!loading && <Transcript live={null} messages={c.messages} notes={NO_NOTES} quiet={false} running={running} session={c.session} />}
          {portal.error && <p className="text-destructive text-sm">{portal.error}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="rounded-3xl border bg-card px-4 py-3 text-center text-muted-foreground text-sm">Read-only, from {name}</p>
      </div>
    </>
  )
}

const NO_NOTES: never[] = []

export function Chat({ portal }: { portal: Portal }) {
  const source = portal.current?.source
  const root = useRef<HTMLDivElement>(null)
  const markdownError = useMarkdownError()
  const banner = (
    <>
      {Boolean(markdownError) && <p role="alert" className="border-b px-4 py-2 text-sm text-muted-foreground">Formatting couldn’t load. <button type="button" className="underline" onClick={() => void retryMarkdown().catch(() => {})}>Try again</button></p>}
      {portal.current && <ChatFind key={portal.current.session} root={root} session={portal.current.session} />}
    </>
  )
  if (portal.route.view === "chat" && portal.current?.session !== portal.route.session) return <><PageHeader title="Chat" /><div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-hidden p-4"><TurnSkeletons count={3} /></div><ComposerPlaceholder /></>
  if (portal.route.view === "chat" && portal.current?.loadError) return <><PageHeader title={portal.current.title || "Chat"} /><div role="alert" className="mx-auto w-full max-w-3xl p-4 text-sm">{portal.current.loadError} <button type="button" className="underline" onClick={() => void portal.refresh(portal.current!.session)}>Retry</button></div></>
  return <div ref={root} className="flex min-h-0 flex-1 flex-col">
    {source && source !== "portal" ? <ReadOnlyChat find={banner} portal={portal} source={source} /> : <PortalChat find={banner} portal={portal} />}
  </div>
}

function PortalChat({ portal, find }: { portal: Portal; find?: ReactNode }) {
  const c = portal.current
  const presence = usePresence()
  // Held on the skeleton until the renderer is in too, so the chat mounts once, at its bottom.
  const renderer = useMarkdown()
  const markdownError = useMarkdownError()
  const loading = !c || c.loading || (!renderer && !markdownError)
  const draftKey = c ? `draft:${c.session}` : ""
  const rename = useRenameDialog(portal)
  const picker = useGroupPicker(portal)
  const { pin, archive } = portal
  const actions = useMemo(() => ({ pin, archive, rename: rename.start, group: picker.start }), [pin, archive, rename.start, picker.start])
  const session = c?.session
  const start = c?.start ?? 0
  const notes = useMemo(() => portal.notes.filter(n => n.session === session && n.at >= start).map(n => ({ ...n, at: n.at - start })), [portal.notes, session, start])
  const [dock, setDock] = useState(0)
  // Nako waits on a secret until it's answered, so the composer becomes its field until then.
  const secret = c?.requests.find(r => r.method === "secret")
  const offline = !portal.connected && <p className="border-b bg-muted px-4 py-2 text-muted-foreground text-xs">nako is offline. messages will work again once it reconnects.</p>
  if (!c)
    return (
      <>
        <PageHeader title="New chat" />
        {offline}
        <NewChat portal={portal} />
      </>
    )
  return (
    <>
      <ChatHeader environments={Boolean(portal.me?.environments)} running={c.running} actions={actions} pinned={Boolean(portal.sessions.find(s => s.id === c.session)?.pinned)} groupable={!portal.sessions.find(s => s.id === c.session)?.machine} session={c.session} title={c.title || portal.sessions.find(row => row.id === c.session)?.title || "chat"} />
      {rename.dialog}
      {picker.dialog}
      {offline}
      {find}
      {/* A fresh scroller per opened chat, mounted once its latest page is in, so it starts at the bottom without scrolling there. */}
      <Conversation className="min-h-0 flex-1" initial="instant" key={`${c.session}:${loading}`}>
        {/* Scrollable from the first layout (StickToBottom only sets overflow later), so OlderTurns can pin the bottom before paint. */}
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6" scrollClassName="overflow-y-auto">
          {loading && <TurnSkeletons count={3} />}
          {!loading && <OlderTurns portal={portal} />}
          {!loading && <KeepBottom dock={dock} />}
          {!loading && <Transcript
              live={portal.live}
              messages={c.messages}
              notes={notes}
              running={c.running}
              session={c.session}
              quiet={presence}
            />}
          <Requests answer={portal.answer} requests={c.requests} />
          {portal.error && <p className="text-destructive text-sm">{portal.error}</p>}
          {/* Room under the last message for the dock, so it can scroll clear of Nako. */}
          <div aria-hidden className="-mt-6 shrink-0" style={{ height: dock }} />
        </ConversationContent>
        <ConversationScrollButton style={{ bottom: dock + 16 }} />
        {!loading && (
          <Dock onHeight={setDock}>
            {presence && !c.requests.length && (
              <Presence
                bare={inBubble}
                key={c.session}
                live={portal.live}
                outcome={portal.sessions.find(s => s.id === c.session)?.status}
                running={c.running}
                signOff={portal.signOff?.session === c.session ? portal.signOff.text : ""}
              />
            )}
          </Dock>
        )}
      </Conversation>
      {c.loading && !portal.sessions.some(row => row.id === c.session) ? <ComposerPlaceholder /> : <SecretDock answer={portal.answer} key={c.session} request={secret}>
        <Composer
          command={portal.command}
          commands={portal.commands}
          draftKey={draftKey}
          session={c.session}
          inChat
          running={c.running}
          send={portal.send}
          setError={portal.setError}
          stop={portal.stop}
        />
      </SecretDock>}
    </>
  )
}
