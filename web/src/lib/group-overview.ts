import { useCallback, useEffect, useSyncExternalStore } from "react"
import { api } from "@/lib/api"
import { d, type Infer } from "@/lib/decode"
import { ChatGroup, GROUP_THREAD_STATUSES, type GroupThreadStatus } from "@/lib/types"

const PullLink = d.object({ key: d.string(), url: d.string() })
const PreviewLink = d.object({ label: d.string(), url: d.string() })
const AttachedLink = d.object({ label: d.string(), url: d.string(), kind: d.string().optional() })
const ThreadParent = d.object({ id: d.string(), title: d.string() })

export const GroupThread = d.object({
  id: d.string(),
  title: d.string(),
  status: d.enum(GROUP_THREAD_STATUSES),
  task_state: d.enum(GROUP_THREAD_STATUSES).nullable(),
  reason: d.string(),
  activity: d.string(),
  summary: d.string(),
  last_active: d.number(),
  started_at: d.number(),
  message_count: d.number(),
  pinned: d.boolean(),
  archived: d.boolean(),
  background: d.boolean(),
  is_lead: d.boolean().optional(),
  prs: PullLink.array(),
  previews: PreviewLink.array(),
  branch: d.string().nullable(),
  links: AttachedLink.array(),
  parent: ThreadParent.nullable(),
})
export type GroupThread = Infer<typeof GroupThread>

const GroupCounts = d.object({
  total: d.number(),
  active: d.number(),
  background: d.number(),
  needs_you: d.number(),
  working: d.number(),
  waiting: d.number(),
  idle: d.number(),
  done: d.number(),
})

export const GroupOverviewData = d.object({
  group: ChatGroup,
  lead_session: d.string().nullable(),
  lead: GroupThread.nullable(),
  children: GroupThread.array(),
  now: d.number(),
  read_only: d.boolean(),
  counts: GroupCounts,
  child_counts: GroupCounts,
  threads: GroupThread.array(),
})
export type GroupOverviewData = Infer<typeof GroupOverviewData>

const TargetSummary = d.object({
  id: d.string(),
  title: d.string(),
  status: d.enum(GROUP_THREAD_STATUSES),
})

export const GroupArchiveIdleResult = d.object({
  dry_run: d.boolean(),
  read_only: d.boolean(),
  targets: TargetSummary.array(),
  archived: d.string().array(),
})
export type GroupArchiveIdleResult = Infer<typeof GroupArchiveIdleResult>

export const GROUP_STATUS_LABEL: Record<GroupThreadStatus, string> = {
  needs_you: "Needs you",
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  done: "Done",
}

export const GROUP_STATUS_DOT: Record<GroupThreadStatus, string> = {
  needs_you: "bg-amber-500",
  working: "bg-primary animate-pulse",
  waiting: "bg-sky-500",
  idle: "bg-muted-foreground/35",
  done: "bg-emerald-500/75",
}

export function span(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export function pullLabel(key: string): string {
  const slash = key.indexOf("/")
  return slash >= 0 ? key.slice(slash + 1) : key
}

export function previewName(label: string): string {
  return label.includes(":") || /^\d+\./.test(label) ? label : label.split(".")[0]
}

export async function fetchGroupOverview(groupId: string, signal?: AbortSignal): Promise<GroupOverviewData> {
  const raw = await api<unknown>(`/api/groups/${encodeURIComponent(groupId)}`, { signal })
  return GroupOverviewData.parse(raw)
}

export async function archiveIdleInGroup(
  groupId: string,
  payload: { sessions?: string[]; dry_run?: boolean } = {},
): Promise<GroupArchiveIdleResult> {
  const raw = await api<unknown>(`/api/groups/${encodeURIComponent(groupId)}/archive-idle`, { method: "POST", body: payload })
  return GroupArchiveIdleResult.parse(raw)
}

const POLL_MS = 10_000

type CacheEntry = { data: GroupOverviewData | null; error: string }
const EMPTY_ENTRY: CacheEntry = { data: null, error: "" }
const cache = new Map<string, CacheEntry>()
const listeners = new Set<() => void>()
const inflight = new Map<string, Promise<void>>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function loadGroupOverview(groupId: string): Promise<void> {
  const existing = inflight.get(groupId)
  if (existing) return existing
  const task = (async () => {
    try {
      const data = await fetchGroupOverview(groupId)
      cache.set(groupId, { data, error: "" })
    } catch (err) {
      const prev = cache.get(groupId)
      cache.set(groupId, { data: prev?.data ?? null, error: (err as Error).message })
    } finally {
      inflight.delete(groupId)
      emit()
    }
  })()
  inflight.set(groupId, task)
  return task
}

export function useGroupOverview(groupId: string | null, syncKey = "") {
  const entry = useSyncExternalStore(
    subscribe,
    () => (groupId ? cache.get(groupId) ?? EMPTY_ENTRY : EMPTY_ENTRY),
  )
  const reload = useCallback(() => {
    if (groupId) void loadGroupOverview(groupId)
  }, [groupId])

  useEffect(() => {
    if (!groupId) return
    if (syncKey.length >= 0) void loadGroupOverview(groupId)
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadGroupOverview(groupId)
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadGroupOverview(groupId)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [groupId, syncKey])

  return { data: entry.data, error: entry.error, loading: Boolean(groupId) && entry.data === null && !entry.error, reload }
}
