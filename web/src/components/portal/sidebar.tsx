import { BellIcon, ChevronLeftIcon, GitPullRequestIcon, PinIcon, PlusIcon, RadioTowerIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { type DragEvent, memo, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { openChatSearch, SEARCH_KEYS } from "@/components/portal/chat-search";
import type { Portal } from "@/hooks/use-portal";
import { inBubble } from "@/lib/bubble";
import type { GroupColor, SessionRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDrawer } from "./drawer";
import { LoadingRows } from "./screen-loading";
import { LoadWarning } from "./load-warning";
import { useGroupPicker, useGroupRename } from "./groups";
import { useRenameDialog } from "./session-actions";
import { CHAT_DRAG, canDrag, type ChatDrag, sections, useFolded } from "./sidebar-utils";
import { ChannelRow, ChatRow, DOT, GroupBlock } from "./sidebar-rows";
import { AppVersion, ConnectionDot, HermesVersion } from "./sidebar-footer";

type SidebarProps = Pick<Portal, "sessions" | "sessionsState" | "pin" | "archive" | "prefetch" | "setGroup" | "createGroup" | "updateGroup" | "deleteGroup" | "setError" | "rename" | "route" | "outside" | "connected" | "linked" | "hermes" | "me"> & {
  currentSession?: string;
  currentTitle?: string;
  currentSource?: string;
  className?: string;
};

// Streaming text never enters these props; only sidebar-visible state can redraw the list.
export const Sidebar = memo(function Sidebar({ className, currentSession, currentTitle, currentSource, ...portal }: SidebarProps) {
  const { go, phone, toggle } = useDrawer();
  const rename = useRenameDialog({ ...portal, current: currentSession ? { session: currentSession, title: currentTitle ?? "" } : null });
  const picker = useGroupPicker(portal);
  const renameGroup = useGroupRename(portal);
  const [folded, fold] = useFolded();
  const { sessions, pin, archive, prefetch, setGroup, updateGroup, deleteGroup } = portal;
  const listed = useMemo(
    () =>
      sections(sessions.filter((s) => !s.notifications && !s.reviews)),
    [sessions],
  );
  const actions = useMemo(
    () => ({ pin, archive, rename: rename.start, group: picker.start }),
    [pin, archive, rename.start, picker.start],
  );
  const groupActions = useMemo(
    () => ({
      rename: renameGroup.start,
      recolor: (group: string, color: GroupColor) => updateGroup(group, { color }),
      ungroup: deleteGroup,
    }),
    [renameGroup.start, updateGroup, deleteGroup],
  );
  // The chat being dragged, and the group it's over ("" for out of its group).
  const dragged = useRef<SessionRow | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const drag = useMemo<ChatDrag | undefined>(() => {
    if (!canDrag) return undefined;
    const end = () => {
      dragged.current = null;
      setDropAt(null);
    };
    // The chat would move: it's ours being dragged, and the place isn't the group it's already in.
    const moves = (e: DragEvent, group: string | null) => {
      const row = dragged.current;
      return row && e.dataTransfer.types.includes(CHAT_DRAG) && (row.group?.id ?? null) !== group ? row : null;
    };
    return {
      start: (row) => {
        dragged.current = row;
      },
      end,
      over: (e, group) => {
        if (!dragged.current) return;
        // A group catches the drag before the list around it does.
        e.stopPropagation();
        if (!moves(e, group)) {
          setDropAt(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropAt(group ?? "");
      },
      drop: (e, group) => {
        const row = moves(e, group);
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        end();
        setGroup(row.id, group);
      },
    };
  }, [setGroup]);
  const inbox = sessions.find((s) => s.notifications);
  const reviews = sessions.find((s) => s.reviews);
  const open = portal.route.view === "chat" ? portal.route.session : null;

  return (
    <aside
      className={cn("flex w-full flex-col border-r bg-sidebar", className)}
    >
      <div className="flex flex-col gap-1 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div
          className="flex items-center gap-2 pl-1"
          data-tauri-drag-region="deep"
        >
          {!inBubble && <img alt="" className="size-6" src="/favicon.png" />}
          <span className="flex-1 font-medium text-sm">Nako</span>
          <Button
            aria-label="New chat"
            onClick={() => go("#/new")}
            size="icon"
            title="New chat"
            variant="ghost"
          >
            <PlusIcon />
          </Button>
          {!phone && (
            <Button
              aria-label="Hide chats"
              className="-ml-1"
              onClick={toggle}
              size="icon"
              title="Hide chats (Ctrl+B)"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
          )}
        </div>
        <button
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          data-find=""
          onClick={openChatSearch}
          type="button"
        >
          <SearchIcon className="size-4 shrink-0" />
          <span className="flex-1">Find</span>
          {!phone && (
            <kbd className="font-sans text-[11px] text-muted-foreground/70">
              {SEARCH_KEYS}
            </kbd>
          )}
        </button>
      </div>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onDragLeave={(e) => {
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDropAt(null);
        }}
        onDragOver={drag && ((e) => drag.over(e, null))}
        onDrop={drag && ((e) => drag.drop(e, null))}
      >
        {/* Always first, Reviews under it once something has posted there. */}
        <ChannelRow
          fallback="Notifications"
          go={go}
          icon={BellIcon}
          open={open}
          row={inbox}
        />
        {(reviews || portal.sessionsState === "loading") ? (
          <ChannelRow
            fallback="Reviews"
            go={go}
            icon={GitPullRequestIcon}
            open={open}
            row={reviews}
          />
        ) : <div aria-hidden="true" className="h-9" />}
        {/* Sessions from Slack, cron and other ways in; only when there are some. */}
        {portal.outside.sources.length > 0 ? (
          <button
            className={cn(
              "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
              (portal.route.view === "outside" || (currentSource && currentSource !== "portal")) && "bg-accent",
            )}
            onClick={() => go("#/elsewhere")}
            type="button"
          >
            <RadioTowerIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Elsewhere</span>
            {portal.outside.running.length > 0 && (
              <span className={cn("size-2 shrink-0 rounded-full", DOT.working)} title="working" />
            )}
          </button>
        ) : <div aria-hidden="true" className="h-9" />}
        {portal.sessionsState === "loading" && <LoadingRows label="Loading chats…" />}
        {portal.sessionsState === "failed" && <p role="alert" className="px-2 py-1 text-muted-foreground text-xs">Could not load chats.</p>}
        {portal.sessionsState === "ready" && listed.length === 0 && (
          <p className="px-2 py-1 text-muted-foreground text-xs">
            no chats yet
          </p>
        )}
        {listed.map(([label, items]) => (
          <div key={label}>
            <p className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-muted-foreground text-xs">
              {label === "pinned" && <PinIcon className="size-3" />}
              {label}
            </p>
            {items.map((entry) =>
              entry.kind === "group" ? (
                <GroupBlock
                  actions={actions}
                  drag={drag}
                  fold={fold}
                  folded={folded.has(entry.group.id)}
                  go={go}
                  group={entry.group}
                  groupActions={groupActions}
                  key={`g:${entry.group.id}`}
                  open={open}
                  prefetch={prefetch}
                  rows={entry.rows}
                  target={dropAt === entry.group.id}
                />
              ) : (
                <ChatRow
                  actions={actions}
                  drag={drag}
                  go={go}
                  key={entry.row.id}
                  prefetch={prefetch}
                  row={entry.row}
                  selected={open === entry.row.id}
                />
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-2 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-0 items-center">
          <ConnectionDot connected={portal.connected} linked={portal.linked} />
          {portal.connected ? (
            <>
              <AppVersion />
              {portal.linked && portal.hermes && <HermesVersion version={portal.hermes} />}
            </>
          ) : (
            <span className="px-2 text-muted-foreground text-xs">
              nako is offline
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {portal.connected && <LoadWarning go={go} me={portal.me} />}
          <Button
            aria-label="Settings"
            onClick={() => go("#/settings")}
            size="icon"
            title="Settings"
            variant="ghost"
          >
            <SettingsIcon />
          </Button>
        </div>
      </div>
      {rename.dialog}
      {picker.dialog}
      {renameGroup.dialog}
    </aside>
  );
});
