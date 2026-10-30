// Cmd/Ctrl+K or the sidebar's Find row: find a chat by title, archived ones included. Picking an
// archived chat brings it back to the list and opens it. It drops down from the sidebar's top corner.
import { ArchiveIcon, BellIcon, MessageSquareIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { navigate, type Portal } from "@/hooks/use-portal";
import { api } from "@/lib/api";
import type { SessionRow } from "@/lib/types";

type Archived = Pick<SessionRow, "id" | "title" | "started_at">;

const OPEN = "nako-chat-search";
export const SEARCH_KEYS = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘K"
  : "Ctrl K";
export const openChatSearch = () => window.dispatchEvent(new Event(OPEN));

const matches = (title: string, query: string) =>
  !query || title.toLowerCase().includes(query);

export const ChatSearch = memo(function ChatSearch({
  sessions,
  unarchive,
}: Pick<Portal, "sessions" | "unarchive">) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<Archived[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return setQuery("");
    let live = true;
    api<Archived[]>("/api/sessions?archived=only")
      .then((rows) => live && setArchived(rows))
      .catch(() => live && setArchived([]));
    return () => {
      live = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const chats = useMemo(
    () => sessions.filter((s) => matches(s.title, q)),
    [sessions, q],
  );
  const shelved = useMemo(
    // A chat already in the list isn't shown as archived too (an older server returns every chat here).
    () => {
      const listed = new Set(sessions.map((s) => s.id));
      return archived.filter((s) => !listed.has(s.id) && matches(s.title, q));
    },
    [archived, sessions, q],
  );

  const pick = (session: string, wasArchived: boolean) => {
    setOpen(false);
    if (wasArchived) unarchive(session);
    else navigate(`#/c/${session}`);
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent
        className="top-3 left-3 w-[min(380px,calc(100vw-1.5rem))] max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-xl bg-card p-0 shadow-2xl sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <DialogDescription className="sr-only">
          Search chats, archived ones included
        </DialogDescription>
        <Command
          className="bg-transparent **:data-[slot=command-input-wrapper]:h-10 **:data-[slot=command-item]:py-1"
          loop
          shouldFilter={false}
        >
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search chats"
            value={query}
          />
          <CommandList className="max-h-[min(20rem,55vh)]">
            <CommandEmpty>no chats match</CommandEmpty>
            {chats.length > 0 && (
              <CommandGroup heading="chats">
                {chats.map((s) => (
                  <CommandItem
                    key={s.id}
                    onSelect={() => pick(s.id, false)}
                    value={`chat:${s.id}`}
                  >
                    {s.notifications ? <BellIcon /> : <MessageSquareIcon />}
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {shelved.length > 0 && (
              <CommandGroup heading="archived">
                {shelved.map((s) => (
                  <CommandItem
                    key={s.id}
                    onSelect={() => pick(s.id, true)}
                    value={`archived:${s.id}`}
                  >
                    <ArchiveIcon />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {s.title}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
});
