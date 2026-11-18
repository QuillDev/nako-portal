import type { ComponentProps, ReactNode } from "react"
import { useState } from "react"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { Popover } from "radix-ui"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { cn } from "@/lib/utils"

export function DropdownContent({ className, ...props }: ComponentProps<typeof Popover.Content>) {
  return <Popover.Portal><Popover.Content collisionPadding={8} sideOffset={8}
    className={cn("z-50 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg", className)} {...props} /></Popover.Portal>
}

export function DropdownList({ className, ...props }: ComponentProps<typeof CommandList>) {
  return <CommandList className={cn("max-h-[min(46vh,20rem,max(3rem,calc(var(--radix-popover-content-available-height)-3rem)))]", className)} {...props} />
}

type Option<T extends string> = { value: T; label: string; detail?: string; disabled?: boolean }

export function SearchableDropdown<T extends string>({ label, value, options, onPick, className, icon,
  compact = false, side, align = "start", placeholder = "Choose an option" }: {
  label: string; value: T; options: Option<T>[]; onPick: (value: T) => void; className?: string; icon?: ReactNode;
  compact?: boolean; side?: "top" | "bottom"; align?: "start" | "end"; placeholder?: string;
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <Button type="button" aria-label={label} variant={compact ? "ghost" : "outline"} size="sm"
        className={cn("min-w-0 justify-start font-normal", className)}>
        {icon}<span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? placeholder}</span>
        {!compact && <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />}
      </Button>
    </Popover.Trigger>
    <DropdownContent aria-label={label} side={side} align={align}>
      <Command label={label} loop filter={(_key, query, keywords) =>
        keywords?.join(" ").toLowerCase().includes(query.trim().toLowerCase()) ? 1 : 0}>
        <CommandInput aria-label={`Search ${label.toLowerCase()}`} placeholder="Search…" />
        <DropdownList className="p-1">
          <CommandEmpty>No matches.</CommandEmpty>
          {options.map((option, index) => <CommandItem key={option.value} value={String(index)}
            keywords={[option.label, option.detail ?? ""]} disabled={option.disabled} className="min-h-9 max-sm:min-h-11"
            onSelect={() => { onPick(option.value); setOpen(false) }}>
            <span className="min-w-0 flex-1"><span className="block truncate">{option.label}</span>
              {option.detail && <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>}</span>
            {option.value === value && <CheckIcon aria-label="Current selection" />}
          </CommandItem>)}
        </DropdownList>
      </Command>
    </DropdownContent>
  </Popover.Root>
}
