// Cmd/Ctrl+K or the sidebar's Find row: find a chat by title, archived ones included. Picking an
// archived chat brings it back to the list and opens it. It grows out of the Find row when that's on
// screen (input over the row, list unfolding below), else it sits near the top of the window.
import { ArchiveIcon, BellIcon, GitPullRequestIcon, MessageSquareIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type CSSProperties, memo, useEffect, useMemo, useState } from "react";
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
  DialogDescription,
  DialogOverlay,
  DialogPortal,
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

const WIDTH = 380;

// Where the box opens: over the sidebar's Find row when it's visible, so the row becomes the input.
const anchor = (): CSSProperties | null => {
  const row = document.querySelector("[data-find]");
  const r = row?.getBoundingClientRect();
  // A hidden sidebar or closed drawer keeps the row's box, so ask what's actually drawn there.
  if (!row || !r || !row.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)))
    return null;
  const width = Math.min(Math.max(WIDTH, r.width + 2), window.innerWidth - r.left - 12);
  return {
    top: r.top - 1,
    left: r.left - 1,
    width,
    "--find-row": `${r.width + 2}px`,
  } as CSSProperties;
};

const matches = (title: string, query: string) =>
  !query || title.toLowerCase().includes(query);

export const ChatSearch = memo(function ChatSearch({
  sessions,
  unarchive,
}: Pick<Portal, "sessions" | "unarchive">) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<Archived[]>([]);
  const [at, setAt] = useState<CSSProperties | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setAt(anchor());
        setOpen((o) => !o);
      }
    };
    const onOpen = () => {
      setAt(anchor());
      setOpen(true);
    };
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
      <DialogPortal>
        <DialogOverlay className={at ? "bg-transparent" : undefined} />
        <DialogPrimitive.Content
          className={
            at
              ? "find-pop fixed z-50 overflow-hidden rounded-lg border bg-card shadow-2xl outline-none"
              : "fixed top-[14vh] left-1/2 z-50 w-[min(380px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-card shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          }
          style={at ?? undefined}
        >
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <DialogDescription className="sr-only">
          Search chats, archived ones included
        </DialogDescription>
        <Command
          className="bg-transparent **:data-[slot=command-input-wrapper]:h-8 **:data-[slot=command-input-wrapper]:px-2 **:data-[slot=command-input]:h-8 **:data-[slot=command-input]:py-0 **:data-[slot=command-item]:py-1"
          loop
          shouldFilter={false}
        >
          <CommandInput
            onValueChange={setQuery}
            placeholder="Find"
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
                    {s.notifications ? <BellIcon /> : s.reviews ? <GitPullRequestIcon /> : <MessageSquareIcon />}
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
});
