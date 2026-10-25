import { MoreHorizontalIcon } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import type { Portal } from "@/hooks/use-portal"
import { usePresence } from "@/lib/presence"
import { Composer } from "./composer"
import { PageHeader } from "./header"
import { Presence } from "./presence"
import { Requests } from "./requests"
import { sessionActions, useRenameDialog } from "./session-actions"
import { Transcript } from "./transcript"

function ChatMenu({ portal }: { portal: Portal }) {
  const c = portal.current!
  const rename = useRenameDialog(portal)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="More" size="icon" variant="ghost">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {sessionActions(portal, c.session, () => rename.start(c.session)).map(a => (
            <DropdownMenuItem key={a.label} onSelect={a.run}>
              {a.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {rename.dialog}
    </>
  )
}

// Stand-ins for turns that haven't loaded yet: a prompt on the right, a reply on the left.
function TurnSkeletons({ count }: { count: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-6">
      {Array.from({ length: count }, (_, i) => (
        <div className="flex flex-col gap-6" key={i}>
          <Skeleton className="ml-auto h-9 w-2/5 rounded-lg" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </div>
      ))}
    </div>
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
function KeepBottom() {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext()
  // StickToBottom's own view of it, which stays true while it eases toward new content.
  const following = useRef(isAtBottom)
  following.current = isAtBottom
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
      <Composer draftKey="draft:new" placeholder="what are we working on?" portal={portal} tall />
    </div>
  )
}

export function Chat({ portal }: { portal: Portal }) {
  const c = portal.current
  const presence = usePresence()
  const draftKey = c ? `draft:${c.session}` : ""
  const [typing, setTyping] = useState(false)
  // A saved draft counts as typing when the chat opens.
  useEffect(() => setTyping(Boolean(draftKey && localStorage.getItem(draftKey)?.trim())), [draftKey])
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
      <PageHeader title={c.title || "chat"}>
        <ChatMenu portal={portal} />
      </PageHeader>
      {offline}
      {/* A fresh scroller per opened chat, mounted once its latest page is in, so it starts at the bottom without scrolling there. */}
      <Conversation className="min-h-0 flex-1" initial="instant" key={`${c.session}:${c.loading}`}>
        {/* Scrollable from the first layout (StickToBottom only sets overflow later), so OlderTurns can pin the bottom before paint. */}
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6" scrollClassName="overflow-y-auto">
          {c.loading && <TurnSkeletons count={3} />}
          {!c.loading && <OlderTurns portal={portal} />}
          {!c.loading && <KeepBottom />}
          {!c.loading && <Transcript
              live={portal.live}
              messages={c.messages}
              notes={portal.notes.filter(n => n.session === c.session && n.at >= c.start).map(n => ({ ...n, at: n.at - c.start }))}
              running={c.running}
              session={c.session}
              quiet={presence}
            />}
          <Requests answer={portal.answer} requests={c.requests} />
          {portal.error && <p className="text-destructive text-sm">{portal.error}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {presence && !c.loading && !c.requests.length && (
        <Presence
          key={c.session}
          live={portal.live}
          outcome={portal.sessions.find(s => s.id === c.session)?.status}
          running={c.running}
          signOff={portal.signOff?.session === c.session ? portal.signOff.text : ""}
          typing={typing}
        />
      )}
      <Composer draftKey={draftKey} onTyping={setTyping} portal={portal} />
    </>
  )
}
