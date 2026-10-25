import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { Portal } from "@/hooks/use-portal"
import { cancelled, register, signIn } from "@/lib/passkeys"

export function Gate({ portal }: { portal: Portal }) {
  const setup = new URLSearchParams(location.hash.slice(1)).get("setup")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function go() {
    setError("")
    setBusy(true)
    try {
      if (setup) await register(setup)
      else await signIn()
      history.replaceState(null, "", "/")
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
      <p className="text-muted-foreground text-sm">{setup ? "Create a passkey on this device. It is the only way in." : "Sign in with your passkey."}</p>
      <Button disabled={busy} onClick={go}>
        {setup ? "Create passkey" : "Sign in"}
      </Button>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  )
}
