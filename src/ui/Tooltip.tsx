import { useLayoutEffect, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "radix-ui";
import { Kbd } from "./Kbd";
import { collisionPadding } from "../app/zoom";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </Tooltip.Provider>
  );
}

/** Closers of all currently open tooltips. */
const openTips = new Set<() => void>();

export function hasOpenTooltips(): boolean {
  return openTips.size > 0;
}

/**
 * Closes all open tooltips. The Esc guard (src/app/escapeGuard.ts) calls this synchronously before
 * Radix sees the key: Radix keeps tooltips in the same stack as dialogs and menus and would otherwise
 * let Esc close only the tooltip – anyone tabbed onto a button (the tooltip appears immediately on
 * focus) would have to press Esc twice for every dialog and every view.
 */
export function closeTooltips(): void {
  for (const close of [...openTips]) close();
}

const tooltipEscapes = new WeakSet<Event>();

/**
 * This Esc only closed a tooltip (Radix calls preventDefault in that case). For a view the key
 * therefore does NOT count as handled. Since the Esc guard closes tooltips before Radix, this only
 * happens when the guard is not installed (tests of individual building blocks).
 */
export function closedOnlyTooltip(event: Event): boolean {
  return tooltipEscapes.has(event);
}

export interface TipProps {
  label: ReactNode;
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactElement;
}

export function Tip({ label, shortcut, side = "bottom", children }: TipProps) {
  const [open, setOpen] = useState(false);
  // In the layout effect: the closer is registered before the tooltip becomes visible.
  useLayoutEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    openTips.add(close);
    return () => {
      openTips.delete(close);
    };
  }, [open]);
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      {/*
        The content is only in the tree while the tooltip is open (forceMount turns off Radix waiting
        for an exit animation). There is no exit animation – but if a tooltip closed before its enter
        animation had been reported (tabbing quickly past a button), Radix took it for one and waited
        for its end, which never came: the closed tooltip stayed and, as the topmost layer in the
        stack, swallowed the next Esc (measured in the settings: in 10 of 11 runs the dialog stayed
        open after Esc).
      */}
      {open ? (
        <Tooltip.Portal forceMount>
          <Tooltip.Content
            forceMount
            side={side}
            sideOffset={6}
            collisionPadding={collisionPadding()}
            onEscapeKeyDown={(event) => tooltipEscapes.add(event)}
            className="animate-pop z-50 flex max-w-80 items-center gap-2 rounded-md border border-border bg-surface-raised px-2 py-1 text-sm text-text shadow-pop"
          >
            <span>{label}</span>
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </Tooltip.Content>
        </Tooltip.Portal>
      ) : null}
    </Tooltip.Root>
  );
}
