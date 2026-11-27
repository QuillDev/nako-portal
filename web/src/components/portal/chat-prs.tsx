import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CornerDownLeftIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LayersIcon,
  MessageSquareIcon,
  XCircleIcon,
} from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { navigate } from "@/hooks/use-portal"
import { sendToComposer } from "@/lib/composer-prompt"
import {
  ciLabel,
  PR_DOT,
  PR_PILL,
  type PrItem,
  reviewLabel,
  sessionPrList,
  shortRepo,
  usePrs,
  worstTone,
} from "@/lib/prs"
import { cn } from "@/lib/utils"

function CiIcon({ state }: { state: PrItem["checks"]["state"] }) {
  if (state === "red") return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
  if (state === "green") return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />
  return <CircleDashedIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

function PrSwitcher({ prs, activeKey, onPick }: { prs: PrItem[]; activeKey: string; onPick: (key: string) => void }) {
  if (prs.length <= 1) return null
  return (
    <div className="flex gap-1 overflow-x-auto border-border/50 border-b px-2 py-1.5">
      {prs.map(item => (
        <button
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
            item.key === activeKey
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          key={item.key}
          onClick={() => onPick(item.key)}
          type="button"
        >
          <span className={cn("size-1.5 shrink-0 rounded-full", PR_DOT[item.tone])} />
          <span>#{item.number}</span>
        </button>
      ))}
    </div>
  )
}

function StackSection({ pr, session }: { pr: PrItem; session: string }) {
  if (pr.stack.length === 0 && !pr.merged_parent) return null
  return (
    <div className="border-border/50 border-t px-2.5 py-2">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LayersIcon className="size-3" />
        Stack
      </p>
      <div className="flex flex-col gap-0.5">
        {pr.merged_parent && (
          <a
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
            href={pr.merged_parent.url}
            rel="noreferrer"
            target="_blank"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-purple-500" />
            <span className="truncate">{pr.merged_parent.key} (merged)</span>
          </a>
        )}
        {pr.stack.map(node => {
          const isCurrent = node.key === pr.key
          const jumpTo = node.session && node.session !== session ? node.session : null
          const rowClass = cn(
            "flex items-center gap-2 rounded-md px-1.5 py-1 text-xs",
            isCurrent && "bg-accent/70 font-medium text-foreground",
            !isCurrent && "text-muted-foreground",
          )
          const indent = { paddingLeft: `${Math.min(node.depth, 4) * 12 + 6}px` }
          if (jumpTo) {
            return (
              <DropdownMenuItem
                className={cn(rowClass, "cursor-pointer")}
                key={node.key}
                onSelect={() => navigate(`#/c/${jumpTo}`)}
                style={indent}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", PR_DOT[node.tone])} />
                <span className="shrink-0 tabular-nums">#{node.number}</span>
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                <MessageSquareIcon className="size-3 shrink-0 opacity-60" />
              </DropdownMenuItem>
            )
          }
          return (
            <div className={rowClass} key={node.key} style={indent}>
              <span className={cn("size-1.5 shrink-0 rounded-full", PR_DOT[node.tone])} />
              <span className="shrink-0 tabular-nums">#{node.number}</span>
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
              {isCurrent && <span className="shrink-0 text-[10px] text-muted-foreground">this</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PrDetail({ pr }: { pr: PrItem }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="truncate">{shortRepo(pr.repo)}</span>
            <span className="tabular-nums">#{pr.number}</span>
            <span className={cn("rounded-full px-1.5 py-0.5 font-medium text-[10px] leading-none", PR_PILL[pr.status])}>
              {pr.status_label}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 font-medium text-foreground text-sm leading-snug">{pr.title}</p>
        </div>
        <a
          aria-label={`Open #${pr.number} on GitHub`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          href={pr.url}
          rel="noreferrer"
          target="_blank"
          title="Open on GitHub"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>

      <p className="mt-2 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground" title={`${pr.base} ← ${pr.head}`}>
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate">
          {pr.base} ← {pr.head || "?"}
        </span>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1">
          <CiIcon state={pr.checks.state} />
          {ciLabel(pr)}
        </span>
        <span>{reviewLabel(pr)}</span>
        {pr.review.unresolved_threads > 0 && (
          <span className="inline-flex items-center gap-1 text-foreground">
            <MessageSquareIcon className="size-3" />
            {pr.review.unresolved_threads} {pr.review.unresolved_threads === 1 ? "thread" : "threads"}
          </span>
        )}
      </div>

      {pr.reason &&
        pr.status !== "ready_to_merge" &&
        pr.status !== "draft" &&
        !/^(?:\d+ open thread\(s\)|\d+ of \d+ checks running)$/.test(pr.reason) && (
        <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">{pr.reason}</p>
      )}
    </div>
  )
}

// The chat's own GitHub PRs, mirroring ChatEnvironments right next to it in the chat header.
// Hidden when the chat has no linked or inferred PR.
export function ChatPrs({ session }: { session: string }) {
  const { data } = usePrs(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const mine = sessionPrList(data, session)
  if (mine.length === 0) return null

  const active = mine.find(p => p.key === selectedKey) ?? mine[0]
  const dot = PR_DOT[worstTone(mine)]
  const chipLabel = mine.length === 1 ? `#${active.number}` : `#${active.number} +${mine.length - 1}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={mine.length === 1 ? `PR #${active.number}: ${active.status_label}` : `${mine.length} pull requests`}
          className="inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground text-xs tabular-nums hover:bg-muted/60 hover:text-foreground"
          data-chat-prs
          size="sm"
          title={`${shortRepo(active.repo)}#${active.number} · ${active.status_label}`}
          variant="ghost"
        >
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />
          <GitPullRequestIcon className="size-3.5 shrink-0" />
          <span className="truncate tabular-nums">{chipLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(23rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-0 shadow-lg"
      >
        <PrSwitcher activeKey={active.key} onPick={setSelectedKey} prs={mine} />
        <PrDetail pr={active} />
        <StackSection pr={active} session={session} />
        {active.quick_actions.length > 0 && (
          <>
            <DropdownMenuSeparator className="my-0 bg-border/50" />
            <div className="p-1">
              {active.quick_actions.map(action => (
                <DropdownMenuItem
                  className="gap-2 text-xs"
                  key={action.id}
                  onSelect={() => sendToComposer(session, action.prompt)}
                >
                  <CornerDownLeftIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{action.label}</span>
                </DropdownMenuItem>
              ))}
            </div>
          </>
        )}
        <DropdownMenuSeparator className="my-0 bg-border/50" />
        <div className="p-1">
          <DropdownMenuItem
            className="text-muted-foreground text-xs hover:text-foreground"
            onSelect={() => navigate("#/reviews")}
          >
            All PRs &amp; reviews
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
