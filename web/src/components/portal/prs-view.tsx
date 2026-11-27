// PRs & Reviews: fast, repo-grouped pull requests and review requests linked to Portal chats,
// with inline expandable details, quick actions, persistent repo collapse, and keyboard navigation.
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  CopyIcon,
  CornerDownLeftIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LayersIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  RotateCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react"
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { navigate, type Portal } from "@/hooks/use-portal"
import { api, sessionPath } from "@/lib/api"
import { sendToComposer } from "@/lib/composer-prompt"
import {
  loadPrs,
  needsAttention,
  PR_DOT,
  type PrGroupRow,
  type PrItem,
  type PrQuickAction,
  type PrStackNode,
  type PrStatusFilter,
  type PrTab,
  type ReviewChatResult,
  shortAge,
  shortRepo,
  startReviewChat,
  usePrs,
  visiblePrGroups,
} from "@/lib/prs"
import type { HistoryMessage, OpenSession, SessionRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useDrawer } from "./drawer"
import { PageHeader } from "./header"
import { LoadingRows } from "./screen-loading"

const COLLAPSED_KEY = "prs:collapsed-repos:v1"

function loadCollapsedRepos(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const list = JSON.parse(raw)
    return Array.isArray(list) ? new Set(list.filter(x => typeof x === "string")) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedRepos(repos: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...repos]))
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

function relativeAge(epochSeconds: number, nowMs: number) {
  const delta = Math.max(0, Math.floor(nowMs / 1000 - epochSeconds))
  if (delta < 60) return "just now"
  const mins = Math.floor(delta / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

type ResolvedChat = {
  session: string
  title: string
  archived: boolean
  groupName?: string
  isGroupLead: boolean
}

function firstText(...values: (string | null | undefined)[]): string {
  for (const v of values) {
    if (v) return v
  }
  return ""
}

function resolveOwnerChat(pr: PrItem, sessionsById: Map<string, SessionRow>): ResolvedChat | null {
  const owner = pr.owner
  if (!owner || owner.source !== "portal") return null
  const live = sessionsById.get(owner.session)
  const lead = live?.group?.lead_session || owner.lead_session
  if (lead) {
    const leadRow = sessionsById.get(lead)
    return {
      session: lead,
      title: firstText(leadRow?.title, owner.lead_title, owner.title),
      archived: !leadRow && Boolean(owner.lead_archived),
      groupName: firstText(live?.group?.name, owner.group_name) || undefined,
      isGroupLead: lead !== owner.session,
    }
  }
  return {
    session: owner.session,
    title: firstText(live?.title, owner.title),
    archived: !live && Boolean(owner.archived),
    isGroupLead: false,
  }
}

function resolveStackNodeChat(node: PrStackNode, sessionsById: Map<string, SessionRow>): { session: string; label: string } | null {
  if (!node.session) return null
  const live = sessionsById.get(node.session)
  const lead = live?.group?.lead_session || node.lead_session
  if (lead) {
    const leadRow = sessionsById.get(lead)
    const group = firstText(live?.group?.name, node.group_name)
    const title = firstText(leadRow?.title, node.lead_title, node.session_title)
    const label = group && title ? `${group} · ${title}` : firstText(title, group)
    return { session: lead, label }
  }
  return { session: node.session, label: firstText(live?.title, node.session_title) }
}

type StatusKind =
  | "ready_to_merge"
  | "changes_requested"
  | "ci_failed"
  | "conflict"
  | "needs_review"
  | "draft"
  | "merged"
  | "ci_running"
  | "waiting"

type StatusLabel = {
  kind: StatusKind
  label: string
  tone: string
}

const STATUS_TONE: Record<StatusKind, string> = {
  ready_to_merge: "text-emerald-600 dark:text-emerald-400",
  changes_requested: "text-orange-600 dark:text-orange-400",
  ci_failed: "text-red-600 dark:text-red-400",
  conflict: "text-amber-600 dark:text-amber-400",
  needs_review: "text-blue-600 dark:text-blue-400",
  ci_running: "text-sky-600 dark:text-sky-400",
  merged: "text-purple-600 dark:text-purple-400",
  draft: "text-muted-foreground/75",
  waiting: "text-muted-foreground/75",
}

function makeStatus(kind: StatusKind, label: string): StatusLabel {
  return { kind, label, tone: STATUS_TONE[kind] }
}

function StatusIcon({ kind, className = "size-3.5" }: { kind: StatusKind; className?: string }) {
  switch (kind) {
    case "ready_to_merge":
      return <GitMergeIcon className={cn("shrink-0", className)} />
    case "changes_requested":
      return <FileDiffIcon className={cn("shrink-0", className)} />
    case "ci_failed":
      return <XCircleIcon className={cn("shrink-0", className)} />
    case "conflict":
      return <TriangleAlertIcon className={cn("shrink-0", className)} />
    case "needs_review":
      return <EyeIcon className={cn("shrink-0", className)} />
    case "draft":
      return <GitPullRequestDraftIcon className={cn("shrink-0", className)} />
    case "merged":
      return <GitMergeIcon className={cn("shrink-0", className)} />
    case "ci_running":
      return <CircleDashedIcon className={cn("shrink-0 animate-spin [animation-duration:3s]", className)} />
    default:
      return <ClockIcon className={cn("shrink-0", className)} />
  }
}

function quietReviewStatus(pr: PrItem): StatusLabel {
  if (pr.checks.state === "red") return makeStatus("ci_failed", "CI failed")
  if (pr.review.changes_requested_by.length > 0 || pr.review.pullfrog === "changes_requested") {
    return makeStatus("changes_requested", "Changes requested")
  }
  if (pr.draft) return makeStatus("draft", "Draft")
  return makeStatus("needs_review", "Needs review")
}

function rowStatusBadge(pr: PrItem, quietReview: boolean): StatusLabel {
  if (quietReview && pr.status === "needs_your_review") return quietReviewStatus(pr)
  switch (pr.status) {
    case "ready_to_merge":
      return makeStatus("ready_to_merge", "Ready to merge")
    case "changes_requested":
      return makeStatus("changes_requested", "Changes requested")
    case "ci_failed":
      return makeStatus("ci_failed", "CI failed")
    case "conflict":
      return makeStatus("conflict", "Conflict")
    case "needs_your_review":
      return makeStatus("needs_review", "Needs review")
    case "draft":
      return makeStatus("draft", "Draft")
    case "merged":
      return makeStatus("merged", "Merged")
    default:
      if (pr.status_label === "ci running" || pr.checks.state === "pending") {
        return makeStatus("ci_running", "CI running")
      }
      if (pr.status_label === "review pending") {
        return makeStatus("waiting", "Review pending")
      }
      return makeStatus("waiting", "Waiting")
  }
}

function ciSummary(pr: PrItem): string {
  const { state, total, failing, pending } = pr.checks
  if (state === "green") return `${total || ""} passed`.trim()
  if (state === "red") return `${failing.length} failed`
  return pending.length > 0 ? `${pending.length} running` : "running"
}

function repoReviewNote(pr: PrItem): string {
  if (pr.review.approved_by.length > 0) return `Approved by ${pr.review.approved_by[0]}`
  if (pr.review.uses_pullfrog && pr.review.pullfrog === "approved") return "Pullfrog approved"
  return ""
}

function CiIcon({ state }: { state: PrItem["checks"]["state"] }) {
  if (state === "green") return <CheckCircle2Icon className="size-3 text-emerald-500" />
  if (state === "red") return <XCircleIcon className="size-3 text-destructive" />
  return <CircleDashedIcon className="size-3 text-amber-500" />
}

function chatButtonTitle(chat: ResolvedChat): string {
  if (chat.isGroupLead) {
    if (chat.groupName && chat.title) return `${chat.groupName} · ${chat.title}`
    if (chat.title) return `Primary chat: ${chat.title}`
    return chat.groupName ? `Open ${chat.groupName} primary chat` : "Open group primary chat"
  }
  return chat.title ? `Chat: ${chat.title}` : "Open linked chat"
}

function RowActions({
  pr,
  chat,
  starting,
  onOpenChat,
  onStartChat,
}: {
  pr: PrItem
  chat: ResolvedChat | null
  starting: boolean
  onOpenChat: (session: string) => void
  onStartChat: (pr: PrItem) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {chat ? (
        <button
          aria-label={chatButtonTitle(chat)}
          className={cn(
            "grid size-7 cursor-pointer place-items-center rounded-md transition-colors hover:bg-background hover:text-foreground",
            chat.archived ? "text-muted-foreground/45" : "text-muted-foreground",
          )}
          data-pr-chat-session={chat.session}
          onClick={() => onOpenChat(chat.session)}
          title={chatButtonTitle(chat)}
          type="button"
        >
          <MessageSquareIcon className="size-3.5" />
        </button>
      ) : (
        <button
          aria-label={
            pr.mine
              ? `Start chat for ${shortRepo(pr.repo)}#${pr.number}`
              : `Start review chat for ${shortRepo(pr.repo)}#${pr.number}`
          }
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-background hover:text-foreground group-hover:text-muted-foreground disabled:opacity-40"
          disabled={starting}
          onClick={() => onStartChat(pr)}
          title={pr.mine ? "Start chat for this PR" : "Start review chat"}
          type="button"
        >
          <MessageSquarePlusIcon className="size-3.5" />
        </button>
      )}
      <a
        aria-label={`Open ${shortRepo(pr.repo)}#${pr.number} on GitHub`}
        className="grid size-7 place-items-center rounded-md text-muted-foreground/50 transition-colors hover:bg-background hover:text-foreground group-hover:text-muted-foreground"
        href={pr.url}
        rel="noreferrer"
        target="_blank"
        title="Open on GitHub"
      >
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </div>
  )
}

function PrChecksDetail({ pr }: { pr: PrItem }) {
  const { failing, pending } = pr.checks
  if (failing.length === 0 && pending.length === 0) return null
  const chip =
    "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-foreground/85 transition-colors hover:bg-accent/60"
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {failing.slice(0, 6).map(check =>
        check.url ? (
          <a className={chip} href={check.url} key={`fail:${check.name}`} rel="noreferrer" target="_blank">
            <XCircleIcon className="size-3 shrink-0 text-destructive" />
            <span className="max-w-44 truncate">{check.name}</span>
          </a>
        ) : (
          <span className={chip} key={`fail:${check.name}`}>
            <XCircleIcon className="size-3 shrink-0 text-destructive" />
            <span className="max-w-44 truncate">{check.name}</span>
          </span>
        ),
      )}
      {pending.slice(0, 4).map(check =>
        check.url ? (
          <a className={chip} href={check.url} key={`pend:${check.name}`} rel="noreferrer" target="_blank">
            <CircleDashedIcon className="size-3 shrink-0 text-amber-500" />
            <span className="max-w-44 truncate">{check.name}</span>
          </a>
        ) : (
          <span className={chip} key={`pend:${check.name}`}>
            <CircleDashedIcon className="size-3 shrink-0 text-amber-500" />
            <span className="max-w-44 truncate">{check.name}</span>
          </span>
        ),
      )}
    </div>
  )
}

function PrStackDetail({
  pr,
  sessionsById,
  onOpenChat,
}: {
  pr: PrItem
  sessionsById: Map<string, SessionRow>
  onOpenChat: (session: string) => void
}) {
  if (pr.stack.length === 0 && !pr.merged_parent) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <LayersIcon className="size-3 shrink-0 opacity-70" />
      {pr.merged_parent && (
        <a
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
          href={pr.merged_parent.url}
          rel="noreferrer"
          target="_blank"
        >
          <span className="size-1.5 rounded-full bg-purple-500" />
          <span className="font-mono">{shortRepo(pr.merged_parent.key)}</span>
          <span className="opacity-70">merged</span>
        </a>
      )}
      {pr.stack.map(node => {
        const isSelf = node.key === pr.key
        if (isSelf) {
          return (
            <span
              className="inline-flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 font-mono text-foreground"
              key={node.key}
            >
              <span className={cn("size-1.5 rounded-full", PR_DOT[node.tone])} />
              #{node.number}
            </span>
          )
        }
        const target = resolveStackNodeChat(node, sessionsById)
        if (target) {
          return (
            <button
              className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-mono hover:bg-background hover:text-foreground"
              key={node.key}
              onClick={() => onOpenChat(target.session)}
              title={`${node.title}${target.label ? ` · ${target.label}` : ""}`}
              type="button"
            >
              <span className={cn("size-1.5 rounded-full", PR_DOT[node.tone])} />
              #{node.number}
            </button>
          )
        }
        return (
          <a
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono hover:bg-background hover:text-foreground"
            href={node.url}
            key={node.key}
            rel="noreferrer"
            target="_blank"
            title={node.title}
          >
            <span className={cn("size-1.5 rounded-full", PR_DOT[node.tone])} />
            #{node.number}
          </a>
        )
      })}
    </div>
  )
}

function statusDetailText(pr: PrItem, badge: StatusLabel): string {
  if (pr.status === "needs_your_review" && badge.kind !== "needs_review") {
    if (badge.kind === "ci_failed" && pr.checks.failing.length > 0) {
      const names = pr.checks.failing
        .slice(0, 3)
        .map(c => c.name)
        .join(", ")
      return `failed: ${names}`
    }
    if (badge.kind === "changes_requested" && pr.review.changes_requested_by.length > 0) {
      return `changes by ${pr.review.changes_requested_by.join(", ")}`
    }
    if (badge.kind === "changes_requested" && pr.review.pullfrog === "changes_requested") {
      return "pullfrog requested changes"
    }
    if (badge.kind === "draft") return ""
  }
  const reason = pr.reason.trim()
  if (
    !reason ||
    reason === "draft pull request" ||
    reason === "checks green and ready to merge" ||
    reason === "merged" ||
    reason === "linked to this chat"
  ) {
    return ""
  }
  return reason
}

function inlineChatLabel(chat: ResolvedChat | null): string {
  if (!chat) return ""
  if (chat.isGroupLead && chat.groupName) return `${chat.groupName} · ${chat.title || "Primary"}`
  return chat.title || chat.groupName || ""
}

function PrInlineDetail({
  pr,
  badge,
  detail,
  chat,
  sessionsById,
  starting,
  onOpenChat,
  onRunAction,
}: {
  pr: PrItem
  badge: StatusLabel
  detail: string
  chat: ResolvedChat | null
  sessionsById: Map<string, SessionRow>
  starting: boolean
  onOpenChat: (session: string) => void
  onRunAction: (pr: PrItem, action: PrQuickAction) => void
}) {
  const [copied, setCopied] = useState(false)
  const chatLabel = inlineChatLabel(chat)
  const showDetailText = Boolean(detail) && !(badge.kind === "ci_failed" && pr.checks.failing.length > 0)

  const copyUrl = async () => {
    try {
      await navigator.clipboard?.writeText(pr.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Ignore clipboard failures in restricted contexts.
    }
  }

  return (
    <div
      className="flex flex-col gap-2 pr-2.5 pt-0.5 pb-2.5 pl-9 text-xs"
      data-pr-detail={pr.key}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={cn("inline-flex items-center gap-1.5 font-medium", badge.tone)}>
          <StatusIcon kind={badge.kind} />
          <span>{badge.label}</span>
        </span>
        {showDetailText && <span className="text-[11px] text-muted-foreground">{detail}</span>}
        <button
          aria-label="Copy PR link"
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={copyUrl}
          type="button"
        >
          {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
          <span>{copied ? "Copied" : "Copy link"}</span>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1 font-mono" title={`${pr.base} ← ${pr.head}`}>
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <span className="truncate">
            {pr.base} ← {pr.head || "?"}
          </span>
        </span>
        {chat && chatLabel && (
          <button
            className="inline-flex min-w-0 cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenChat(chat.session)}
            title={chatButtonTitle(chat)}
            type="button"
          >
            <MessageSquareIcon className="size-3 shrink-0 opacity-70" />
            <span className="max-w-56 truncate">{chatLabel}</span>
          </button>
        )}
      </div>

      <PrChecksDetail pr={pr} />
      <PrStackDetail onOpenChat={onOpenChat} pr={pr} sessionsById={sessionsById} />

      {pr.quick_actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {pr.quick_actions.map(action => (
            <button
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-45"
              data-pr-action={action.id}
              disabled={starting}
              key={action.id}
              onClick={() => onRunAction(pr, action)}
              type="button"
            >
              <CornerDownLeftIcon className="size-3 shrink-0 text-muted-foreground" />
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PrRowMeta({
  pr,
  badge,
  note,
}: {
  pr: PrItem
  badge: StatusLabel
  note: string
}) {
  const threads = pr.review.unresolved_threads
  const hasMeta = pr.checks.state !== "none" || threads > 0 || !pr.mine || Boolean(note)
  if (!hasMeta) return null
  const emphasizeFailedCi = pr.checks.state === "red" && badge.kind !== "ci_failed"
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {pr.checks.state !== "none" && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1",
            emphasizeFailedCi && "text-destructive",
          )}
        >
          <CiIcon state={pr.checks.state} />
          <span className="tabular-nums">{ciSummary(pr)}</span>
        </span>
      )}
      {threads > 0 && (
        <span className="shrink-0 tabular-nums">
          {threads} {threads === 1 ? "thread" : "threads"}
        </span>
      )}
      {!pr.mine && <span className="shrink-0">@{pr.author}</span>}
      {note && <span className="truncate">{note}</span>}
    </span>
  )
}

const RepoPrRow = memo(function RepoPrRow({
  pr,
  sessionsById,
  quietReview,
  expanded,
  selected,
  starting,
  onToggleExpand,
  onPrefetch,
  onOpenChat,
  onStartChat,
  onRunAction,
}: {
  pr: PrItem
  sessionsById: Map<string, SessionRow>
  quietReview: boolean
  expanded: boolean
  selected: boolean
  starting: boolean
  onToggleExpand: (key: string) => void
  onPrefetch: (session: string) => void
  onOpenChat: (session: string) => void
  onStartChat: (pr: PrItem) => void
  onRunAction: (pr: PrItem, action: PrQuickAction) => void
}) {
  const age = shortAge(pr.updated_at)
  const badge = rowStatusBadge(pr, quietReview)
  const detail = statusDetailText(pr, badge)
  const note = repoReviewNote(pr)
  const chat = resolveOwnerChat(pr, sessionsById)

  const handleWarm = () => {
    if (chat) onPrefetch(chat.session)
  }

  return (
    <div
      className={cn("relative rounded-md transition-colors", expanded && "bg-accent/45")}
      data-pr-expanded={expanded ? "true" : undefined}
      data-pr-row={pr.key}
      onFocusCapture={handleWarm}
      onMouseEnter={handleWarm}
    >
      <div
        className={cn(
          "group flex items-center gap-3 rounded-md px-2 py-2 transition-colors",
          !expanded && "hover:bg-accent/50",
          !expanded && selected && "bg-accent/55",
        )}
      >
        <button
          aria-expanded={expanded}
          aria-label={`${badge.label}: #${pr.number} ${pr.title}`}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left"
          onClick={() => onToggleExpand(pr.key)}
          type="button"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn("inline-flex h-5 w-[18px] shrink-0 items-center justify-center", badge.tone)}
                data-pr-status-badge={pr.status}
              >
                <StatusIcon className="size-[15px]" kind={badge.kind} />
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72" side="top" sideOffset={6}>
              <span className="font-medium">{badge.label}</span>
              {detail && <span className="ml-1.5 opacity-80">· {detail}</span>}
            </TooltipContent>
          </Tooltip>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums"
                title={`${pr.base} ← ${pr.head}`}
              >
                #{pr.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{pr.title}</span>
            </span>
            <PrRowMeta badge={badge} note={note} pr={pr} />
          </span>
        </button>
        {age && <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/75 tabular-nums">{age}</span>}
        <RowActions chat={chat} onOpenChat={onOpenChat} onStartChat={onStartChat} pr={pr} starting={starting} />
      </div>
      {expanded && (
        <PrInlineDetail
          badge={badge}
          chat={chat}
          detail={detail}
          onOpenChat={onOpenChat}
          onRunAction={onRunAction}
          pr={pr}
          sessionsById={sessionsById}
          starting={starting}
        />
      )}
    </div>
  )
})

const RepoSection = memo(function RepoSection({
  repo,
  groups,
  sessionsById,
  collapsed,
  quietReview,
  expandedKey,
  selectedKey,
  startingKey,
  onToggleCollapse,
  onToggleExpand,
  onPrefetch,
  onOpenChat,
  onStartChat,
  onRunAction,
}: {
  repo: string
  groups: PrGroupRow[]
  sessionsById: Map<string, SessionRow>
  collapsed: boolean
  quietReview: boolean
  expandedKey: string | null
  selectedKey: string | null
  startingKey: string | null
  onToggleCollapse: (repo: string) => void
  onToggleExpand: (key: string) => void
  onPrefetch: (session: string) => void
  onOpenChat: (session: string) => void
  onStartChat: (pr: PrItem) => void
  onRunAction: (pr: PrItem, action: PrQuickAction) => void
}) {
  const count = groups.reduce((sum, g) => sum + g.members.length, 0)
  const hasFailing = collapsed && groups.some(g => g.members.some(pr => pr.tone === "failing"))

  return (
    <section className="py-2" data-repo-section={repo}>
      <button
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onToggleCollapse(repo)}
        type="button"
      >
        {collapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
        <span className="font-mono font-medium text-foreground">{shortRepo(repo)}</span>
        <span className="tabular-nums opacity-70">{count}</span>
        {hasFailing && <span aria-hidden="true" className="ml-1 size-1.5 rounded-full bg-destructive" />}
      </button>
      {!collapsed && (
        <div className="mt-1 divide-y divide-border/40">
          {groups.map(group =>
            group.members.map(pr => (
              <RepoPrRow
                expanded={expandedKey === pr.key}
                key={pr.key}
                onOpenChat={onOpenChat}
                onPrefetch={onPrefetch}
                onRunAction={onRunAction}
                onStartChat={onStartChat}
                onToggleExpand={onToggleExpand}
                pr={pr}
                quietReview={quietReview}
                selected={selectedKey === pr.key}
                sessionsById={sessionsById}
                starting={startingKey === pr.key}
              />
            )),
          )}
        </div>
      )}
    </section>
  )
})

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
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
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

function ReviewChatPreviewDialog({ plan, onClose }: { plan: ReviewChatResult | null; onClose: () => void }) {
  return (
    <Dialog onOpenChange={open => !open && onClose()} open={plan !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start chat</DialogTitle>
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

function PrsToolbar({
  tabs,
  tab,
  statusFilter,
  attentionInTab,
  readyInTab,
  query,
  inputRef,
  onSelectTab,
  onStatusFilter,
  onQueryChange,
}: {
  tabs: { id: PrTab; label: string; count?: number; unread?: boolean }[]
  tab: PrTab
  statusFilter: PrStatusFilter
  attentionInTab: number
  readyInTab: number
  query: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onSelectTab: (tab: PrTab) => void
  onStatusFilter: (next: PrStatusFilter) => void
  onQueryChange: (q: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-3 pb-2">
      <div className="inline-flex items-center rounded-lg bg-muted/60 p-0.5">
        {tabs.map(t => (
          <button
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              tab === t.id
                ? "bg-background font-medium text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={t.id}
            onClick={() => onSelectTab(t.id)}
            type="button"
          >
            <span>{t.label}</span>
            {t.count !== undefined && (
              <span className="text-[11px] text-muted-foreground tabular-nums">{t.count}</span>
            )}
            {t.unread && <span aria-label="unread" className="size-1.5 rounded-full bg-emerald-500" />}
          </button>
        ))}
      </div>

      {tab !== "feed" && (
        <div className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto">
          {attentionInTab > 0 && (
            <button
              aria-pressed={statusFilter === "attention"}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                statusFilter === "attention"
                  ? "bg-destructive/12 font-medium text-destructive"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              data-status-filter="attention"
              onClick={() => onStatusFilter(statusFilter === "attention" ? "all" : "attention")}
              type="button"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-destructive" />
              <span>Attention</span>
              <span className="tabular-nums opacity-75">{attentionInTab}</span>
            </button>
          )}
          {readyInTab > 0 && (
            <button
              aria-pressed={statusFilter === "ready"}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                statusFilter === "ready"
                  ? "bg-emerald-500/12 font-medium text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              data-status-filter="ready"
              onClick={() => onStatusFilter(statusFilter === "ready" ? "all" : "ready")}
              type="button"
            >
              <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
              <span>Ready</span>
              <span className="tabular-nums opacity-75">{readyInTab}</span>
            </button>
          )}
          <div className="relative flex-1 sm:w-44 sm:flex-none">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter PRs"
              className="h-8 pr-7 pl-8 text-xs"
              onChange={e => onQueryChange(e.target.value)}
              placeholder="Filter… (/)"
              ref={inputRef}
              value={query}
            />
            {query && (
              <button
                aria-label="Clear filter"
                className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => onQueryChange("")}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function isTextInputTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable
}

function navKeyDelta(key: string): number {
  if (key === "j" || key === "ArrowDown") return 1
  if (key === "k" || key === "ArrowUp") return -1
  return 0
}

function useNowTick(everyMs = 30_000) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return nowMs
}
function stepSelectionKey(flatPrs: PrItem[], selectedKey: string | null, delta: number): string | null {
  const idx = selectedKey ? flatPrs.findIndex(p => p.key === selectedKey) : -1
  const nextIdx =
    idx < 0 ? (delta > 0 ? 0 : flatPrs.length - 1) : Math.max(0, Math.min(flatPrs.length - 1, idx + delta))
  return flatPrs[nextIdx]?.key ?? null
}

function useCollapsedRepos() {
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(loadCollapsedRepos)
  useEffect(() => {
    saveCollapsedRepos(collapsedRepos)
  }, [collapsedRepos])
  const toggleCollapseRepo = useCallback((repo: string) => {
    setCollapsedRepos(prev => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }, [])
  return { collapsedRepos, toggleCollapseRepo }
}

function handleActivePrKey(
  e: KeyboardEvent,
  activePr: PrItem,
  sessionsById: Map<string, SessionRow>,
  onToggleExpand: (key: string) => void,
  onOpenChat: (session: string) => void,
  onStartChat: (pr: PrItem) => void,
) {
  if (e.key === "Enter") {
    e.preventDefault()
    onToggleExpand(activePr.key)
  } else if (e.key === "c") {
    e.preventDefault()
    const chat = resolveOwnerChat(activePr, sessionsById)
    if (chat) onOpenChat(chat.session)
    else onStartChat(activePr)
  } else if (e.key === "g" || e.key === "o") {
    e.preventDefault()
    window.open(activePr.url, "_blank", "noopener,noreferrer")
  }
}

function usePrKeyboardNav({
  enabled,
  flatPrs,
  sessionsById,
  selectedKey,
  expandedKey,
  inputRef,
  onSelect,
  onToggleExpand,
  onClearExpand,
  onOpenChat,
  onStartChat,
}: {
  enabled: boolean
  flatPrs: PrItem[]
  sessionsById: Map<string, SessionRow>
  selectedKey: string | null
  expandedKey: string | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onSelect: (key: string | null) => void
  onToggleExpand: (key: string) => void
  onClearExpand: () => void
  onOpenChat: (session: string) => void
  onStartChat: (pr: PrItem) => void
}) {
  useEffect(() => {
    if (!enabled) return
    const handleNavKey = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) {
        if (e.key === "Escape") e.target.blur()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "/") {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (e.key === "Escape") {
        if (expandedKey) onClearExpand()
        else if (selectedKey) onSelect(null)
        return
      }
      if (e.key === "r") {
        void loadPrs(true)
        return
      }
      if (flatPrs.length === 0) return
      const delta = navKeyDelta(e.key)
      if (delta !== 0) {
        e.preventDefault()
        const nextKey = stepSelectionKey(flatPrs, selectedKey, delta)
        onSelect(nextKey)
        if (nextKey) document.querySelector(`[data-pr-row="${CSS.escape(nextKey)}"]`)?.scrollIntoView({ block: "nearest" })
        return
      }
      const activePr = flatPrs.find(p => p.key === (selectedKey ?? expandedKey))
      if (activePr) handleActivePrKey(e, activePr, sessionsById, onToggleExpand, onOpenChat, onStartChat)
    }
    window.addEventListener("keydown", handleNavKey)
    return () => window.removeEventListener("keydown", handleNavKey)
  }, [enabled, flatPrs, sessionsById, selectedKey, expandedKey, inputRef, onSelect, onToggleExpand, onClearExpand, onOpenChat, onStartChat])
}

function PrsRepoBody({
  loading,
  byRepo,
  sessionsById,
  filtering,
  collapsedRepos,
  expandedKey,
  selectedKey,
  startingKey,
  quietReview,
  hiddenCount,
  includeOld,
  windowDays,
  refreshing,
  onToggleCollapse,
  onToggleExpand,
  onToggleIncludeOld,
  onLoadOlder,
  onPrefetch,
  onOpenChat,
  onStartChat,
  onRunAction,
}: {
  loading: boolean
  byRepo: [string, { groups: PrGroupRow[]; latest: number }][]
  sessionsById: Map<string, SessionRow>
  filtering: boolean
  collapsedRepos: Set<string>
  expandedKey: string | null
  selectedKey: string | null
  startingKey: string | null
  quietReview: boolean
  hiddenCount: number
  includeOld: boolean
  windowDays: number
  refreshing: boolean
  onToggleCollapse: (repo: string) => void
  onToggleExpand: (key: string) => void
  onToggleIncludeOld: () => void
  onLoadOlder: () => void
  onPrefetch: (session: string) => void
  onOpenChat: (session: string) => void
  onStartChat: (pr: PrItem) => void
  onRunAction: (pr: PrItem, action: PrQuickAction) => void
}) {
  if (loading) return <LoadingRows columns count={6} label="Loading pull requests…" />
  if (byRepo.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground text-xs">
        <GitPullRequestIcon className="size-5 opacity-50" />
        <p>{filtering ? "No matching pull requests." : "No open pull requests here."}</p>
        {windowDays > 0 && (
          <button
            className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
            disabled={refreshing}
            onClick={onLoadOlder}
            type="button"
          >
            {`Load older (>${windowDays}d)`}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col" data-pr-layout="repo">
      <div className="divide-y divide-border/50">
        {byRepo.map(([repo, bucket]) => (
          <RepoSection
            collapsed={!filtering && collapsedRepos.has(repo)}
            expandedKey={expandedKey}
            groups={bucket.groups}
            key={repo}
            onOpenChat={onOpenChat}
            onPrefetch={onPrefetch}
            onRunAction={onRunAction}
            onStartChat={onStartChat}
            onToggleCollapse={onToggleCollapse}
            onToggleExpand={onToggleExpand}
            quietReview={quietReview}
            repo={repo}
            selectedKey={selectedKey}
            sessionsById={sessionsById}
            startingKey={startingKey}
          />
        ))}
      </div>
      {(hiddenCount > 0 || windowDays > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-border/50 border-t pt-2">
          {hiddenCount > 0 && (
            <button
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              onClick={onToggleIncludeOld}
              type="button"
            >
              {includeOld ? "Hide drafts & older" : `Show ${hiddenCount} drafts & older`}
            </button>
          )}
          {windowDays > 0 && (
            <button
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
              disabled={refreshing}
              onClick={onLoadOlder}
              type="button"
            >
              {`Load older (>${windowDays}d)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function groupByRepo(groups: PrGroupRow[]) {
  const map = new Map<string, { groups: PrGroupRow[]; latest: number }>()
  for (const group of groups) {
    const repo = group.repos[0] || group.members[0]?.repo || "other"
    const cur = map.get(repo) ?? { groups: [], latest: 0 }
    cur.groups.push(group)
    cur.latest = Math.max(cur.latest, group.latestUpdated)
    map.set(repo, cur)
  }
  return [...map.entries()].toSorted((a, b) => b[1].latest - a[1].latest)
}

function visibleFlatPrs(
  byRepo: [string, { groups: PrGroupRow[]; latest: number }][],
  filtering: boolean,
  collapsedRepos: Set<string>,
) {
  const out: PrItem[] = []
  for (const [repo, bucket] of byRepo) {
    if (!filtering && collapsedRepos.has(repo)) continue
    for (const g of bucket.groups) {
      for (const pr of g.members) out.push(pr)
    }
  }
  return out
}

function computeTabStats(prs: PrItem[], tab: PrTab) {
  const mine = prs.filter(p => p.mine)
  const reviewing = prs.filter(p => !p.mine)
  const active = tab === "mine" ? mine : tab === "reviewing" ? reviewing : tab === "all" ? prs : []
  return {
    mineCount: mine.length,
    reviewingCount: reviewing.length,
    attentionInTab: active.filter(p => !p.draft && needsAttention(p)).length,
    readyInTab: active.filter(p => p.status === "ready_to_merge").length,
  }
}

function buildTabs(
  total: number | null,
  stats: ReturnType<typeof computeTabStats>,
  reviewsSession: { unread?: boolean } | undefined,
): { id: PrTab; label: string; count?: number; unread?: boolean }[] {
  const tabs: { id: PrTab; label: string; count?: number; unread?: boolean }[] = [
    { id: "mine", label: "Mine", count: total !== null ? stats.mineCount : undefined },
    { id: "reviewing", label: "Reviewing", count: total !== null ? stats.reviewingCount : undefined },
    { id: "all", label: "All", count: total ?? undefined },
  ]
  if (reviewsSession) tabs.push({ id: "feed", label: "Feed", unread: Boolean(reviewsSession.unread) })
  return tabs
}

export function PrsView({ portal }: { portal: Portal }) {
  const { go } = useDrawer()
  const { data, error, refreshing } = usePrs(true, { poll: true })
  const [tab, setTab] = useState<PrTab>("mine")
  const [statusFilter, setStatusFilter] = useState<PrStatusFilter>("all")
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const [includeOld, setIncludeOld] = useState(false)
  const { collapsedRepos, toggleCollapseRepo } = useCollapsedRepos()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [startingKey, setStartingKey] = useState<string | null>(null)
  const [actionError, setActionError] = useState("")
  const [previewPlan, setPreviewPlan] = useState<ReviewChatResult | null>(null)
  const nowMs = useNowTick()
  const searchRef = useRef<HTMLInputElement>(null)

  const reviewsSession = portal.sessions.find(s => s.reviews)
  const sessionsById = useMemo(
    () => new Map(portal.sessions.map(s => [s.id, s])),
    [portal.sessions],
  )
  const tabStats = useMemo(() => computeTabStats(data?.prs ?? [], tab), [data, tab])
  const groups = useMemo(
    () => visiblePrGroups(data, tab, deferredQuery, statusFilter),
    [data, tab, deferredQuery, statusFilter],
  )
  const filtering = Boolean(deferredQuery.trim()) || statusFilter !== "all"
  const visibleGroups = useMemo(
    () => (filtering || includeOld ? groups : groups.filter(g => !g.staleOrDraft)),
    [groups, filtering, includeOld],
  )
  const hiddenCount = useMemo(
    () => (filtering ? 0 : groups.filter(g => g.staleOrDraft).reduce((sum, g) => sum + g.members.length, 0)),
    [groups, filtering],
  )
  const byRepo = useMemo(() => groupByRepo(visibleGroups), [visibleGroups])
  const flatVisiblePrs = useMemo(
    () => visibleFlatPrs(byRepo, filtering, collapsedRepos),
    [byRepo, filtering, collapsedRepos],
  )

  const toggleExpandPr = useCallback((key: string) => {
    setExpandedKey(prev => (prev === key ? null : key))
    setSelectedKey(key)
  }, [])

  const openChat = useCallback(
    (session: string) => {
      portal.prefetch(session)
      go(`#/c/${session}`)
    },
    [portal, go],
  )

  const startChatForPr = useCallback(async (pr: PrItem, options?: { prompt?: string; actionLabel?: string }) => {
    setStartingKey(pr.key)
    setActionError("")
    try {
      const result = await startReviewChat(pr, options)
      if (result.preview) setPreviewPlan(result)
      else if (result.session) navigate(`#/c/${result.session}`)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStartingKey(null)
    }
  }, [])

  const handleRunAction = useCallback(
    (pr: PrItem, action: PrQuickAction) => {
      const chat = resolveOwnerChat(pr, sessionsById)
      if (chat) {
        sendToComposer(chat.session, action.prompt)
        openChat(chat.session)
        return
      }
      void startChatForPr(pr, { prompt: action.prompt, actionLabel: action.label })
    },
    [sessionsById, openChat, startChatForPr],
  )

  const handleStartChat = useCallback(
    (pr: PrItem) => {
      const firstAction = pr.mine ? pr.quick_actions[0] : undefined
      void startChatForPr(
        pr,
        firstAction ? { prompt: firstAction.prompt, actionLabel: firstAction.label } : undefined,
      )
    },
    [startChatForPr],
  )

  usePrKeyboardNav({
    enabled: tab !== "feed" && previewPlan === null,
    flatPrs: flatVisiblePrs,
    sessionsById,
    selectedKey,
    expandedKey,
    inputRef: searchRef,
    onSelect: setSelectedKey,
    onToggleExpand: toggleExpandPr,
    onClearExpand: useCallback(() => setExpandedKey(null), []),
    onOpenChat: openChat,
    onStartChat: handleStartChat,
  })

  const tabs = buildTabs(data ? data.prs.length : null, tabStats, reviewsSession)
  const shownError = actionError || error || data?.error || ""

  return (
    <>
      <PageHeader title="PRs">
        {data && (
          <span className="hidden text-muted-foreground text-xs sm:inline" title="Last refreshed">
            {refreshing ? "syncing…" : relativeAge(data.taken_at, nowMs)}
          </span>
        )}
        <Button aria-label="Refresh PRs" disabled={refreshing} onClick={() => void loadPrs(true)} size="icon" title="Refresh PRs (r)" variant="ghost">
          <RotateCwIcon className={cn("size-4", refreshing && "animate-spin")} />
        </Button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-2 pb-8 md:px-4">
          <PrsToolbar
            attentionInTab={tabStats.attentionInTab}
            inputRef={searchRef}
            onQueryChange={setQuery}
            onSelectTab={next => {
              setTab(next)
              setStatusFilter("all")
              setExpandedKey(null)
              setSelectedKey(null)
            }}
            onStatusFilter={setStatusFilter}
            query={query}
            readyInTab={tabStats.readyInTab}
            statusFilter={statusFilter}
            tab={tab}
            tabs={tabs}
          />
          {shownError && (
            <p className="px-2 py-1.5 text-destructive text-xs" role="alert">
              {shownError}
            </p>
          )}
          {tab === "feed" && reviewsSession ? (
            <ReviewFeed onOpenChat={openChat} sessionId={reviewsSession.id} />
          ) : (
            <TooltipProvider delayDuration={180}>
              <PrsRepoBody
                byRepo={byRepo}
                collapsedRepos={collapsedRepos}
                expandedKey={expandedKey}
                filtering={filtering}
                hiddenCount={hiddenCount}
                includeOld={includeOld}
                loading={!data && !error}
                onLoadOlder={() => void loadPrs(true, { includeOlder: true })}
                onOpenChat={openChat}
                onPrefetch={portal.prefetch}
                onRunAction={handleRunAction}
                onStartChat={handleStartChat}
                onToggleCollapse={toggleCollapseRepo}
                onToggleExpand={toggleExpandPr}
                onToggleIncludeOld={() => setIncludeOld(v => !v)}
                quietReview={tab === "reviewing"}
                refreshing={refreshing}
                selectedKey={selectedKey}
                sessionsById={sessionsById}
                startingKey={startingKey}
                windowDays={data?.window_days ?? 0}
              />
            </TooltipProvider>
          )}
        </div>
      </div>
      <ReviewChatPreviewDialog onClose={() => setPreviewPlan(null)} plan={previewPlan} />
    </>
  )
}
