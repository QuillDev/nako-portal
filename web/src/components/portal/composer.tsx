import { PaperclipIcon, SquareIcon } from "lucide-react"
import { useRef, useState } from "react"
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input"
import { InputGroupAddon } from "@/components/ui/input-group"
import type { Portal } from "@/hooks/use-portal"
import { burstHearts, saysThanks } from "@/lib/hearts"
import { isCommand, SlashMenu, useSlashMenu } from "./slash-menu"

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

// Drafts live in this browser per chat, so switching chats or reloading keeps them.
// `tall` gives the new-chat composer room to write: the text on top, the buttons on a row below.
const TALL = {
  group: "[&>[data-slot=input-group]]:grid [&>[data-slot=input-group]]:grid-cols-[auto_1fr_auto] [&>[data-slot=input-group]]:rounded-[22px] [&>[data-slot=input-group]]:p-1.5",
  text: "col-span-3 row-start-1 min-h-14 px-2.5 pt-3 pb-1",
  // The addons' negative side margins suit the inline pill; in the grid they push the buttons onto the border.
  start: "col-start-1 row-start-2 p-0 has-[>button]:ml-0",
  end: "col-start-3 row-start-2 p-0 has-[>button]:mr-0",
}

// onTyping: whether the box holds text, as the person types and once a message goes out.
type ComposerProps = { portal: Portal; draftKey: string; placeholder?: string; tall?: boolean; onTyping?: (typing: boolean) => void }

export function Composer(props: ComposerProps) {
  return (
    <PromptInputProvider initialInput={localStorage.getItem(props.draftKey) || ""} key={props.draftKey}>
      <ComposerBody {...props} />
    </PromptInputProvider>
  )
}

function ComposerBody({ portal, draftKey, placeholder, tall, onTyping }: ComposerProps) {
  const running = Boolean(portal.current?.running)
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const { textInput } = usePromptInputController()
  const slash = useSlashMenu(portal.current ? portal.commands : [])

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" ref={box}>
      <SlashMenu active={slash.active} onPicked={() => box.current?.querySelector("textarea")?.focus()} options={slash.options} pick={slash.pick} />
      <PromptInputAttachments className="px-1 pt-0 pb-2">
        {file => <PromptInputAttachment data={file} />}
      </PromptInputAttachments>
      <PromptInput
        className={`[&>[data-slot=input-group]]:items-end [&>[data-slot=input-group]]:rounded-3xl [&>[data-slot=input-group]]:bg-card ${tall ? TALL.group : ""}`}
        maxFileSize={MAX_FILE}
        multiple
        onError={e => portal.setError(e.message)}
        onSubmit={async message => {
          if (!message.text.trim() && !message.files.length) return
          if (saysThanks(message.text)) burstHearts(box.current?.querySelector("form"))
          setSending(true)
          try {
            if (portal.current && isCommand(message.text) && !message.files.length) {
              const prefill = await portal.command(message.text)
              localStorage.removeItem(draftKey)
              onTyping?.(Boolean(prefill))
              // The composer clears itself once this returns; put /undo's text back after that.
              if (prefill) setTimeout(() => textInput.setInput(prefill))
              return
            }
            await portal.send(
              message.text,
              message.files.map(f => ({ url: f.url, filename: f.filename, mediaType: f.mediaType })),
            )
            localStorage.removeItem(draftKey)
            onTyping?.(false)
          } finally {
            setSending(false)
          }
        }}
      >
        <InputGroupAddon align="inline-start" className={`self-end pb-1.5 ${tall ? TALL.start : ""}`}>
          <AttachButton />
        </InputGroupAddon>
        <PromptInputTextarea
          className={tall ? TALL.text : "min-h-0 px-1 py-3"}
          enterKeyHint="send"
          onKeyDownCapture={slash.onKeyDownCapture}
          onChange={e => {
            localStorage.setItem(draftKey, e.currentTarget.value)
            onTyping?.(Boolean(e.currentTarget.value.trim()))
          }}
          placeholder={running ? "Steer or queue a message" : placeholder || "Message"}
          rows={1}
        />
        <InputGroupAddon align="inline-end" className={`gap-1 self-end pb-1.5 ${tall ? TALL.end : ""}`}>
          {running && (
            <PromptInputButton
              aria-label="Stop"
              className="rounded-full"
              onClick={() => portal.stop()}
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
