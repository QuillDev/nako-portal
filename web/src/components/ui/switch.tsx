import { cn } from "@/lib/utils"

// An on/off toggle. `label` names it for screen readers when no visible label is attached.
function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  className,
}: { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 data-[state=on]:bg-primary",
        className,
      )}
      data-slot="switch"
      data-state={checked ? "on" : "off"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-foreground/80 shadow-sm transition-transform data-[state=on]:translate-x-[18px] data-[state=on]:bg-white" data-state={checked ? "on" : "off"} />
    </button>
  )
}

export { Switch }
