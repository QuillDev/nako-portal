import { BoxesIcon } from "lucide-react"
import { Fragment } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { navigate } from "@/hooks/use-portal"
import { STATUS_DOT, useEnvironments } from "@/lib/environments"
import { cn } from "@/lib/utils"

// The chat's own environments (what its command tags with this chat), with their links one tap
// away; hidden when the chat has none.
export function ChatEnvironments({ session }: { session: string }) {
  const { data } = useEnvironments(true)
  const mine = data?.environments.filter(env => env.session === session && env.status !== "stopped") ?? []
  if (!data || mine.length === 0) return null
  const only = mine.length === 1 ? mine[0] : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={only ? only.name : `${mine.length} ${data.title.toLowerCase()}`}
          className="max-w-48 gap-1.5 px-2.5 text-muted-foreground text-xs"
          data-chat-environments
          size="sm"
          title={only ? only.name : data.title}
          variant="ghost"
        >
          <BoxesIcon />
          <span className="hidden truncate sm:inline">{only ? only.name : mine.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(16rem,calc(100vw-1rem))] p-1.5 pt-2">
        {mine.map((env, i) => (
          <Fragment key={env.name}>
            {i > 0 && <DropdownMenuSeparator />}
            <p className="flex items-center gap-2 px-2 pb-1 text-muted-foreground text-xs">
              <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[env.status])} />
              <span className="truncate">{env.name}</span>
              {env.detail && <span className="truncate">· {env.detail}</span>}
            </p>
            {env.links.map(link => (
              <DropdownMenuItem asChild className="text-xs" key={link.url}>
                <a href={link.url} rel="noreferrer" target="_blank">
                  {link.label}
                </a>
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-muted-foreground text-xs" onSelect={() => navigate("#/environments")}>
          All {data.title.toLowerCase()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
