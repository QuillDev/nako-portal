import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import type { Note } from "@/components/portal/transcript"
import type { Attachment } from "@/hooks/use-portal"
import { api, dataUrlToFile, sessionPath } from "@/lib/api"
import type { HistoryMessage, Live, OpenSession } from "@/lib/types"

type CacheEntry = {
  messages: HistoryMessage[]
  running: boolean
  live: Live | null
  loaded: boolean
  error: string
}

type PreviewTurn = {
  message: HistoryMessage
  note: string
}

const EMPTY: CacheEntry = { messages: [], running: false, live: null, loaded: false, error: "" }
const EMPTY_PREVIEW: PreviewTurn[] = []
const cache = new Map<string, CacheEntry>()
const previewTurns = new Map<string, PreviewTurn[]>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function loadMiniThread(sessionId: string): Promise<void> {
  const running = inflight.get(sessionId)
  if (running) return running
  const task = (async () => {
    try {
      const opened = await api<OpenSession>(sessionPath(sessionId))
      cache.set(sessionId, {
        messages: opened.messages ?? [],
        running: Boolean(opened.running),
        live: opened.live ?? null,
        loaded: true,
        error: "",
      })
    } catch (err) {
      const prev = cache.get(sessionId)
      cache.set(sessionId, {
        messages: prev?.messages ?? [],
        running: prev?.running ?? false,
        live: prev?.live ?? null,
        loaded: true,
        error: (err as Error).message,
      })
    } finally {
      inflight.delete(sessionId)
      emit()
    }
  })()
  inflight.set(sessionId, task)
  return task
}

export function appendPreviewMessage(
  sessionId: string,
  text: string,
  threadTitle: string,
  attachments: Attachment[] = [],
) {
  const prev = previewTurns.get(sessionId) ?? []
  const images = attachments
    .filter(f => f.mediaType.startsWith("image/") && f.url.startsWith("data:"))
    .map(f => f.url)
  const message: HistoryMessage = {
    role: "user",
    text,
    row_id: `preview-${Date.now()}-${prev.length}`,
    images: images.length ? images : undefined,
  }
  previewTurns.set(sessionId, [
    ...prev,
    { message, note: `Preview only · would send to ${threadTitle}` },
  ])
  emit()
}

export async function sendMiniMessage(sessionId: string, text: string, attachments: Attachment[] = []) {
  const form = new FormData()
  form.append("text", text)
  const files = await Promise.all(
    attachments.map(file => dataUrlToFile(file.url, file.filename || "attachment", file.mediaType)),
  )
  for (const file of files) form.append("file", file)
  await api(sessionPath(sessionId, "/messages"), { method: "POST", form })
  await loadMiniThread(sessionId)
}

const MINI_POLL_MS = 3_000

export function useMiniThread(
  sessionId: string | null,
  options: { active?: boolean; syncKey?: string } = {},
) {
  const { active = false, syncKey = "" } = options
  const entry = useSyncExternalStore(
    subscribe,
    () => (sessionId ? cache.get(sessionId) ?? EMPTY : EMPTY),
  )
  const local = useSyncExternalStore(
    subscribe,
    () => (sessionId ? previewTurns.get(sessionId) ?? EMPTY_PREVIEW : EMPTY_PREVIEW),
  )
  const reload = useCallback(() => {
    if (sessionId) void loadMiniThread(sessionId)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return
    if (syncKey.length >= 0) void loadMiniThread(sessionId)
  }, [sessionId, syncKey])

  const polling = Boolean(sessionId && (active || entry.running))
  useEffect(() => {
    if (!sessionId || !polling) return
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadMiniThread(sessionId)
    }, MINI_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadMiniThread(sessionId)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      void loadMiniThread(sessionId)
    }
  }, [sessionId, polling])

  const messages = useMemo(
    () => (local.length > 0 ? [...entry.messages, ...local.map(t => t.message)] : entry.messages),
    [entry.messages, local],
  )
  const notes = useMemo<Note[]>(
    () =>
      local.map((t, i) => ({
        at: entry.messages.length + i + 1,
        text: t.note,
        key: `preview-note-${t.message.role === "user" ? t.message.row_id : i}`,
      })),
    [entry.messages.length, local],
  )

  return {
    messages,
    notes,
    running: entry.running,
    live: entry.live,
    loading: Boolean(sessionId) && !entry.loaded,
    error: entry.error,
    reload,
  }
}
