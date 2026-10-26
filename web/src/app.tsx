import { lazy, Suspense } from "react"
import { Chat } from "@/components/portal/chat"
import { DrawerLayout } from "@/components/portal/drawer"
import { Sidebar } from "@/components/portal/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePortal } from "@/hooks/use-portal"

// Screens most loads never show stay out of the first download.
const Gate = lazy(() => import("@/components/portal/gate").then(m => ({ default: m.Gate })))
const DesktopLink = lazy(() => import("@/components/portal/desktop-link").then(m => ({ default: m.DesktopLink })))
const Settings = lazy(() => import("@/components/portal/settings").then(m => ({ default: m.Settings })))

export function App() {
  const portal = usePortal()
  if (!portal.me) return null
  if (!portal.me.signed_in)
    return (
      <Suspense>
        <Gate portal={portal} />
      </Suspense>
    )
  if (portal.route.view === "desktop")
    return (
      <Suspense>
        <DesktopLink query={portal.route.query} />
      </Suspense>
    )
  return (
    <TooltipProvider>
      <DrawerLayout list={portal.route.view === "list"} sidebar={<Sidebar portal={portal} />}>
        <main className="flex min-w-0 flex-1 flex-col">
          {portal.route.view === "settings" ? (
            <Suspense>
              <Settings portal={portal} />
            </Suspense>
          ) : (
            <Chat portal={portal} />
          )}
        </main>
      </DrawerLayout>
    </TooltipProvider>
  )
}
