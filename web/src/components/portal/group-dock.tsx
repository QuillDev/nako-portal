import {
  ArchiveIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GitPullRequestIcon,
  GlobeIcon,
} from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { type Attachment, navigate, type Portal } from "@/hooks/use-portal"
import {
  archiveIdleInGroup,
  GROUP_STATUS_DOT,
  GROUP_STATUS_LABEL,
  type GroupArchiveIdleResult,
  type GroupOverviewData,
  type GroupThread,
  previewName,
  pullLabel,
  span,
} from "@/lib/group-overview"
import { appendPreviewMessage, sendMiniMessage, useMiniThread } from "@/lib/mini-thread"
import type { ChatGroup, GroupThreadStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Composer } from "./composer"
import { GroupSwatch } from "./groups"
import { Transcript } from "./transcript"

const STATUS_TEXT: Record<GroupThreadStatus, string> = {
  needs_you: "text-amber-600 dark:text-amber-400",
  working: "text-primary",
  waiting: "text-sky-600 dark:text-sky-400",
  idle: "text-muted-foreground",
  done: "text-emerald-600 dark:text-emerald-400",
}

// Quiet one-click header back-link shown only inside child/worker threads.
export const GroupBackChip = memo(function GroupBackChip({
  group,
  leadSession,
  prefetch,
}: {
  group: ChatGroup
  leadSession: string
  prefetch: (session: string) => void
}) {
  return (
    <button
      className="inline-flex h-7 max-w-[10.5rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:max-w-[15rem]"
      data-group-back
      onClick={() => navigate(`#/c/${leadSession}`)}
      onPointerEnter={() => prefetch(leadSession)}
      title={`Back to ${group.name} main chat`}
      type="button"
    >
      <ArrowUpIcon className="size-3 shrink-0 opacity-75" />
      <GroupSwatch className="size-1.5 rounded-full" color={group.color} />
      <span className="truncate">{group.name}</span>
    </button>
  )
})

function summarizeActiveHint(threads: GroupThread[], archivedCount: number) {
  if (threads.length === 0) return archivedCount > 0 ? `${archivedCount} archived` : ""
  const needsYou = threads.filter(t => t.status === "needs_you").length
  const working = threads.filter(t => t.status === "working").length
  const waiting = threads.filter(t => t.status === "waiting").length
  if (needsYou > 0 && working > 0) return `${needsYou} needs you · ${working} working`
  if (needsYou > 0) return `${needsYou} needs you`
  if (working > 0) return `${working} working`
  if (waiting > 0) return `${waiting} waiting`
  return ""
}

function StatusDots({ threads }: { threads: GroupThread[] }) {
  const visibleDots = threads.slice(0, 6)
  const overflow = Math.max(0, threads.length - visibleDots.length)
  if (visibleDots.length === 0) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {visibleDots.map(thread => (
        <span
          className={cn("size-1.5 rounded-full", GROUP_STATUS_DOT[thread.status])}
          key={thread.id}
          title={`${thread.title} · ${GROUP_STATUS_LABEL[thread.status]}`}
        />
      ))}
      {overflow > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">+{overflow}</span>}
    </span>
  )
}

function ArchivePreviewStrip({
  result,
  busy,
  onConfirm,
  onClose,
}: {
  result: GroupArchiveIdleResult
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="border-t border-border/60 bg-muted/35 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {result.read_only
            ? `Preview: would archive ${result.targets.length} idle ${result.targets.length === 1 ? "thread" : "threads"}`
            : `Archive ${result.targets.length} idle ${result.targets.length === 1 ? "thread" : "threads"}?`}
        </span>
        <div className="flex items-center gap-1.5">
          {!result.read_only && result.targets.length > 0 && (
            <button
              className="cursor-pointer rounded bg-foreground px-2 py-0.5 text-[11px] font-medium text-background hover:opacity-90 disabled:opacity-50"
              disabled={busy}
              onClick={onConfirm}
              type="button"
            >
              Archive
            </button>
          )}
          <button
            className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            {result.read_only ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
      {result.targets.length > 0 && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground">{result.targets.map(t => t.title).join(" · ")}</p>
      )}
    </div>
  )
}

function ThreadListRow({
  thread,
  now,
  onOpenMini,
  prefetch,
}: {
  thread: GroupThread
  now: number
  onOpenMini: (thread: GroupThread) => void
  prefetch: (session: string) => void
}) {
  const snippet = thread.activity || thread.summary
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 transition-colors hover:bg-muted/50" data-dock-thread={thread.id}>
      <button
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
        onClick={() => onOpenMini(thread)}
        onPointerEnter={() => prefetch(thread.id)}
        type="button"
      >
        <span
          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", GROUP_STATUS_DOT[thread.status])}
          title={GROUP_STATUS_LABEL[thread.status]}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{thread.title}</span>
            {thread.is_lead && <span className="shrink-0 text-[11px] text-muted-foreground">Main</span>}
            <span className={cn("shrink-0 text-[11px] tabular-nums", STATUS_TEXT[thread.status])}>
              {GROUP_STATUS_LABEL[thread.status]}
              {now > 0 ? ` · ${span(now - thread.last_active)}` : ""}
            </span>
          </div>
          {snippet && <p className="mt-0.5 truncate text-xs text-muted-foreground">{snippet}</p>}
        </div>
      </button>
      <button
        aria-label={`Open ${thread.title} in full view`}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => navigate(`#/c/${thread.id}`)}
        onPointerEnter={() => prefetch(thread.id)}
        title="Open full chat"
        type="button"
      >
        <ArrowUpRightIcon className="size-3.5" />
      </button>
    </div>
  )
}

function AddonDrawerHeader({
  group,
  session,
  leadSession,
  expanded,
  activeThreads,
  archivedCount,
  archivableCount,
  showArchived,
  archiveBusy,
  onToggle,
  onSetLead,
  onToggleArchived,
  onPreviewArchive,
}: {
  group: ChatGroup
  session: string
  leadSession: string | null
  expanded: boolean
  activeThreads: GroupThread[]
  archivedCount: number
  archivableCount: number
  showArchived: boolean
  archiveBusy: boolean
  onToggle: () => void
  onSetLead: (groupId: string, session: string | null) => void
  onToggleArchived: () => void
  onPreviewArchive: () => void
}) {
  const hint = summarizeActiveHint(activeThreads, archivedCount)
  return (
    <div
      className={cn(
        "flex h-[34px] items-center justify-between gap-2 bg-muted/25 px-3.5 transition-colors",
        !expanded && "hover:bg-muted/45",
      )}
    >
      <button
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        data-group-addon-toggle
        onClick={onToggle}
        title={expanded ? "Collapse group threads (Esc)" : "Expand group threads"}
        type="button"
      >
        <GroupSwatch color={group.color} />
        <span className="truncate text-xs font-medium text-foreground">{group.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">· {activeThreads.length}</span>
        <StatusDots threads={activeThreads} />
        {hint && <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">· {hint}</span>}
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {expanded && !leadSession && (
          <button
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onSetLead(group.id, session)}
            type="button"
          >
            Set as main
          </button>
        )}
        {expanded && archivedCount > 0 && (
          <button
            className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onToggleArchived}
            type="button"
          >
            {showArchived ? "Hide archived" : `Archived (${archivedCount})`}
          </button>
        )}
        {expanded && archivableCount > 0 && (
          <button
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            disabled={archiveBusy}
            onClick={onPreviewArchive}
            type="button"
          >
            <ArchiveIcon className="size-3" />
            <span className="hidden sm:inline">Archive idle</span>
          </button>
        )}
        <button
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse thread list" : "Expand thread list"}
          className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onToggle}
          title={expanded ? "Collapse (Esc)" : "Expand group threads"}
          type="button"
        >
          <ChevronUpIcon className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-180")} />
        </button>
      </div>
    </div>
  )
}

function AddonListDrawer({
  group,
  session,
  leadSession,
  now,
  expanded,
  activeThreads,
  archivedThreads,
  archivableCount,
  onToggle,
  onOpenMini,
  onReload,
  onSetLead,
  prefetch,
}: {
  group: ChatGroup
  session: string
  leadSession: string | null
  now: number
  expanded: boolean
  activeThreads: GroupThread[]
  archivedThreads: GroupThread[]
  archivableCount: number
  onToggle: () => void
  onOpenMini: (thread: GroupThread) => void
  onReload: () => void
  onSetLead: (groupId: string, session: string | null) => void
  prefetch: (session: string) => void
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [archivePreview, setArchivePreview] = useState<GroupArchiveIdleResult | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)

  const previewArchive = async () => {
    setArchiveBusy(true)
    try {
      setArchivePreview(await archiveIdleInGroup(group.id, { dry_run: true }))
    } finally {
      setArchiveBusy(false)
    }
  }

  const confirmArchive = async () => {
    setArchiveBusy(true)
    try {
      await archiveIdleInGroup(group.id, { dry_run: false })
      setArchivePreview(null)
      onReload()
    } finally {
      setArchiveBusy(false)
    }
  }

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-10 overflow-hidden rounded-t-[22px] border border-b-border/60 border-x-input border-t-input bg-card transition-shadow duration-150",
        expanded && "shadow-[0_-10px_28px_rgb(0_0_0/0.09)] dark:shadow-[0_-12px_32px_rgb(0_0_0/0.48)]",
      )}
      data-group-dock-drawer={expanded ? "list" : "addon"}
    >
      <AddonDrawerHeader
        activeThreads={activeThreads}
        archivableCount={archivableCount}
        archiveBusy={archiveBusy}
        archivedCount={archivedThreads.length}
        expanded={expanded}
        group={group}
        leadSession={leadSession}
        onPreviewArchive={() => void previewArchive()}
        onSetLead={onSetLead}
        onToggle={onToggle}
        onToggleArchived={() => setShowArchived(s => !s)}
        session={session}
        showArchived={showArchived}
      />

      <div
        aria-hidden={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-150 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        data-group-dock-list={expanded ? "open" : "closed"}
        inert={!expanded}
      >
        <div className={cn("overflow-hidden", expanded && "border-t border-border/60")}>
          <div className="max-h-[min(240px,32dvh)] overflow-y-auto divide-y divide-border/50">
            {activeThreads.map(thread => (
              <ThreadListRow key={thread.id} now={now} onOpenMini={onOpenMini} prefetch={prefetch} thread={thread} />
            ))}
            {activeThreads.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No active threads in this group</p>
            )}
            {showArchived && archivedThreads.length > 0 && (
              <>
                <div className="bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">Archived &amp; background</div>
                {archivedThreads.map(thread => (
                  <ThreadListRow key={thread.id} now={now} onOpenMini={onOpenMini} prefetch={prefetch} thread={thread} />
                ))}
              </>
            )}
          </div>

          {archivePreview && (
            <ArchivePreviewStrip
              busy={archiveBusy}
              onClose={() => setArchivePreview(null)}
              onConfirm={() => void confirmArchive()}
              result={archivePreview}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function MiniThreadBadge({ thread }: { thread: GroupThread }) {
  const pr = thread.prs[0]
  if (pr) {
    return (
      <a
        className="hidden h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
        href={pr.url}
        rel="noreferrer"
        target="_blank"
      >
        <GitPullRequestIcon className="size-3" />
        <span className="max-w-[8rem] truncate">{pullLabel(pr.key)}</span>
      </a>
    )
  }
  const preview = thread.previews[0]
  if (preview) {
    return (
      <a
        className="hidden h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground sm:inline-flex"
        href={preview.url}
        rel="noreferrer"
        target="_blank"
      >
        <GlobeIcon className="size-3" />
        <span className="max-w-[8rem] truncate">{previewName(preview.label)}</span>
      </a>
    )
  }
  return null
}

// Stage 3: same bottom-anchored outer shell with the mini transcript rising upward from
// the top edge of the composer, while the composer stays in-flow at the exact same position.
function StageThreeFusedChat({
  group,
  thread,
  readOnly,
  composer,
  onReload,
  onBack,
  onCollapse,
  prefetch,
}: {
  group: ChatGroup
  thread: GroupThread
  readOnly: boolean
  composer: Pick<Portal, "command" | "commands" | "send" | "stop" | "setError">
  onReload: () => void
  onBack: () => void
  onCollapse: () => void
  prefetch: (session: string) => void
}) {
  const { messages, notes, running, live, loading, error } = useMiniThread(thread.id, {
    active: thread.status === "working",
    syncKey: `${thread.message_count}:${thread.last_active}:${thread.status}`,
  })

  const sendToMini = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (readOnly) {
        appendPreviewMessage(thread.id, text, thread.title, attachments)
        return
      }
      composer.setError("")
      try {
        await sendMiniMessage(thread.id, text, attachments)
        onReload()
      } catch (err) {
        composer.setError((err as Error).message)
        throw err
      }
    },
    [composer, onReload, readOnly, thread.id, thread.title],
  )

  return (
    <div
      className="group/dock relative z-20 mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-group-dock
      data-group-dock-stage="chat"
      data-group-mini-chat
    >
      <div className="relative h-9">
        <div
          className="absolute inset-x-0 bottom-0 z-10 overflow-hidden rounded-t-[22px] border border-b-border/60 border-x-foreground/25 border-t-foreground/25 bg-card shadow-[0_-10px_28px_rgb(0_0_0/0.11)] dark:shadow-[0_-12px_32px_rgb(0_0_0/0.52)]"
          data-group-mini-shell
        >
          <div className="flex h-[34px] items-center gap-1.5 border-b border-border/60 bg-muted/35 px-2.5">
            <button
              aria-label="Back to thread list"
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              data-mini-back
              onClick={onBack}
              title="Back to list (Esc)"
              type="button"
            >
              <ArrowLeftIcon className="size-3.5" />
            </button>
            <span
              className={cn("size-1.5 shrink-0 rounded-full", GROUP_STATUS_DOT[thread.status])}
              title={GROUP_STATUS_LABEL[thread.status]}
            />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{thread.title}</span>
            <MiniThreadBadge thread={thread} />
            <button
              aria-label="Open full chat"
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => navigate(`#/c/${thread.id}`)}
              onPointerEnter={() => prefetch(thread.id)}
              title="Open full chat"
              type="button"
            >
              <ArrowUpRightIcon className="size-3.5" />
            </button>
            <button
              aria-label="Collapse mini chat"
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCollapse}
              title="Collapse"
              type="button"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>

          <Conversation className="h-[min(280px,36dvh)]" initial="instant" key={`${thread.id}:${loading}`}>
            <ConversationContent className="gap-3.5 px-3.5 py-2.5" scrollClassName="overflow-y-auto">
              {loading && (
                <div className="space-y-2 py-2">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              )}
              {!loading && error && <p className="text-xs text-destructive">{error}</p>}
              {!loading && !error && messages.length === 0 && (
                <p className="py-3 text-center text-xs text-muted-foreground">No messages yet</p>
              )}
              {!loading && !error && messages.length > 0 && (
                <Transcript
                  compact
                  live={live}
                  messages={messages}
                  notes={notes}
                  quiet
                  running={running}
                  session={thread.id}
                />
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>
      </div>

      <div
        className="rounded-b-[22px] border border-t-0 border-foreground/25 bg-card shadow-xs"
        data-group-dock-composer
      >
        <Composer
          attached
          attachedTarget={{ title: thread.title, color: group.color }}
          command={composer.command}
          commands={composer.commands}
          draftKey={`draft:${thread.id}`}
          inChat
          placeholder={`Message ${thread.title}…`}
          running={thread.status === "working" || running}
          send={sendToMini}
          session={thread.id}
          setError={composer.setError}
          stop={composer.stop}
        />
      </div>
    </div>
  )
}

function collectPeerThreads(data: GroupOverviewData | null, session: string) {
  if (!data) return { active: [] as GroupThread[], archived: [] as GroupThread[], archivableCount: 0 }
  const ordered: GroupThread[] = []
  if (data.lead && data.lead.id !== session) ordered.push(data.lead)
  for (const child of data.children) {
    if (child.id !== session) ordered.push(child)
  }
  const active = ordered.filter(t => !t.archived && !t.background)
  const archived = ordered.filter(t => t.archived || t.background)
  const archivableCount = active.filter(t => !t.is_lead && !t.pinned && (t.status === "idle" || t.status === "done")).length
  return { active, archived, archivableCount }
}

// 3-stage top-addon dock attached directly onto the composer:
// Stage 1: slim composer-width addon bar fused to the top edge of the composer ->
// Stage 2: drawer smoothly opens upward from that bar into a scrollable thread list ->
// Stage 3: mini scrollable chat rises upward in the same frame while the bottom composer targets it.
export const GroupComposerDock = memo(function GroupComposerDock({
  group,
  session,
  draftKey,
  running,
  data,
  composer,
  onReload,
  onSetLead,
  prefetch,
}: {
  group: ChatGroup
  session: string
  draftKey: string
  running: boolean
  data: GroupOverviewData | null
  composer: Pick<Portal, "command" | "commands" | "send" | "stop" | "setError">
  onReload: () => void
  onSetLead: (groupId: string, session: string | null) => void
  prefetch: (session: string) => void
}) {
  const [stage, setStage] = useState<"addon" | "list" | "chat">("addon")
  const [miniId, setMiniId] = useState<string | null>(null)

  const leadSession = data?.lead_session ?? group.lead_session ?? null
  const peers = collectPeerThreads(data, session)
  const miniThread = miniId ? [...peers.active, ...peers.archived].find(t => t.id === miniId) ?? null : null

  const toggleList = useCallback(() => {
    setStage(prev => (prev === "list" ? "addon" : "list"))
  }, [])

  const openMini = useCallback((thread: GroupThread) => {
    setMiniId(thread.id)
    setStage("chat")
  }, [])

  const backToList = useCallback(() => {
    setStage("list")
  }, [])

  const collapse = useCallback(() => {
    setStage("addon")
  }, [])

  useEffect(() => {
    if (stage === "addon") return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      setStage(prev => (prev === "chat" ? "list" : "addon"))
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [stage])

  if (!data || (peers.active.length === 0 && peers.archived.length === 0)) {
    return (
      <Composer
        command={composer.command}
        commands={composer.commands}
        draftKey={draftKey}
        inChat
        running={running}
        send={composer.send}
        session={session}
        setError={composer.setError}
        stop={composer.stop}
      />
    )
  }

  if (stage === "chat" && miniThread) {
    return (
      <StageThreeFusedChat
        composer={composer}
        group={group}
        onBack={backToList}
        onCollapse={collapse}
        onReload={onReload}
        prefetch={prefetch}
        readOnly={data.read_only}
        thread={miniThread}
      />
    )
  }

  return (
    <div
      className="group/dock relative z-20 mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-group-dock
      data-group-dock-stage={stage}
    >
      <div className="relative h-9">
        <AddonListDrawer
          activeThreads={peers.active}
          archivableCount={peers.archivableCount}
          archivedThreads={peers.archived}
          expanded={stage === "list"}
          group={group}
          leadSession={leadSession}
          now={data.now}
          onOpenMini={openMini}
          onReload={onReload}
          onSetLead={onSetLead}
          onToggle={toggleList}
          prefetch={prefetch}
          session={session}
        />
      </div>

      <div
        className="rounded-b-[22px] border border-t-0 border-input bg-card shadow-xs"
        data-group-dock-composer
      >
        <Composer
          attached
          command={composer.command}
          commands={composer.commands}
          draftKey={draftKey}
          inChat
          running={running}
          send={composer.send}
          session={session}
          setError={composer.setError}
          stop={composer.stop}
        />
      </div>
    </div>
  )
})
