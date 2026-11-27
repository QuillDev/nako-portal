import { useEffect, useState } from "react"
import { ArrowRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

// A bottom sheet on phones, a centered panel on wider screens.
export const PANEL =
  "gap-3 rounded-[22px] bg-card p-4 sm:max-w-[440px] max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:pb-[max(1.75rem,env(safe-area-inset-bottom))] max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom"

const SHEET = "(max-width: 639.98px)"

// True while PANEL shows as a bottom sheet.
export function useSheet() {
  const [sheet, setSheet] = useState(() => matchMedia(SHEET).matches)
  useEffect(() => {
    const query = matchMedia(SHEET)
    const onChange = () => setSheet(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return sheet
}

// Drag the knob to the end of the track to confirm; letting go early springs it back.
export function SlideToConfirm({ label, disabled, onConfirm }: { label: string; disabled: boolean; onConfirm: () => void }) {
  const [offset, setOffset] = useState(0)
  const [drag, setDrag] = useState<{ start: number; max: number } | null>(null)
  const done = (max: number, at: number) => {
    setDrag(null)
    if (at >= max * 0.9) {
      setOffset(max)
      onConfirm()
    } else setOffset(0)
  }
  return (
    <div className={cn("relative h-12 select-none rounded-full bg-muted touch-none", disabled && "opacity-50")} data-slide-confirm>
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center pl-10 text-muted-foreground text-sm" style={{ opacity: drag ? 1 - offset / drag.max : 1 }}>{label}</span>
      <button
        aria-label={label}
        className={cn("absolute top-1 left-1 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm", !drag && "transition-transform")}
        disabled={disabled}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onConfirm() } }}
        onPointerDown={e => {
          const track = e.currentTarget.parentElement
          if (!track) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag({ start: e.clientX - offset, max: track.clientWidth - e.currentTarget.offsetWidth - 8 })
        }}
        onPointerMove={e => drag && setOffset(Math.min(drag.max, Math.max(0, e.clientX - drag.start)))}
        onPointerUp={() => drag && done(drag.max, offset)}
        onPointerCancel={() => { setDrag(null); setOffset(0) }}
        style={{ transform: `translateX(${offset}px)` }}
        type="button"
      >
        <ArrowRightIcon className="size-5" />
      </button>
    </div>
  )
}

type Ask = { title: string; body?: string; action: string; destructive?: boolean }
let show: ((ask: Ask, answer: (ok: boolean) => void) => void) | null = null

/** Ask before doing something: a second button press on desktop, a slide on phones. Resolves true to go ahead. */
export function confirmAction(ask: Ask): Promise<boolean> {
  return new Promise(resolve => (show ? show(ask, resolve) : resolve(false)))
}

/** Draws the confirmations `confirmAction` asks for; mounted once at the app root. */
export function ConfirmHost() {
  const sheet = useSheet()
  const [open, setOpen] = useState<{ ask: Ask; answer: (ok: boolean) => void } | null>(null)
  useEffect(() => {
    show = (ask, answer) => setOpen(previous => {
      previous?.answer(false)
      return { ask, answer }
    })
    return () => { show = null }
  }, [])
  const finish = (ok: boolean) => {
    open?.answer(ok)
    setOpen(null)
  }
  return (
    <Dialog open={open !== null} onOpenChange={next => !next && finish(false)}>
      {open && (
        <DialogContent className={PANEL} data-confirm showCloseButton={false}>
          <DialogTitle className="font-medium text-base">{open.ask.title}</DialogTitle>
          {open.ask.body ? <DialogDescription className="text-sm">{open.ask.body}</DialogDescription> : <DialogDescription className="sr-only">{open.ask.title}</DialogDescription>}
          {sheet
            ? <SlideToConfirm label={`Slide to ${open.ask.action.toLowerCase()}`} disabled={false} onConfirm={() => finish(true)} />
            : <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => finish(false)}>Cancel</Button>
                <Button size="sm" variant={open.ask.destructive ? "destructive" : "default"} onClick={() => finish(true)}>{open.ask.action}</Button>
              </div>}
        </DialogContent>
      )}
    </Dialog>
  )
}
