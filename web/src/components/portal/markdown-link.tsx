// Links in replies. A link to another chat (an `@session:` reference, or a pasted address of a chat
// on this portal) opens it here in the app: a plain same-page link with no new window, so the web app, the desktop shell and the
// Android shell all just switch chats. Every other link renders as Streamdown draws it.
import type { ComponentProps } from "react"
import { loadedMarkdown } from "@/lib/markdown"
import { CHAT_HREF, useChatTitle } from "@/lib/session-refs"

type LinkProps = ComponentProps<"a"> & { node?: unknown }

function ChatLink({ session, children }: { session: string; children: React.ReactNode }) {
  const title = useChatTitle(session)
  return (
    <a className="wrap-anywhere text-primary font-medium underline" data-chat-link={session} href={`${CHAT_HREF}${session}`}>
      {title || children}
    </a>
  )
}

/** The chat a link opens, when it's a chat on this portal (`#/c/<id>`, or the full address of one). */
function chatOf(href: string | undefined) {
  if (!href) return null
  const local = href.startsWith(CHAT_HREF) ? href : href.startsWith(`${location.origin}/`) ? new URL(href).hash : ""
  const match = local.match(/^#\/c\/([\w.-]+)$/)
  return match ? match[1] : null
}

export function MarkdownLink(props: LinkProps) {
  const session = chatOf(props.href)
  if (session) return <ChatLink session={session}>{props.children}</ChatLink>
  // Streamdown is loaded by the time it renders a link.
  const Default = loadedMarkdown()!.defaultComponents.a as (props: LinkProps) => React.ReactNode
  return <Default {...props} />
}

/** Streamdown's `components`, one object so memoized messages keep their props. */
export const markdownComponents = { a: MarkdownLink }
