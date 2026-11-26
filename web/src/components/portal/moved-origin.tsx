import { useState } from "react"
import { forgetShapes } from "skullet"
import { AuthButton, AuthScreen } from "@/components/portal/auth-screen"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { desktopApp } from "@/lib/desktop-window"

const isDesktop = () => /NakoDesktop\//.test(navigator.userAgent)
const isAndroid = () => /NakoAndroid\//.test(navigator.userAgent)

export function MovedOrigin({ origin, portal }: { origin: string; portal: Portal }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const desktop = isDesktop()
  const android = isAndroid()
  const host = new URL(origin).host

  async function copyAddress() {
    setError("")
    try {
      await navigator.clipboard.writeText(origin)
      setCopied(true)
    } catch {
      setError(`Enter ${origin} in Change server.`)
    }
  }

  async function switchServer() {
    setError("")
    setBusy(true)
    try {
      const bridge = desktopApp()
      if (bridge) {
        try {
          const result = (await bridge.invoke("switch_origin")) as { moved?: boolean } | null
          if (result?.moved) return
        } catch {
          try {
            await bridge.invoke("change_server")
            return
          } catch {
            // Older desktop shell: fall back to copying the new address for tray -> Change server.
          }
        }
      }
      await copyAddress()
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setError("")
    setBusy(true)
    try {
      await api("/api/logout", { method: "POST" })
      forgetShapes()
      await portal.boot()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const note = desktop
    ? copied
      ? `Copied ${origin}. Open Change server from the Nako tray menu and paste it.`
      : `This portal moved to ${origin}. Use Change server in the Nako tray menu to switch.`
    : android
      ? copied
        ? `Copied ${origin}.`
        : `This portal moved to ${origin}.`
      : `This portal moved to ${origin}.`

  return (
    <AuthScreen error={error} note={note} title="Portal moved">
      {desktop ? (
        <AuthButton disabled={busy} onClick={switchServer}>
          {copied ? "Copied address" : "Switch server"}
        </AuthButton>
      ) : android ? (
        <AuthButton disabled={busy} onClick={copyAddress}>
          {copied ? "Copied address" : `Copy ${host}`}
        </AuthButton>
      ) : (
        <AuthButton onClick={() => location.replace(`${origin}${location.pathname}${location.search}${location.hash}`)}>
          Open {host}
        </AuthButton>
      )}
      {portal.me?.signed_in && (
        <AuthButton disabled={busy} onClick={signOut} variant="ghost">
          Sign out
        </AuthButton>
      )}
    </AuthScreen>
  )
}
