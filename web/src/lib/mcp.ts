// MCP servers: the list `hermes mcp` keeps for the shown profile. The gateway reads and writes
// it with Hermes's own helpers; header and env values never come back, only their names.
import { useSyncExternalStore } from "react"
import { api, ApiError } from "@/lib/api"

export type McpServer = {
  name: string
  url: string
  command: string
  args: string[]
  env: string[]
  auth: "none" | "header" | "oauth"
  enabled: boolean
  plugin: string
  status: "connected" | "connecting" | "failed" | "disabled" | "lazy" | "configured" | "installing"
  error: string
  signed_in: boolean
  picked: boolean
  codex: string
  installing: boolean
}

export type McpList = { servers: McpServer[]; codex: boolean }

export type McpCatalogEntry = {
  name: string
  description: string
  transport: string
  url: string
  command: string
  args: string[]
  auth: string
  env: { name: string; prompt: string; required: boolean; secret: boolean; saved: boolean }[]
  source: string
  post_install: string
  installed: boolean
}

export type McpTool = { name: string; description: string; on: boolean }
export type McpTest = { ok: boolean; error: string; tools: McpTool[] }
export type McpSignIn = { flow_id: string; status: string; authorization_url: string | null; error: string | null }

export type McpCustom = { name: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; auth?: "oauth"; token?: string }

const serverPath = (name: string) => `/api/mcp/servers/${encodeURIComponent(name)}`

let list: McpList | false | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

export function reloadMcp() {
  loading = api<McpList>("/api/mcp").then(
    rows => {
      list = rows
      for (const l of listeners) l()
    },
    e => {
      // A Hermes that can't run MCP servers (or a gateway that went away): no page.
      if (e instanceof ApiError) list = list || false
      for (const l of listeners) l()
    },
  )
  return loading
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loading) void reloadMcp()
  return () => listeners.delete(listener)
}

/** null until the first read; false when this install has no MCP; the list after. */
export const useMcp = () => useSyncExternalStore(subscribe, () => list)

export const mcpCatalog = () => api<McpCatalogEntry[]>("/api/mcp/catalog")

export const installMcp = (name: string, env: Record<string, string>) => api(`/api/mcp/catalog/${encodeURIComponent(name)}/install`, { method: "POST", body: { env } })

export const addMcp = (server: McpCustom) => api<{ name: string }>("/api/mcp/servers", { method: "POST", body: server })

export const setMcpEnabled = (name: string, enabled: boolean) => api(`${serverPath(name)}/enabled`, { method: "POST", body: { enabled } })

export const removeMcp = (name: string) => api(`${serverPath(name)}/remove`, { method: "POST" })

export const testMcp = (name: string) => api<McpTest>(`${serverPath(name)}/test`, { method: "POST" })

export const setMcpTools = (name: string, tools: string[], on: string[]) => api(`${serverPath(name)}/tools`, { method: "POST", body: { tools, on } })

export const startMcpSignIn = (name: string) => api<McpSignIn>(`${serverPath(name)}/signin`, { method: "POST" })

export const pollMcpSignIn = (flow: string) => api<McpSignIn>(`/api/mcp/signin/${encodeURIComponent(flow)}`)

export const cancelMcpSignIn = (flow: string) => api(`/api/mcp/signin/${encodeURIComponent(flow)}/cancel`, { method: "POST" })
