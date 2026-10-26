// Rename, pin and archive for one chat: the open chat's ⋯ menu and the list's
// right-click / long-press menu offer the same actions.
import { ArchiveIcon, type LucideIcon, PencilIcon, PinIcon, PinOffIcon } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"

export type SessionAction = { label: string; icon: LucideIcon; run: () => void }

// What the menus call. Every function keeps its identity, so menus can skip rendering again.
export type ChatActions = Pick<Portal, "pin" | "archive"> & { rename: (session: string) => void }

export function sessionActions({ pin, archive, rename }: ChatActions, session: string, pinned: boolean): SessionAction[] {
  return [
    { label: "Rename", icon: PencilIcon, run: () => rename(session) },
    { label: pinned ? "Unpin" : "Pin", icon: pinned ? PinOffIcon : PinIcon, run: () => pin(session, !pinned) },
    { label: "Archive", icon: ArchiveIcon, run: () => archive(session) },
  ]
}

/** The chat being renamed, if any, and the dialog that renames it. */
export function useRenameDialog(portal: Portal) {
  const [target, setTarget] = useState<{ session: string; title: string } | null>(null)
  const latest = useRef(portal)
  latest.current = portal
  const start = useCallback((session: string) => {
    const { current, sessions } = latest.current
    const title = current?.session === session ? current.title : sessions.find(s => s.id === session)?.title
    setTarget({ session, title: title || "" })
  }, [])
  const dialog = (
    <Dialog onOpenChange={open => !open && setTarget(null)} open={target !== null}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault()
            if (target && target.title.trim()) portal.rename(target.session, target.title.trim())
            setTarget(null)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <Input aria-label="Title" autoFocus onChange={e => setTarget(t => t && { ...t, title: e.target.value })} value={target?.title ?? ""} />
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
  return { start, dialog }
}
