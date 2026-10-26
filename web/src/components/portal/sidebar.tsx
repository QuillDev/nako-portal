import { ArrowDownToLineIcon, BellIcon, ChevronLeftIcon, PlusIcon, SettingsIcon } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import { appVersion, installDesktopUpdate, useDesktopUpdate } from "@/lib/desktop-update"
import type { SessionRow, Status } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useDrawer } from "./drawer"
import { sessionActions, useRenameDialog } from "./session-actions"

function age(seconds: number) {
  const days = (Date.now() / 1000 - seconds) / 86400
  if (days < 1) return "today"
  if (days < 2) return "yesterday"
  if (days < 7) return "this week"
  if (days < 30) return "this month"
  return "older"
}

function groups(rows: SessionRow[]) {
  const out: [string, SessionRow[]][] = []
  const pinned = rows.filter(r => r.pinned)
  if (pinned.length) out.push(["pinned", pinned])
  for (const row of rows.filter(r => !r.pinned)) {
    const label = age(row.started_at)
    const group = out.find(([name]) => name === label)
    if (group) group[1].push(row)
    else out.push([label, [row]])
  }
  return out
}

// How long the pointer rests on a chat before it's read ahead of the click.
const HOVER_MS = 80

const DOT: Partial<Record<Status, string>> = { working: "bg-primary animate-pulse", "needs you": "bg-amber-500", failed: "bg-destructive" }

export function Sidebar({ portal, className }: { portal: Portal; className?: string }) {
  const { go, phone, toggle } = useDrawer()
  const [filter, setFilter] = useState("")
  const rename = useRenameDialog(portal)
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined)
  const update = useDesktopUpdate()
  const needle = filter.trim().toLowerCase()
  const rows = portal.sessions.filter(s => !s.notifications && (!needle || s.title.toLowerCase().includes(needle)))
  const inbox = portal.sessions.find(s => s.notifications)
  const open = portal.route.view === "chat" ? portal.route.session : null

  const item = (s: SessionRow) => (
    <ContextMenu key={s.id}>
      <ContextMenuTrigger asChild>
        <button
          className={cn("flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent data-[state=open]:bg-accent", open === s.id && "bg-accent")}
          onClick={() => go(`#/c/${s.id}`)}
          // Read the chat while the pointer settles on it, so the click opens it at once.
          onFocus={() => portal.prefetch(s.id)}
          onPointerDown={() => portal.prefetch(s.id)}
          onPointerEnter={() => {
            clearTimeout(hover.current)
            hover.current = setTimeout(() => portal.prefetch(s.id), HOVER_MS)
          }}
          onPointerLeave={() => clearTimeout(hover.current)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {s.status && DOT[s.status] && <span className={cn("size-2 shrink-0 rounded-full", DOT[s.status])} title={s.status} />}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {sessionActions(portal, s.id, () => rename.start(s.id)).map(a => (
          <ContextMenuItem key={a.label} onSelect={a.run}>
            <a.icon className="size-4 text-muted-foreground" />
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )

  return (
    <aside className={cn("flex w-full flex-col border-r bg-sidebar", className)}>
      <div className="flex flex-col gap-3 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2 pl-1" data-tauri-drag-region="deep">
          <img alt="" className="size-6" src="/icon-192.png" />
          <span className="flex-1 font-medium text-sm">Nako</span>
          <Button aria-label="New chat" onClick={() => go("#/new")} size="icon" title="New chat" variant="ghost">
            <PlusIcon />
          </Button>
          {!phone && (
            <Button aria-label="Hide chats" className="-ml-1" onClick={toggle} size="icon" title="Hide chats (Ctrl+B)" variant="ghost">
              <ChevronLeftIcon />
            </Button>
          )}
        </div>
        <Input aria-label="Search chats" onChange={e => setFilter(e.target.value)} placeholder="Search" type="search" value={filter} />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {/* Always first. The dot is green while a post waits unread, or shows the chat's status. */}
        <button
          className={cn("mt-2 flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent", inbox && open === inbox.id && "bg-accent")}
          disabled={!inbox}
          onClick={() => inbox && go(`#/c/${inbox.id}`)}
          type="button"
        >
          <BellIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{inbox?.title || "Notifications"}</span>
          {inbox?.status && DOT[inbox.status] ? (
            <span className={cn("size-2 shrink-0 rounded-full", DOT[inbox.status])} title={inbox.status} />
          ) : (
            inbox?.unread && open !== inbox.id && <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="new notification" />
          )}
        </button>
        {rows.length === 0 && <p className="px-2 py-1 text-muted-foreground text-xs">no chats yet</p>}
        {groups(rows).map(([label, items]) => (
          <div key={label}>
            <p className="px-2 pt-3 pb-1 text-muted-foreground text-xs">{label}</p>
            {items.map(item)}
          </div>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-2 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <span className="px-2 text-muted-foreground text-xs tabular-nums">{portal.connected ? (appVersion ? `v${appVersion}` : "") : "nako is offline"}</span>
        <div className="flex items-center">
          {update && (
            <Button
              aria-label={`Restart to update to ${update}`}
              className="text-primary hover:text-primary"
              onClick={installDesktopUpdate}
              size="icon"
              title={`Restart to update to ${update}`}
              variant="ghost"
            >
              <ArrowDownToLineIcon />
            </Button>
          )}
          <Button aria-label="Settings" onClick={() => go("#/settings")} size="icon" title="Settings" variant="ghost">
            <SettingsIcon />
          </Button>
        </div>
      </div>
      {rename.dialog}
    </aside>
  )
}
