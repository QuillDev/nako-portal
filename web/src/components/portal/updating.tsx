import { LoaderCircleIcon } from "lucide-react"
import { useDesktopUpdate } from "@/lib/desktop-update"
import { AuthScreen } from "./auth-screen"

/** Covers the app while it installs an update, so a restart (or Homebrew's build) never looks like a crash. */
export function UpdatingScreen() {
  const update = useDesktopUpdate()
  if (update?.state !== "installing") return null
  const note = update.brew
    ? `Homebrew is building ${update.version}. This takes a few minutes; Nako reopens when it's done.`
    : `Installing ${update.version}. Nako restarts when it's done.`
  return (
    <div aria-live="polite" className="fixed inset-0 z-50 bg-background" role="status">
      <AuthScreen note={note} title="Updating">
        <LoaderCircleIcon className="mx-auto size-5 animate-spin text-muted-foreground" />
      </AuthScreen>
    </div>
  )
}
