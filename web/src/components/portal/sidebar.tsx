import { ArrowDownToLineIcon, BellIcon, ChevronLeftIcon, PinIcon, PlusIcon, SettingsIcon } from "lucide-react"
import { memo, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import { appVersion, canCheck, checkForUpdate, installDesktopUpdate, useDesktopUpdate } from "@/lib/desktop-update"
import type { SessionRow, Status } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useDrawer } from "./drawer"
import { type ChatActions, sessionActions, useRenameDialog } from "./session-actions"

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

type RowProps = { row: SessionRow; selected: boolean; go: (hash: string) => void; prefetch: (session: string) => void; actions: ChatActions }

// One chat in the list. It renders again only when its own row, selection or handlers change,
// so a status dot or a streaming turn elsewhere doesn't redraw the whole list.
const ChatRow = memo(function ChatRow({ row, selected, go, prefetch, actions }: RowProps) {
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn("flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent data-[state=open]:bg-accent", selected && "bg-accent")}
          // Shift+click pins or unpins instead of opening.
          onClick={e => (e.shiftKey ? actions.pin(row.id, !row.pinned) : go(`#/c/${row.id}`))}
          // Read the chat while the pointer settles on it, so the click opens it at once.
          onFocus={() => prefetch(row.id)}
          onPointerDown={() => prefetch(row.id)}
          onPointerEnter={() => {
            clearTimeout(hover.current)
            hover.current = setTimeout(() => prefetch(row.id), HOVER_MS)
          }}
          onPointerLeave={() => clearTimeout(hover.current)}
          type="button"
        >
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          {row.status && DOT[row.status] && <span className={cn("size-2 shrink-0 rounded-full", DOT[row.status])} title={row.status} />}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {sessionActions(actions, row.id, Boolean(row.pinned)).map(a => (
          <ContextMenuItem key={a.label} onSelect={a.run}>
            <a.icon className="size-4 text-muted-foreground" />
            {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
})

export function Sidebar({ portal, className }: { portal: Portal; className?: string }) {
  const { go, phone, toggle } = useDrawer()
  const [filter, setFilter] = useState("")
  const rename = useRenameDialog(portal)
  const needle = filter.trim().toLowerCase()
  const { sessions, pin, archive, prefetch } = portal
  const listed = useMemo(() => groups(sessions.filter(s => !s.notifications && (!needle || s.title.toLowerCase().includes(needle)))), [sessions, needle])
  const actions = useMemo(() => ({ pin, archive, rename: rename.start }), [pin, archive, rename.start])
  const inbox = sessions.find(s => s.notifications)
  const open = portal.route.view === "chat" ? portal.route.session : null

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
        {listed.length === 0 && <p className="px-2 py-1 text-muted-foreground text-xs">no chats yet</p>}
        {listed.map(([label, items]) => (
          <div key={label}>
            <p className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-muted-foreground text-xs">
              {label === "pinned" && <PinIcon className="size-3" />}
              {label}
            </p>
            {items.map(row => (
              <ChatRow actions={actions} go={go} key={row.id} prefetch={prefetch} row={row} selected={open === row.id} />
            ))}
          </div>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-2 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {portal.connected ? <AppVersion /> : <span className="px-2 text-muted-foreground text-xs">nako is offline</span>}
        <div className="flex items-center">
          <Button aria-label="Settings" onClick={() => go("#/settings")} size="icon" title="Settings" variant="ghost">
            <SettingsIcon />
          </Button>
        </div>
      </div>
      {rename.dialog}
    </aside>
  )
}

const CHECK_LABEL = { checking: "checking…", latest: "up to date", error: "couldn't check" } as const

/** The app's version; in an app that updates itself, clicking it checks, and a found update gets its button beside it. */
function AppVersion() {
  const update = useDesktopUpdate()
  if (!appVersion) return <span />
  const state = update?.state
  const label = (state === "checking" || state === "latest" || state === "error" ? CHECK_LABEL[state] : null) ?? `v${appVersion}`
  const ready = (state === "ready" || state === "installing") && update?.version
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
        <span className="px-2 text-muted-foreground text-xs tabular-nums">{label}</span>
      )}
      {ready && (
        <Button
          aria-label={`Update to ${update.version}`}
          className="text-primary hover:text-primary"
          onClick={installDesktopUpdate}
          size="icon"
          title={update.error ? `Update to ${update.version} (last try: ${update.error})` : `Update to ${update.version}`}
          variant="ghost"
        >
          <ArrowDownToLineIcon />
        </Button>
      )}
    </div>
  )
}
