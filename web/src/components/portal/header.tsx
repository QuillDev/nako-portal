import { ChevronRightIcon, MenuIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { hasWindowControls, windowAction } from "@/lib/desktop-window"
import { useDrawer } from "./drawer"

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { show, collapsed, toggle } = useDrawer()
  return (
    // The desktop app drags its window by this strip.
    <header className="flex items-center gap-1 px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]" data-tauri-drag-region="deep">
      <Button aria-label="Chats" className="md:hidden" onClick={show} size="icon" variant="ghost">
        <MenuIcon />
      </Button>
      {collapsed && (
        <Button aria-label="Show chats" onClick={toggle} size="icon" title="Show chats (Ctrl+B)" variant="ghost">
          <ChevronRightIcon />
        </Button>
      )}
      <h2 className="min-w-0 flex-1 truncate px-2 font-medium text-sm leading-9">{title}</h2>
      {children}
      {hasWindowControls && <WindowControls />}
    </header>
  )
}

/** Minimize, maximize and close for the desktop app, which has no system title bar. */
export function WindowControls() {
  return (
    <div className="ml-1 flex items-center">
      <Button aria-label="Minimize" className="text-muted-foreground" onClick={() => windowAction("minimize")} size="icon" title="Minimize" variant="ghost">
        <MinusIcon />
      </Button>
      <Button aria-label="Maximize" className="text-muted-foreground" onClick={() => windowAction("toggle_maximize")} size="icon" title="Maximize" variant="ghost">
        <SquareIcon className="size-3.5" />
      </Button>
      <Button
        aria-label="Close"
        className="text-muted-foreground hover:bg-[#e81123] hover:text-white dark:hover:bg-[#e81123]"
        onClick={() => windowAction("close")}
        size="icon"
        title="Close"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  )
}
