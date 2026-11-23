import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { chatFindRanges, nextMatch } from "@/lib/chat-find"

const OPEN = "nako-find-in-chat"
export function FindInChatButton() {
  return <Button aria-label="Find in chat" title="Find in chat (Ctrl/⌘ F)" className="text-muted-foreground" size="icon" variant="ghost" onClick={() => window.dispatchEvent(new Event(OPEN))}><SearchIcon /></Button>
}

export function ChatFind({ root, session }: { root: RefObject<HTMLDivElement | null>; session: string }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const close = useCallback(() => {
    setOpen(false)
    previousFocus.current?.focus()
  }, [])

  useEffect(() => {
    const show = () => {
      if (!input.current) previousFocus.current = document.activeElement as HTMLElement | null
      setOpen(true)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
    }
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault()
        show()
      } else if (event.key === "Escape" && input.current) { event.preventDefault(); close() }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN, show)
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN, show) }
  }, [close])

  useEffect(() => {
    setCurrent(0)
    if (!open || !root.current) { setMatches([]); return }
    const element = root.current
    let frame = 0
    const update = () => setMatches(chatFindRanges(element, query))
    update()
    const observer = new MutationObserver(records => {
      // Find's own count and controls aren't transcript changes.
      if (!records.some(record => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest("[data-find-text], [role=log]"))) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    })
    observer.observe(element, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [open, query, root, session])

  useEffect(() => {
    const index = Math.max(0, Math.min(current, matches.length - 1))
    const active = matches[index]
    // Feature detect both halves of the Custom Highlight API.
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined
    if (matches.length && registry && typeof Highlight !== "undefined") {
      registry.set("chat-find", new Highlight(...matches))
      registry.set("chat-find-current", new Highlight(...(active ? [active] : [])))
    }
    if (active) {
      const element = active.startContainer.parentElement
      // Range geometry scrolls the matching line, even inside a long reply.
      const rect = active.getBoundingClientRect()
      let scrollParent = element
      while (scrollParent && !(scrollParent.scrollHeight > scrollParent.clientHeight && /auto|scroll/.test(getComputedStyle(scrollParent).overflowY))) scrollParent = scrollParent.parentElement
      if (scrollParent && rect.height) {
        const box = scrollParent.getBoundingClientRect()
        scrollParent.scrollTop += rect.top - box.top - scrollParent.clientHeight / 2
      } else element?.scrollIntoView({ block: "center" })
    }
    return () => { registry?.delete("chat-find"); registry?.delete("chat-find-current") }
  }, [matches, current])

  if (!open) return null
  const index = Math.max(0, Math.min(current, matches.length - 1))
  const move = (direction: number) => setCurrent(() => nextMatch(index, direction, matches.length))
  return <div role="search" aria-label="Find in chat" className="flex items-center gap-1 border-b px-4 py-1 text-sm">
    <input ref={input} aria-label="Find in chat" placeholder="Find in chat" className="min-w-0 flex-1 bg-transparent py-1 outline-none" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
    }} />
    <span role="status" className="shrink-0 px-2 text-xs text-muted-foreground">{matches.length ? `${index + 1} / ${matches.length}` : "0"}</span>
    <Button aria-label="Previous match" size="icon" variant="ghost" disabled={!matches.length} onClick={() => move(-1)}><ChevronUpIcon /></Button>
    <Button aria-label="Next match" size="icon" variant="ghost" disabled={!matches.length} onClick={() => move(1)}><ChevronDownIcon /></Button>
    <Button aria-label="Close find" size="icon" variant="ghost" onClick={close}><XIcon /></Button>
  </div>
}
