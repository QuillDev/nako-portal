import { ChevronRightIcon, ExternalLinkIcon, MenuIcon, XIcon } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { closeBubble, inBubble, openBubbleInApp } from "@/lib/bubble"
import { useWindowControls, windowAction } from "@/lib/desktop-window"
import { useDrawer } from "./drawer"

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const { show, collapsed, toggle } = useDrawer()
  const windowControls = useWindowControls()
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
      {windowControls && <WindowControls />}
      {inBubble && <BubbleControls />}
    </header>
  )
}

/** The floating panel's own buttons: open this page in the full app, or put the panel away. */
function BubbleControls() {
  return (
    <div className="flex items-center">
      <Button aria-label="Open in app" className="text-muted-foreground" onClick={openBubbleInApp} size="icon" variant="ghost">
        <ExternalLinkIcon />
      </Button>
      <Button aria-label="Close" className="text-muted-foreground" onClick={closeBubble} size="icon" variant="ghost">
        <XIcon />
      </Button>
    </div>
  )
}

/** Minimize, maximize and close for the desktop app, which has no system title bar. */
export function WindowControls() {
  return (
    <div className="ml-1 flex items-center">
      <Button aria-label="Minimize" className="text-muted-foreground" onClick={() => windowAction("minimize")} size="icon" title="Minimize" variant="ghost">
        <Glyph d="M0 5.5h10" />
      </Button>
      <Button aria-label="Maximize" className="text-muted-foreground" onClick={() => windowAction("toggle_maximize")} size="icon" title="Maximize" variant="ghost">
        <Glyph d="M.5.5h9v9h-9z" />
      </Button>
      <Button
        aria-label="Close"
        className="text-muted-foreground hover:bg-[#e81123] hover:text-white dark:hover:bg-[#e81123]"
        onClick={() => windowAction("close")}
        size="icon"
        title="Close"
        variant="ghost"
      >
        <Glyph d="M.5.5l9 9M9.5.5l-9 9" />
      </Button>
    </div>
  )
}

/** Thin 10px caption glyphs, drawn like the system's own so the three match in weight. */
function Glyph({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1" viewBox="0 0 10 10">
      <path d={d} />
    </svg>
  )
}
