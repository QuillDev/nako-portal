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
} from "@/components/ai-elements/prompt-input"
import { InputGroupAddon } from "@/components/ui/input-group"
import type { Portal } from "@/hooks/use-portal"
import { burstHearts, saysThanks } from "@/lib/hearts"

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
export function Composer({ portal, draftKey }: { portal: Portal; draftKey: string }) {
  const running = Boolean(portal.current?.running)
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  return (
    <PromptInputProvider initialInput={localStorage.getItem(draftKey) || ""} key={draftKey}>
      <div className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" ref={box}>
        <PromptInputAttachments className="px-1 pt-0 pb-2">
          {file => <PromptInputAttachment data={file} />}
        </PromptInputAttachments>
        <PromptInput
          className="[&>[data-slot=input-group]]:items-end [&>[data-slot=input-group]]:rounded-3xl [&>[data-slot=input-group]]:bg-card"
          maxFileSize={MAX_FILE}
          multiple
          onError={e => portal.setError(e.message)}
          onSubmit={async message => {
            if (!message.text.trim() && !message.files.length) return
            if (saysThanks(message.text)) burstHearts(box.current?.querySelector("form"))
            setSending(true)
            try {
              await portal.send(
                message.text,
                message.files.map(f => ({ url: f.url, filename: f.filename, mediaType: f.mediaType })),
              )
              localStorage.removeItem(draftKey)
            } finally {
              setSending(false)
            }
          }}
        >
          <InputGroupAddon align="inline-start" className="self-end pb-1.5">
            <AttachButton />
          </InputGroupAddon>
          <PromptInputTextarea
            className="min-h-0 px-1 py-3"
            enterKeyHint="send"
            onChange={e => localStorage.setItem(draftKey, e.currentTarget.value)}
            placeholder={running ? "Steer or queue a message" : "Message"}
            rows={1}
          />
          <InputGroupAddon align="inline-end" className="gap-1 self-end pb-1.5">
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
    </PromptInputProvider>
  )
}
