import { MoreHorizontalIcon } from "lucide-react"
import { useState } from "react"
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import { Composer } from "./composer"
import { PageHeader } from "./header"
import { Requests } from "./requests"
import { Transcript } from "./transcript"

function ChatMenu({ portal }: { portal: Portal }) {
  const c = portal.current!
  const pinned = Boolean(portal.sessions.find(s => s.id === c.session)?.pinned)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState("")
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="More" size="icon" variant="ghost">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setTitle(c.title)
              setRenaming(true)
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => portal.pin(c.session, !pinned)}>{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => portal.archive(c.session)}>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={setRenaming} open={renaming}>
        <DialogContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={e => {
              e.preventDefault()
              if (title.trim()) portal.rename(c.session, title.trim())
              setRenaming(false)
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
            </DialogHeader>
            <Input aria-label="Title" autoFocus onChange={e => setTitle(e.target.value)} value={title} />
            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
