import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export function ProviderListHeader({ onAdd }: { onAdd?: () => void }) {
  return <div className="flex min-h-8 items-center justify-between gap-3"><span className="text-muted-foreground text-xs">Accounts and keys this profile can run on</span>
    <Button className="shrink-0" disabled={!onAdd} onClick={onAdd} size="sm" variant="outline"><PlusIcon />Add a provider</Button>
  </div>
}

export function SettingsLoading({ page, rows = 3 }: { page: string; rows?: number }) {
  const search = page === "mcp" || page === "secrets"
  return <div role="status" className="flex flex-col gap-2 [&_[data-slot=skeleton]]:motion-reduce:animate-none">
    <span className="sr-only">Loading settings…</span>
    {search && <div aria-hidden="true" className="flex gap-2 pb-1"><Skeleton className="h-10 flex-1 rounded-full" /><Skeleton className="size-10 rounded-full" /></div>}
    {page === "providers" && <ProviderListHeader />}
    {page === "mesh" ? <div aria-hidden="true" className="grid aspect-square max-w-xl place-items-center sm:aspect-[4/3]"><Skeleton className="size-12 rounded-full" /></div> :
      ["general", "notifications", "nako", "profile", "presets", "signoff", "account", "gateway"].includes(page) ? <div aria-hidden="true" className="flex flex-col gap-2">{Array.from({ length: rows }, (_, i) =>
        <div className="flex h-9 items-center justify-between" key={i}><Skeleton className="h-3 w-24" /><Skeleton className="h-7 w-28" /></div>)}</div> :
    <div aria-hidden="true">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-14 items-center gap-3 px-1">
      {page === "providers" && <Skeleton className="size-[18px] rounded-full" />}
      <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-32 max-w-full" /><Skeleton className="h-2.5 w-20" /></div>
      <Skeleton className="size-3" />
    </div>)}</div>}
  </div>
}
