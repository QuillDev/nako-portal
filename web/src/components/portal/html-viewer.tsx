import { DownloadIcon, Maximize2Icon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { DialogClose } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

// Runs in an opaque origin (no portal cookies/storage/DOM access) while letting scripts, styles and links work.
const HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
// Virtual desktop/email width scaled down into the inline preview box so 600px emails aren't clipped.
const VIRTUAL_WIDTH = 640
const ACTION = "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"

export function HtmlThumb({
  item,
  onOpen,
  onBroken,
}: { item: { url: string; name: string; download?: string }; onOpen: () => void; onBroken: () => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const broken = useRef(onBroken)
  broken.current = onBroken
  const [ready, setReady] = useState(false)
  const [box, setBox] = useState({ width: 368, height: 240 })

  useEffect(() => {
    const controller = new AbortController()
    fetch(item.url, { method: "HEAD", credentials: "same-origin", signal: controller.signal })
      .then(res => {
        if (!res.ok) broken.current()
      })
      .catch(() => {})
    return () => controller.abort()
  }, [item.url])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const sync = () => {
      if (el.clientWidth && el.clientHeight) setBox({ width: el.clientWidth, height: el.clientHeight })
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scale = Math.min(1, box.width / VIRTUAL_WIDTH)
  const frameWidth = Math.round(box.width / scale)
  const frameHeight = Math.round(box.height / scale)

  return (
    <div className="flex w-96 max-w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2">
      <div className="flex h-8 items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="ml-1 min-w-0 truncate font-mono">{item.name}</span>
        <div className="flex shrink-0 items-center gap-2 pr-1">
          {item.download && (
            <a aria-label={`Download ${item.name}`} className={ACTION} download={item.name} href={item.download} title="Download">
              <DownloadIcon size={14} />
            </a>
          )}
          <button aria-label={`Full screen ${item.name}`} className={ACTION} onClick={onOpen} title="Full screen" type="button">
            <Maximize2Icon size={14} />
          </button>
        </div>
      </div>
      <div className="relative h-60 w-full overflow-hidden rounded-md border bg-white" ref={wrap}>
        <iframe
          aria-hidden="true"
          className="pointer-events-none block border-0 bg-white"
          loading="lazy"
          onLoad={() => setReady(true)}
          sandbox={HTML_SANDBOX}
          scrolling="no"
          src={item.url}
          style={{
            width: frameWidth,
            height: frameHeight,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            visibility: ready ? "visible" : "hidden",
          }}
          tabIndex={-1}
          title={item.name}
        />
        {!ready && <Skeleton aria-label="Loading preview" className="absolute inset-0 rounded-none" role="status" />}
      </div>
    </div>
  )
}

export function HtmlViewer({ src, name, download }: { src: string; name: string; download?: string }) {
  const [ready, setReady] = useState(false)
  return (
    <div className="flex h-full w-full flex-col bg-background sm:p-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2 bg-sidebar p-2 sm:rounded-xl sm:border sm:border-border">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 text-muted-foreground text-xs">
          <span className="ml-1 min-w-0 truncate font-mono">{name}</span>
          <div className="flex shrink-0 items-center gap-2 pr-1">
            {download && (
              <a aria-label={`Download ${name}`} className={ACTION} download={name} href={download} title="Download">
                <DownloadIcon size={14} />
              </a>
            )}
            <DialogClose aria-label="Exit full screen" className={ACTION} title="Exit full screen">
              <XIcon size={14} />
            </DialogClose>
          </div>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-white">
          {!ready && <Skeleton aria-label="Loading preview" className="absolute inset-0 rounded-none" role="status" />}
          <iframe
            className="block size-full border-0 bg-white"
            onLoad={() => setReady(true)}
            sandbox={HTML_SANDBOX}
            src={src}
            style={{ visibility: ready ? "visible" : "hidden" }}
            title={name}
          />
        </div>
      </div>
    </div>
  )
}
