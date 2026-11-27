// PRs & Reviews: live stack-grouped view of your open PRs and PRs requesting your review,
// linked directly to the Portal chats that own them, plus quick access to the Reviews feed.
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LayersIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  RotateCwIcon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { navigate, type Portal } from "@/hooks/use-portal"
import { api, sessionPath } from "@/lib/api"
import {
  ciLabel,
  loadPrs,
  PR_DOT,
  PR_PILL,
  type PrGroupRow,
  type PrItem,
  type PrTab,
  type ReviewChatResult,
  reviewLabel,
  shortRepo,
  startReviewChat,
  usePrs,
  visiblePrGroups,
} from "@/lib/prs"
import type { HistoryMessage, OpenSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useDrawer } from "./drawer"
import { PageHeader } from "./header"
import { LoadingRows } from "./screen-loading"

function relativeAge(epochSeconds: number) {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds))
  if (delta < 60) return "just now"
  const mins = Math.floor(delta / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function CiBadge({ pr }: { pr: PrItem }) {
  const { state } = pr.checks
  if (state === "none") return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {state === "red" ? (
        <XCircleIcon className="size-3 text-destructive" />
      ) : state === "green" ? (
        <CheckCircle2Icon className="size-3 text-emerald-500" />
      ) : (
        <CircleDashedIcon className="size-3 text-amber-500" />
      )}
      <span>{ciLabel(pr)}</span>
    </span>
  )
}

function rowBadge(pr: PrItem, quietReview: boolean): { label: string; style: string } | null {
  if (!quietReview || pr.status !== "needs_your_review") {
    return { label: pr.status_label, style: PR_PILL[pr.status] }
  }
  if (pr.checks.state === "red") {
    return { label: "ci failed", style: PR_PILL.ci_failed }
  }
  if (pr.review.changes_requested_by.length > 0 || pr.review.pullfrog === "changes_requested") {
    return { label: "changes requested", style: PR_PILL.changes_requested }
  }
  return null
}

function PrOwnerAction({
  pr,
  portalSession,
  starting,
  mobile,
  onOpenChat,
  onStartReview,
}: {
  pr: PrItem
  portalSession: string | null
  starting: boolean
  mobile?: boolean
  onOpenChat: (session: string) => void
  onStartReview: (pr: PrItem) => void
}) {
  if (portalSession) {
    return (
      <button
        className={cn(
          "items-center gap-1 rounded-md text-muted-foreground text-xs hover:text-foreground",
          mobile
            ? "inline-flex max-w-full"
            : "hidden max-w-44 px-2 py-1 hover:bg-background sm:inline-flex",
        )}
        onClick={() => onOpenChat(portalSession)}
        title={pr.owner?.title || portalSession}
        type="button"
      >
        <MessageSquareIcon className="size-3 shrink-0" />
        <span className="truncate">{pr.owner?.title || "Open chat"}</span>
      </button>
    )
  }
  if (pr.mine) return null
  return (
    <Button
      className={cn("h-7 gap-1 px-2 text-xs", !mobile && "hidden sm:inline-flex")}
      disabled={starting}
      onClick={() => onStartReview(pr)}
      size="sm"
      variant="outline"
    >
      <MessageSquarePlusIcon className="size-3.5" />
      Start review chat
    </Button>
  )
}

function rowDotTone(pr: PrItem, quietReview: boolean) {
  if (quietReview && pr.status === "needs_your_review" && pr.checks.state === "red") return "failing"
  return pr.tone
}

function PrMetaLine({ pr }: { pr: PrItem }) {
  return (
    <div
      className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
      title={pr.reason || undefined}
    >
      <span className="shrink-0 font-mono text-[11px] tabular-nums">
        {shortRepo(pr.repo)}#{pr.number}
      </span>
      {!pr.mine && <span className="shrink-0">@{pr.author}</span>}
      <span
        className="hidden min-w-0 items-center gap-1 truncate font-mono text-[11px] sm:inline-flex"
        title={`${pr.base} ← ${pr.head}`}
      >
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">
          {pr.base} ← {pr.head}
        </span>
      </span>
      <CiBadge pr={pr} />
      <span className="min-w-0 truncate">{reviewLabel(pr)}</span>
      {pr.review.unresolved_threads > 0 && (
        <span className="shrink-0 tabular-nums">
          {pr.review.unresolved_threads} {pr.review.unresolved_threads === 1 ? "thread" : "threads"}
        </span>
      )}
    </div>
  )
}

function PrRow({
  pr,
  quietReview,
  starting,
  onOpenChat,
  onStartReview,
}: {
  pr: PrItem
  quietReview: boolean
  starting: boolean
  onOpenChat: (session: string) => void
  onStartReview: (pr: PrItem) => void
}) {
  const portalSession = pr.owner?.source === "portal" ? pr.owner.session : null
  const badge = rowBadge(pr, quietReview)
  const dotTone = rowDotTone(pr, quietReview)

  return (
    <div
      className="group relative flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-accent/60"
      data-pr-row={pr.key}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", PR_DOT[dotTone])}
        />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {portalSession ? (
              <button
                className="min-w-0 truncate text-left font-medium text-foreground text-sm hover:underline"
                onClick={() => onOpenChat(portalSession)}
                type="button"
              >
                {pr.title}
              </button>
            ) : (
              <a
                className="min-w-0 truncate font-medium text-foreground text-sm hover:underline"
                href={pr.url}
                rel="noreferrer"
                target="_blank"
              >
                {pr.title}
              </a>
            )}
            {badge && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 font-medium text-[11px] leading-none",
                  badge.style,
                )}
                title={pr.reason || undefined}
              >
                {badge.label}
              </span>
            )}
          </div>

          <PrMetaLine pr={pr} />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <PrOwnerAction
            onOpenChat={onOpenChat}
            onStartReview={onStartReview}
            portalSession={portalSession}
            pr={pr}
            starting={starting}
          />
          <a
            aria-label={`Open ${shortRepo(pr.repo)}#${pr.number} on GitHub`}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
            href={pr.url}
            rel="noreferrer"
            target="_blank"
            title="Open on GitHub"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
      </div>

      {/* On narrow phone screens, place the chat link / review CTA cleanly below the metadata. */}
      {(portalSession || !pr.mine) && (
        <div className="flex items-center gap-2 pl-3.5 sm:hidden">
          <PrOwnerAction
            mobile
            onOpenChat={onOpenChat}
            onStartReview={onStartReview}
            portalSession={portalSession}
            pr={pr}
            starting={starting}
          />
        </div>
      )}
    </div>
  )
}

function StackBlock({
  group,
  quietReview,
  startingKey,
  onOpenChat,
  onStartReview,
}: {
  group: PrGroupRow
  quietReview: boolean
  startingKey: string | null
  onOpenChat: (session: string) => void
  onStartReview: (pr: PrItem) => void
}) {
  const isStack = group.kind === "stack"
  return (
    <div className={cn("py-0.5", isStack && "my-1.5 rounded-lg border border-border/60 px-1.5 py-1")} data-pr-group={group.id}>
      {isStack && (
        <div className="flex items-center gap-1.5 px-2 pt-0.5 pb-1 text-muted-foreground text-xs">
          <LayersIcon className="size-3 shrink-0" />
          <span>
            Stack · {group.repos.map(shortRepo).join(" + ")} · {group.members.length} PRs
          </span>
        </div>
      )}
      <div className="divide-y divide-border/50">
        {group.members.map(pr => (
          <PrRow
            key={pr.key}
            onOpenChat={onOpenChat}
            onStartReview={onStartReview}
            pr={pr}
            quietReview={quietReview}
            starting={startingKey === pr.key}
          />
        ))}
      </div>
    </div>
  )
}

function ReviewFeed({ sessionId, onOpenChat }: { sessionId: string; onOpenChat: (id: string) => void }) {
  const [messages, setMessages] = useState<HistoryMessage[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const opened = await api<OpenSession>(sessionPath(sessionId))
        if (active) setMessages(opened.messages)
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [sessionId])

  const posts = useMemo(
    () => (messages ?? []).filter(m => m.role === "assistant" && m.text.trim()).toReversed().slice(0, 30),
    [messages],
  )

  return (
    <div className="flex flex-col gap-2 px-2 pt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">Recent posts in Reviews</p>
        <Button onClick={() => onOpenChat(sessionId)} size="sm" variant="outline">
          <MessageSquareIcon className="size-3.5" />
          Open Reviews chat
        </Button>
      </div>
      {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
      {!messages && !error && <LoadingRows count={4} label="Loading review stream…" />}
      {messages && posts.length === 0 && <p className="py-6 text-muted-foreground text-xs">no review posts yet</p>}
      <div className="divide-y">
        {posts.map((post, idx) => (
          <div className="py-3 text-sm" key={post.role === "assistant" ? String(post.row_id ?? post.timestamp ?? idx) : idx}>
            <p className="whitespace-pre-wrap break-words leading-relaxed">{post.role === "assistant" ? post.text : ""}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReviewChatPreviewDialog({
  plan,
  onClose,
}: {
  plan: ReviewChatResult | null
  onClose: () => void
}) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open={plan !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start review chat</DialogTitle>
          <DialogDescription>
            Read-only preview — in live Portal this opens a new chat attached to {plan?.pr}.
          </DialogDescription>
        </DialogHeader>
        {plan && (
          <div className="flex flex-col gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">Title</p>
              <p className="mt-0.5 font-medium text-foreground">{plan.title}</p>
            </div>
            {plan.prompt && (
              <div>
                <p className="text-muted-foreground">Initial brief</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2.5 font-mono text-[11px] text-foreground">
                  {plan.prompt}
                </pre>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {plan?.url && (
            <Button asChild size="sm" variant="outline">
              <a href={plan.url} rel="noreferrer" target="_blank">
                Open on GitHub
              </a>
            </Button>
          )}
          <Button onClick={onClose} size="sm">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PrsList({
  loading,
  groups,
  quietReview,
  query,
  startingKey,
  onOpenChat,
  onStartReview,
}: {
  loading: boolean
  groups: PrGroupRow[]
  quietReview: boolean
  query: string
  startingKey: string | null
  onOpenChat: (session: string) => void
  onStartReview: (pr: PrItem) => void
}) {
  if (loading) return <LoadingRows columns count={6} label="Loading pull requests…" />
  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground text-xs">
        <GitPullRequestIcon className="size-5 opacity-50" />
        <p>{query ? "No matching pull requests." : "No open pull requests here."}</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col divide-y divide-border/40">
      {groups.map(group => (
        <StackBlock
          group={group}
          key={group.id}
          onOpenChat={onOpenChat}
          onStartReview={onStartReview}
          quietReview={quietReview}
          startingKey={startingKey}
        />
      ))}
    </div>
  )
}

export function PrsView({ portal }: { portal: Portal }) {
  const { go } = useDrawer()
  const { data, error } = usePrs(true, 60_000)
  const [tab, setTab] = useState<PrTab>("mine")
  const [query, setQuery] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [previewPlan, setPreviewPlan] = useState<ReviewChatResult | null>(null)

  const reviewsSession = portal.sessions.find(s => s.reviews)
  const mineCount = useMemo(() => (data ? data.prs.filter(p => p.mine).length : 0), [data])
  const reviewingCount = useMemo(() => (data ? data.prs.filter(p => !p.mine).length : 0), [data])
  const groups = useMemo(() => visiblePrGroups(data, tab, query), [data, tab, query])

  const openChat = (session: string) => {
    portal.prefetch(session)
    go(`#/c/${session}`)
  }

  const handleStartReview = async (pr: PrItem) => {
    setStartingKey(pr.key)
    setActionError("")
    try {
      const result = await startReviewChat(pr)
      if (result.preview) {
        setPreviewPlan(result)
      } else if (result.session) {
        navigate(`#/c/${result.session}`)
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStartingKey(null)
    }
  }

  const tabs: { id: PrTab; label: string; count?: number; unread?: boolean }[] = [
    { id: "mine", label: "My PRs", count: data ? mineCount : undefined },
    { id: "reviewing", label: "Reviewing", count: data ? reviewingCount : undefined },
    { id: "all", label: "All", count: data ? data.prs.length : undefined },
    ...(reviewsSession ? [{ id: "feed" as const, label: "Review feed", unread: Boolean(reviewsSession.unread) }] : []),
  ]
  const shownError = actionError || error || data?.error || ""

  return (
    <>
      <PageHeader title="PRs & Reviews">
        {data && (
          <span className="hidden text-muted-foreground text-xs sm:inline" title="Last refreshed">
            {relativeAge(data.taken_at)}
          </span>
        )}
        <Button
          aria-label="Refresh PRs"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void loadPrs(true).finally(() => setRefreshing(false))
          }}
          size="icon"
          title="Refresh PRs"
          variant="ghost"
        >
          <RotateCwIcon className={cn("size-4", refreshing && "animate-spin")} />
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-2 pb-8 md:px-4">
          <div className="flex flex-col gap-2 px-2 pt-1 pb-3 sm:flex-row sm:items-center">
            <div className="inline-flex max-w-full items-center overflow-x-auto rounded-md border border-border/60 bg-muted/50 p-0.5">
              {tabs.map(item => (
                <button
                  aria-pressed={tab === item.id}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] px-2.5 py-1 font-medium text-muted-foreground text-xs hover:text-foreground",
                    tab === item.id && "bg-background text-foreground shadow-xs",
                  )}
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  type="button"
                >
                  <span>{item.label}</span>
                  {item.count !== undefined && (
                    <span className="text-[11px] text-muted-foreground/80 tabular-nums">{item.count}</span>
                  )}
                  {item.unread && <span aria-label="unread" className="size-1.5 rounded-full bg-emerald-500" />}
                </button>
              ))}
            </div>

            {tab !== "feed" && (
              <div className="relative w-full sm:ml-auto sm:w-56">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Filter PRs"
                  className="h-8 pl-8 text-xs"
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Filter repo, #PR, title…"
                  value={query}
                />
              </div>
            )}
          </div>

          {shownError && (
            <p className="px-2 py-1.5 text-destructive text-xs" role="alert">
              {shownError}
            </p>
          )}

          {tab === "feed" && reviewsSession ? (
            <ReviewFeed onOpenChat={openChat} sessionId={reviewsSession.id} />
          ) : (
            <PrsList
              groups={groups}
              loading={!data && !error}
              onOpenChat={openChat}
              onStartReview={pr => void handleStartReview(pr)}
              query={query}
              quietReview={tab === "reviewing"}
              startingKey={startingKey}
            />
          )}
        </div>
      </div>

      <ReviewChatPreviewDialog onClose={() => setPreviewPlan(null)} plan={previewPlan} />
    </>
  )
}
