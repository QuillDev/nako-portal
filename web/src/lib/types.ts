export type Me = { signed_in: boolean; has_passkeys: boolean; connected: boolean }

export type SessionRow = {
  id: string
  title: string
  started_at: number
  preview?: string
  // The cron job, when the chat is only cron posts nobody has answered yet.
  notification?: string | null
  pinned?: boolean
  status?: Status | null
}

export type Status = "working" | "needs you" | "done" | "failed"

export type HistoryMessage =
  // images: local previews for a turn that is still being sent
  | { role: "user"; text: string; row_id?: string | number; images?: string[] }
  | { role: "assistant"; text: string; reasoning?: string; row_id?: string | number }
  | { role: "tool"; name: string; context?: string; args?: Record<string, unknown>; tool_call_id?: string }

export type PortalRequest = {
  id: string
  method: string
  answerable: boolean
  params: {
    description?: string
    command?: string
    choices?: string[]
    questions?: { qid: string; question: string; choices?: string[] }[]
  }
}

export type OpenSession = {
  session: string
  title: string
  messages: HistoryMessage[]
  // Where messages[0] sits in the whole transcript; above 0, older pages are left to load.
  start: number
  running: boolean
  status?: Status | null
  requests: PortalRequest[]
}

export type LiveTool = {
  id: string
  name: string
  context: string
  args?: Record<string, unknown>
  done: boolean
  failed: boolean
  summary?: string
}

export type Live = { text: string; reasoning: string; tools: LiveTool[] }

export type Passkey = { id: string; label: string; current?: boolean }

export type Frame =
  | { kind: "hub.connected" | "hub.disconnected" | "sessions.changed" }
  | { kind: "status"; session: string; status: Status }
  | { kind: "request"; session: string; request: PortalRequest }
  | { kind: "request.closed"; session: string; id: string }
  | { kind: "alert"; session: string | null; title: string; body: string }
  | { kind: "event"; session: string; type: string; payload: Record<string, unknown> }
