import { MoreHorizontalIcon } from "lucide-react"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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

export function Chat({ portal }: { portal: Portal }) {
  const c = portal.current
  return (
    <>
      <PageHeader title={c ? c.title || "chat" : "New chat"}>{c && <ChatMenu portal={portal} />}</PageHeader>
      {!portal.connected && <p className="border-b bg-muted px-4 py-2 text-muted-foreground text-xs">nako is offline. messages will work again once it reconnects.</p>}
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-6">
          {!c && <ConversationEmptyState description="" title="what are we working on?" />}
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
