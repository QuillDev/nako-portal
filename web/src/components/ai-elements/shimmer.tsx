"use client";

import { cn } from "@/lib/utils";
import { type CSSProperties, type ElementType, memo } from "react";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

// Portal: upstream calls motion.create() during render, which restarts the sweep on
// every re-render (several times a second while a reply streams). A CSS keyframe
// does the same sweep and drops the motion dependency.
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => (
  <Component
    className={cn(
      "relative inline-block animate-[shimmer_var(--duration)_linear_infinite] bg-[length:250%_100%,auto] bg-clip-text text-transparent",
      "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
      className
    )}
    style={
      {
        "--spread": `${(children?.length ?? 0) * spread}px`,
        "--duration": `${duration}s`,
        backgroundImage:
          "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
      } as CSSProperties
    }
  >
    {children}
  </Component>
);

export const Shimmer = memo(ShimmerComponent);
