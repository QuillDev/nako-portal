import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { DialogClose } from "@/components/ui/dialog"

type View = { scale: number; x: number; y: number }
type Point = { x: number; y: number }

const MAX_SCALE = 8
const ZOOM_STEP = 2.5
const SWIPE = 70
const FIT: View = { scale: 1, x: 0, y: 0 }

// Keeps the image covering the viewport edge it overflows, and centred on axes where it fits.
function clamp(view: View, image: HTMLElement, box: HTMLElement): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale))
  const maxX = Math.max(0, (image.offsetWidth * scale - box.clientWidth) / 2)
  const maxY = Math.max(0, (image.offsetHeight * scale - box.clientHeight) / 2)
  return { scale, x: Math.min(maxX, Math.max(-maxX, view.x)), y: Math.min(maxY, Math.max(-maxY, view.y)) }
}

// Scales by `factor` while the point under `at` (relative to the viewport centre) stays put.
function zoomAt(view: View, factor: number, at: Point): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * factor))
  const k = scale / view.scale
  return { scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }
}

const arrow =
  "absolute top-1/2 hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white/90 outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white/60 md:grid"

export function ImageViewer({ src, name, onPrev, onNext }: { src: string; name: string; onPrev?: () => void; onNext?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<View>(FIT)
  const [smooth, setSmooth] = useState(false)
  // Horizontal drag past the image's edge: shown as a damped offset, and a long enough one changes image.
  const [pull, setPull] = useState(0)
  const current = useRef(view)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef({ moved: false, onImage: false, pinched: false, pull: 0, downAt: { x: 0, y: 0 }, lastTap: 0, lastTapAt: { x: 0, y: 0 } })
  const nav = useRef({ onPrev, onNext })
  nav.current = { onPrev, onNext }

  const apply = (next: View, animate = false) => {
    if (!image.current || !box.current) return
    const clamped = clamp(next, image.current, box.current)
    current.current = clamped
    setSmooth(animate)
    setView(clamped)
    return clamped
  }

  const centred = (clientX: number, clientY: number): Point => {
    const r = box.current!.getBoundingClientRect()
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
  }

  useEffect(() => {
    const el = box.current
    if (!el) return
    // React's onWheel is passive, so preventDefault (page zoom on ctrl+wheel / trackpad pinch) needs a native listener.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const speed = e.ctrlKey ? 0.01 : 0.002
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      apply(zoomAt(current.current, Math.exp(-delta * speed), centred(e.clientX, e.clientY)))
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") nav.current.onPrev?.()
      else if (e.key === "ArrowRight") nav.current.onNext?.()
      else return
      e.preventDefault()
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKey)
    const onResize = () => apply(current.current)
    window.addEventListener("resize", onResize)
    return () => {
      el.removeEventListener("wheel", onWheel)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onResize)
    }
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return
    box.current!.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (pointers.current.size === 1) {
      g.moved = false
      g.pinched = false
      g.pull = 0
      // Pointer capture retargets later events to the box, so remember what the press started on.
      g.onImage = e.target === image.current
    } else g.pinched = true
    g.downAt = { x: e.clientX, y: e.clientY }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const next = { x: e.clientX, y: e.clientY }
    const g = gesture.current
    if (Math.hypot(next.x - g.downAt.x, next.y - g.downAt.y) > 6) g.moved = true
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId)
    pointers.current.set(e.pointerId, next)
    const v = current.current
    if (others.length === 1) {
      // Pinch: scale by the change in finger distance around the old midpoint, then follow the midpoint.
      const other = others[0][1]
      const before = Math.hypot(prev.x - other.x, prev.y - other.y)
      const after = Math.hypot(next.x - other.x, next.y - other.y)
      const midBefore = centred((prev.x + other.x) / 2, (prev.y + other.y) / 2)
      const midAfter = centred((next.x + other.x) / 2, (next.y + other.y) / 2)
      const zoomed = zoomAt(v, before ? after / before : 1, midBefore)
      g.pull = 0
      setPull(0)
      apply({ ...zoomed, x: zoomed.x + midAfter.x - midBefore.x, y: zoomed.y + midAfter.y - midBefore.y })
    } else if (others.length === 0 && !g.pinched) {
      // Drag pans; whatever the image edge stops becomes pull toward the neighbouring image.
      const dx = next.x - prev.x
      const wanted = g.pull ? v.x : v.x + dx
      const moved = apply({ ...v, x: wanted, y: v.y + next.y - prev.y })
      if (!moved) return
      const blocked = g.pull ? dx : wanted - moved.x
      if (blocked || g.pull) {
        g.pull += blocked
        // No neighbour that way: let it give a little, then stop.
        if ((g.pull > 0 && !nav.current.onPrev) || (g.pull < 0 && !nav.current.onNext)) g.pull = Math.max(-SWIPE / 2, Math.min(SWIPE / 2, g.pull))
        setPull(g.pull)
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const g = gesture.current
    if (pointers.current.size) return
    if (g.pull) {
      const swipe = e.type !== "pointercancel" && Math.abs(g.pull) >= SWIPE ? (g.pull > 0 ? nav.current.onPrev : nav.current.onNext) : undefined
      g.pull = 0
      setSmooth(true)
      setPull(0)
      swipe?.()
      return
    }
    if (g.moved || g.pinched || e.type === "pointercancel") return
    const now = performance.now()
    const tapAt = { x: e.clientX, y: e.clientY }
    const double = now - g.lastTap < 300 && Math.hypot(tapAt.x - g.lastTapAt.x, tapAt.y - g.lastTapAt.y) < 30
    g.lastTap = double ? 0 : now
    g.lastTapAt = tapAt
    if (double) {
      const v = current.current
      apply(v.scale > 1 ? FIT : zoomAt(v, ZOOM_STEP, centred(e.clientX, e.clientY)), true)
    } else if (!g.onImage && current.current.scale === 1) {
      close.current?.click()
    }
  }

  return (
    <div
      className="relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
      data-zoomed={view.scale > 1 || undefined}
      onPointerCancel={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={box}
    >
      <img
        alt={name}
        className={`max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] rounded-md object-contain will-change-transform ${view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"} ${smooth ? "transition-transform duration-200 ease-out" : ""}`}
        draggable={false}
        ref={image}
        src={src}
        style={{ transform: `translate(${view.x + pull * 0.6}px, ${view.y}px) scale(${view.scale})` }}
      />
      {onPrev && (
        <button aria-label="Previous image" className={`${arrow} left-3`} onClick={onPrev} type="button">
          <ChevronLeftIcon className="size-5" />
        </button>
      )}
      {onNext && (
        <button aria-label="Next image" className={`${arrow} right-3`} onClick={onNext} type="button">
          <ChevronRightIcon className="size-5" />
        </button>
      )}
      <DialogClose
        aria-label="Close"
        className="absolute top-3 right-3 grid size-9 place-items-center rounded-full bg-black/60 text-white/90 outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white/60"
        ref={close}
      >
        <XIcon className="size-4" />
      </DialogClose>
    </div>
  )
}
