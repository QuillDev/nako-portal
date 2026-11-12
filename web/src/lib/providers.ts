// Providers: the accounts and API keys Hermes can run on, as `hermes model` lists them. The
// gateway reads and writes them; the portal only shows the list and takes a key. A saved key
// never comes back, so this file has no way to read one.
import { useSyncExternalStore } from "react"
import { api, ApiError } from "@/lib/api"

export type Provider = {
  slug: string
  label: string
  description: string
  kind: "key" | "signin" | "cli"
  command: string
  connected: boolean
  source: string
  env_var: string
  env_vars: string[]
  signup_url: string
  /** Set when the provider can hold several accounts: each one, and how a sign-in goes. */
  accounts?: Account[]
  login?: "paste" | "code"
}

export type Account = { id: string; label: string; email: string; plan: string; signed_in: boolean }
export type AccountSignIn = { attempt: string; mode: "paste" | "code"; url?: string; user_code?: string; verification_url?: string; poll_interval?: number }
export type AccountResult = { outcome: "added" | "refreshed"; label: string; email: string; plan: string }
export type AccountSignInStatus = { status: "pending" | "done" | "error" | "expired" | "cancelled"; result?: AccountResult; error?: string }

export type SignIn = { session_id: string; user_code: string; verification_url: string; expires_in: number; poll_interval: number }
export type SignInStatus = { status: "pending" | "approved" | "denied" | "expired" | "error" | "cancelled"; error: string | null }

export const providerPath = (slug: string) => `/api/providers/${encodeURIComponent(slug)}`

let list: Provider[] | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

export function reloadProviders() {
  loading = api<Provider[]>("/api/providers").then(
    rows => {
      list = rows
      for (const l of listeners) l()
    },
    e => {
      // An install that can't list providers (or a gateway that went away): no page, no error.
      if (e instanceof ApiError) list = list ?? []
      for (const l of listeners) l()
    },
  )
  return loading
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!loading) void reloadProviders()
  return () => listeners.delete(listener)
}

/** null until the first read; the rows after. */
export const useProviders = () => useSyncExternalStore(subscribe, () => list)

export const setProviderKey = (slug: string, value: string) => api(`${providerPath(slug)}/key`, { method: "POST", body: { value } })

export const removeProviderKey = (slug: string) => api(`${providerPath(slug)}/remove`, { method: "POST" })

export const startSignIn = (slug: string) => api<SignIn>(`${providerPath(slug)}/signin`, { method: "POST" })

export const pollSignIn = (slug: string, session: string) => api<SignInStatus>(`${providerPath(slug)}/signin/${encodeURIComponent(session)}`)

const attemptPath = (slug: string, attempt: string) => `${providerPath(slug)}/accounts/signin/${encodeURIComponent(attempt)}`

/** Sign in to one more account, or again to `target`; who signs in decides whether it's added or refreshed. */
export const startAccountSignIn = (slug: string, target?: string) =>
  api<AccountSignIn>(`${providerPath(slug)}/accounts/signin`, { method: "POST", body: { target: target ?? null } })

export const finishAccountSignIn = (slug: string, attempt: string, code: string) =>
  api<AccountResult>(`${attemptPath(slug, attempt)}/code`, { method: "POST", body: { code } })

export const pollAccountSignIn = (slug: string, attempt: string) => api<AccountSignInStatus>(attemptPath(slug, attempt))

export const cancelAccountSignIn = (slug: string, attempt: string) => api(`${attemptPath(slug, attempt)}/cancel`, { method: "POST" })
