import { PaperclipIcon, SquareIcon } from "lucide-react"
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { InputGroupAddon } from "@/components/ui/input-group"
import { navigate, type Portal } from "@/hooks/use-portal"
import { burstHearts, saysThanks } from "@/lib/hearts"
import { isCommand, SlashMenu, useSlashMenu } from "./slash-menu"
import { type ModelSelection, NewChatModel, SessionModel } from "./model-picker"

const MAX_FILE = 25 * 1024 * 1024

function AttachButton() {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton
      aria-label="Attach files"
      className="rounded-full"
      onClick={() => attachments.openFileDialog()}
      size="icon-sm"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  )
}

const carriesFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"))

// Files dragged anywhere over the chat attach to this composer (PromptInput's globalDrop adds them);
// this only shows where they'll go while the drag is over the window.
function DropZone({ anchor }: { anchor: React.RefObject<HTMLDivElement | null> }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    // dragenter/dragleave fire for every child crossed, so count them to know when the drag left the window.
    let depth = 0
    const show = (on: boolean) => setTarget(on ? (anchor.current?.closest("main") ?? null) : null)
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth += 1
      show(true)
    }
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) show(false)
    }
    const end = () => {
      depth = 0
      show(false)
    }
    document.addEventListener("dragenter", enter)
    document.addEventListener("dragleave", leave)
    document.addEventListener("drop", end)
    document.addEventListener("dragend", end)
    return () => {
      document.removeEventListener("dragenter", enter)
      document.removeEventListener("dragleave", leave)
      document.removeEventListener("drop", end)
      document.removeEventListener("dragend", end)
    }
  }, [anchor])
  if (!target) return null
  return createPortal(
    <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-background/85 p-3" data-drop-zone>
      <div className="grid size-full place-items-center rounded-2xl border border-dashed border-foreground/20">
        <div className="flex flex-col items-center gap-2 text-center">
          <PaperclipIcon className="size-6 text-muted-foreground" />
          <p className="font-medium text-sm">Drop files to attach</p>
        </div>
      </div>
    </div>,
    target,
  )
}

// Drafts live in this browser per chat, so switching chats or reloading keeps them.
// Room to write everywhere: the text on top, the buttons on a row below.
const TALL = {
  group: "[&>[data-slot=input-group]]:grid [&>[data-slot=input-group]]:grid-cols-[auto_1fr_auto] [&>[data-slot=input-group]]:rounded-[22px] [&>[data-slot=input-group]]:p-1.5",
  text: "col-span-3 row-start-1 min-h-14 px-2.5 pt-3 pb-1",
  // The addons' negative side margins suit the inline pill; in the grid they push the buttons onto the border.
  start: "col-start-1 row-start-2 p-0 has-[>button]:ml-0",
  end: "col-start-3 row-start-2 p-0 has-[>button]:mr-0",
}

// The effort and speed buttons beside the model show only while the bottom row has room for them,
// speed going first. Hidden ones stay laid out off to the side, so their width is still known.
function useTuneFit(box: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const root = box.current
    const group = root?.querySelector<HTMLElement>("[data-slot=input-group]")
    const start = root?.querySelector<HTMLElement>("[data-align=inline-start]")
    const end = root?.querySelector<HTMLElement>("[data-align=inline-end]")
    if (!group || !start || !end) return
    const fit = () => {
      const items = [...start.children].flatMap(c => getComputedStyle(c).display === "contents" ? [...c.children] : [c]) as HTMLElement[]
      const gap = parseFloat(getComputedStyle(start).columnGap) || 0
      const pad = getComputedStyle(group)
      const room = group.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight) - end.offsetWidth - 4
      let used = items.filter(i => !i.hasAttribute("data-tune")).reduce((sum, i, n) => sum + i.offsetWidth + (n ? gap : 0), 0)
      let fits = true
      for (const chip of items.filter(i => i.hasAttribute("data-tune"))) {
        used += gap + chip.offsetWidth
        fits &&= used <= room
        const next = fits ? "in" : "out"
        if (chip.dataset.fit !== next) chip.dataset.fit = next
      }
    }
    fit()
    const sizes = new ResizeObserver(fit)
    for (const el of [group, start, end]) sizes.observe(el)
    // The chips arrive once the chat's model loads, and change width with their value.
    const changes = new MutationObserver(fit)
    changes.observe(start, { childList: true, subtree: true, characterData: true })
    return () => { sizes.disconnect(); changes.disconnect() }
  }, [box])
}

// inChat: a chat is open, so slash commands run in it. Only what the composer uses comes in, and
// every function keeps its identity, so a streaming reply doesn't redraw the composer.
type ComposerProps = Pick<Portal, "send" | "command" | "stop" | "setError" | "commands"> & {
  draftKey: string
  session?: string
  placeholder?: string
  running: boolean
  inChat: boolean
}

export const Composer = memo(function Composer(props: ComposerProps) {
  return (
    <PromptInputProvider initialInput={localStorage.getItem(props.draftKey) || ""} key={props.draftKey}
      onInputChange={value => value ? localStorage.setItem(props.draftKey, value) : localStorage.removeItem(props.draftKey)}>
      <ComposerBody {...props} />
    </PromptInputProvider>
  )
})

const NO_COMMANDS: ComposerProps["commands"] = []

function ComposerBody({ session, placeholder, running, inChat, commands, send, command, stop, setError }: ComposerProps) {
  const [sending, setSending] = useState(false)
  const [model, setModel] = useState<ModelSelection>({})
  const box = useRef<HTMLDivElement>(null)
  const slash = useSlashMenu(inChat ? commands : NO_COMMANDS)
  useTuneFit(box)

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" ref={box}>
      <SlashMenu active={slash.active} onPicked={() => box.current?.querySelector("textarea")?.focus()} options={slash.options} pick={slash.pick} />
      <DropZone anchor={box} />
      <PromptInputAttachments className="px-1 pt-0 pb-2">
        {file => <PromptInputAttachment data={file} />}
      </PromptInputAttachments>
      <PromptInput
        className={`[&>[data-slot=input-group]]:items-end [&>[data-slot=input-group]]:rounded-3xl [&>[data-slot=input-group]]:bg-card ${TALL.group}`}
        globalDrop
        maxFileSize={MAX_FILE}
        multiple
        onError={e => setError(e.message)}
        onSubmit={async message => {
          if (!message.text.trim() && !message.files.length) return
          if (message.text.trim() === "!restart" && !message.files.length) {
            navigate("#/settings/gateway")
            return
          }
          if (saysThanks(message.text)) burstHearts(box.current?.querySelector("form"))
          setSending(true)
          try {
            if (inChat && isCommand(message.text) && !message.files.length) {
              return await command(message.text)
            }
            await send(
              message.text,
              message.files.map(f => ({ url: f.url, filename: f.filename, mediaType: f.mediaType })),
              !inChat && Object.keys(model).length ? model : undefined,
            )
          } finally {
            setSending(false)
          }
        }}
      >
        <InputGroupAddon align="inline-start" className={`relative self-end pb-1.5 ${TALL.start}`}>
          <AttachButton />
          {!inChat && <NewChatModel selection={model} onPick={setModel} />}
          {session && <SessionModel key={session} session={session} running={running} />}
        </InputGroupAddon>
        <PromptInputTextarea
          className={TALL.text}
          enterKeyHint="send"
          onKeyDownCapture={slash.onKeyDownCapture}
          placeholder={running ? "Steer or queue a message" : placeholder || "Message"}
          rows={1}
        />
        <InputGroupAddon align="inline-end" className={`gap-1 self-end pb-1.5 ${TALL.end}`}>
          {running && (
            <PromptInputButton
              aria-label="Stop"
              className="rounded-full"
              onClick={() => stop()}
              size="icon-sm"
              title="Stop"
              variant="outline"
            >
              <SquareIcon className="size-4" />
            </PromptInputButton>
          )}
          <PromptInputSubmit className="rounded-full" disabled={sending} status={sending ? "submitted" : undefined} />
        </InputGroupAddon>
      </PromptInput>
    </div>
  )
}
