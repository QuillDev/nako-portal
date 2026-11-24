import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse motion-reduce:animate-none rounded-md bg-accent", className)} data-slot="skeleton" {...props} />
}

export { Skeleton }
