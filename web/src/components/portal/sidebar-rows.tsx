import { memo, useEffect, useRef } from "react";
import { ArrowUpIcon, ChevronDownIcon, FolderMinusIcon, MessageSquareIcon, PencilIcon, type LucideIcon } from "lucide-react";
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

function StatusDot({ row, selected }: { row: SessionRow; selected: boolean }) {
  if (row.status && DOT[row.status]) {
    return <span className={cn("size-2 shrink-0 rounded-full", DOT[row.status])} title={row.status} />;
  }
  if (row.group_status === "needs_you") {
    return <span className="size-2 shrink-0 rounded-full bg-amber-500" title="needs you" />;
  }
  if (row.group_status === "working") {
    return <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" title="working" />;
  }
  if (row.group_status === "waiting") {
    return <span className="size-2 shrink-0 rounded-full bg-sky-500" title="waiting" />;
  }
  if (row.finished && !selected) {
    return <span className={cn("size-2 shrink-0 rounded-full", NEW)} title="new reply" />;
  }
  return null;
}

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
  useEffect(() => () => clearTimeout(hover.current), []);
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
          <StatusDot row={row} selected={selected} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {sessionActions(actions, row.id, Boolean(row.pinned), !row.machine, row.group).map((a) => (
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
  // A dragged chat is hovering over this group.
  target: boolean;
};

export type GroupActions = {
  rename: (group: ChatGroup) => void;
  recolor: (group: string, color: GroupColor) => void;
  ungroup: (group: string) => void;
  setLead: (group: string, session: string | null) => void;
};

function groupRollup(rows: SessionRow[], open: string | null) {
  const needsAttention = rows.some((r) => r.status === "needs you" || r.status === "failed" || r.group_status === "needs_you");
  const hasWorking = rows.some((r) => r.status === "working" || r.group_status === "working");
  const hasUnread = rows.some((r) => r.finished && open !== r.id);
  return { needsAttention, hasWorking, hasUnread };
}

function FoldedRollup({ rows, childCount, open }: { rows: SessionRow[]; childCount: number; open: string | null }) {
  const { needsAttention, hasWorking, hasUnread } = groupRollup(rows, open);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {needsAttention && <span className="size-1.5 rounded-full bg-amber-500" title="needs you" />}
      {hasWorking && <span className="size-1.5 animate-pulse rounded-full bg-primary" title="working" />}
      {!needsAttention && !hasWorking && hasUnread && <span className={cn("size-1.5 rounded-full", NEW)} title="new reply" />}
      {childCount > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">{childCount}</span>}
    </span>
  );
}

function GroupRowMenu({
  group,
  leadId,
  targetId,
  firstRowId,
  go,
  groupActions,
}: {
  group: ChatGroup;
  leadId: string | null;
  targetId: string | null;
  firstRowId: string | null;
  go: (hash: string) => void;
  groupActions: GroupActions;
}) {
  return (
    <ContextMenuContent>
      {targetId && (
        <ContextMenuItem onSelect={() => go(`#/c/${targetId}`)}>
          <MessageSquareIcon className="size-4 text-muted-foreground" />
          {leadId ? "Open main chat" : "Open latest chat"}
        </ContextMenuItem>
      )}
      {!leadId && firstRowId && (
        <ContextMenuItem onSelect={() => groupActions.setLead(group.id, firstRowId)}>
          <ArrowUpIcon className="size-4 text-muted-foreground" />
          Set latest as main chat
        </ContextMenuItem>
      )}
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
  );
}

function splitGroupRows(group: ChatGroup, rows: SessionRow[]) {
  const leadId = group.lead_session ?? null;
  const leadRow = leadId ? rows.find((r) => r.id === leadId) ?? null : null;
  const childRows = leadId ? rows.filter((r) => r.id !== leadId) : rows;
  return { leadId, leadRow, childRows, targetId: leadId ?? rows[0]?.id ?? null };
}

function GroupHeaderButton({
  group,
  leadRow,
  targetId,
  folded,
  isLeadOpen,
  childCount,
  open,
  rows,
  go,
  prefetch,
}: {
  group: ChatGroup;
  leadRow: SessionRow | null;
  targetId: string | null;
  folded: boolean;
  isLeadOpen: boolean;
  childCount: number;
  open: string | null;
  rows: SessionRow[];
  go: (hash: string) => void;
  prefetch: (session: string) => void;
}) {
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  return (
    <button
      className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2 text-left"
      onClick={() => targetId && go(`#/c/${targetId}`)}
      onFocus={() => targetId && prefetch(targetId)}
      onPointerDown={() => targetId && prefetch(targetId)}
      onPointerEnter={() => {
        if (!targetId) return;
        clearTimeout(hover.current);
        hover.current = setTimeout(() => prefetch(targetId), HOVER_MS);
      }}
      onPointerLeave={() => clearTimeout(hover.current)}
      title={leadRow ? `${group.name} — ${leadRow.title}` : group.name}
      type="button"
    >
      <GroupSwatch color={group.color} />
      <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
      {folded ? (
        <FoldedRollup childCount={childCount} open={open} rows={rows} />
      ) : (
        leadRow && <StatusDot row={leadRow} selected={isLeadOpen} />
      )}
    </button>
  );
}

// A chat group: the group row itself IS the main (lead) chat; clicking the group name opens it
// directly in Portal's core chat view, while the chevron folds/unfolds its child worker threads.
export const GroupBlock = memo(function GroupBlock({
  group,
  rows,
  folded,
  open,
  fold,
  go,
  prefetch,
  actions,
  groupActions,
  drag,
  target,
}: GroupProps) {
  const { leadId, leadRow, childRows, targetId } = splitGroupRows(group, rows);
  const isLeadOpen = Boolean(leadId && open === leadId);
  const holdsOpen = rows.some((r) => r.id === open);

  return (
    <div
      className={cn("rounded-md", target && "bg-accent/50 ring-1 ring-inset ring-ring")}
      onDragOver={(e) => drag?.over(e, group.id)}
      onDrop={(e) => drag?.drop(e, group.id)}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "flex w-full select-none items-center rounded-md text-sm hover:bg-accent data-[state=open]:bg-accent",
              (isLeadOpen || (folded && holdsOpen)) && "bg-accent",
            )}
          >
            <GroupHeaderButton
              childCount={leadId ? childRows.length : rows.length}
              folded={folded}
              go={go}
              group={group}
              isLeadOpen={isLeadOpen}
              leadRow={leadRow}
              open={open}
              prefetch={prefetch}
              rows={rows}
              targetId={targetId}
            />
            {childRows.length > 0 && (
              <button
                aria-expanded={!folded}
                aria-label={folded ? `Expand ${group.name}` : `Collapse ${group.name}`}
                className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => fold(group.id)}
                title={folded ? "Expand threads" : "Collapse threads"}
                type="button"
              >
                <ChevronDownIcon
                  className={cn("size-4 shrink-0 transition-transform", folded && "-rotate-90")}
                />
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <GroupRowMenu
          firstRowId={rows[0]?.id ?? null}
          go={go}
          group={group}
          groupActions={groupActions}
          leadId={leadId}
          targetId={targetId}
        />
      </ContextMenu>
      {!folded && childRows.length > 0 && (
        <div className="relative pl-5">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[13px] w-0.5 opacity-70"
            style={{ background: GROUP_HEX[group.color] }}
          />
          {childRows.map((row) => (
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
