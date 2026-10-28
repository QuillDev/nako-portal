export type Me = { signed_in: boolean; has_passkeys: boolean; connected: boolean; name?: string }

export type SessionRow = {
  id: string
  title: string
  started_at: number
  pinned?: boolean
  // The one chat posts to the portal (cron deliveries) land in; it sits above every other chat.
  notifications?: boolean
  // A post landed in the notifications chat since it was last opened.
  unread?: boolean
  status?: Status | null
}

// A slash command a portal chat can run (`/api/commands`).
export type Command = { name: string; description: string; skill: boolean }

// What a command printed, shown in the chat where it ran. Only this browser keeps it, like Desktop.
// `at` is the transcript index it follows.
export type CommandNote = { session: string; at: number; text: string; key: string }

// A background process a chat's turn started (terminal background=true), from Hermes's process registry.
export type BackgroundProcess = {
  id: string
  command: string
  label: string
  cwd?: string
  running: boolean
  // How it ended: exited, killed, lost, ...
  ended?: string | null
  started_at: number
  exited_at: number | null
  exit_code: number | null
  notify: boolean
}

export type Status = "working" | "needs you" | "done" | "failed"

export type HistoryMessage =
  // images: local previews for a turn that is still being sent
  | { role: "user"; text: string; row_id?: string | number; images?: string[] }
  // label: the cron job that posted it, when it's a cron post
  | { role: "assistant"; text: string; reasoning?: string; label?: string; row_id?: string | number }
  | { role: "tool"; name: string; context?: string; tool_call_id?: string }

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

// What the gateway has sent in a chat and not saved yet: a reply streaming in (each edit
// replaces its text), tool progress, a post. The transcript replaces it once saved.
// after: how many tools the turn had started when the message was last written to, so a message
// followed by more tool calls reads as her working, not her reply.
export type LiveMessage = { id: string; text: string; after?: number }

// A tool call in the running turn, as it starts and ends.
export type LiveTool = { id: string; name: string; context: string; state: "running" | "done" | "failed" }

export type Live = { messages: LiveMessage[]; tools: LiveTool[] }

export type Passkey = { id: string; label: string; current?: boolean }

export type Frame =
  | { kind: "hub.connected" | "hub.disconnected" | "sessions.changed" }
  | { kind: "status"; session: string; status: Status }
  | { kind: "request"; session: string; request: PortalRequest }
  | { kind: "request.closed"; session: string; id: string }
  | { kind: "alert"; session: string | null; title: string; body: string }
  | { kind: "profile.changed"; profile: string }
  | { kind: "event"; session: string; type: string; payload: Record<string, unknown> }
