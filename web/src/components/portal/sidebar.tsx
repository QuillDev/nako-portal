import {
  ArrowDownToLineIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  FolderMinusIcon,
  GitPullRequestIcon,
  type LucideIcon,
  PinIcon,
  PlusIcon,
  NetworkIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { health, useMesh } from "@/lib/mesh";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openChatSearch, SEARCH_KEYS } from "@/components/portal/chat-search";
import type { Portal } from "@/hooks/use-portal";
import { inBubble } from "@/lib/bubble";
import {
  appVersion,
  canCheck,
  checkForUpdate,
  installDesktopUpdate,
  useDesktopUpdate,
} from "@/lib/desktop-update";
import { type ChatGroup, GROUP_COLORS, type GroupColor, type SessionRow, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDrawer } from "./drawer";
import { GROUP_HEX, GroupSwatch, useGroupPicker, useGroupRename } from "./groups";
import {
  type ChatActions,
  sessionActions,
  useRenameDialog,
} from "./session-actions";

function age(seconds: number) {
  const days = (Date.now() / 1000 - seconds) / 86400;
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return "this week";
  if (days < 30) return "this month";
  return "older";
}

// A line in the list: one chat, or a chat group with its chats (newest first).
type Entry =
  | { kind: "chat"; row: SessionRow }
  | { kind: "group"; group: ChatGroup; rows: SessionRow[] };

// Pinned chats first, then the rest by age. A group sits where its newest chat would, so it moves
// up as any of its chats does; the rows come newest first, so the first one met places it.
function sections(rows: SessionRow[]) {
  const out: [string, Entry[]][] = [];
  const pinned = rows.filter((r) => r.pinned);
  if (pinned.length) out.push(["pinned", pinned.map((row) => ({ kind: "chat", row }))]);
  const placed = new Map<string, SessionRow[]>();
  for (const row of rows.filter((r) => !r.pinned)) {
    const held = row.group && placed.get(row.group.id);
    if (held) {
      held.push(row);
      continue;
    }
    const label = age(row.started_at);
    let entry: Entry = { kind: "chat", row };
    if (row.group) {
      const members = [row];
      placed.set(row.group.id, members);
      entry = { kind: "group", group: row.group, rows: members };
    }
    const section = out.find(([name]) => name === label);
    if (section) section[1].push(entry);
    else out.push([label, [entry]]);
  }
  return out;
}

// Groups folded shut on this device.
const FOLDED = "nako-folded-groups";
function useFolded() {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(z.array(z.string()).parse(JSON.parse(localStorage.getItem(FOLDED) || "[]")));
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      localStorage.setItem(FOLDED, JSON.stringify([...next]));
      return next;
    });
  }, []);
  return [folded, toggle] as const;
}

// How long the pointer rests on a chat before it's read ahead of the click.
const HOVER_MS = 80;

const DOT: Partial<Record<Status, string>> = {
  working: "bg-primary animate-pulse",
  "needs you": "bg-amber-500",
  failed: "bg-destructive",
};

type RowProps = {
  row: SessionRow;
  selected: boolean;
  // Drawn inside a group: indented, with the group's color down its left edge.
  color?: GroupColor;
  go: (hash: string) => void;
  prefetch: (session: string) => void;
  actions: ChatActions;
};

// One chat in the list. It renders again only when its own row, selection or handlers change,
// so a status dot or a streaming turn elsewhere doesn't redraw the whole list.
const ChatRow = memo(function ChatRow({
  row,
  selected,
  color,
  go,
  prefetch,
  actions,
}: RowProps) {
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "relative flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent data-[state=open]:bg-accent",
            selected && "bg-accent",
            color && "pl-7",
          )}
          // Shift+click pins or unpins instead of opening.
          onClick={(e) =>
            e.shiftKey ? actions.pin(row.id, !row.pinned) : go(`#/c/${row.id}`)
          }
          // Read the chat while the pointer settles on it, so the click opens it at once.
          onFocus={() => prefetch(row.id)}
          onPointerDown={() => prefetch(row.id)}
          onPointerEnter={() => {
            clearTimeout(hover.current);
            hover.current = setTimeout(() => prefetch(row.id), HOVER_MS);
          }}
          onPointerLeave={() => clearTimeout(hover.current)}
          type="button"
        >
          {color && (
            <span
              className="absolute inset-y-0 left-[13px] w-0.5 opacity-70"
              style={{ background: GROUP_HEX[color] }}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          {row.machine && (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{row.machine}</span>
          )}
          {row.status && DOT[row.status] && (
            <span
              className={cn("size-2 shrink-0 rounded-full", DOT[row.status])}
              title={row.status}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {sessionActions(actions, row.id, Boolean(row.pinned), !row.machine).map((a) => (
          <ContextMenuItem key={a.label} onSelect={a.run}>
            <a.icon className="size-4 text-muted-foreground" />
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
});

type GroupProps = {
  group: ChatGroup;
  rows: SessionRow[];
  folded: boolean;
  open: string | null;
  fold: (id: string) => void;
  go: (hash: string) => void;
  prefetch: (session: string) => void;
  actions: ChatActions;
  groupActions: GroupActions;
};

type GroupActions = {
  rename: (group: ChatGroup) => void;
  recolor: (group: string, color: GroupColor) => void;
  ungroup: (group: string) => void;
};

// A chat group: its name row (click folds it; right-click renames, recolors or ungroups) and its chats.
const GroupBlock = memo(function GroupBlock({ group, rows, folded, open, fold, go, prefetch, actions, groupActions }: GroupProps) {
  const holdsOpen = rows.some((r) => r.id === open);
  // Folded, a status dot inside still shows on the name row.
  const dot = folded ? rows.map((r) => r.status).find((s) => s && DOT[s]) : undefined;
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            aria-expanded={!folded}
            className={cn(
              "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent data-[state=open]:bg-accent",
              folded && holdsOpen && "bg-accent",
            )}
            onClick={() => fold(group.id)}
            type="button"
          >
            <GroupSwatch color={group.color} />
            <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
            {dot && <span className={cn("size-2 shrink-0 rounded-full", DOT[dot])} title={dot} />}
            <ChevronDownIcon
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", folded && "-rotate-90")}
            />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => groupActions.rename(group)}>
            <PencilIcon className="size-4 text-muted-foreground" />
            Rename group
          </ContextMenuItem>
          <div className="flex gap-1.5 px-2 py-1.5">
            {GROUP_COLORS.map((color) => (
              <ContextMenuItem
                aria-label={color}
                className={cn(
                  "size-5 rounded-[5px] p-0",
                  color === group.color && "outline-2 outline-foreground outline-offset-2",
                )}
                key={color}
                onSelect={() => groupActions.recolor(group.id, color)}
                style={{ background: GROUP_HEX[color] }}
                title={color}
              />
            ))}
          </div>
          <ContextMenuItem onSelect={() => groupActions.ungroup(group.id)}>
            <FolderMinusIcon className="size-4 text-muted-foreground" />
            Ungroup
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {!folded &&
        rows.map((row) => (
          <ChatRow
            actions={actions}
            color={group.color}
            go={go}
            key={row.id}
            prefetch={prefetch}
            row={row}
            selected={open === row.id}
          />
        ))}
    </div>
  );
});

// A chat posts land in. The dot is green while a post waits unread, or shows the chat's status.
function ChannelRow({
  row,
  icon: Icon,
  fallback,
  open,
  go,
}: {
  row?: SessionRow;
  icon: LucideIcon;
  fallback: string;
  open: string | null;
  go: (hash: string) => void;
}) {
  return (
    <button
      className={cn(
        "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm first:mt-2 hover:bg-accent",
        row && open === row.id && "bg-accent",
      )}
      disabled={!row}
      onClick={() => row && go(`#/c/${row.id}`)}
      type="button"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{row?.title || fallback}</span>
      {row?.status && DOT[row.status] ? (
        <span
          className={cn("size-2 shrink-0 rounded-full", DOT[row.status])}
          title={row.status}
        />
      ) : (
        row?.unread &&
        open !== row.id && (
          <span
            className="size-2 shrink-0 rounded-full bg-emerald-500"
            title="new post"
          />
        )
      )}
    </button>
  );
}

export function Sidebar({
  portal,
  className,
}: {
  portal: Portal;
  className?: string;
}) {
  const { go, phone, toggle } = useDrawer();
  const rename = useRenameDialog(portal);
  const picker = useGroupPicker(portal);
  const renameGroup = useGroupRename(portal);
  const [folded, fold] = useFolded();
  const { sessions, pin, archive, prefetch, updateGroup, deleteGroup } = portal;
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
          {!inBubble && <img alt="" className="size-6" src="/icon-192.png" />}
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
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* Always first, Reviews under it once something has posted there. */}
        <ChannelRow
          fallback="Notifications"
          go={go}
          icon={BellIcon}
          open={open}
          row={inbox}
        />
        {reviews && (
          <ChannelRow
            fallback="Reviews"
            go={go}
            icon={GitPullRequestIcon}
            open={open}
            row={reviews}
          />
        )}
        {listed.length === 0 && (
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
                  fold={fold}
                  folded={folded.has(entry.group.id)}
                  go={go}
                  group={entry.group}
                  groupActions={groupActions}
                  key={`g:${entry.group.id}`}
                  open={open}
                  prefetch={prefetch}
                  rows={entry.rows}
                />
              ) : (
                <ChatRow
                  actions={actions}
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
      <MeshRow go={go} machinesSeen={portal.machinesSeen} open={portal.route.view === "mesh"} />
      <div className="flex items-center justify-between gap-2 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex min-w-0 items-center">
          <ConnectionDot connected={portal.connected} linked={portal.linked} />
          {portal.connected ? (
            <AppVersion />
          ) : (
            <span className="px-2 text-muted-foreground text-xs">
              nako is offline
            </span>
          )}
        </div>
        <div className="flex items-center">
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
}

const MESH_DOT = { online: "bg-emerald-500", degraded: "bg-amber-500", offline: "bg-muted-foreground/40" };

/** The way to the Mesh page, with a dot per machine; only on a portal that is a mesh hub. */
function MeshRow({ go, machinesSeen, open }: { go: (hash: string) => void; machinesSeen: number; open: boolean }) {
  const mesh = useMesh(machinesSeen);
  if (!mesh?.hub) return null;
  return (
    <div className="border-t px-2 py-1">
      <button
        className={cn(
          "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
          open && "bg-accent",
        )}
        onClick={() => go("#/mesh")}
        type="button"
      >
        <NetworkIcon className="size-4 text-muted-foreground" />
        <span className="flex-1">Mesh</span>
        <span className="flex items-center gap-1">
          {mesh.machines.slice(0, 8).map((m) => (
            <span className={cn("size-1.5 rounded-full", MESH_DOT[health(m)])} key={m.name} title={m.name} />
          ))}
        </span>
      </button>
    </div>
  );
}

/** Green while the portal and nako are both reachable, amber while this page reconnects to the portal, red while nako is offline. */
function ConnectionDot({
  connected,
  linked,
}: {
  connected: boolean;
  linked: boolean;
}) {
  const [color, label] = !connected
    ? ["bg-destructive", "nako is offline"]
    : !linked
      ? ["bg-amber-500 animate-pulse", "reconnecting"]
      : ["bg-emerald-500", "connected"];
  return (
    <span
      aria-label={label}
      className={cn("ml-2 size-2 shrink-0 rounded-full", color)}
      role="status"
      title={label}
    />
  );
}

const CHECK_LABEL = {
  checking: "checking…",
  latest: "up to date",
  error: "couldn't check",
} as const;

/** The app's version; in an app that updates itself, clicking it checks, and a found update gets its button beside it. */
function AppVersion() {
  const update = useDesktopUpdate();
  if (!appVersion) return <span />;
  const state = update?.state;
  const label =
    (state === "checking" || state === "latest" || state === "error"
      ? CHECK_LABEL[state]
      : null) ?? `v${appVersion}`;
  const ready =
    (state === "ready" || state === "installing") && update?.version;
  return (
    <div className="flex min-w-0 items-center">
      {canCheck() ? (
        <button
          className="rounded-md px-2 py-1 text-muted-foreground text-xs tabular-nums hover:bg-accent hover:text-foreground disabled:pointer-events-none"
          disabled={state === "checking" || state === "installing"}
          onClick={checkForUpdate}
          title={update?.error ?? "Check for updates"}
          type="button"
        >
          {label}
        </button>
      ) : (
        <span className="px-2 text-muted-foreground text-xs tabular-nums">
          {label}
        </span>
      )}
      {ready && (
        <Button
          aria-label={`Update to ${update.version}`}
          className="text-primary hover:text-primary"
          onClick={installDesktopUpdate}
          size="icon"
          title={
            update.error
              ? `Update to ${update.version} (last try: ${update.error})`
              : `Update to ${update.version}`
          }
          variant="ghost"
        >
          <ArrowDownToLineIcon />
        </Button>
      )}
    </div>
  );
}
