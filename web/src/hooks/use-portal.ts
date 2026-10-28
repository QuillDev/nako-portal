// Portal state: the signed-in user, the chat list, the open chat and its live turn.
// Transcripts are never stored here; every open reads Hermes's own history.
import { useCallback, useEffect, useRef, useState } from "react"
import { api, dataUrlToFile, sessionPath, whenSignedOut } from "@/lib/api"
import type { Command, CommandNote, Frame, HistoryMessage, Live, Me, OpenSession, SessionRow } from "@/lib/types"

/** Whether this page is on screen and focused, i.e. you'd see a reply land without an alert. */
const looking = () => document.visibilityState === "visible" && document.hasFocus()

export type Route = { view: "list" } | { view: "new" } | { view: "settings" } | { view: "chat"; session: string } | { view: "desktop"; query: string }

export type Attachment = { url: string; filename?: string; mediaType: string }

function parseRoute(hash: string): Route {
  const chat = hash.match(/^#\/c\/([\w.-]+)/)
  if (chat) return { view: "chat", session: chat[1] }
  if (hash === "#/new") return { view: "new" }
  if (hash === "#/settings") return { view: "settings" }
  if (hash.startsWith("#/desktop?")) return { view: "desktop", query: hash.slice("#/desktop?".length) }
  return { view: "list" }
}

export function navigate(hash: string) {
  if (location.hash !== hash) location.hash = hash
}

const emptyLive = (): Live => ({ messages: [], tools: [] })

// Chats opened or hovered lately, kept so going back to one shows it at once while it rereads.
const CACHED_CHATS = 24
// A prefetch this fresh opens the chat without reading it again.
const FRESH_MS = 3000

type Cached = { opened: OpenSession; at: number }

// at: when it was last read whole; a read that recent opens the chat without reading it again.
function remember(cache: Map<string, Cached>, opened: OpenSession, at: number) {
  cache.delete(opened.session)
  cache.set(opened.session, { opened, at })
  while (cache.size > CACHED_CHATS) cache.delete(cache.keys().next().value!)
}

function sameMessage(a: HistoryMessage, b: HistoryMessage) {
  if (a === b) return true
  const keys = Object.keys(a) as (keyof HistoryMessage)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(k => {
    const x = a[k] as unknown
    const y = b[k] as unknown
    return x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i]))
  })
}

// The reread messages, reusing the ones already on screen that didn't change, so only new or
// edited rows render again.
function reuse(shown: HistoryMessage[], fresh: HistoryMessage[]) {
  let changed = shown.length !== fresh.length
  const out = fresh.map((m, i) => {
    const old = shown[i]
    if (old && sameMessage(old, m)) return old
    changed = true
    return m
  })
  return changed ? out : shown
}

export function usePortal() {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [current, setCurrent] = useState<(OpenSession & { loading: boolean; loadingOlder: boolean }) | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [connected, setConnected] = useState(true)
  // Whether this page's socket to the portal is up; while it's down nothing live arrives.
  const [linked, setLinked] = useState(true)
  const [error, setError] = useState("")
  const [commands, setCommands] = useState<Command[]>([])
  const [notes, setNotes] = useState<CommandNote[]>([])
  // Nako's line about the open chat's last finished turn.
  const [signOff, setSignOff] = useState<{ session: string; text: string } | null>(null)

  const currentRef = useRef(current)
  currentRef.current = current
  const socketRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(1000)
  const cacheRef = useRef(new Map<string, Cached>())
  const inflightRef = useRef(new Map<string, Promise<OpenSession>>())

  // One read of a chat's latest page at a time; a hover and the click after it share it.
  const read = useCallback((session: string) => {
    const pending = inflightRef.current.get(session)
    if (pending) return pending
    const reading = api<OpenSession>(sessionPath(session)).finally(() => inflightRef.current.delete(session))
    inflightRef.current.set(session, reading)
    reading.then(opened => remember(cacheRef.current, opened, Date.now()), () => {})
    return reading
  }, [])

  // Reads a chat the pointer is on, so opening it is instant.
  const prefetch = useCallback(
    (session: string) => {
      const cached = cacheRef.current.get(session)
      if (currentRef.current?.session === session || (cached && Date.now() - cached.at < FRESH_MS)) return
      read(session).catch(() => {})
    },
    [read],
  )

  const loadSessions = useCallback(async () => {
    try {
      const rows = await api<SessionRow[]>("/api/sessions")
      // The same list again (a reconnect, another tab's change elsewhere) leaves the sidebar as it is.
      setSessions(shown => (JSON.stringify(shown) === JSON.stringify(rows) ? shown : rows))
      setConnected(true)
    } catch (e) {
      if (/offline/i.test(String((e as Error).message))) setConnected(false)
    }
  }, [])

  // Rereads the open chat from where its loaded pages start, so older pages already on screen stay.
  const refresh = useCallback(async (session: string) => {
    const open = currentRef.current
    const since = open?.session === session && !open.loading ? `?since=${open.start}` : ""
    try {
      const opened = await (since ? api<OpenSession>(sessionPath(session) + since) : read(session))
      setCurrent(c => {
        if (c?.session !== session) return c
        // An older page that landed while this was in flight sits before opened.start.
        const kept = !c.loading && c.start < opened.start ? c.messages.slice(0, opened.start - c.start) : []
        const start = opened.start - kept.length
        const messages = c.loading ? opened.messages : c.start === start ? reuse(c.messages, [...kept, ...opened.messages]) : [...kept, ...opened.messages]
        return { ...opened, start, messages, loading: false, loadingOlder: c.loadingOlder }
      })
      if (!opened.running) setLive(null)
      // Opening the notifications chat marks its posts seen on the server too.
      setSessions(rows => (rows.some(r => r.id === session && r.unread) ? rows.map(r => (r.id === session ? { ...r, unread: false } : r)) : rows))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [read])

  const loadOlder = useCallback(async () => {
    const open = currentRef.current
    if (!open || open.loading || open.loadingOlder || open.start === 0) return
    const { session, start } = open
    setCurrent(c => (c?.session === session ? { ...c, loadingOlder: true } : c))
    try {
      const older = await api<OpenSession>(sessionPath(session, `?before=${start}`))
      setCurrent(c => (c?.session === session && c.start === start ? { ...c, start: older.start, messages: [...older.messages, ...c.messages], loadingOlder: false } : c))
    } catch (e) {
      setCurrent(c => (c?.session === session ? { ...c, loadingOlder: false } : c))
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
          loadSessions()
          // A post can land in the open notifications chat; reading it there also marks it seen.
          if (currentRef.current && !currentRef.current.running) refresh(currentRef.current.session)
          return
        case "status":
          setSessions(rows => rows.map(r => (r.id === frame.session ? { ...r, status: frame.status } : r)))
          return
        case "alert":
          return
        case "profile.changed":
          // Another profile's chats: the open one isn't among them any more.
          if (currentRef.current) navigate("#/")
          cacheRef.current.clear()
          loadSessions()
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
          setSignOff(null)
          setLive(emptyLive())
          setCurrent(c => c && { ...c, running: true })
          break
        case "gateway.message": {
          const message = { id: String(p.id || ""), text: String(p.text || "") }
          setLive(l => {
            const base = l || emptyLive()
            const at = base.messages.findIndex(m => m.id === message.id)
            return {
              ...base,
              messages: at < 0 ? [...base.messages, { ...message, after: base.tools.length }] : base.messages.map((m, i) => (i === at ? { ...m, text: message.text, after: m.text === message.text ? m.after : base.tools.length } : m)),
            }
          })
          break
        }
        case "tool": {
          const tool = { id: String(p.id || ""), name: String(p.name || "tool"), context: String(p.context || ""), state: p.state === "running" ? "running" : p.state === "failed" ? "failed" : "done" } as const
          setLive(l => {
            const base = l || emptyLive()
            const at = tool.id ? base.tools.findIndex(t => t.id === tool.id) : -1
            return { ...base, tools: at < 0 ? [...base.tools, tool] : base.tools.map((t, i) => (i === at ? tool : t)) }
          })
          break
        }
        case "message.complete":
          setCurrent(c => c && { ...c, running: false })
          refresh(open.session)
          break
        case "signoff":
          setSignOff({ session: open.session, text: String(p.text || "") })
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
      setLinked(true)
      socket.send(JSON.stringify({ watch: currentRef.current?.session ?? null, looking: looking() }))
    }
    socket.onmessage = event => onFrameRef.current(JSON.parse(event.data))
    socket.onclose = () => {
      socketRef.current = null
      setLinked(false)
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
    api<Command[]>("/api/commands").then(setCommands, () => {})
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
    // The server holds alerts for the chat on screen; tell it whenever that changes.
    const onLooking = () => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ looking: looking() }))
    }
    window.addEventListener("hashchange", onHash)
    document.addEventListener("visibilitychange", onVisible)
    document.addEventListener("visibilitychange", onLooking)
    window.addEventListener("focus", onLooking)
    window.addEventListener("blur", onLooking)
    return () => {
      window.removeEventListener("hashchange", onHash)
      document.removeEventListener("visibilitychange", onVisible)
      document.removeEventListener("visibilitychange", onLooking)
      window.removeEventListener("focus", onLooking)
      window.removeEventListener("blur", onLooking)
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
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ watch: null }))
      return
    }
    if (currentRef.current?.session === routedSession) return
    const title = sessions.find(s => s.id === routedSession)?.title || ""
    const cached = cacheRef.current.get(routedSession)
    const reading = inflightRef.current.has(routedSession)
    // Seen lately: show it as it was straight away, then catch up from where its pages start.
    if (cached) setCurrent({ ...cached.opened, title: cached.opened.title || title, loading: false, loadingOlder: false })
    else setCurrent({ session: routedSession, title, messages: [], start: 0, requests: [], running: false, loading: true, loadingOlder: false })
    setLive(null)
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ watch: routedSession }))
    // A read already on its way (the pointer was on the row) or just finished is the latest page.
    if (!(cached && !reading && Date.now() - cached.at < FRESH_MS)) refresh(routedSession)
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
          setCurrent(c => c && { ...c, running: true, messages: [...c.messages, { role: "user", text, row_id: `pending-${Date.now()}`, images: attachments.filter(a => a.mediaType.startsWith("image/") && a.url.startsWith("data:")).map(a => a.url) }] })
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

  const setName = useCallback(async (name: string) => {
    const saved = await api<{ name: string }>("/api/me/name", { method: "POST", body: { name } })
    setMe(m => (m ? { ...m, name: saved.name } : m))
  }, [])

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
        cacheRef.current.delete(session)
        if (currentRef.current?.session === session) navigate("#/")
        await loadSessions()
      }),
    [act, loadSessions],
  )

  // `/name arg` in an open chat. Output shows in the chat; `prefill` text goes back to the composer.
  const command = useCallback(
    async (text: string): Promise<string | undefined> => {
      const open = currentRef.current
      if (!open) {
        setError("Open a chat to run commands")
        return
      }
      setError("")
      const note = (body: string) =>
        setNotes(n => [...n, { session: open.session, at: open.start + open.messages.length, text: body, key: `note-${Date.now()}-${n.length}` }])
      try {
        const done = await api<{ output?: string | null; prefill?: string; sent?: boolean }>(sessionPath(open.session, "/command"), { method: "POST", body: { text } })
        note(done.output ? `${text.trim()}\n${done.output}` : text.trim())
        if (done.sent) {
          setCurrent(c => (c?.session === open.session ? { ...c, running: true } : c))
          setLive(l => l || emptyLive())
          refresh(open.session)
        }
        return done.prefill
      } catch (e) {
        note(`${text.trim()}\n${(e as Error).message}`)
      }
    },
    [refresh],
  )

  // What's on screen is what going back to a chat shows next time.
  useEffect(() => {
    if (current && !current.loading) {
      const { loading: _loading, loadingOlder: _older, ...opened } = current
      remember(cacheRef.current, opened, cacheRef.current.get(current.session)?.at ?? 0)
    }
  }, [current])

  return { me, setName, boot, sessions, route, current, live, connected, linked, error, setError, send, stop, answer, rename, pin, archive, loadOlder, prefetch, commands, command, notes, signOff }
}

export type Portal = ReturnType<typeof usePortal>
