import { ArrowUpIcon, PaperclipIcon } from "lucide-react"
import { Skeleton, Skullet } from "@/components/ui/skeleton"
import type { Route } from "@/hooks/use-portal"
import { AuthScreen } from "./auth-screen"
import { DrawerLayout } from "./drawer"
import { PageHeader } from "./header"
import { SettingsFrame, SettingsPlaceholder } from "./settings-frame"

const ROW_TITLES = [
  "Review the billing reconciliation check",
  "Update staging auth redirects",
  "Notes from the afternoon sync",
  "Compare usage across accounts",
  "Draft release notes for desktop",
  "Check background job logs",
]

export function LoadingRows({ label, columns = false, detail = false, count = 5 }: { label: string; columns?: boolean; detail?: boolean; count?: number }) {
  return (
    <Skullet label={label} loading>
      <div>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`flex items-center gap-2 px-2 ${detail ? "h-14" : "h-9"}`}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{ROW_TITLES[i % ROW_TITLES.length]}</span>
              {detail && <span className="truncate text-muted-foreground text-xs">Connected · 12 tools available</span>}
            </div>
            {columns && <>
              <span className="w-16 shrink-0 text-xs">Slack</span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums">12m</span>
            </>}
            <span className="size-2 shrink-0 rounded-full" {...{ "skullet-block": "" }} />
          </div>
        ))}
      </div>
    </Skullet>
  )
}

export function ComposerPlaceholder() {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="rounded-[22px] border bg-card p-1.5">
        <Skullet loading>
          <div className="grid grid-cols-[auto_1fr_auto]">
            <div className="col-span-3 row-start-1 min-h-14 px-2.5 pt-3 pb-1 text-sm">Message Nako…</div>
            <div className="col-start-1 row-start-2 flex items-center gap-1 p-0">
              <span className="grid size-8 place-items-center rounded-full" {...{ "skullet-block": "" }}><PaperclipIcon className="size-4" /></span>
              <span className="inline-flex h-8 items-center rounded-md px-2.5 text-sm">claude-sonnet</span>
            </div>
            <div className="col-start-3 row-start-2 flex items-center p-0">
              <span className="grid size-8 place-items-center rounded-full" {...{ "skullet-block": "" }}><ArrowUpIcon className="size-4" /></span>
            </div>
          </div>
        </Skullet>
      </div>
    </div>
  )
}

export function OpeningScreen({ route }: { route: Route }) {
  let seenSession = false
  try { seenSession = sessionStorage.getItem("portal-seen-session") === "1" } catch { /* No hint in private storage. */ }
  const setup = new URLSearchParams(location.hash.slice(1)).has("setup")
  if (setup || route.view === "desktop" || route.view === "list" && !seenSession) {
    const desktop = route.view === "desktop"
    return <AuthScreen title={desktop ? "Sign in the desktop app?" : "Nako"} note={desktop ? "Only if you just asked the Nako app on this computer to sign in." : setup ? "Create a passkey on this device. It is the only way in." : undefined}>
      <span role="status" className="sr-only">Checking sign-in…</span><Skeleton className="h-11 rounded-[10px]" />{desktop && <Skeleton className="h-11 rounded-[10px]" />}
    </AuthScreen>
  }
  return <><span role="status" className="sr-only">Opening portal…</span><div inert><DrawerLayout list={route.view === "list"} sidebar={<aside className="flex w-full flex-col border-r bg-sidebar"><div className="flex h-[88px] flex-col justify-evenly px-4"><Skeleton className="h-4 w-20" /><Skeleton className="h-3 w-24" /></div><LoadingRows label="Loading chats…" /></aside>}>
    <main className="relative flex min-w-0 flex-1 flex-col">{route.view === "settings" ? <SettingsFrame page={route.page} hasEnvironments={false}><SettingsPlaceholder page={route.page} /></SettingsFrame> : <><PageHeader title={route.view === "outside" ? "Elsewhere" : route.view === "chat" ? "Chat" : "New chat"} />
      {route.view === "outside" ? <div className="mx-auto w-full max-w-3xl px-2 md:px-4"><LoadingRows label="Loading sessions…" columns /></div> : route.view === "chat" ? <><div className="mx-auto w-full max-w-3xl flex-1 p-4"><LoadingRows label="Loading conversation…" /></div><ComposerPlaceholder /></> : <div className="flex min-h-0 flex-1 flex-col md:justify-center md:pb-[16vh]"><div className="grid flex-1 place-items-center md:flex-none md:pb-7"><Skeleton className="h-11 w-56" /></div><ComposerPlaceholder /></div>}
    </>}</main>
  </DrawerLayout></div></>
}
