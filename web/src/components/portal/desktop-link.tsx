import { useState } from "react"
import { Button } from "@/components/ui/button"
import { navigate } from "@/hooks/use-portal"
import { api } from "@/lib/api"

// The desktop app can't use passkeys in its webview, so it opens this page in the browser.
// Approving hands a one-time code to the app's loopback listener; only the app can redeem it.
export function DesktopLink({ query }: { query: string }) {
  const params = new URLSearchParams(query)
  const port = Number(params.get("port"))
  const state = params.get("state") || ""
  const challenge = params.get("challenge") || ""
  const valid = Number.isInteger(port) && port >= 1024 && port <= 65535 && /^[\w-]{16,128}$/.test(state) && /^[\w-]{43}$/.test(challenge)
  const [error, setError] = useState(valid ? "" : "This sign-in link is broken. Start again from the app.")
  const [busy, setBusy] = useState(false)

  async function approve() {
    setError("")
    setBusy(true)
    try {
      const { code } = await api<{ code: string }>("/api/desktop/link", { method: "POST", body: { challenge } })
      location.href = `http://127.0.0.1:${port}/callback?${new URLSearchParams({ code, state })}`
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <img alt="" className="size-24 rounded-full ring-2 ring-primary ring-offset-4 ring-offset-background" src="/icon-192.png" />
      <h1 className="font-semibold text-2xl tracking-tight">Sign in the desktop app?</h1>
      <p className="text-muted-foreground text-sm">Only if you just asked the Nako app on this computer to sign in.</p>
      <div className="flex gap-2">
        <Button disabled={busy || !valid} onClick={approve}>
          Sign in
        </Button>
        <Button onClick={() => navigate("#/")} variant="ghost">
          Cancel
        </Button>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  )
}
