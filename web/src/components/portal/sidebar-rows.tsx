import { memo, useRef } from "react";
import { ChevronDownIcon, FolderMinusIcon, PencilIcon, type LucideIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { type ChatGroup, GROUP_COLORS, type GroupColor, type SessionRow, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GROUP_HEX, GroupSwatch } from "./groups";
import { type ChatActions, sessionActions } from "./session-actions";
import { CHAT_DRAG, type ChatDrag } from "./sidebar-utils";

// How long the pointer rests on a chat before it's read ahead of the click.
const HOVER_MS = 80;

export const DOT: Partial<Record<Status, string>> = {
  working: "bg-primary animate-pulse",
  "needs you": "bg-amber-500",
  failed: "bg-destructive",
};

// A chat with something you haven't read yet: a reply that landed while you were elsewhere, or a post.
const NEW = "bg-emerald-500";

type RowProps = {
  row: SessionRow;
  selected: boolean;
  go: (hash: string) => void;
  prefetch: (session: string) => void;
  actions: ChatActions;
  drag?: ChatDrag;
};

// One chat in the list. It renders again only when its own row, selection or handlers change,
// so a status dot or a streaming turn elsewhere doesn't redraw the whole list.
export const ChatRow = memo(function ChatRow({
  row,
  selected,
  go,
  prefetch,
  actions,
  drag,
}: RowProps) {
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent data-[state=open]:bg-accent data-[dragging]:opacity-50",
            selected && "bg-accent",
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
          // Another machine's chats can't be grouped.
          draggable={Boolean(drag && !row.machine)}
          onDragStart={(e) => {
            if (!drag) return;
            e.dataTransfer.setData(CHAT_DRAG, row.id);
            e.dataTransfer.effectAllowed = "move";
            e.currentTarget.dataset.dragging = "";
            drag.start(row);
          }}
          onDragEnd={(e) => {
            delete e.currentTarget.dataset.dragging;
            drag?.end();
          }}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          {row.machine && (
            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{row.machine}</span>
          )}
          {row.status && DOT[row.status] ? (
            <span
              className={cn("size-2 shrink-0 rounded-full", DOT[row.status])}
              title={row.status}
            />
          ) : (
            row.finished &&
            !selected && <span className={cn("size-2 shrink-0 rounded-full", NEW)} title="new reply" />
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
  drag?: ChatDrag;
  // A dragged chat is over this group and would land in it.
  target: boolean;
};

type GroupActions = {
  rename: (group: ChatGroup) => void;
  recolor: (group: string, color: GroupColor) => void;
  ungroup: (group: string) => void;
};

// A chat group: its name row (click folds it; right-click renames, recolors or ungroups) and its chats.
export const GroupBlock = memo(function GroupBlock({ group, rows, folded, open, fold, go, prefetch, actions, groupActions, drag, target }: GroupProps) {
  const holdsOpen = rows.some((r) => r.id === open);
  // Folded, a status dot inside still shows on the name row, or else a new reply's.
  const dot = folded ? rows.map((r) => r.status).find((s) => s && DOT[s]) : undefined;
  const fresh = folded && !dot && rows.some((r) => r.finished && r.id !== open);
  return (
    <div
      className={cn("rounded-md", target && "bg-accent")}
      onDragOver={drag && ((e) => drag.over(e, group.id))}
      onDrop={drag && ((e) => drag.drop(e, group.id))}
    >
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
            {fresh && <span className={cn("size-2 shrink-0 rounded-full", NEW)} title="new reply" />}
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
      {!folded && (
        <div className="relative pl-5">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[13px] w-0.5 opacity-70"
            style={{ background: GROUP_HEX[group.color] }}
          />
          {rows.map((row) => (
            <ChatRow
              actions={actions}
              drag={drag}
              go={go}
              key={row.id}
              prefetch={prefetch}
              row={row}
              selected={open === row.id}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// A chat posts land in. The dot is green while a post waits unread, or shows the chat's status.
export function ChannelRow({
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
            className={cn("size-2 shrink-0 rounded-full", NEW)}
            title="new post"
          />
        )
      )}
    </button>
  );
}

