import { Skullet } from "@/components/ui/skeleton"

export function UsageSkeleton() {
  return (
    <Skullet id="settings-usage" label="Loading usage limits…" loading>
      <div className="space-y-5">
        {["Claude", "ChatGPT / Codex"].map(title => (
          <section key={title} className="space-y-4 border-b pb-5 last:border-0">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold text-lg">
              <span className="size-5 shrink-0 rounded" {...{ "skullet-block": "" }} />
              {title}
            </h2>
            <div className="space-y-3">
              <p className="font-medium text-sm">alex@example.test</p>
              {["5-hour", "Weekly"].map(label => (
                <div key={label} className="grid grid-cols-[3.25rem_minmax(0,1fr)_5rem] items-center gap-x-3 gap-y-1 text-sm">
                  <span>{label}</span>
                  <div className="h-1 rounded-full bg-muted" {...{ "skullet-block": "" }} />
                  <span className="text-right tabular-nums">24% used</span>
                  <div className="col-span-full text-muted-foreground text-xs tabular-nums">
                    <span>Resets Thu, Nov 26, 3:00 PM</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Skullet>
  )
}
