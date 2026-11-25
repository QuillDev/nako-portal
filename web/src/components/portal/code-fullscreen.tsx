// Streamdown draws a reply's code block with copy and download buttons. Each block's button row
// gets a small host element with a full screen button portalled into it, the way tables get their
// phone menu; the button opens the same block over the whole window.
import { Maximize2Icon, XIcon } from "lucide-react"
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { createPortal } from "react-dom"
import type { defaultComponents } from "streamdown"
import { loadedMarkdown } from "@/lib/markdown"

type CodeProps = ComponentProps<typeof defaultComponents.code>

const BUTTON = "cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground"

/** Render Streamdown's unchanged code; only fenced blocks get the extra button. */
export function MarkdownCode(props: CodeProps) {
  const Code = loadedMarkdown()!.defaultComponents.code
  return "data-block" in props ? <BlockCode {...props} /> : <Code {...props} />
}

function BlockCode(props: CodeProps) {
  const Code = loadedMarkdown()!.defaultComponents.code
  const body = useRef<HTMLElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  // Streamdown hands the rest of the props to the block's body, so the ref lands inside the block.
  useLayoutEffect(() => {
    const actions = body.current?.closest('[data-streamdown="code-block"]')?.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')
    if (!actions) return
    let next = actions.querySelector<HTMLElement>(":scope > [data-code-fullscreen]")
    if (!next) {
      next = document.createElement("span")
      next.dataset.codeFullscreen = ""
      next.className = "flex"
      actions.append(next)
    }
    setHost(previous => previous === next ? previous : next)
  })
  const code = codeOf(props.children)
  const language = props.className?.match(/language-(\S+)/)?.[1] ?? ""
  return (
    <>
      <Code {...props} ref={body} />
      {host && createPortal(
        <button className={BUTTON} onClick={() => setOpen(true)} title="Full screen" type="button">
          <Maximize2Icon size={14} />
        </button>,
        host,
      )}
      {open && <FullScreenCode code={code} language={language} onClose={() => setOpen(false)} />}
    </>
  )
}

function FullScreenCode({ code, language, onClose }: { code: string; language: string; onClose: () => void }) {
  const markdown = loadedMarkdown()!
  const context = useContext(markdown.StreamdownContext)
  // The inline block stops at a few hundred pixels; here the window is the limit.
  const unbounded = useMemo(() => ({ ...context, codeBlockMaxHeight: Infinity }), [context])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    document.addEventListener("keydown", key)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener("keydown", key)
    }
  }, [onClose])
  return createPortal(
    // CodeBlock forwards className to its body and <pre>, not its outer container, so size the container and body from here.
    <div
      aria-label="Code"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-background p-4 [&>[data-streamdown=code-block]]:my-0 [&>[data-streamdown=code-block]]:min-h-0 [&>[data-streamdown=code-block]]:flex-1 [&_[data-streamdown=code-block-body]]:min-h-0 [&_[data-streamdown=code-block-body]]:flex-1 [&_[data-streamdown=code-block-body]]:overflow-y-auto"
      data-code-fullscreen-view=""
      role="dialog"
    >
      <markdown.StreamdownContext.Provider value={unbounded}>
        <markdown.CodeBlock code={code} language={language}>
          <markdown.CodeBlockDownloadButton code={code} language={language} />
          <markdown.CodeBlockCopyButton />
          <button className={BUTTON} onClick={onClose} title="Exit full screen" type="button">
            <XIcon size={14} />
          </button>
        </markdown.CodeBlock>
      </markdown.StreamdownContext.Provider>
    </div>,
    document.body,
  )
}

/** The fence's text, read the way Streamdown reads it. */
function codeOf(children: React.ReactNode): string {
  if (typeof children === "string") return children
  if (children && typeof children === "object" && "props" in children) {
    const inner = (children.props as { children?: unknown }).children
    if (typeof inner === "string") return inner
  }
  return ""
}
