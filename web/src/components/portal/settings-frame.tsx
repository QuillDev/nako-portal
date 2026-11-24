import type { ReactNode } from "react"
import { BellIcon, BoxesIcon, ChartLineIcon, ChevronRightIcon, KeyRoundIcon, type LucideIcon, BlocksIcon, NetworkIcon, PlugIcon, SlidersHorizontalIcon, SparklesIcon, UserIcon } from "lucide-react"
import { navigate } from "@/hooks/use-portal"
import { cn } from "@/lib/utils"
import { PageHeader } from "./header"
import { SettingsLoading } from "./settings-loading"
import { UsageSkeleton } from "./usage-skeleton"

export function SettingsPlaceholder({ page }: { page: string | null }) {
  return page === "usage" ? <UsageSkeleton /> : <SettingsLoading page={page ?? "general"} />
}

type Page = { id: string; label: string; icon: LucideIcon; unavailable?: boolean }
type Bucket = { label: string; pages: Page[] }

// The settings menu: the page list beside the open page on wide screens, its own screen on phones.
function SettingsMenu({ buckets, current }: { buckets: Bucket[]; current: string | null }) {
  // Phones show the menu on its own, so no row there reads as the open page.
  return (
    <nav aria-label="Settings" className="flex flex-col px-2 pb-6 md:w-52 md:shrink-0">
      {buckets.map((bucket, index) => (
        <div className="flex flex-col" key={bucket.label || index}>
          {bucket.label ? <p className={cn("px-2 pt-3 pb-1 text-muted-foreground text-xs", bucket.pages.every(page => page.unavailable) && "invisible")}>{bucket.label}</p> : <div className="h-3" />}
          {bucket.pages.map(page => page.unavailable ? (
            <div key={page.id} aria-hidden="true" className="h-10 md:h-9" />
          ) : (
            <button
              aria-current={page.id === current ? "page" : undefined}
              className="flex select-none items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-muted-foreground text-sm outline-none hover:bg-accent hover:text-foreground md:aria-[current=page]:bg-accent md:aria-[current=page]:text-foreground md:py-2"
              key={page.id}
              onClick={() => navigate(`#/settings/${page.id}`)}
              type="button"
            >
              <page.icon className="size-4" />
              <span className="flex-1 truncate">{page.label}</span>
              <ChevronRightIcon className="size-4 md:hidden" />
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}

type FrameProps = {
  page: string | null; hasEnvironments: boolean; environmentsTitle?: string; error?: string; children: ReactNode
  unavailable?: Partial<Record<"providers" | "usage" | "secrets" | "mcp" | "mesh", boolean>>
}
export function SettingsFrame({ page, hasEnvironments, environmentsTitle, unavailable = {}, error, children }: FrameProps) {
  const buckets: Bucket[] = [
    { label: "App", pages: [{ id: "general", label: "General", icon: SlidersHorizontalIcon }, { id: "notifications", label: "Notifications", icon: BellIcon }] },
    {
      label: "Nako",
      pages: [
        { id: "gateway", label: "Gateway", icon: NetworkIcon },
        { id: "nako", label: "Model & profile", icon: SparklesIcon },
        { id: "usage", label: "Usage", icon: ChartLineIcon, unavailable: unavailable.usage },
        { id: "providers", label: "Providers", icon: PlugIcon, unavailable: unavailable.providers },
        { id: "secrets", label: "Secrets", icon: KeyRoundIcon, unavailable: unavailable.secrets },
        { id: "mcp", label: "MCP servers", icon: BlocksIcon, unavailable: unavailable.mcp },
      ],
    },
    {
      label: "Machines",
      pages: [
        { id: "mesh", label: "Mesh", icon: NetworkIcon, unavailable: unavailable.mesh },
        { id: "environments", label: environmentsTitle || "Environments", icon: BoxesIcon, unavailable: !hasEnvironments },
      ],
    },
    { label: "", pages: [{ id: "account", label: "Account", icon: UserIcon }] },
  ].filter(bucket => bucket.pages.length > 0)
  // Wide screens always show a page beside the menu; phones show the menu until one is picked.
  const shown = page ?? "general"
  const selected = buckets.flatMap(b => b.pages).find(p => p.id === shown)
  const label = selected?.label ?? "Settings"

  return (
    <>
      <PageHeader
        back={page ? () => navigate("#/settings") : undefined}
        title={
          page ? (
            <>
              <span className="md:hidden">{label}</span>
              <span className="hidden md:inline">Settings</span>
            </>
          ) : (
            "Settings"
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("w-full overflow-y-auto md:block md:w-auto", page && "hidden")}>
          <SettingsMenu buckets={buckets} current={shown} />
        </div>
        <section className={cn("min-w-0 flex-1 overflow-y-auto md:block md:border-l", !page && "hidden")}>
          <div className="flex w-full max-w-xl flex-col gap-2 px-4 pb-6 md:px-6">
            <h3 className="hidden pt-1.5 pb-2 font-semibold text-[15px] md:block">{label}</h3>
            {selected?.unavailable ? <p className="text-muted-foreground text-sm">Unavailable on this portal.</p> : children}
            {error && <p className="pt-4 text-destructive text-sm">{error}</p>}
          </div>
        </section>
      </div>
    </>
  )
}
