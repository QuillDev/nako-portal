import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { hasWindowControls } from "@/lib/desktop-window"
import { cn } from "@/lib/utils"
import { WindowControls } from "./header"

// Sign-in style screens: serif title, optional note, a stack of wide buttons.
export function AuthScreen({ title, note, error, children }: { title: string; note?: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center p-6 pb-[12vh] text-center">
      {hasWindowControls && (
        <div className="fixed inset-x-0 top-0 flex justify-end p-2" data-tauri-drag-region="deep">
          <WindowControls />
        </div>
      )}
      <h1 className="font-serif text-[2.75rem] leading-none">{title}</h1>
      {note && <p className="mt-3 max-w-[300px] text-muted-foreground text-sm">{note}</p>}
      <div className="mt-7 flex w-[300px] max-w-full flex-col gap-2">{children}</div>
      {error && <p className="mt-4 text-destructive text-sm">{error}</p>}
    </div>
  )
}

export function AuthButton({ className, variant, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        "h-11 w-full rounded-[10px] text-[15px]",
        !variant && "bg-foreground text-background hover:bg-foreground/90",
        className,
      )}
      variant={variant}
      {...props}
    />
  )
}
