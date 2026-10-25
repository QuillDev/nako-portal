import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { usePromptInputController } from "@/components/ai-elements/prompt-input"
import type { Command } from "@/lib/types"
import { cn } from "@/lib/utils"

// `/` at the start, then a bare name and whitespace or the end: what Hermes treats as a command.
// `/usr/local` (a second slash) is prose.
export const isCommand = (text: string) => /^\/[^\s/]*(?:\s|$)/.test(text.trim())

// Commands whose name starts with what was typed come first, then ones that contain it.
function matching(commands: Command[], typed: string) {
  const needle = typed.slice(1).toLowerCase()
  const name = (c: Command) => c.name.slice(1).toLowerCase()
  return [...commands.filter(c => name(c).startsWith(needle)), ...commands.filter(c => !name(c).startsWith(needle) && name(c).includes(needle))]
}

// The `/` menu above the composer. Returns the list to render and a key handler for the textarea:
// arrows move, Tab or Enter fills the command in, Escape closes it until the text changes.
export function useSlashMenu(commands: Command[]) {
  const { textInput } = usePromptInputController()
  const typed = textInput.value
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const naming = /^\/\S*$/.test(typed) && dismissed !== typed
  const options = naming ? matching(commands, typed) : []

  useEffect(() => setActive(0), [typed])

  const pick = (command: Command) => {
    textInput.setInput(`${command.name} `)
    setDismissed(null)
  }

  const onKeyDownCapture = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!options.length || e.nativeEvent.isComposing) return
    const handled = (run: () => void) => {
      e.preventDefault()
      e.stopPropagation()
      run()
    }
    if (e.key === "ArrowDown") handled(() => setActive(i => (i + 1) % options.length))
    else if (e.key === "ArrowUp") handled(() => setActive(i => (i - 1 + options.length) % options.length))
    else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) handled(() => pick(options[Math.min(active, options.length - 1)]))
    else if (e.key === "Escape") handled(() => setDismissed(typed))
  }

  return { options, active, pick, onKeyDownCapture }
}

export function SlashMenu({ options, active, pick, onPicked }: { options: Command[]; active: number; pick: (c: Command) => void; onPicked: () => void }) {
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  if (!options.length) return null
  return (
    <div className="mb-2 max-h-64 overflow-y-auto rounded-xl border bg-popover p-1 text-sm shadow-md" ref={list} role="listbox">
      {options.map((c, i) => (
        <button
          aria-selected={i === active}
          className={cn("flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left", i === active && "bg-accent")}
          data-index={i}
          key={c.name}
          // Keep focus in the textarea, so typing carries on after a pick.
          onMouseDown={e => e.preventDefault()}
          onClick={() => {
            pick(c)
            onPicked()
          }}
          role="option"
          type="button"
        >
          <span className="shrink-0 font-medium">{c.name}</span>
          <span className="min-w-0 truncate text-muted-foreground text-xs">{c.description}</span>
        </button>
      ))}
    </div>
  )
}
