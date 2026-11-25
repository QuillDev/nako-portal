import { Skeleton as Skullet, SkeletonBox } from "skullet/react"
import { cn } from "@/lib/utils"

// A lone skullet-shimmering bar sized by Tailwind classes (passing empty strings lets className control size and radius).
function Skeleton({ className, style, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("overflow-hidden rounded-md", className)} data-slot="skeleton" style={style} {...props}>
      <SkeletonBox className="size-full" height="" radius="" width="" />
    </div>
  )
}

export { Skeleton, SkeletonBox, Skullet }
