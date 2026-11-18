import { SmileIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Popover } from "radix-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import emojiData from "emoji-picker-element-data/en/emojibase/data.json?url"

const segmenter = new Intl.Segmenter()
const firstEmoji = (text: string) => {
  const first = segmenter.segment(text.trim())[Symbol.iterator]().next().value?.segment ?? ""
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(first) ? first : ""
}

export function PresetEmoji({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false)
  const [composition, setComposition] = useState<string | null>(null)
  const content = useRef<HTMLDivElement>(null)
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (!next) setComposition(null) }}>
    <Popover.Trigger asChild>
      <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={value ? `Change emoji: ${value}` : "Choose emoji"}>
        {value ? <span aria-hidden="true" className="grid size-5 place-items-center overflow-hidden text-base leading-none">{value}</span> : <SmileIcon />}
      </Button>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} tabIndex={-1} aria-label="Choose emoji" sideOffset={6} align="start" collisionPadding={8}
      onOpenAutoFocus={e => { e.preventDefault(); content.current?.focus() }}
      className="z-[60] w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-popover shadow-lg outline-none">
      {open && <EmojiGrid onPick={icon => { onPick(icon); setOpen(false) }} />}
      <div className="flex gap-2 border-t p-2">
        <Input aria-label="Type or paste an emoji" value={composition ?? value} maxLength={32} placeholder="Type or paste an emoji" inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false}
          onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); setOpen(false) } }}
          onCompositionStart={e => setComposition(e.currentTarget.value)}
          onCompositionEnd={e => { setComposition(null); onPick(firstEmoji(e.currentTarget.value)) }}
          onChange={e => composition === null ? onPick(firstEmoji(e.target.value)) : setComposition(e.target.value)} />
        {value && <Button type="button" variant="ghost" className="shrink-0" onClick={() => { onPick(""); setOpen(false) }}>Clear</Button>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}

function EmojiGrid({ onPick }: { onPick: (icon: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const pick = useRef(onPick)
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading")
  useEffect(() => { pick.current = onPick }, [onPick])
  useEffect(() => {
    const mount = host.current
    if (!mount) return
    let active = true
    void import("emoji-picker-element").then(({ Picker }) => {
      if (!active) return
      const picker = new Picker({ dataSource: emojiData })
      picker.classList.add(document.documentElement.classList.contains("dark") ? "dark" : "light")
      Object.assign(picker.style, { width: "100%", height: "clamp(8rem, calc(var(--radix-popover-content-available-height) - 3.5rem), 22rem)" })
      for (const [name, value] of Object.entries({
        background: "var(--popover)", "border-size": "0", "input-border-color": "var(--input)",
        "button-hover-background": "var(--accent)", "button-active-background": "var(--accent)",
        "indicator-color": "var(--primary)",
        "category-emoji-size": "1.125rem", "category-emoji-padding": "0.375rem",
      })) picker.style.setProperty(`--${name}`, value)
      picker.addEventListener("emoji-click", ({ detail }) => { if (detail.unicode) pick.current(detail.unicode) })
      mount.replaceChildren(picker)
      // The picker lives in a shadow root, outside the portal's focus styles.
      const focus = document.createElement("style")
      focus.textContent = `@media (forced-colors: none) {
        :host :focus-visible { outline: none; }
        :host :focus-visible:not(input) { background-image: linear-gradient(var(--focus-fill), var(--focus-fill)); }
      }`
      picker.shadowRoot?.append(focus)
      setStatus("ready")
    }).catch(() => { if (active) setStatus("failed") })
    return () => { active = false; mount.replaceChildren() }
  }, [])
  return <>
    <div ref={host} />
    {status === "failed" && <p role="alert" className="p-3 text-sm">Couldn’t open the picker. You can still type or paste an emoji.</p>}
    {status === "loading" && <p role="status" className="p-3 text-sm text-muted-foreground">Loading emoji…</p>}
  </>
}
