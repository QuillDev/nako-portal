import { useEffect, useSyncExternalStore } from "react"
import { api } from "@/lib/api"
import { d, Decoder, type Infer } from "@/lib/decode"

const PrTone = d.enum(["ready", "pending", "failing", "merged", "muted"])
const PrStatus = d.enum([
  "conflict",
  "ci_failed",
  "changes_requested",
  "needs_your_review",
  "ready_to_merge",
  "draft",
  "pending",
  "merged",
])

const PrCheck = d.object({
  name: d.string(),
  url: d.string().default(""),
})

const PrChecks = d.object({
  state: d.enum(["green", "red", "pending", "none"]),
  total: d.number().default(0),
  failing: d.array(PrCheck).default([]),
  pending: d.array(PrCheck).default([]),
})

const PrReview = d.object({
  uses_pullfrog: d.boolean().default(false),
  pullfrog: d.enum(["approved", "changes_requested", "pending", "commented", "none"]).default("none"),
  pullfrog_running: d.boolean().default(false),
  pullfrog_approved_on_head: d.boolean().default(false),
  pullfrog_open_threads: d.number().default(0),
  approved_by: d.array(d.string()).default([]),
  changes_requested_by: d.array(d.string()).default([]),
  unresolved_threads: d.number().default(0),
})

const PrOwner = d.object({
  session: d.string(),
  title: d.string().default(""),
  source: d.string().default("portal"),
  archived: d.boolean().default(false),
  explicit: d.boolean().default(false),
})

const PrStackNode = d.object({
  key: d.string(),
  number: d.number(),
  repo: d.string(),
  title: d.string(),
  url: d.string(),
  status: PrStatus,
  status_label: d.string(),
  tone: PrTone,
  depth: d.number().default(0),
  session: d.string().nullable().optional(),
  session_title: d.string().default(""),
})

const PrMergedParent = d.object({
  key: d.string(),
  url: d.string(),
  head: d.string(),
  retargeted: d.boolean().default(false),
  carries_old_commits: d.boolean().nullable().optional(),
  squash: d.boolean().default(false),
})

const PrQuickAction = d.object({
  id: d.string(),
  label: d.string(),
  prompt: d.string(),
})

const PrItem = d.object({
  key: d.string(),
  repo: d.string(),
  number: d.number(),
  title: d.string(),
  url: d.string(),
  author: d.string(),
  mine: d.boolean(),
  draft: d.boolean().default(false),
  base: d.string(),
  head: d.string(),
  trunk: d.string().default("main"),
  updated_at: d.string().default(""),
  status: PrStatus,
  status_label: d.string(),
  tone: PrTone,
  reason: d.string().default(""),
  checks: PrChecks,
  review: PrReview,
  owner: PrOwner.nullable().optional(),
  stack_id: d.string(),
  depth: d.number().default(0),
  parent_key: d.string().nullable().optional(),
  child_keys: d.array(d.string()).default([]),
  merged_parent: PrMergedParent.nullable().optional(),
  stack: d.array(PrStackNode).default([]),
  quick_actions: d.array(PrQuickAction).default([]),
})

const PrStackMember = d.object({
  key: d.string(),
  depth: d.number().default(0),
})

const PrStack = d.object({
  id: d.string(),
  kind: d.enum(["stack", "standalone"]),
  repos: d.array(d.string()).default([]),
  members: d.array(PrStackMember).default([]),
})

const StringListRecord = new Decoder<Record<string, string[]>>((input, path) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {}
  const listDecoder = d.array(d.string())
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = listDecoder.read(value, [...path, key])
  }
  return out
})

const PrsSnapshot = d.object({
  viewer: d.string(),
  taken_at: d.number(),
  stale: d.boolean().default(false),
  readonly: d.boolean().default(false),
  error: d.string().nullable().optional(),
  prs: d.array(PrItem),
  stacks: d.array(PrStack),
  by_session: StringListRecord.default({}),
})

const ReviewChatResult = d.object({
  preview: d.boolean(),
  pr: d.string(),
  title: d.string(),
  prompt: d.string().optional(),
  session: d.string().nullable().optional(),
  url: d.string().optional(),
})

export type PrTone = Infer<typeof PrTone>
export type PrStatus = Infer<typeof PrStatus>
export type PrItem = Infer<typeof PrItem>
export type PrStack = Infer<typeof PrStack>
export type PrStackNode = Infer<typeof PrStackNode>
export type PrQuickAction = Infer<typeof PrQuickAction>
export type PrsSnapshot = Infer<typeof PrsSnapshot>
export type ReviewChatResult = Infer<typeof ReviewChatResult>

export const PR_DOT: Record<PrTone, string> = {
  ready: "bg-emerald-500",
  pending: "bg-amber-500",
  failing: "bg-destructive",
  merged: "bg-purple-500",
  muted: "bg-muted-foreground/50",
}

export const PR_PILL: Record<PrStatus, string> = {
  conflict: "bg-destructive/12 text-destructive",
  ci_failed: "bg-destructive/12 text-destructive",
  changes_requested: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  needs_your_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  ready_to_merge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  draft: "bg-muted text-muted-foreground",
  pending: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  merged: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
}

const STATUS_PRIORITY: Record<PrStatus, number> = {
  conflict: 0,
  ci_failed: 1,
  changes_requested: 2,
  needs_your_review: 3,
  pending: 4,
  ready_to_merge: 5,
  draft: 6,
  merged: 7,
}

export function shortRepo(repo: string) {
  const slash = repo.indexOf("/")
  return slash >= 0 ? repo.slice(slash + 1) : repo
}

export function worstTone(prs: PrItem[]): PrTone {
  if (prs.some(p => p.tone === "failing")) return "failing"
  if (prs.some(p => p.tone === "pending")) return "pending"
  if (prs.some(p => p.tone === "ready")) return "ready"
  if (prs.some(p => p.tone === "merged")) return "merged"
  return "muted"
}

export function ciLabel(pr: PrItem): string {
  const { state, failing, pending, total } = pr.checks
  if (state === "red") return `CI failed (${failing.length})`
  if (state === "pending") return `CI running (${pending.length}/${total})`
  if (state === "green") return total > 0 ? `CI green (${total})` : "CI green"
  return "No CI"
}

export function reviewLabel(pr: PrItem): string {
  const { review } = pr
  if (review.changes_requested_by.length > 0) return `Changes by ${review.changes_requested_by[0]}`
  if (review.uses_pullfrog) {
    if (review.pullfrog_running) return "Pullfrog reviewing"
    if (review.pullfrog === "approved") return "Pullfrog approved"
    if (review.pullfrog === "changes_requested") return "Pullfrog changes"
    if (review.pullfrog === "commented") return "Pullfrog commented"
    return "Pullfrog pending"
  }
  if (review.approved_by.length > 0) return `Approved by ${review.approved_by[0]}`
  return pr.mine ? "No reviews" : "Review requested"
}

export type PrTab = "mine" | "reviewing" | "all" | "feed"

export type PrGroupRow = {
  id: string
  kind: "stack" | "standalone"
  repos: string[]
  members: PrItem[]
  priority: number
}

function matchesFilter(pr: PrItem, q: string) {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    pr.title.toLowerCase().includes(needle) ||
    pr.repo.toLowerCase().includes(needle) ||
    String(pr.number).includes(needle) ||
    `#${pr.number}`.includes(needle) ||
    pr.head.toLowerCase().includes(needle) ||
    pr.author.toLowerCase().includes(needle) ||
    pr.status_label.toLowerCase().includes(needle)
  )
}

function matchesTab(pr: PrItem, tab: PrTab) {
  if (tab === "mine") return pr.mine
  if (tab === "reviewing") return !pr.mine
  return true
}

/** Group and sort visible PRs into parent->child stacks first, then urgent standalones. */
export function visiblePrGroups(data: PrsSnapshot | null, tab: PrTab, query: string): PrGroupRow[] {
  if (!data || tab === "feed") return []
  const byKey = new Map(data.prs.map(p => [p.key, p]))
  const groups: PrGroupRow[] = []

  for (const stack of data.stacks) {
    const members: PrItem[] = []
    for (const m of stack.members) {
      const pr = byKey.get(m.key)
      if (pr && matchesTab(pr, tab) && matchesFilter(pr, query)) {
        members.push(pr)
      }
    }
    if (members.length === 0) continue
    const priority = Math.min(...members.map(pr => STATUS_PRIORITY[pr.status]))
    groups.push({
      id: stack.id,
      kind: members.length > 1 || members.some(pr => Boolean(pr.merged_parent)) ? "stack" : "standalone",
      repos: stack.repos,
      members,
      priority,
    })
  }

  return groups.toSorted((a, b) => {
    if (a.kind !== b.kind) return a.kind === "stack" ? -1 : 1
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.id.localeCompare(b.id)
  })
}

export function sessionPrList(data: PrsSnapshot | null, session: string): PrItem[] {
  if (!data) return []
  const keys = data.by_session[session]
  if (!keys || keys.length === 0) return []
  const byKey = new Map(data.prs.map(p => [p.key, p]))
  const out: PrItem[] = []
  for (const key of keys) {
    const pr = byKey.get(key)
    if (pr) out.push(pr)
  }
  return out
}

export function attentionCount(data: PrsSnapshot | null): number {
  if (!data) return 0
  return data.prs.filter(
    p => p.status === "needs_your_review" || p.status === "ci_failed" || p.status === "changes_requested",
  ).length
}

type State = {
  data: PrsSnapshot | null
  error: string
}

let current: State = { data: null, error: "" }
const listeners = new Set<() => void>()
let inflight: Promise<void> | null = null
let fetchSeq = 0

function set(next: State) {
  current = next
  for (const listener of listeners) listener()
}

export function loadPrs(fresh = false): Promise<void> {
  if (!fresh && inflight) return inflight
  const seq = ++fetchSeq
  const path = fresh ? "/api/prs?refresh=1" : "/api/prs"
  const run = async (): Promise<void> => {
    try {
      const raw = await api<unknown>(path)
      if (seq >= fetchSeq) set({ data: PrsSnapshot.parse(raw), error: "" })
    } catch (error: unknown) {
      if (seq >= fetchSeq) set({ ...current, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (inflight === promise) inflight = null
    }
  }
  const promise = run()
  inflight = promise
  return promise
}

export function reloadPrs(): Promise<void> {
  return loadPrs(false)
}

export async function startReviewChat(pr: PrItem): Promise<ReviewChatResult> {
  const raw = await api<unknown>("/api/prs/review-chat", {
    method: "POST",
    body: {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      base: pr.base,
      head: pr.head,
    },
  })
  return ReviewChatResult.parse(raw)
}

/** Last PR snapshot, refreshed on mount and every `every` ms while visible. */
export function usePrs(enabled: boolean, every = 60_000): State {
  const state = useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
  useEffect(() => {
    if (!enabled) return
    void loadPrs()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadPrs()
    }, every)
    return () => clearInterval(timer)
  }, [enabled, every])
  return state
}
