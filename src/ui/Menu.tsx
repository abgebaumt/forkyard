import { useRef, type ReactElement, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { ContextMenu as RadixContext, DropdownMenu as RadixDropdown } from "radix-ui";
import { appliedZoom, collisionPadding } from "../app/zoom";
import { cn } from "./cn";
import { Kbd } from "./Kbd";

export interface MenuAction {
  type?: "item";
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the entry as selected (e.g. the default pull mode). */
  checked?: boolean;
  /**
   * Half-sentence after the label: for disabled entries the reason, otherwise what exactly the entry
   * does (e.g. "Changes stay staged"). Also shown in the tooltip.
   */
  hint?: string;
  /** Submenu. The entry itself then triggers nothing. */
  children?: MenuEntry[];
  /** Full text for the tooltip if the label truncates long names. Otherwise the label applies. */
  tooltip?: string;
  onSelect?: () => void;
}

export type MenuEntry = MenuAction | { type: "separator" } | { type: "label"; label: string };

export const menuSurface =
  "animate-pop z-50 min-w-48 max-w-120 rounded-lg border border-border bg-surface-raised p-1 text-base text-text shadow-pop";

const itemClass = (entry: MenuAction) =>
  cn(
    "flex h-row cursor-default items-center gap-2 rounded-sm px-2 outline-none",
    "data-[highlighted]:bg-accent-surface data-[disabled]:text-text-disabled data-[state=open]:bg-accent-surface",
    entry.danger && "text-danger",
  );

/** Full text for the tooltip: long names are cut off in the menu. */
const itemTitle = (entry: MenuAction) => {
  const text = entry.tooltip ?? entry.label;
  return entry.hint ? `${text} – ${entry.hint}` : text;
};

function ItemBody({ entry }: { entry: MenuAction }) {
  return (
    <>
      <span className="flex size-icon shrink-0 items-center justify-center" aria-hidden>
        {entry.checked ? <Check className="size-icon" /> : entry.icon}
      </span>
      {/* When space gets tight, the hint gives way first: the label says what the entry does – often only at the end ("… delete"). */}
      <span className="min-w-0 flex-auto truncate">{entry.label}</span>
      {entry.hint ? (
        // The gap to the hint sits INSIDE the wrapper: if the hint has to give way entirely, it frees the gap too.
        <span className="max-w-58 min-w-0 shrink-[9999] overflow-hidden">
          <span className="ml-2 block truncate text-right text-sm text-text-muted">{entry.hint}</span>
        </span>
      ) : null}
      {entry.shortcut ? <Kbd className="ml-4">{entry.shortcut}</Kbd> : null}
      {entry.children ? <ChevronRight className="-mr-1 ml-2 size-icon shrink-0 text-text-muted" aria-hidden /> : null}
    </>
  );
}

/** The Radix building blocks that dropdown and context menu name the same way. */
interface MenuParts {
  Item: typeof RadixDropdown.Item;
  Separator: typeof RadixDropdown.Separator;
  Label: typeof RadixDropdown.Label;
  Sub: typeof RadixDropdown.Sub;
  SubTrigger: typeof RadixDropdown.SubTrigger;
  SubContent: typeof RadixDropdown.SubContent;
  Portal: typeof RadixDropdown.Portal;
}

const dropdownParts: MenuParts = RadixDropdown;
const contextParts = RadixContext as unknown as MenuParts;

/** Long menus stay inside the window and scroll (Radix sets the variable per menu type). */
const dropdownFit = "max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto";
const contextFit = "max-h-(--radix-context-menu-content-available-height) overflow-y-auto";

/** Entries of a menu including submenus – for dropdown, context menu and the menu at a spot. */
function renderEntries(parts: MenuParts, entries: MenuEntry[], fit: string): ReactNode {
  return entries.map((entry, index) => {
    if (entry.type === "separator") return <parts.Separator key={index} className="my-1 h-px bg-border" />;
    if (entry.type === "label") {
      return (
        <parts.Label key={index} className="px-2 py-1 text-xs font-medium text-text-muted">
          {entry.label}
        </parts.Label>
      );
    }
    if (entry.children) {
      return (
        <parts.Sub key={index}>
          <parts.SubTrigger disabled={entry.disabled} title={itemTitle(entry)} className={itemClass(entry)}>
            <ItemBody entry={entry} />
          </parts.SubTrigger>
          <parts.Portal>
            <parts.SubContent sideOffset={2} alignOffset={-4} collisionPadding={collisionPadding()} className={cn(menuSurface, fit)}>
              {renderEntries(parts, entry.children, fit)}
            </parts.SubContent>
          </parts.Portal>
        </parts.Sub>
      );
    }
    return (
      <parts.Item
        key={index}
        disabled={entry.disabled}
        onSelect={entry.onSelect}
        title={itemTitle(entry)}
        // The check mark alone would only be visible: "currently selected" is also there for screen readers.
        aria-current={entry.checked ? "true" : undefined}
        className={itemClass(entry)}
      >
        <ItemBody entry={entry} />
      </parts.Item>
    );
  });
}

export interface PopupMenuProps {
  entries: MenuEntry[];
  /** Spot in the window (clientX/clientY) where the menu opens – e.g. the drop spot when dragging. */
  point: { x: number; y: number };
  /** Name of the menu for screen readers. */
  label?: string;
  onClose: () => void;
}

/**
 * Menu at a spot instead of at a trigger: for the drop menu after dragging a branch
 * and for menus opened by a command. Esc closes without triggering anything; focus returns
 * to where it was before.
 */
export function PopupMenu({ entries, point, label, onClose }: PopupMenuProps) {
  // The app zoom is a CSS zoom on the root element; mouse coordinates are unaffected by it.
  const zoom = appliedZoom();
  const previous = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  return (
    <RadixDropdown.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDropdown.Trigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: point.x / zoom, top: point.y / zoom }} />
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          sideOffset={2}
          collisionPadding={collisionPadding()}
          aria-label={label}
          className={cn(menuSurface, dropdownFit)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // If an entry has opened a prompt, focus belongs there.
            if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
            if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus();
          }}
        >
          {renderEntries(dropdownParts, entries, dropdownFit)}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

/** Menu surface without behaviour – for the context menu, the dropdown and the design page. */
export function MenuPreview({ entries }: { entries: MenuEntry[] }) {
  return (
    <div role="menu" className={cn(menuSurface, "w-fit max-w-full animate-none")}>
      {entries.map((entry, index) => {
        if (entry.type === "separator") {
          return <div key={index} role="separator" className="my-1 h-px bg-border" />;
        }
        if (entry.type === "label") {
          return (
            <div key={index} className="px-2 py-1 text-xs font-medium text-text-muted">
              {entry.label}
            </div>
          );
        }
        return (
          <div
            key={index}
            role="menuitem"
            aria-disabled={entry.disabled || undefined}
            data-disabled={entry.disabled ? "" : undefined}
            className={itemClass(entry)}
          >
            <ItemBody entry={entry} />
          </div>
        );
      })}
    </div>
  );
}

interface MenuProps {
  entries: MenuEntry[];
  children: ReactElement;
}

export function DropdownMenu({
  entries,
  children,
  align = "start",
  open,
  onOpenChange,
}: MenuProps & { align?: "start" | "end"; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <RadixDropdown.Root open={open} onOpenChange={onOpenChange}>
      <RadixDropdown.Trigger asChild>{children}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content align={align} sideOffset={4} collisionPadding={collisionPadding()} className={cn(menuSurface, dropdownFit)}>
          {renderEntries(dropdownParts, entries, dropdownFit)}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

/** Right-click menu. Also opens via the Menu key and Shift+F10. */
export function ContextMenu({ entries, children }: MenuProps) {
  return (
    <RadixContext.Root>
      <RadixContext.Trigger
        asChild
        onContextMenu={(event) => {
          // Radix places the menu at the event's clientX/clientY – visible pixels. Positioning,
          // however, happens inside the zoomed root element, i.e. in layout pixels: without conversion
          // the menu would open offset by the zoom factor (at 150 % almost outside the window).
          const zoom = appliedZoom();
          if (zoom === 1) return;
          const point = event as unknown as { clientX: number; clientY: number };
          point.clientX = event.clientX / zoom;
          point.clientY = event.clientY / zoom;
        }}
      >
        {children}
      </RadixContext.Trigger>
      <RadixContext.Portal>
        <RadixContext.Content collisionPadding={collisionPadding()} className={cn(menuSurface, contextFit)}>
          {renderEntries(contextParts, entries, contextFit)}
        </RadixContext.Content>
      </RadixContext.Portal>
    </RadixContext.Root>
  );
}
