// Chat groups: the picker that files a chat in one (searchable, and it makes a new group from what
// you typed), and the dialog that renames a group. The sidebar draws the groups themselves.
import { FolderMinusIcon, PlusIcon } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { Portal } from "@/hooks/use-portal"
import { api } from "@/lib/api"
import { ChatGroup, type GroupColor } from "@/lib/types"
import { cn } from "@/lib/utils"

// One hue per color name, light enough to read on the dark sidebar and dark enough on the light one.
export const GROUP_HEX: Record<GroupColor, string> = {
  blue: "#60a5fa",
  green: "#4ade80",
  yellow: "#eab308",
  orange: "#fb923c",
  red: "#f87171",
  teal: "#2dd4bf",
  purple: "#a78bfa",
  grey: "#a1a1aa",
}

export function GroupSwatch({ color, className }: { color: GroupColor; className?: string }) {
  return <span className={cn("size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: GROUP_HEX[color] }} />
}

/** "Move to group…": pick a group for a chat, make one from the search text, or take it out of its group. */
export function useGroupPicker(portal: Portal) {
  const [target, setTarget] = useState<{ session: string; group: string | null } | null>(null)
  const [groups, setGroups] = useState<ChatGroup[]>([])
  const [query, setQuery] = useState("")
  const latest = useRef(portal)
  latest.current = portal
  const start = useCallback((session: string) => {
    const row = latest.current.sessions.find(s => s.id === session)
    setTarget({ session, group: row?.group?.id ?? null })
    setQuery("")
    api<unknown>("/api/groups")
      .then(rows => setGroups(ChatGroup.array().parse(rows)))
      .catch(e => latest.current.setError((e as Error).message))
  }, [])
  const pick = async (group: string | null) => {
    if (!target) return
    setTarget(null)
    await latest.current.setGroup(target.session, group)
  }
  const create = async () => {
    const name = query.trim()
    if (!target || !name) return
    setTarget(null)
    try {
      const made = await latest.current.createGroup(name)
      await latest.current.setGroup(target.session, made.id)
    } catch (e) {
      latest.current.setError((e as Error).message)
    }
  }
  const typed = query.trim()
  const exact = groups.some(g => g.name.toLowerCase() === typed.toLowerCase())
  const dialog = (
    <Dialog onOpenChange={open => !open && setTarget(null)} open={target !== null}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-sm" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Move to group</DialogTitle>
          <DialogDescription>Pick a group for this chat, or type a name to make one</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput onValueChange={setQuery} placeholder="find or create a group…" value={query} />
          <CommandList>
            {!typed && <CommandEmpty>no groups yet</CommandEmpty>}
            <CommandGroup>
              {groups.map(g => (
                <CommandItem key={g.id} onSelect={() => pick(g.id)} value={`${g.name} ${g.id}`}>
                  <GroupSwatch color={g.color} />
                  <span className="flex-1 truncate">{g.name}</span>
                  {g.id === target?.group && <span className="text-muted-foreground text-xs">current</span>}
                </CommandItem>
              ))}
              {target?.group && !typed && (
                <CommandItem onSelect={() => pick(null)} value="remove from group">
                  <FolderMinusIcon className="text-muted-foreground" />
                  Remove from group
                </CommandItem>
              )}
            </CommandGroup>
            {/* Its own group: cmdk hides a group whose items all miss the search, forced ones too. */}
            {typed && !exact && (
              <CommandGroup forceMount>
                <CommandItem forceMount onSelect={create} value={`new ${typed}`}>
                  <PlusIcon className="text-muted-foreground" />
                  <span className="truncate">New group "{typed}"</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
  return { start, dialog }
}

/** Rename a group. */
export function useGroupRename(portal: Portal) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null)
  const start = useCallback((group: ChatGroup) => setTarget({ id: group.id, name: group.name }), [])
  const dialog = (
    <Dialog onOpenChange={open => !open && setTarget(null)} open={target !== null}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={e => {
            e.preventDefault()
            if (target && target.name.trim()) portal.updateGroup(target.id, { name: target.name.trim() })
            setTarget(null)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename group</DialogTitle>
          </DialogHeader>
          <Input aria-label="Name" autoFocus onChange={e => setTarget(t => t && { ...t, name: e.target.value })} value={target?.name ?? ""} />
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
  return { start, dialog }
}
