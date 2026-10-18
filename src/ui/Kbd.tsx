import type { ReactNode } from "react";
import { cn } from "./cn";
import { shortcutKeys } from "./shortcut";

/** Keyboard shortcut. "Mod+Shift+S" is split into the key caps of the platform (see `./shortcut`). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  const keys = typeof children === "string" ? shortcutKeys(children) : [children];
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, index) => (
        <kbd
          key={index}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-surface px-1 font-sans text-xs font-medium text-text-muted"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
