// On a phone the chat list is a drawer over the open page: swipe right anywhere to pull
// it in, swipe left or tap outside to put it away. From md up the list sits beside the page,
// where its edge drags to resize and it collapses (Ctrl/Cmd+B, or dragging it nearly shut).
import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { navigate } from "@/hooks/use-portal"
import { cn } from "@/lib/utils"

const PHONE = "(max-width: 767.98px)"
// Movement before a touch counts as a swipe or a scroll.
const SLOP = 10
// A flick this fast (px/ms) settles the drawer whichever way it was going.
const FLICK = 0.3

const WIDTH = { min: 220, max: 480, initial: 288, collapseBelow: 160 }

type Drawer = { phone: boolean; collapsed: boolean; toggle: () => void; show: () => void; go: (hash: string) => void }

const DrawerContext = createContext<Drawer>({ phone: false, collapsed: false, toggle: () => {}, show: () => {}, go: navigate })

export const useDrawer = () => useContext(DrawerContext)

function usePhone() {
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches)
  useEffect(() => {
    const query = matchMedia(PHONE)
    const onChange = () => setPhone(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return phone
}

// True when something under the finger can still scroll the way the swipe is going,
// so code blocks and tables keep scrolling sideways instead of moving the drawer.
function scrollsSideways(target: EventTarget | null, root: HTMLElement, dx: number) {
  for (let el = target instanceof Element ? target : null; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) continue
    const overflow = getComputedStyle(el).overflowX
    if (overflow !== "auto" && overflow !== "scroll") continue
    if (dx > 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true
  }
  return false
}

const clamp = (width: number) => Math.min(WIDTH.max, Math.max(WIDTH.min, width))

function useDesktopSidebar() {
  const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem("sidebar:width")) || WIDTH.initial))
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebar:collapsed") === "1")
  const [dragging, setDragging] = useState(false)
  useEffect(() => localStorage.setItem("sidebar:width", String(width)), [width])
  useEffect(() => localStorage.setItem("sidebar:collapsed", collapsed ? "1" : "0"), [collapsed])
  const toggle = useCallback(() => setCollapsed(c => !c), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget
    const left = handle.parentElement!.getBoundingClientRect().left
    handle.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const next = ev.clientX - left
      if (next < WIDTH.collapseBelow) setCollapsed(true)
      else {
        setCollapsed(false)
        setWidth(clamp(next))
      }
    }
    const end = () => {
      setDragging(false)
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }

  return { width, collapsed, dragging, toggle, startResize, reset: () => setWidth(WIDTH.initial) }
}

const pushedDrawer = () => (history.state as { drawer?: boolean } | null)?.drawer === true

/**
 * The list is open on the list route, or after `show()` pushed a history entry for it,
 * so Back (Android's included) closes the drawer before it leaves the chat.
 */
export function DrawerLayout({ list, sidebar, children }: { list: boolean; sidebar: ReactNode; children: ReactNode }) {
  const phone = usePhone()
  const desk = useDesktopSidebar()
  const collapsed = !phone && desk.collapsed
  const [pushed, setPushed] = useState(pushedDrawer)
  const open = list || pushed
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const shadeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sync = () => setPushed(pushedDrawer())
    window.addEventListener("popstate", sync)
    window.addEventListener("hashchange", sync)
    return () => {
      window.removeEventListener("popstate", sync)
      window.removeEventListener("hashchange", sync)
    }
  }, [])

  const show = useCallback(() => {
    if (open) return
    history.pushState({ drawer: true }, "")
    setPushed(true)
  }, [open])

  const hide = useCallback(() => {
    if (pushed) history.back()
    else if (list) navigate("#/new")
  }, [pushed, list])

  // Picking something in the drawer takes the drawer's place in history.
  const go = useCallback(
    (hash: string) => {
      if (!pushed) return navigate(hash)
      if (location.hash === hash) return history.back()
      location.replace(hash)
    },
    [pushed],
  )

  const state = useRef({ open, show, hide })
  state.current = { open, show, hide }

  useEffect(() => {
    const root = rootRef.current
    const panel = panelRef.current
    const shade = shadeRef.current
    if (!phone || !root || !panel || !shade) return
    let touch: { x: number; y: number; dragging: boolean; offset: number; at: number; speed: number } | null = null

    const paint = (offset: number) => {
      const width = panel.offsetWidth
      panel.dataset.dragging = ""
      panel.style.transition = shade.style.transition = "none"
      panel.style.translate = `${offset - width}px 0`
      shade.style.opacity = String(offset / width)
    }
    const release = () => {
      delete panel.dataset.dragging
      panel.style.transition = shade.style.transition = panel.style.translate = shade.style.opacity = ""
    }
    // Animate to where the drawer ends up, then hand back to the class that matches the state.
    const settle = (opening: boolean) => {
      panel.style.transition = shade.style.transition = ""
      panel.style.translate = opening ? "0 0" : "-100% 0"
      shade.style.opacity = opening ? "1" : "0"
      panel.addEventListener("transitionend", release, { once: true })
      setTimeout(release, 400)
      if (opening !== state.current.open) (opening ? state.current.show : state.current.hide)()
    }

    const onStart = (e: TouchEvent) => {
      const target = e.target as Element
      touch = null
      if (e.touches.length !== 1 || target.closest("input, textarea, [contenteditable]")) return
      const { clientX: x, clientY: y } = e.touches[0]
      touch = { x, y, dragging: false, offset: 0, at: e.timeStamp, speed: 0 }
    }
    const onMove = (e: TouchEvent) => {
      if (!touch) return
      const dx = e.touches[0].clientX - touch.x
      const dy = e.touches[0].clientY - touch.y
      const opened = state.current.open
      if (!touch.dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        const toward = opened ? dx < 0 : dx > 0
        if (Math.abs(dx) <= Math.abs(dy) || !toward || scrollsSideways(e.target, root, dx)) {
          touch = null
          return
        }
        touch.dragging = true
      }
      e.preventDefault()
      const width = panel.offsetWidth
      const offset = Math.min(width, Math.max(0, (opened ? width : 0) + dx))
      const elapsed = e.timeStamp - touch.at
      if (elapsed > 0) touch.speed = (offset - touch.offset) / elapsed
      touch.offset = offset
      touch.at = e.timeStamp
      paint(offset)
    }
    const onEnd = (e: TouchEvent) => {
      const done = touch
      touch = null
      if (!done?.dragging) return
      // A finger that stopped before lifting isn't flicking.
      const speed = e.timeStamp - done.at > 100 ? 0 : done.speed
      const half = done.offset > panel.offsetWidth / 2
      settle(speed > FLICK ? true : speed < -FLICK ? false : half)
    }

    root.addEventListener("touchstart", onStart, { passive: true })
    root.addEventListener("touchmove", onMove, { passive: false })
    root.addEventListener("touchend", onEnd)
    root.addEventListener("touchcancel", onEnd)
    return () => {
      root.removeEventListener("touchstart", onStart)
      root.removeEventListener("touchmove", onMove)
      root.removeEventListener("touchend", onEnd)
      root.removeEventListener("touchcancel", onEnd)
      release()
    }
  }, [phone])

  return (
    <DrawerContext.Provider value={{ phone, collapsed, toggle: desk.toggle, show, go }}>
      <div className="relative flex h-dvh overflow-hidden" ref={rootRef}>
        <div
          className={cn(
            "relative flex max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[85vw] max-md:max-w-sm max-md:transition-[translate] max-md:duration-200 max-md:ease-out max-md:motion-reduce:transition-none max-md:data-dragging:shadow-xl",
            "md:shrink-0 md:overflow-hidden md:transition-[width] md:duration-200 md:ease-out md:motion-reduce:transition-none",
            desk.dragging && "md:transition-none",
            open ? "max-md:shadow-xl" : "max-md:-translate-x-full",
          )}
          inert={phone ? !open : collapsed}
          ref={panelRef}
          style={phone ? undefined : { width: collapsed ? 0 : desk.width }}
        >
          <div className="flex w-full md:shrink-0" style={phone ? undefined : { width: desk.width }}>
            {sidebar}
          </div>
          {!phone && (
            <div
              aria-label="Resize chat list"
              aria-orientation="vertical"
              className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-border data-dragging:bg-border"
              data-dragging={desk.dragging ? "" : undefined}
              onDoubleClick={desk.reset}
              onPointerDown={desk.startResize}
              role="separator"
            />
          )}
        </div>
        <div
          aria-hidden
          className={cn("fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 motion-reduce:transition-none md:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")}
          onClick={hide}
          ref={shadeRef}
        />
        {children}
      </div>
    </DrawerContext.Provider>
  )
}
