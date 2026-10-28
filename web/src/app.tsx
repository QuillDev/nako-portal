import { type ComponentType, lazy, Suspense, useEffect } from "react"
import { Chat } from "@/components/portal/chat"
import { DrawerLayout } from "@/components/portal/drawer"
import { Sidebar } from "@/components/portal/sidebar"
import { UpdatingScreen } from "@/components/portal/updating"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePortal } from "@/hooks/use-portal"

/**
 * A screen kept out of the first download. Once its chunk is in, it renders straight away:
 * React.lazy suspends on its first render even then, and React holds a suspended screen's reveal
 * for up to 300 ms, which made Settings take a third of a second to open.
 */
function screen<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null
  const get = () => load().then(component => (loaded = component))
  const Lazy = lazy(() => get().then(component => ({ default: component })))
  function Screen(props: P) {
    const Loaded = loaded
    if (Loaded) return <Loaded {...props} />
    return (
      <Suspense>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return Object.assign(Screen, { preload: () => void get().catch(() => {}) })
}

const Gate = screen(() => import("@/components/portal/gate").then(m => m.Gate))
const DesktopLink = screen(() => import("@/components/portal/desktop-link").then(m => m.DesktopLink))
const Settings = screen(() => import("@/components/portal/settings").then(m => m.Settings))

// Settings is one tap away from every chat; fetch it once things are quiet so it opens at once.
function useWarmSettings(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(Settings.preload, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    }
    const timer = setTimeout(Settings.preload, 2000)
    return () => clearTimeout(timer)
  }, [signedIn])
}

export function App() {
  const portal = usePortal()
  useWarmSettings(Boolean(portal.me?.signed_in))
  if (!portal.me) return null
  if (!portal.me.signed_in) return <Gate portal={portal} />
  if (portal.route.view === "desktop") return <DesktopLink query={portal.route.query} />
  return (
    <TooltipProvider>
      <DrawerLayout list={portal.route.view === "list"} sidebar={<Sidebar portal={portal} />}>
        <main className="relative flex min-w-0 flex-1 flex-col">{portal.route.view === "settings" ? <Settings portal={portal} /> : <Chat portal={portal} />}</main>
      </DrawerLayout>
      <UpdatingScreen />
    </TooltipProvider>
  )
}
