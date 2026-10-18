import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { UserRound, Waypoints } from "lucide-react";
import type { GraphColumnId } from "../../core";
import { IconButton } from "../../ui/Button";
import { formatShortcut } from "../../ui/shortcut";
import type { MenuEntry } from "../../ui/Menu";
import { cn } from "../../ui/cn";
import {
  AUTHOR_NAME_FROM,
  COLUMN_LABELS,
  COLUMN_LIMITS,
  DEFAULT_COLUMNS,
  isOptional,
  isResizable,
  moveColumn,
  placeColumn,
  sameColumns,
  setColumnVisible,
  setColumnWidth,
  type ColumnLayout,
  type ColumnState,
  type OptionalColumnId,
  type ResizableColumnId,
} from "./columns";
import { rootZoom } from "./geometry";
import { t } from "../../i18n";

export interface GraphHeaderProps {
  /** Desired state (stored or currently being edited). */
  columns: ColumnState[];
  /** What is actually shown at the current width. */
  layout: ColumnLayout;
  /** Width of the list's scrollbar, so that header and rows line up. */
  gutter: number;
  /** `persist: false` while dragging (display only), `true` to save. */
  onChange: (next: ColumnState[], options: { persist: boolean }) => void;
  /** Opens the list's menu at a spot (unzoomed window coordinates). */
  onMenu: (request: { entries: MenuEntry[]; x: number; y: number; label: string; restore: () => void }) => void;
  /** Switch "only current branch, upstream and target" in the header of the refs column; if omitted, there is none. */
  smart?: SmartToggle | null;
}

export interface SmartToggle {
  on: boolean;
  /** Why the switch does not work right now (no branch checked out) – or null. */
  blocked: string | null;
  /** What it shows or would show, e.g. "main, origin/main and develop". */
  detail: string | null;
  onToggle: () => void;
}

export const SMART_LABEL = t("graph.header.smart");

const STEP = 8;
/** From this distance on, a pressed column header counts as dragged. */
const DRAG_THRESHOLD = 6;

/**
 * Header row of the graph. One tab stop for all columns (arrow keys switch), plus:
 *   Shift+←/→  change width           Double click on the handle  reset width
 *   Ctrl+←/→   move optional column (or drag the header)
 *   Enter, Space, Menu key, Shift+F10, right click  menu: show/hide, reset
 */
export function GraphHeader({ columns, layout, gutter, onChange, onMenu, smart = null }: GraphHeaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<GraphColumnId>("refs");
  const [moving, setMoving] = useState<OptionalColumnId | null>(null);
  const [resizing, setResizing] = useState<ResizableColumnId | null>(null);
  const latest = useRef(columns);
  latest.current = columns;
  const resize = useRef<{ id: ResizableColumnId; x: number; width: number; sign: 1 | -1 } | null>(null);
  const drag = useRef<{ id: OptionalColumnId; x: number; active: boolean; before: ColumnState[] } | null>(null);

  const tabStop = layout.order.includes(focusId) ? focusId : "refs";
  const cell = (id: GraphColumnId) => rootRef.current?.querySelector<HTMLElement>(`[data-column="${id}"]`) ?? null;
  const focusCell = (id: GraphColumnId) => {
    setFocusId(id);
    requestAnimationFrame(() => cell(id)?.focus());
  };
  const visibleOptional = layout.order.filter(isOptional);
  const state = (id: GraphColumnId) => columns.find((column) => column.id === id);

  // --- Menu -------------------------------------------------------------------------------------
  const menuFor = (id: GraphColumnId): MenuEntry[] => {
    const entries: MenuEntry[] = [{ type: "label", label: t("graph.header.showColumns") }];
    for (const optional of columns.filter((column) => isOptional(column.id))) {
      const optionalId = optional.id as OptionalColumnId;
      entries.push({
        label: layout.squeezed.includes(optionalId) ? t("graph.header.noRoom", { column: COLUMN_LABELS[optionalId] }) : COLUMN_LABELS[optionalId],
        checked: optional.visible,
        onSelect: () => onChange(setColumnVisible(latest.current, optionalId, !optional.visible), { persist: true }),
      });
    }
    entries.push({ type: "separator" }, { type: "label", label: t("graph.header.columnTitle", { column: COLUMN_LABELS[id] }) });
    if (isOptional(id)) {
      const at = visibleOptional.indexOf(id);
      entries.push(
        { label: t("graph.header.moveLeft"), shortcut: "Mod+←", disabled: at <= 0, onSelect: () => onChange(moveColumn(latest.current, visibleOptional, id, -1), { persist: true }) },
        { label: t("graph.header.moveRight"), shortcut: "Mod+→", disabled: at < 0 || at >= visibleOptional.length - 1, onSelect: () => onChange(moveColumn(latest.current, visibleOptional, id, 1), { persist: true }) },
      );
    }
    if (isResizable(id)) {
      entries.push({
        label: id === "graph" ? t("graph.header.fitLanes") : t("graph.header.resetWidth"),
        disabled: state(id)?.width === null,
        onSelect: () => onChange(setColumnWidth(latest.current, id, null), { persist: true }),
      });
    } else {
      entries.push({ label: t("graph.header.fillsSpace"), disabled: true });
    }
    entries.push(
      { type: "separator" },
      { label: t("graph.header.resetAll"), disabled: sameColumns(columns, DEFAULT_COLUMNS), onSelect: () => onChange(DEFAULT_COLUMNS, { persist: true }) },
    );
    return entries;
  };

  const openMenu = (id: GraphColumnId, x: number, y: number) =>
    onMenu({ entries: menuFor(id), x, y, label: t("graph.header.menuLabel", { column: COLUMN_LABELS[id] }), restore: () => cell(id)?.focus() });

  const openMenuBelow = (id: GraphColumnId) => {
    const box = cell(id)?.getBoundingClientRect();
    if (box) openMenu(id, box.left + 8, box.bottom);
  };

  // --- Keyboard ---------------------------------------------------------------------------------
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, id: GraphColumnId) => {
    // The switch in the column header keeps its keys (Enter, Space).
    if ((event.target as Element).closest("button")) return;
    const at = layout.order.indexOf(id);
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (horizontal !== 0 && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (isResizable(id)) onChange(setColumnWidth(columns, id, layout.widths[id] + horizontal * STEP), { persist: true });
      } else if (event.ctrlKey || event.metaKey) {
        if (isOptional(id)) {
          onChange(moveColumn(columns, visibleOptional, id, horizontal), { persist: true });
          // When reordering, the browser re-parents the element and takes its focus in the process.
          focusCell(id);
        }
      } else {
        const next = layout.order[at + horizontal];
        if (next) focusCell(next);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? layout.order[0] : layout.order[layout.order.length - 1];
      if (next) focusCell(next);
    } else if (event.key === "Enter" || event.key === " " || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openMenuBelow(id);
    }
  };

  // --- Drag width -------------------------------------------------------------------------------
  const onResizeDown = (event: PointerEvent<HTMLSpanElement>, id: ResizableColumnId, sign: 1 | -1) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { id, x: event.clientX, width: layout.widths[id], sign };
    setResizing(id);
  };
  const onResizeMove = (event: PointerEvent<HTMLSpanElement>) => {
    const current = resize.current;
    if (!current) return;
    const delta = (current.sign * (event.clientX - current.x)) / rootZoom();
    onChange(setColumnWidth(latest.current, current.id, current.width + delta), { persist: false });
  };
  const onResizeEnd = () => {
    if (!resize.current) return;
    resize.current = null;
    setResizing(null);
    onChange(latest.current, { persist: true });
  };

  // --- Drag order -------------------------------------------------------------------------------
  const onHeadDown = (event: PointerEvent<HTMLDivElement>, id: GraphColumnId) => {
    if (event.button !== 0 || !isOptional(id)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, x: event.clientX, active: false, before: columns };
  };
  const onHeadMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    if (!current.active) {
      if (Math.abs(event.clientX - current.x) < DRAG_THRESHOLD) return;
      current.active = true;
      setMoving(current.id);
    }
    // Place before the first other optional column whose centre lies to the right of the pointer.
    let before: OptionalColumnId | null = null;
    for (const other of visibleOptional) {
      if (other === current.id) continue;
      const box = cell(other)?.getBoundingClientRect();
      if (box && event.clientX < box.left + box.width / 2) {
        before = other;
        break;
      }
    }
    const next = placeColumn(latest.current, visibleOptional, current.id, before);
    if (!sameColumns(next, latest.current)) onChange(next, { persist: false });
  };
  const onHeadEnd = (cancelled: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setMoving(null);
    if (!current.active) return;
    if (cancelled) onChange(current.before, { persist: false });
    else onChange(latest.current, { persist: true });
  };

  const hint = (id: GraphColumnId) => {
    const parts = [COLUMN_LABELS[id]];
    if (isResizable(id)) parts.push(t("graph.header.hintWidth", { left: formatShortcut("Shift+←"), right: formatShortcut("Shift+→") }));
    if (isOptional(id)) parts.push(t("graph.header.hintMove", { left: formatShortcut("Mod+←"), right: formatShortcut("Mod+→") }));
    parts.push(t("graph.header.hintMenu"));
    return parts.join(" · ");
  };

  return (
    <div role="rowgroup" className="shrink-0 border-b border-border bg-surface">
      <div
        ref={rootRef}
        role="row"
        aria-rowindex={1}
        data-graph-header
        className="flex h-control-md items-stretch text-xs font-semibold tracking-wide text-text-muted uppercase"
        style={{ paddingRight: gutter }}
      >
        {layout.order.map((id, index) => {
          const resizable = isResizable(id);
          // Left of the message the handle sits on the right edge, right of it on the left edge: it always lies on the boundary that moves.
          const handleRight = id === "refs" || id === "graph";
          return (
            <div
              key={id}
              role="columnheader"
              aria-colindex={index + 1}
              data-column={id}
              data-moving={moving === id || undefined}
              tabIndex={id === tabStop ? 0 : -1}
              title={hint(id)}
              onFocus={() => setFocusId(id)}
              onKeyDown={(event) => onKeyDown(event, id)}
              onContextMenu={(event: MouseEvent) => {
                event.preventDefault();
                openMenu(id, event.clientX, event.clientY);
              }}
              onPointerDown={(event) => onHeadDown(event, id)}
              onPointerMove={onHeadMove}
              onPointerUp={() => onHeadEnd(false)}
              onPointerCancel={() => onHeadEnd(true)}
              className={cn(
                "relative flex items-center px-2 focus-visible:-outline-offset-2",
                id === "message" ? "min-w-40 flex-1" : "shrink-0",
                isOptional(id) && "cursor-grab hover:text-text",
                "data-[moving=true]:cursor-grabbing data-[moving=true]:bg-accent-surface data-[moving=true]:text-text",
              )}
              style={id === "message" ? undefined : { width: layout.widths[id] }}
            >
              {id === "author" && layout.widths.author < AUTHOR_NAME_FROM ? (
                // Only the avatar fits: an icon instead of a truncated word.
                <>
                  <UserRound className="mx-auto size-3.5" aria-hidden />
                  <span className="sr-only">{COLUMN_LABELS[id]}</span>
                </>
              ) : (
                <span className="truncate">{COLUMN_LABELS[id]}</span>
              )}
              {id === "refs" && smart ? (
                <IconButton
                  size="sm"
                  data-smart-toggle={smart.on ? "on" : "off"}
                  label={smart.blocked ? `${SMART_LABEL} – ${smart.blocked}` : smart.detail ? `${SMART_LABEL}: ${smart.detail}` : SMART_LABEL}
                  active={smart.on}
                  aria-pressed={smart.on}
                  aria-disabled={smart.blocked && !smart.on ? true : undefined}
                  // The switch's tooltip replaces the column's hint here.
                  title=""
                  className={cn("mr-1 ml-auto", smart.blocked && !smart.on && "text-text-disabled hover:bg-transparent hover:text-text-disabled")}
                  icon={<Waypoints className="size-icon" aria-hidden />}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    // Switching off always works; switching on only if a branch is checked out.
                    if (smart.on || !smart.blocked) smart.onToggle();
                  }}
                />
              ) : null}
              {resizable ? (
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("graph.header.widthOf", { column: COLUMN_LABELS[id] })}
                  aria-valuenow={Math.round(layout.widths[id])}
                  aria-valuemin={COLUMN_LIMITS[id].min}
                  aria-valuemax={COLUMN_LIMITS[id].max}
                  data-resize={id}
                  data-active={resizing === id || undefined}
                  onPointerDown={(event) => onResizeDown(event, id, handleRight ? 1 : -1)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                  onPointerCancel={onResizeEnd}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onChange(setColumnWidth(latest.current, id, null), { persist: true });
                  }}
                  // 8 px handle area over the column boundary; only the line is visible.
                  className={cn("group/handle absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none", handleRight ? "-right-1" : "-left-1")}
                >
                  <span
                    aria-hidden
                    className="absolute inset-y-1.5 left-1/2 w-px -translate-x-1/2 bg-border group-hover/handle:inset-y-0 group-hover/handle:w-0.5 group-hover/handle:bg-accent group-data-[active=true]/handle:inset-y-0 group-data-[active=true]/handle:w-0.5 group-data-[active=true]/handle:bg-accent"
                  />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
