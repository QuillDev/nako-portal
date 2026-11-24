import { Skeleton } from "@/components/ui/skeleton"

export function UsageSkeleton() {
  return <div role="status" className="space-y-5">
    <span className="sr-only">Loading usage limits…</span>
    {[0, 1].map(section => <div key={section} aria-hidden="true" className="space-y-4 border-b pb-5 last:border-0 [&_[data-slot=skeleton]]:motion-reduce:animate-none">
      <div className="flex h-7 items-center gap-2">
        <Skeleton className="size-5 rounded-full" /><Skeleton className="h-4 w-28" />
      </div>
      {[0, 1].map(row => <div key={row} className="grid grid-cols-[3.25rem_minmax(0,1fr)_5rem] items-center gap-x-3 gap-y-1">
        <div className="flex h-5 items-center"><Skeleton className="h-3 w-10" /></div>
        <Skeleton className="h-1" /><Skeleton className="h-3 w-14 justify-self-end" />
        <Skeleton className="col-span-full my-0.5 h-3 w-36" />
      </div>)}
    </div>)}
  </div>
}
