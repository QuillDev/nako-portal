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
import { memo, type ReactNode, useCallback, useEffect, useState } from "react"
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

function summarizeDockLabel(threads: GroupThread[], archivedCount: number) {
  const total = threads.length
  if (total === 0) return archivedCount > 0 ? `${archivedCount} archived` : "0 threads"
  const needsYou = threads.filter(t => t.status === "needs_you").length
  const working = threads.filter(t => t.status === "working").length
  const waiting = threads.filter(t => t.status === "waiting").length
  const idle = total - needsYou - working - waiting
  if (needsYou > 0 && working > 0) return `${needsYou} needs you · ${working} working`
  if (needsYou > 0) return `${needsYou} needs you${total > needsYou ? ` · ${total - needsYou} idle` : ""}`
  if (working > 0) return `${working} working${idle > 0 ? ` · ${idle} idle` : ""}`
  if (waiting > 0) return `${waiting} waiting${idle > 0 ? ` · ${idle} idle` : ""}`
  return `${total} ${total === 1 ? "thread" : "threads"}`
}

function StageOneDotChip({
  threads,
  archivedCount,
  onExpand,
}: {
  threads: GroupThread[]
  archivedCount: number
  onExpand: () => void
}) {
  const visibleDots = threads.slice(0, 6)
  const overflow = Math.max(0, threads.length - visibleDots.length)
  const label = summarizeDockLabel(threads, archivedCount)
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center px-3 pb-1.5">
      <button
        aria-expanded={false}
        className="inline-flex h-7 max-w-full cursor-pointer items-center gap-2 rounded-full border border-border/75 bg-card/90 px-2.5 text-xs text-muted-foreground shadow-2xs transition-colors hover:border-border hover:bg-card hover:text-foreground"
        data-group-dot-chip
        onClick={onExpand}
        title="Expand group threads"
        type="button"
      >
        {visibleDots.length > 0 && (
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
        )}
        <span className="truncate font-medium tabular-nums">{label}</span>
        <ChevronUpIcon className="size-3.5 shrink-0 opacity-65" />
      </button>
    </div>
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

function StageTwoThreadList({
  group,
  session,
  leadSession,
  now,
  activeThreads,
  archivedThreads,
  archivableCount,
  onOpenMini,
  onCollapse,
  onReload,
  onSetLead,
  prefetch,
}: {
  group: ChatGroup
  session: string
  leadSession: string | null
  now: number
  activeThreads: GroupThread[]
  archivedThreads: GroupThread[]
  archivableCount: number
  onOpenMini: (thread: GroupThread) => void
  onCollapse: () => void
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
    <div className="mx-auto w-full max-w-3xl px-3 pb-2" data-group-dock-list>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <GroupSwatch color={group.color} />
            <span className="truncate text-xs font-medium text-foreground">{group.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">· {activeThreads.length}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!leadSession && (
              <button
                className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onSetLead(group.id, session)}
                type="button"
              >
                Set as main
              </button>
            )}
            {archivedThreads.length > 0 && (
              <button
                className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setShowArchived(s => !s)}
                type="button"
              >
                {showArchived ? "Hide archived" : `Archived (${archivedThreads.length})`}
              </button>
            )}
            {archivableCount > 0 && (
              <button
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={archiveBusy}
                onClick={() => void previewArchive()}
                type="button"
              >
                <ArchiveIcon className="size-3" />
                <span className="hidden sm:inline">Archive idle</span>
              </button>
            )}
            <button
              aria-label="Collapse thread list"
              className="grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCollapse}
              title="Collapse (Esc)"
              type="button"
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
        </div>

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

// Stage 3: unified single container fusing the selected thread's real Transcript (compact mode)
// directly onto Portal's real bottom composer (zero duplicate inputs, zero duplicate renderers).
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
  composer: Pick<Portal, "command" | "commands" | "stop" | "setError">
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
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-group-mini-chat>
      <div
        className="overflow-hidden rounded-[22px] border border-foreground/20 bg-card shadow-[0_4px_18px_rgb(0_0_0/0.07)] transition-colors focus-within:border-foreground/35 dark:shadow-[0_10px_32px_rgb(0_0_0/0.45)]"
        data-group-mini-shell
      >
        <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/35 px-2.5 py-2">
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

        <div className="border-t border-border/60">
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

// 3-stage Cursor-inspired dock wrapping the composer slot:
// Stage 1: compact dot chip above normal composer ->
// Stage 2: composer-width scrollable thread list above normal composer ->
// Stage 3: mini scrollable chat fused directly onto the single real bottom composer.
export const GroupComposerDock = memo(function GroupComposerDock({
  group,
  session,
  data,
  composer,
  onReload,
  onSetLead,
  prefetch,
  children,
}: {
  group: ChatGroup
  session: string
  data: GroupOverviewData | null
  composer: Pick<Portal, "command" | "commands" | "stop" | "setError">
  onReload: () => void
  onSetLead: (groupId: string, session: string | null) => void
  prefetch: (session: string) => void
  children: ReactNode
}) {
  const [stage, setStage] = useState<"chip" | "list" | "chat">("chip")
  const [miniId, setMiniId] = useState<string | null>(null)

  const leadSession = data?.lead_session ?? group.lead_session ?? null
  const peers = collectPeerThreads(data, session)
  const miniThread = miniId ? [...peers.active, ...peers.archived].find(t => t.id === miniId) ?? null : null

  const openMini = useCallback((thread: GroupThread) => {
    setMiniId(thread.id)
    setStage("chat")
  }, [])

  const backToList = useCallback(() => {
    setStage("list")
  }, [])

  const collapse = useCallback(() => {
    setStage("chip")
  }, [])

  useEffect(() => {
    if (stage === "chip") return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      setStage(prev => (prev === "chat" ? "list" : "chip"))
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [stage])

  if (!data || (peers.active.length === 0 && peers.archived.length === 0)) return <>{children}</>

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
    <>
      {stage === "list" ? (
        <StageTwoThreadList
          activeThreads={peers.active}
          archivableCount={peers.archivableCount}
          archivedThreads={peers.archived}
          group={group}
          leadSession={leadSession}
          now={data.now}
          onCollapse={collapse}
          onOpenMini={openMini}
          onReload={onReload}
          onSetLead={onSetLead}
          prefetch={prefetch}
          session={session}
        />
      ) : (
        <StageOneDotChip
          archivedCount={peers.archived.length}
          onExpand={() => setStage("list")}
          threads={peers.active}
        />
      )}
      {children}
    </>
  )
})
