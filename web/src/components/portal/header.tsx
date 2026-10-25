import { MenuIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { useDrawer } from "./drawer"

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { show } = useDrawer()
  return (
    <header className="flex items-center gap-1 border-b px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <Button aria-label="Chats" className="md:hidden" onClick={show} size="icon" variant="ghost">
        <MenuIcon />
      </Button>
      <h2 className="min-w-0 flex-1 truncate px-2 font-medium text-sm">{title}</h2>
      {children}
    </header>
  )
}
