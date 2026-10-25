import { useState } from "react"
import { AuthButton, AuthScreen } from "@/components/portal/auth-screen"
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
    <AuthScreen error={error} note="Only if you just asked the Nako app on this computer to sign in." title="Sign in the desktop app?">
      <AuthButton disabled={busy || !valid} onClick={approve}>
        Sign in
      </AuthButton>
      <AuthButton onClick={() => navigate("#/")} variant="ghost">
        Cancel
      </AuthButton>
    </AuthScreen>
  )
}
