import { useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ArrowDownToLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appVersion, canCheck, checkForUpdate, installDesktopUpdate, useDesktopUpdate } from "@/lib/desktop-update";
import type { Backends, HermesBuild } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Green while the portal and nako are both reachable, amber while this page reconnects to the portal, red while nako is offline. */
export function ConnectionDot({
  connected,
  linked,
}: {
  connected: boolean;
  linked: boolean;
}) {
  const [color, label] = !connected
    ? ["bg-destructive", "nako is offline"]
    : !linked
      ? ["bg-amber-500 animate-pulse", "reconnecting"]
      : ["bg-emerald-500", "connected"];
  return (
    <span
      aria-label={label}
      className={cn("ml-2 size-2 shrink-0 rounded-full", color)}
      role="status"
      title={label}
    />
  );
}

const CHECK_LABEL = {
  checking: "checking…",
  latest: "up to date",
  error: "couldn't check",
} as const;

export function HermesVersion({ version }: { version: HermesBuild }) {
  const [open, setOpen] = useState(false);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enter = () => {
    clearTimeout(leave.current);
    setOpen(true);
  };
  const exit = () => {
    leave.current = setTimeout(() => setOpen(false), 180);
  };
  return (
    <>
      {appVersion && <span aria-hidden="true" className="text-muted-foreground text-xs">·</span>}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={`Hermes ${version.version} build details`}
          className="ml-1 inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs tabular-nums hover:bg-accent focus-visible:bg-accent"
          onPointerEnter={(event) => { if (event.pointerType === "mouse") enter(); }}
          onPointerLeave={(event) => { if (event.pointerType === "mouse") exit(); }}
          onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) enter(); }}
          onBlur={(event) => {
            if (!event.relatedTarget || !document.getElementById(event.currentTarget.getAttribute("aria-controls") ?? "")?.contains(event.relatedTarget)) exit();
          }}
          onClick={(event) => { if (event.detail === 0 || (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === "mouse")) { event.preventDefault(); enter(); } }}
        >
          {/* Nous Research mark, from Hermes Agent's assets/nous-girl-black.svg. */}
          <img alt="" className="size-4 opacity-65 dark:invert" src="/nous-mark.png" />
          {version.version}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label="Hermes Agent build"
            className="z-50 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
            side="top"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerEnter={(event) => { if (event.pointerType === "mouse") enter(); }}
            onPointerLeave={(event) => { if (event.pointerType === "mouse") exit(); }}
          >
            <div className="mb-0.5 font-medium">Hermes Agent</div>
            <div className="break-all text-muted-foreground">{version.build}</div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

/** The app's version; in an app that updates itself, clicking it checks, and a found update gets its button beside it. */
export function AppVersion() {
  const update = useDesktopUpdate();
  if (!appVersion) return <span />;
  const state = update?.state;
  const label =
    (state === "checking" || state === "latest" || state === "error"
      ? CHECK_LABEL[state]
      : null) ?? `v${appVersion}`;
  const ready =
    (state === "ready" || state === "installing") && update?.version;
  return (
    <div className="flex min-w-0 items-center">
      {canCheck() ? (
        <button
          className="rounded-md px-2 py-1 text-muted-foreground text-xs tabular-nums hover:bg-accent hover:text-foreground disabled:pointer-events-none"
          disabled={state === "checking" || state === "installing"}
          onClick={checkForUpdate}
          title={update?.error ?? "Check for updates"}
          type="button"
        >
          {label}
        </button>
      ) : (
        <span className="px-2 text-muted-foreground text-xs tabular-nums">
          {label}
        </span>
      )}
      {ready && (
        <Button
          aria-label={`Update to ${update.version}`}
          className="text-primary hover:text-primary"
          onClick={installDesktopUpdate}
          size="icon"
          title={
            update.error
              ? `Update to ${update.version} (last try: ${update.error})`
              : `Update to ${update.version}`
          }
          variant="ghost"
        >
          <ArrowDownToLineIcon />
        </Button>
      )}
    </div>
  );
}

const BACKEND_NAMES: Record<string, string> = { python: "Python", bun: "Bun" };

/** Python / Bun in one segmented pill; a click on a connected one switches the portal to it. */
export function BackendSwitch({ state, onPick }: { state: Backends; onPick: (id: string) => void }) {
  return (
    <div aria-label="Backend" className="inline-flex items-center rounded-md border border-border/60 bg-muted/50 p-0.5" role="group">
      {state.backends.map((backend) => {
        const name = BACKEND_NAMES[backend.id] ?? backend.id;
        const active = state.active === backend.id;
        return (
          <button
            aria-pressed={active}
            className="inline-flex h-6 items-center gap-1.5 rounded px-2 font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:bg-accent disabled:opacity-50 disabled:hover:text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs"
            disabled={!backend.connected}
            key={backend.id}
            onClick={() => !active && onPick(backend.id)}
            title={backend.connected ? (backend.version ? `${name} ${backend.version}` : name) : `${name} isn't connected`}
            type="button"
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", backend.connected ? "bg-emerald-500" : "bg-muted-foreground/40")} />
            {name}
          </button>
        );
      })}
    </div>
  );
}
