// Cmd/Ctrl+K or the sidebar's Find row: find a chat by title, archived ones included. Picking an
// archived chat brings it back to the list and opens it. It grows out of the Find row when that's on
// screen (input over the row, list unfolding below), else it sits near the top of the window.
import { ArchiveIcon, BellIcon, GitPullRequestIcon, MessageSquareIcon } from "lucide-react";
import { LoadingRows } from "./screen-loading";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
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
import { mergeMessageMatches, type MessageMatch } from "@/lib/chat-search";
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
  const [archived, setArchived] = useState<Archived[] | null>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const [results, setResults] = useState<MessageMatch[]>([]);
  const [searchState, setSearchState] = useState("");
  const generation = useRef(0);

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
    setArchived(null);
    api<Archived[]>("/api/sessions?archived=only")
      .then((rows) => live && setArchived(rows))
      .catch(() => live && setArchived([]));
    return () => {
      live = false;
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setResults([]);
    setSearchState("");
    if (!open || q.length < 2) return;
    setSearchState("Searching messages…");
    const timer = setTimeout(() => {
      void api<MessageMatch[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal }).then(rows => {
        if (current !== generation.current || controller.signal.aborted) return;
        setResults(rows);
        setSearchState("");
      }).catch(() => {
        if (current === generation.current && !controller.signal.aborted) setSearchState("Message search is unavailable");
      });
    }, 180);
    return () => { ++generation.current; clearTimeout(timer); controller.abort(); };
  }, [open, q]);
  const chats = useMemo(
    () => sessions.filter((s) => matches(s.title, q)),
    [sessions, q],
  );
  const shelved = useMemo(
    // A chat already in the list isn't shown as archived too (an older server returns every chat here).
    () => {
      const listed = new Set(sessions.map((s) => s.id));
      return (archived ?? []).filter((s) => !listed.has(s.id) && matches(s.title, q));
    },
    [archived, sessions, q],
  );

  const pick = (session: string, wasArchived: boolean) => {
    setOpen(false);
    if (wasArchived) unarchive(session);
    else navigate(`#/c/${session}`);
  };
  const messageMatches = mergeMessageMatches(results, [...chats, ...shelved]);

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
          <CommandList className="h-[min(20rem,55vh)]">
            {searchState === "Searching messages…" || archived === null ? !chats.length && !shelved.length && <LoadingRows label="Searching chats…" count={3} /> : <CommandEmpty>{searchState || "no chats match"}</CommandEmpty>}
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
                    {s.machine && <span className="shrink-0 text-xs text-muted-foreground">{s.machine}</span>}
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
            {messageMatches.length > 0 && <CommandGroup heading="messages">
              {messageMatches.map(s => <CommandItem key={s.id} value={`message:${s.id}`} onSelect={() => pick(s.id, s.archived)}>
                {s.archived ? <ArchiveIcon /> : <MessageSquareIcon />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{s.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{s.snippet}</span>
                </span>
              </CommandItem>)}
            </CommandGroup>}
            {searchState && (chats.length > 0 || shelved.length > 0) && <p role="status" className="px-2 py-1 text-xs text-muted-foreground">{searchState}</p>}
          </CommandList>
        </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
});
