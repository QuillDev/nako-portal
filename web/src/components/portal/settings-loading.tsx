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
    {page === "mesh" ? <><div aria-hidden="true" className="relative mx-auto aspect-square w-full max-w-xl sm:aspect-[4/3]">
      <svg className="absolute size-full stroke-border" preserveAspectRatio="none" viewBox="0 0 100 100">{[[50,18],[20,68],[80,68]].map(([x,y]) => <line key={x} x1="50" y1="50" x2={x} y2={y} vectorEffect="non-scaling-stroke" />)}</svg>
      {[[50,50],[50,18],[20,68],[80,68]].map(([x,y], i) => <div key={i} style={{left:`${x}%`,top:`${y}%`}} className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"><Skeleton className={i ? "size-9 rounded-full" : "size-14 rounded-full"} /><Skeleton className="h-2 w-12" /></div>)}
    </div><div aria-hidden="true" className="flex justify-end pt-2"><Skeleton className="h-8 w-28" /></div></> :
      ["general", "notifications", "nako", "profile", "presets", "signoff", "account", "gateway"].includes(page) ? <div aria-hidden="true" className="flex flex-col gap-2">{Array.from({ length: rows }, (_, i) =>
        <div className="flex h-9 items-center justify-between" key={i}><Skeleton className="h-3 w-24" /><Skeleton className="h-7 w-28" /></div>)}</div> :
    <div aria-hidden="true">{Array.from({ length: rows }, (_, index) => <div key={index} className="flex h-14 items-center gap-3 px-1">
      {page === "providers" && <Skeleton className="size-[18px] rounded-full" />}
      <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-32 max-w-full" /><Skeleton className="h-2.5 w-20" /></div>
      <Skeleton className="size-3" />
    </div>)}</div>}
  </div>
}
