import { useState } from "react"
import { Button } from "@/components/ui/button"
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
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <img alt="" className="size-24 rounded-full ring-2 ring-primary ring-offset-4 ring-offset-background" src="/icon-192.png" />
      <h1 className="font-semibold text-2xl tracking-tight">Nako</h1>
      {desktopApp && !setup ? (
        <>
          <p className="text-muted-foreground text-sm">Sign in with your browser.</p>
          {/* The app catches this navigation and opens the browser. */}
          <Button onClick={() => location.assign("/desktop/sign-in")}>Sign in</Button>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">{setup ? "Create a passkey on this device. It is the only way in." : "Sign in with your passkey."}</p>
          <Button disabled={busy} onClick={go}>
            {setup ? "Create passkey" : "Sign in"}
          </Button>
        </>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  )
}
