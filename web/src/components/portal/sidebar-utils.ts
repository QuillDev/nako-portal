import { type DragEvent, useCallback, useState } from "react";
import { age } from "@/lib/times";
import { d } from "@/lib/decode";
import type { ChatGroup, SessionRow } from "@/lib/types";

// A line in the list: one chat, or a chat group with its chats (newest first).
export type Entry =
  | { kind: "chat"; row: SessionRow }
  | { kind: "group"; group: ChatGroup; rows: SessionRow[] };

// Pinned chats first, then the rest by age. A group sits where its newest chat would, so it moves
// up as any of its chats does; the rows come newest first, so the first one met places it.
export function sections(rows: SessionRow[]) {
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
export function useFolded() {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(d.array(d.string()).parse(JSON.parse(localStorage.getItem(FOLDED) || "[]")));
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

// Dragging a chat onto a group files it there; dropping it anywhere else in the list takes it out
// of its group. Only with a mouse: on touch, a long press is the chat's menu.
export const CHAT_DRAG = "application/x-nako-chat";
export const canDrag = typeof matchMedia === "function" && !matchMedia("(pointer: coarse)").matches;

export type ChatDrag = {
  start: (row: SessionRow) => void;
  end: () => void;
  // `group` is where the chat would land: a group id, or null for out of its group.
  over: (e: DragEvent, group: string | null) => void;
  drop: (e: DragEvent, group: string | null) => void;
};

