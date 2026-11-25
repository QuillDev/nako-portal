import { ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skullet } from "@/components/ui/skeleton"

export function ProviderListHeader({ onAdd }: { onAdd?: () => void }) {
  return <div className="flex min-h-8 items-center justify-between gap-3"><span className="text-muted-foreground text-xs">Accounts and keys this profile can run on</span>
    <Button className="shrink-0" disabled={!onAdd} onClick={onAdd} size="sm" variant="outline"><PlusIcon />Add a provider</Button>
  </div>
}

const ROW_PAGES = new Set(["general", "notifications", "nako", "profile", "presets", "signoff", "account", "gateway"])
const PAGE_IDS: Record<string, string> = {
  providers: "settings-providers",
  secrets: "settings-secrets",
  mcp: "settings-mcp",
  mesh: "settings-mesh",
  environments: "settings-environments",
  gateway: "settings-gateway",
  profile: "settings-profile",
  presets: "settings-presets",
  signoff: "settings-signoff",
  account: "settings-passkeys",
}

export function SettingsLoading({ page, rows = 3 }: { page: string; rows?: number }) {
  const search = page === "mcp" || page === "secrets"
  const id = PAGE_IDS[page]
  const body = page === "mesh" ? (
    <div className="flex flex-col gap-4">
      <div className="relative mx-auto aspect-square w-full max-w-xl sm:aspect-[4/3]">
        <svg className="absolute size-full stroke-border" preserveAspectRatio="none" viewBox="0 0 100 100" {...{ "skullet-ignore": "" }}>{[[50, 18], [20, 68], [80, 68]].map(([x, y]) => <line key={x} x1="50" y1="50" x2={x} y2={y} vectorEffect="non-scaling-stroke" />)}</svg>
        {[[50, 50, "hub"], [50, 18, "laptop"], [20, 68, "desktop"], [80, 68, "homelab"]].map(([x, y, name], i) => (
          <div key={String(name)} style={{ left: `${x}%`, top: `${y}%` }} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5">
            <span className={i ? "size-12 rounded-full border-2 bg-card" : "size-14 rounded-full border-2 bg-card"} {...{ "skullet-block": "" }} />
            <span className="font-medium text-sm">{name}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-end"><Button size="sm" variant="outline"><PlusIcon />Add machine</Button></div>
    </div>
  ) : ROW_PAGES.has(page) ? (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div className="flex min-h-9 items-center justify-between gap-4 text-sm" key={i}>
          <span>Setting option</span>
          <Button size="sm" variant="outline">Current value</Button>
        </div>
      ))}
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      {search && (
        <div className="flex items-center gap-2 pb-1">
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-card px-3.5" {...{ "skullet-block": "" }}>
            <SearchIcon className="size-4 shrink-0" />
            <span className="text-sm">Search</span>
          </div>
          <Button className="size-10 rounded-full" size="icon"><PlusIcon className="size-[18px]" /></Button>
        </div>
      )}
      <div className="flex flex-col">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-1 py-2.5">
            {page === "providers" && <span className="size-[18px] shrink-0 rounded-full" {...{ "skullet-block": "" }} />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">Provider or server name</span>
              <span className="truncate text-muted-foreground text-xs">connected</span>
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </div>
        ))}
      </div>
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      {page === "providers" && <ProviderListHeader />}
      <Skullet id={id} label="Loading settings…" loading>{body}</Skullet>
    </div>
  )
}
