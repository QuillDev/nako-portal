import { cn } from "@/lib/utils"

const marks: Record<string, string> = {
  "openai-codex": "openai",
  "claude-subscription-directsdk-experimental": "claude-color",
  "antigravity-oauth": "antigravity-color",
  openrouter: "openrouter",
}

export function ProviderMark({ slug, className }: { slug: string; className?: string }) {
  const mark = Object.hasOwn(marks, slug) ? marks[slug] : null
  return mark ? <img alt="" className={cn("size-5 shrink-0", !mark.endsWith("-color") && "dark:invert", className)} src={`/provider-marks/${mark}.svg`} /> : null
}
