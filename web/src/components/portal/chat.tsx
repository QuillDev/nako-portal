import { MoreHorizontalIcon } from "lucide-react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import type { Portal } from "@/hooks/use-portal"
import { Composer } from "./composer"
import { PageHeader } from "./header"
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

export function Chat({ portal }: { portal: Portal }) {
  const c = portal.current
  return (
    <>
      <PageHeader title={c ? c.title || "chat" : "New chat"}>{c && <ChatMenu portal={portal} />}</PageHeader>
      {!portal.connected && <p className="border-b bg-muted px-4 py-2 text-muted-foreground text-xs">nako is offline. messages will work again once it reconnects.</p>}
      {/* A fresh scroller per opened chat, mounted once its latest page is in, so it starts at the bottom without scrolling there. */}
      <Conversation className="min-h-0 flex-1" initial="instant" key={c ? `${c.session}:${c.loading}` : "new"}>
        {/* Scrollable from the first layout (StickToBottom only sets overflow later), so OlderTurns can pin the bottom before paint. */}
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6" scrollClassName="overflow-y-auto">
          {!c && <ConversationEmptyState description="" title="what are we working on?" />}
          {c?.loading && <TurnSkeletons count={3} />}
          {c && !c.loading && <OlderTurns portal={portal} />}
          {c && !c.loading && <Transcript live={portal.live} messages={c.messages} running={c.running} session={c.session} />}
          {c && <Requests answer={portal.answer} requests={c.requests} />}
          {portal.error && <p className="text-destructive text-sm">{portal.error}</p>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <Composer draftKey={`draft:${c?.session || "new"}`} portal={portal} />
    </>
  )
}
