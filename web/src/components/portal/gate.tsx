import { useState } from "react"
import { GlobeIcon, KeyRoundIcon } from "lucide-react"
import { AuthButton, AuthScreen } from "@/components/portal/auth-screen"
import type { Portal } from "@/hooks/use-portal"
import { cancelled, register, signIn } from "@/lib/passkeys"

// The desktop app's webview has no passkeys, so it signs in through the browser instead.
const desktopApp = /NakoDesktop\//.test(navigator.userAgent)

export function Gate({ portal }: { portal: Portal }) {
  const hash = new URLSearchParams(location.hash.slice(1))
  const setup = hash.get("setup")
  const [error, setError] = useState(hash.get("signin") === "failed" ? "That sign-in didn't go through. Try again." : "")
  const [busy, setBusy] = useState(false)

  async function go() {
    setError("")
    setBusy(true)
    try {
      if (setup) await register(setup)
      else await signIn()
      // A browser opened by the desktop app goes on to approve it.
      history.replaceState(null, "", location.hash.startsWith("#/desktop?") ? `/${location.hash}` : "/")
      await portal.boot()
    } catch (e) {
      setError(cancelled(e) ? "Cancelled." : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthScreen error={error} note={setup ? "Create a passkey on this device. It is the only way in." : undefined} title="Nako">
      {desktopApp && !setup ? (
        // The app catches this navigation and opens the browser.
        <AuthButton onClick={() => location.assign("/desktop/sign-in")}>
          <GlobeIcon />
          Sign in with browser
        </AuthButton>
      ) : (
        <AuthButton disabled={busy} onClick={go}>
          <KeyRoundIcon />
          {setup ? "Create passkey" : "Sign in with passkey"}
        </AuthButton>
      )}
    </AuthScreen>
  )
}
