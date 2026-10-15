/**
 * A standalone section in the left panel (worktrees, submodules): header like the ref sections,
 * below it a list with arrow keys, Enter for the main action, Delete to remove and a context menu
 * via right click, Menu key and Shift+F10.
 *
 * For the keyboard the rows belong to the panel's single list: arrow down leads from the last
 * ref row to here, arrow up back; the tab stop stays on the ref row (roving tabindex), and
 * from the section header arrow down also leads into the list.
 *
 * The section lives in the left panel but takes care of its keys and menus itself –
 * the panel only needs to know that everything under `[data-extra-section]` is not its own.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { hasOpenDialog } from "../app/dialogs";
import { describeError } from "../app/errors";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { PanelSection } from "../ui/Git";
import { ContextMenu, type MenuAction, type MenuEntry } from "../ui/Menu";
import { t } from "../i18n";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * A menu entry. `blocked` disables it and shows the reason. The action only runs once the menu is
 * closed – otherwise a prompt that opens immediately would not get focus.
 */
export function menuItem(label: string, IconComponent: Icon | null, onSelect: () => void, extra: Partial<MenuAction> & { blocked?: string | null } = {}): MenuAction {
  const { blocked, ...rest } = extra;
  return {
    label,
    icon: IconComponent ? <IconComponent className="size-icon" aria-hidden /> : undefined,
    onSelect: blocked ? undefined : () => window.requestAnimationFrame(() => window.setTimeout(onSelect, 0)),
    ...rest,
    ...(blocked ? { disabled: true, hint: blocked } : {}),
  };
}

export const MENU_SEPARATOR: MenuEntry = { type: "separator" };

/** What the list passes to a row; `attrs` belongs on the row element. */
export interface SideRowState {
  selected: boolean;
  /** Reachable by Tab – only if the panel has no other row with a tab stop (see SideSection). */
  focusable: boolean;
  attrs: { "data-side-row": string };
}

export interface SideSectionProps<T> {
  /** Identifier of the section (`data-extra-section`). */
  id: string;
  title: string;
  icon?: ReactNode;
  count?: number | string;
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  pinnedActions?: ReactNode;
  /** Name of the list for screen readers. */
  listLabel: string;
  items: T[];
  itemId: (item: T) => string;
  /** Text that typing jumps to (initial letters). */
  itemText: (item: T) => string;
  renderRow: (item: T, state: SideRowState) => ReactNode;
  /** Enter and double click. */
  onActivate?: (item: T) => void;
  /** Delete. */
  onRemove?: (item: T) => void;
  rowMenu: (item: T) => MenuEntry[];
  sectionMenu: MenuEntry[];
  /** Notice above the rows. */
  notice?: ReactNode;
  /** Below the rows (e.g. "Load more"); not shown while a placeholder replaces them. */
  footer?: ReactNode;
  /** Replaces the rows: skeleton, error, empty state. */
  placeholder?: ReactNode;
}

const OVERLAY = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';
/** Everything that lies above the page – focus there does not mean the user has left the section. */
const FLOATING = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-toast]';
const TYPEAHEAD_PAUSE_MS = 700;
const isMenuKey = (event: { key: string; shiftKey: boolean }) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

export function SideSection<T>({
  id,
  title,
  icon,
  count,
  open,
  onToggle,
  actions,
  pinnedActions,
  listLabel,
  items,
  itemId,
  itemText,
  renderRow,
  onActivate,
  onRemove,
  rowMenu,
  sectionMenu,
  notice,
  footer,
  placeholder,
}: SideSectionProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  /** The user is currently working in this section: if the row under focus disappears, a neighbour gets it. */
  const engaged = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });

  const ids = items.map(itemId);
  const indexOf = (rowId: string | null | undefined) => (rowId ? ids.indexOf(rowId) : -1);
  // If the active row disappears, the row at the same position moves up (otherwise the last one).
  const activeIndex = indexOf(activeId);
  const lastIndex = useRef(0);
  if (activeIndex >= 0) lastIndex.current = activeIndex;
  const focusableId = activeIndex >= 0 ? activeId : (ids[Math.min(lastIndex.current, ids.length - 1)] ?? null);
  const showRows = open && !placeholder;

  const rowElement = (rowId: string) => rootRef.current?.querySelector<HTMLElement>(`[data-side-row="${CSS.escape(rowId)}"]`) ?? null;
  const headerButton = () => rootRef.current?.querySelector<HTMLElement>("[data-section-header] button") ?? null;

  const focusRow = (rowId: string) => {
    setActiveId(rowId);
    setSelectedId(rowId);
    pendingFocus.current = rowId;
  };
  useLayoutEffect(() => {
    const rowId = pendingFocus.current;
    if (!rowId) return;
    const element = rowElement(rowId);
    if (!element) return;
    pendingFocus.current = null;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  });

  // Focus moves to another area: the section no longer gives it back.
  // If it comes from outside onto a row (arrow key from the section above), that row becomes the active one.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest(FLOATING)) return;
      if (rootRef.current?.contains(target)) {
        const rowId = target.dataset.sideRow;
        if (rowId) {
          setActiveId(rowId);
          setSelectedId(rowId);
        }
        return;
      }
      engaged.current = false;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  /** The scrolling area of the panel; all sections in it form one list for the arrow keys. */
  const panelScope = (): ParentNode => rootRef.current?.closest("[data-left-scroll]") ?? document;
  /** Row before (-1) or after (+1) `from` across section boundaries – including the panel's ref rows. */
  const neighbourRow = (from: HTMLElement, step: 1 | -1): HTMLElement | null => {
    const rows = Array.from(panelScope().querySelectorAll<HTMLElement>("[data-side-row], [data-row-id]"));
    return rows[rows.indexOf(from) + step] ?? null;
  };

  // The panel has exactly one row reachable by Tab – as a rule a ref row; from there the arrow keys
  // lead here. If the panel currently shows no ref row (everything hidden or filtered
  // out), the first row of these sections takes over the tab stop.
  const [tabStop, setTabStop] = useState(false);
  useLayoutEffect(() => {
    const scope = panelScope();
    const first = scope.querySelector<HTMLElement>("[data-side-row]");
    const next = !scope.querySelector('[data-row-id][tabindex="0"]') && Boolean(first && rootRef.current?.contains(first));
    if (next !== tabStop) setTabStop(next);
  });

  // From the panel's last ref row, arrow down leads into the first row of these sections.
  useEffect(() => {
    const scope = rootRef.current?.closest<HTMLElement>("[data-left-scroll]");
    if (!scope) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowDown" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (!target?.matches("[data-row-id]") || target.closest("[data-virtual]")) return;
      const rows = Array.from(scope.querySelectorAll<HTMLElement>("[data-side-row], [data-row-id]"));
      const next = rows[rows.indexOf(target) + 1];
      // Only the section that owns the next row takes over – and only at the end of the ref rows.
      if (!next?.hasAttribute("data-side-row") || !rootRef.current?.contains(next)) return;
      event.preventDefault();
      engaged.current = true;
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    };
    scope.addEventListener("keydown", onKey);
    return () => scope.removeEventListener("keydown", onKey);
  }, []);

  // After an action (remove, prune) the focused row is gone and focus would fall to <body>.
  // Still in the same step it moves to the neighbouring row – before the shell's focus guard
  // (src/app/commands/focus.ts) puts it on the panel's first row two frames later.
  const idKey = ids.join("\n");
  useLayoutEffect(() => {
    if (!engaged.current || document.querySelector(OVERLAY)) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = (showRows && focusableId ? rowElement(focusableId) : null) ?? headerButton();
    target?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // --- Context menu ----------------------------------------------------------------------------------
  const openContextMenuFor = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: rect.left + Math.min(rect.width / 2, 48), clientY: rect.bottom - 2 }),
    );
  };

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    engaged.current = true;
    const target = event.target as HTMLElement;
    // In an input, the menu with copy and paste belongs there.
    if (target.closest("input, textarea")) {
      event.stopPropagation();
      return;
    }
    const rowId = target.closest<HTMLElement>("[data-side-row]")?.dataset.sideRow;
    if (rowId && ids.includes(rowId)) {
      setSelectedId(rowId);
      setActiveId(rowId);
      setMenuTarget(rowId);
    } else {
      setMenuTarget(null);
    }
  };

  const menuItemFor = menuTarget ? items[indexOf(menuTarget)] : undefined;
  let menuEntries = menuItemFor ? rowMenu(menuItemFor) : sectionMenu;
  if (!menuEntries.length) menuEntries = [{ label: t("graph.sideSection.noActions"), disabled: true }];

  // --- Mouse and keyboard ----------------------------------------------------------------------------
  const rowFromEvent = (event: { target: EventTarget }): T | undefined => {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a")) return undefined;
    return items[indexOf(target.closest<HTMLElement>("[data-side-row]")?.dataset.sideRow)];
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const item = rowFromEvent(event);
    if (!item) return;
    setActiveId(itemId(item));
    setSelectedId(itemId(item));
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const item = rowFromEvent(event);
    if (item) onActivate?.(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    engaged.current = true;
    const target = event.target as HTMLElement;
    if (hasOpenDialog() || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
    if (target.closest("input, textarea")) return;

    if (isMenuKey(event)) {
      const anchor = target.closest<HTMLElement>("[data-side-row]") ?? target.closest<HTMLElement>("[data-section-header]");
      if (!anchor) return;
      event.preventDefault();
      // The surrounding panel should not open the same menu a second time.
      event.stopPropagation();
      // On Windows only releasing the key triggers the WebView's menu – this replaces it.
      window.addEventListener("keyup", (up) => up.preventDefault(), { capture: true, once: true });
      openContextMenuFor(anchor);
      return;
    }

    // From the header, arrow down leads into the list.
    if (event.key === "ArrowDown" && target.closest("[data-section-header]") && target.tagName === "BUTTON" && showRows && focusableId) {
      event.preventDefault();
      focusRow(focusableId);
      return;
    }

    if (!target.matches("[data-side-row]")) return;
    const index = indexOf(target.dataset.sideRow);
    const item = items[index];
    if (index < 0 || item === undefined) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const go = (next: number) => {
      const rowId = ids[next];
      if (rowId) focusRow(rowId);
    };

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        // At the end of its own list it continues in the next section.
        if (index === ids.length - 1) return void neighbourRow(target, 1)?.focus();
        return go(index + 1);
      case "ArrowUp":
        event.preventDefault();
        // At the start: last row of the section above, otherwise its own header.
        if (index === 0) return void (neighbourRow(target, -1) ?? headerButton())?.focus();
        return go(index - 1);
      case "Home":
        event.preventDefault();
        return go(0);
      case "End":
        event.preventDefault();
        return go(ids.length - 1);
      case "Enter":
        if (!plain) return;
        event.preventDefault();
        setSelectedId(itemId(item));
        return onActivate?.(item);
      case " ":
        if (typeahead.current.text && Date.now() - typeahead.current.at < TYPEAHEAD_PAUSE_MS) break;
        event.preventDefault();
        return setSelectedId(itemId(item));
      case "Delete":
        if (!onRemove) return;
        event.preventDefault();
        return onRemove(item);
    }

    // Typing jumps to the next entry that starts like that.
    if (plain && event.key.length === 1) {
      const now = Date.now();
      const buffer = typeahead.current;
      const key = event.key.toLowerCase();
      buffer.text = now - buffer.at > TYPEAHEAD_PAUSE_MS ? key : buffer.text + key;
      buffer.at = now;
      const repeated = [...buffer.text].every((char) => char === buffer.text[0]);
      const needle = repeated ? (buffer.text[0] ?? key) : buffer.text;
      const offset = repeated || buffer.text.length === 1 ? 1 : 0;
      for (let step = 0; step < items.length; step++) {
        const candidate = (index + offset + step) % items.length;
        const other = items[candidate];
        if (other !== undefined && itemText(other).toLowerCase().startsWith(needle)) {
          event.preventDefault();
          return go(candidate);
        }
      }
    }
  };

  return (
    <div
      ref={rootRef}
      data-extra-section={id}
      // This section's menu is already open: the surrounding panel does not open its own as well.
      onContextMenu={(event) => event.stopPropagation()}
      onPointerDownCapture={() => {
        engaged.current = true;
      }}
    >
      <ContextMenu entries={menuEntries}>
        <div onContextMenuCapture={onContextMenuCapture} onClick={onClick} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>
          <PanelSection title={title} icon={icon} count={count} open={open} onOpenChange={onToggle} stickyHeader actions={actions} pinnedActions={pinnedActions}>
            {notice}
            {placeholder ?? (
              <div role="tree" aria-label={listLabel}>
                {items.map((item) => {
                  const rowId = itemId(item);
                  return renderRow(item, { selected: selectedId === rowId, focusable: tabStop && ids[0] === rowId, attrs: { "data-side-row": rowId } });
                })}
              </div>
            )}
            {placeholder ? null : footer}
          </PanelSection>
        </div>
      </ContextMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks for the states of a section
// ---------------------------------------------------------------------------

/** Placeholder rows (two lines) while the section is loading. */
export function SideSkeleton({ rows = 2 }: { rows?: number }) {
  const widths = ["w-28", "w-36", "w-24"];
  return (
    <div aria-hidden data-skeleton>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-1.5 px-2">
          <span className="size-3.5 shrink-0 animate-pulse rounded-sm bg-surface-raised" />
          <span className="flex flex-col gap-1.5">
            <span className={cn("h-2.5 animate-pulse rounded-sm bg-surface-raised", widths[index % widths.length])} />
            <span className="h-2 w-20 animate-pulse rounded-sm bg-surface-raised" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Single-line empty state with at most one action. */
export function SideEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-row items-center gap-2 py-1 pr-1 pl-4.5 text-sm text-text-muted" data-empty>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export function SideLoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const { text, hint } = describeError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-2 py-2 text-sm" data-load-error>
      <p className="flex items-start gap-1.5 font-medium text-text">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
        {title}
      </p>
      <p className="selectable break-words text-text-muted">
        {text}
        {hint ? ` ${hint}` : ""}
      </p>
      <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
        {t("graph.sideSection.retry")}
      </Button>
    </div>
  );
}

/** Highlight filter matches in the text (case-insensitive). */
export function Marked({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={index} className="rounded-sm bg-warning-surface text-text">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
