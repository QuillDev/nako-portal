import { Chat } from "@/components/portal/chat"
import { DesktopLink } from "@/components/portal/desktop-link"
import { DrawerLayout } from "@/components/portal/drawer"
import { Gate } from "@/components/portal/gate"
import { Settings } from "@/components/portal/settings"
import { Sidebar } from "@/components/portal/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePortal } from "@/hooks/use-portal"

export function App() {
  const portal = usePortal()
  if (!portal.me) return null
  if (!portal.me.signed_in) return <Gate portal={portal} />
  if (portal.route.view === "desktop") return <DesktopLink query={portal.route.query} />
  return (
    <TooltipProvider>
      <DrawerLayout list={portal.route.view === "list"} sidebar={<Sidebar portal={portal} />}>
        <main className="flex min-w-0 flex-1 flex-col">{portal.route.view === "settings" ? <Settings portal={portal} /> : <Chat portal={portal} />}</main>
      </DrawerLayout>
    </TooltipProvider>
  )
}
