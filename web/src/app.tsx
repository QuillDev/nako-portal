import { Chat } from "@/components/portal/chat"
import { Gate } from "@/components/portal/gate"
import { Settings } from "@/components/portal/settings"
import { Sidebar } from "@/components/portal/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePortal } from "@/hooks/use-portal"
import { cn } from "@/lib/utils"

export function App() {
  const portal = usePortal()
  if (!portal.me) return null
  if (!portal.me.signed_in) return <Gate portal={portal} />
  const away = portal.route.view !== "list"
  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden">
        {/* On a phone the list and the open page take turns; side by side from md up. */}
        <Sidebar portal={portal} className={cn(away && "max-md:hidden")} />
        <main className={cn("flex min-w-0 flex-1 flex-col", !away && "max-md:hidden")}>
          {portal.route.view === "settings" ? <Settings portal={portal} /> : <Chat portal={portal} />}
        </main>
      </div>
    </TooltipProvider>
  )
}
