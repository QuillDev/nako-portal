// Portal state: the signed-in user, the chat list, the open chat and its live turn.
// Transcripts are never stored here; every open reads Hermes's own history.
import { useCallback, useEffect, useRef, useState } from "react"
import { api, dataUrlToFile, sessionPath, whenSignedOut } from "@/lib/api"
import type { Frame, Live, LiveTool, Me, OpenSession, SessionRow } from "@/lib/types"

export type Route = { view: "list" } | { view: "new" } | { view: "settings" } | { view: "chat"; session: string }

export type Attachment = { url: string; filename?: string; mediaType: string }

function parseRoute(hash: string): Route {
  const chat = hash.match(/^#\/c\/([\w.-]+)/)
  if (chat) return { view: "chat", session: chat[1] }
  if (hash === "#/new") return { view: "new" }
  if (hash === "#/settings") return { view: "settings" }
  return { view: "list" }
}

export function navigate(hash: string) {
  if (location.hash !== hash) location.hash = hash
}

const emptyLive = (): Live => ({ text: "", reasoning: "", tools: [] })

function toolFrom(payload: Record<string, unknown>): LiveTool {
  return {
    id: String(payload.tool_id || crypto.randomUUID()),
    name: String(payload.name || "tool"),
    context: String(payload.context || payload.preview || ""),
    args: (payload.args as Record<string, unknown>) || undefined,
    done: false,
    failed: false,
  }
}

export function usePortal() {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [current, setCurrent] = useState<(OpenSession & { loading: boolean }) | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [connected, setConnected] = useState(true)
  const [error, setError] = useState("")

  const currentRef = useRef(current)
  currentRef.current = current
  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(1000)

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api<SessionRow[]>("/api/sessions"))
      setConnected(true)
    } catch (e) {
      if (/offline/i.test(String((e as Error).message))) setConnected(false)
    }
  }, [])

  const refresh = useCallback(async (session: string) => {
    try {
      const opened = await api<OpenSession>(sessionPath(session))
      if (currentRef.current?.session !== session) return
      setCurrent({ ...opened, loading: false })
      if (!opened.running) setLive(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  // Socket: hub state, list changes and the open chat's live events.
  const onFrame = useCallback(
    (frame: Frame) => {
      switch (frame.kind) {
        case "hub.connected":
          setConnected(true)
          loadSessions()
          if (currentRef.current) refresh(currentRef.current.session)
          return
        case "hub.disconnected":
          return setConnected(false)
        case "sessions.changed":
          return void loadSessions()
        case "status":
          setSessions(rows => rows.map(r => (r.id === frame.session ? { ...r, status: frame.status } : r)))
          return
        case "alert":
          return
      }
      const open = currentRef.current
      if (!open || frame.session !== open.session) return
      if (frame.kind === "request") {
        setCurrent(c => c && { ...c, requests: [...c.requests.filter(r => r.id !== frame.request.id), frame.request] })
        return
      }
      if (frame.kind === "request.closed") {
        setCurrent(c => c && { ...c, requests: c.requests.filter(r => r.id !== frame.id) })
        return
      }
      const p = frame.payload || {}
      switch (frame.type) {
        case "message.start":
          setLive(emptyLive())
          setCurrent(c => c && { ...c, running: true })
          break
        case "message.delta":
          setLive(l => ({ ...(l || emptyLive()), text: (l?.text || "") + String(p.text || "") }))
          break
        case "reasoning.delta":
        case "thinking.delta":
          setLive(l => ({ ...(l || emptyLive()), reasoning: (l?.reasoning || "") + String(p.text || "") }))
          break
        case "tool.start":
          setLive(l => ({ ...(l || emptyLive()), tools: [...(l?.tools || []), toolFrom(p)] }))
          break
        case "tool.complete":
          setLive(l => {
            const base = l || emptyLive()
            const id = String(p.tool_id || "")
            return {
              ...base,
              tools: base.tools.map(t => (t.id === id ? { ...t, done: true, failed: Boolean(p.error), summary: p.summary ? String(p.summary) : undefined } : t)),
            }
          })
          break
        case "message.interim":
          setLive(emptyLive())
          refresh(open.session)
          break
        case "message.complete":
          setCurrent(c => c && { ...c, running: false })
          refresh(open.session)
          break
        case "session.title":
          if (p.title) setCurrent(c => c && { ...c, title: String(p.title) })
          break
        case "error":
          setError(String(p.message || "something went wrong"))
          break
      }
    },
    [loadSessions, refresh],
  )

  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  const connect = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return
    const url = new URL("/ws", location.href)
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url)
    socketRef.current = socket
    socket.onopen = () => {
      retryRef.current = 1000
      if (currentRef.current) socket.send(JSON.stringify({ watch: currentRef.current.session }))
    }
    socket.onmessage = event => onFrameRef.current(JSON.parse(event.data))
    socket.onclose = () => {
      socketRef.current = null
      setTimeout(() => meRef.current?.signed_in && connect(), retryRef.current)
      retryRef.current = Math.min(retryRef.current * 2, 15000)
    }
  }, [])

  const meRef = useRef(me)
  meRef.current = me

  const boot = useCallback(async () => {
    setError("")
    const who = await api<Me>("/api/me")
    setMe(who)
    if (!who.signed_in) return
    connect()
    await loadSessions()
  }, [connect, loadSessions])

  useEffect(() => {
    whenSignedOut(() => setMe(m => ({ ...(m || { has_passkeys: true, connected: true }), signed_in: false })))
    boot().catch(e => setError((e as Error).message))
    const onHash = () => setRoute(parseRoute(location.hash))
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !meRef.current?.signed_in) return
      connect()
      loadSessions()
      if (currentRef.current) refresh(currentRef.current.session)
    }
    window.addEventListener("hashchange", onHash)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("hashchange", onHash)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [boot, connect, loadSessions, refresh])

  // Opening a chat follows the route.
  const routedSession = route.view === "chat" ? route.session : null
  useEffect(() => {
    if (!me?.signed_in) return
    setError("")
    if (!routedSession) {
      setCurrent(null)
      setLive(null)
      return
    }
    if (currentRef.current?.session === routedSession) return
    const title = sessions.find(s => s.id === routedSession)?.title || ""
    setCurrent({ session: routedSession, title, messages: [], requests: [], running: false, loading: true })
    setLive(null)
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ watch: routedSession }))
    refresh(routedSession)
    // sessions is only read for a placeholder title
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routedSession, me?.signed_in, refresh])

  const send = useCallback(
    async (text: string, attachments: Attachment[]) => {
      const form = new FormData()
      form.set("text", text)
      for (const a of attachments) {
        const name = a.filename || "file"
        form.append("file", a.url.startsWith("data:") ? dataUrlToFile(a.url, name, a.mediaType) : new File([], name), name)
      }
      setError("")
      try {
        const open = currentRef.current
        if (open) {
          await api(sessionPath(open.session, "/messages"), { method: "POST", form })
          setCurrent(c => c && { ...c, running: true, messages: [...c.messages, { role: "user", text, row_id: `pending-${Date.now()}` }] })
          setLive(l => l || emptyLive())
        } else {
          const created = await api<{ session: string }>("/api/sessions", { method: "POST", form })
          await loadSessions()
          navigate(`#/c/${created.session}`)
        }
      } catch (e) {
        setError((e as Error).message)
        throw e
      }
    },
    [loadSessions],
  )

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [],
  )

  const stop = useCallback(() => act(() => api(sessionPath(currentRef.current!.session, "/stop"), { method: "POST" })), [act])

  const answer = useCallback(
    (id: string, result: unknown) =>
      act(async () => {
        await api(`/api/requests/${encodeURIComponent(id)}`, { method: "POST", body: { result } })
        setCurrent(c => c && { ...c, requests: c.requests.filter(r => r.id !== id) })
      }),
    [act],
  )

  const rename = useCallback(
    (session: string, title: string) =>
      act(async () => {
        await api(sessionPath(session, "/title"), { method: "POST", body: { title } })
        setCurrent(c => (c && c.session === session ? { ...c, title } : c))
        await loadSessions()
      }),
    [act, loadSessions],
  )

  const pin = useCallback(
    (session: string, pinned: boolean) =>
      act(async () => {
        await api(sessionPath(session, "/pin"), { method: "POST", body: { pinned } })
        await loadSessions()
      }),
    [act, loadSessions],
  )

  const archive = useCallback(
    (session: string) =>
      act(async () => {
        await api(sessionPath(session, "/archive"), { method: "POST", body: { archived: true } })
        navigate("#/")
        await loadSessions()
      }),
    [act, loadSessions],
  )

  return { me, boot, sessions, route, current, live, connected, error, setError, send, stop, answer, rename, pin, archive }
}

export type Portal = ReturnType<typeof usePortal>
