import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronDown, FolderGit2, FolderX, LibraryBig, Plus, X } from "lucide-react";
import { cn } from "../../ui/cn";
import { ContextMenu, DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { appliedZoom } from "../../ui/zoom";
import { t } from "../../i18n";
import type { ScreenPoint, StripReport } from "../../core";
import { indexWithout, leftStrip, visibleRect } from "./tabDrag";

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

export interface RepoTab {
  id: string;
  title: string;
  /** Full path, shown as tooltip. */
  path?: string;
  /** Uncommitted changes in the working directory. */
  dirty?: boolean;
  /** Management tab instead of a repository. */
  kind?: "repo" | "management";
  /** The repository's folder is missing. */
  missing?: boolean;
  /** The title can be changed directly on the tab (F2, double click, context menu). */
  renamable?: boolean;
  /** Name of the folder: placeholder in the input – an empty alias resets to it. */
  folderName?: string;
}

/** What a tab's context menu can trigger on the bar itself. */
export interface TabMenuActions {
  /** Opens the input directly on the tab. */
  rename: () => void;
}

export interface TabBarProps {
  tabs: RepoTab[];
  activeId: string;
  onActivate?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
  /** Reordering by dragging. `index` is the new position in the list without the dragged tab. */
  onMove?: (id: string, index: number) => void;
  /** New title of a tab with `renamable`; empty means "back to the folder name". */
  onRename?: (id: string, value: string) => void;
  /** Entries of a tab's context menu. */
  menuFor?: (tab: RepoTab, actions: TabMenuActions) => MenuEntry[];
  /** Request from outside (command palette) to open the input on this tab; `nonce` changes per request. */
  renameRequest?: { id: string; nonce: number } | null;
  /** Placed before the tabs (the profile chip). */
  lead?: ReactNode;
  /**
   * A tab let go outside the strip: `screen` is the pointer on the screen, `insideSelf` whether it
   * is still inside this window. Without it, dragging only reorders.
   */
  onDragOut?: (id: string, screen: ScreenPoint, insideSelf: boolean) => void;
  /** Where the bar and the tab middles are (client coordinates); `null` once the bar is gone. */
  onStripReport?: (report: StripReport | null) => void;
}

const DRAG_THRESHOLD = 4;
/** Longest alias (as in repository management). */
const TITLE_MAX = 80;

function tabLabel(tab: RepoTab) {
  return tab.kind === "management" ? tab.title || t("ui.tabs.management") : tab.title;
}

/**
 * Where a name is split so that the end stays when truncating: at the last separator shortly before
 * the end ("station-14" → "station" + "-14"), otherwise before the last five characters. Short names stay whole.
 */
export function splitForMiddle(text: string): { head: string; tail: string } | null {
  const chars = [...text];
  if (chars.length < 8) return null;
  let cut = chars.length - 5;
  for (let index = chars.length - 3; index >= chars.length - 9 && index >= 3; index--) {
    if ("-_./ ".includes(chars[index]!)) {
      cut = index;
      break;
    }
  }
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

/**
 * Text that is truncated in the middle when space is short: the beginning gives way ("kundenportal-fr…-v2"),
 * the end stays readable – so many similar names can still be told apart. The full text also belongs
 * in a title or aria-label of the surrounding element.
 */
export function MiddleText({ text, className }: { text: string; className?: string }) {
  const parts = splitForMiddle(text);
  return (
    // "truncate" on the frame: without a split it truncates at the end itself; with a split the front part is truncated.
    <span data-middle-text="" className={cn("min-w-0 truncate", parts && "flex", className)}>
      {parts ? (
        <>
          <span className="min-w-0 truncate whitespace-pre">{parts.head}</span>
          <span className="shrink-0 whitespace-pre">{parts.tail}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

/** Input directly on the tab: Enter applies, Esc discards, clicking elsewhere applies. */
function TabRename({ tab, onDone }: { tab: RepoTab; onDone: (value: string | null, how: "key" | "blur") => void }) {
  const [value, setValue] = useState(tab.title);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (result: string | null, how: "key" | "blur") => {
    if (finished.current) return;
    finished.current = true;
    onDone(result, how);
  };
  const folder = tab.folderName ?? tab.title;
  return (
    <span className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-2.5">
      <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
      <input
        ref={input}
        type="text"
        data-tab-rename=""
        aria-label={t("ui.tabs.alias", { folder })}
        title={t("ui.tabs.renameHint")}
        placeholder={folder}
        value={value}
        maxLength={TITLE_MAX}
        spellCheck={false}
        autoComplete="off"
        className="h-control-sm w-full min-w-0 rounded-sm border border-accent bg-surface-sunken px-1 text-base text-text placeholder:text-text-muted"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Keys in the field belong to the field – not to the tab bar (arrows, Delete) and not to the window.
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            finish(value, "key");
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(null, "key");
          }
        }}
        onBlur={() => finish(value, "blur")}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onAuxClick={(event) => event.stopPropagation()}
      />
    </span>
  );
}

interface PointerAt {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

/** How often the strip reports where it is while the window is resized. */
const STRIP_REPORT_DEBOUNCE_MS = 100;

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
  onMove,
  onRename,
  menuFor,
  renameRequest,
  lead,
  onDragOut,
  onStripReport,
}: TabBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** `out`: the pointer (client) while it is outside the strip – the ghost follows it. */
  const [drag, setDrag] = useState<{ id: string; target: number; out: { x: number; y: number } | null } | null>(null);
  const pointer = useRef<{
    id: string;
    x: number;
    y: number;
    active: boolean;
    last: PointerAt;
    element: HTMLElement;
    pointerId: number;
  } | null>(null);
  const suppressClick = useRef(false);

  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  // Detect overflow: tabs shrink down to 128 px, after that the overflow menu appears.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const check = () => {
      setOverflow(list.scrollWidth > list.clientWidth + 1);
      // Otherwise, when the window gets narrower, the active tab would slide out of the visible part.
      list
        .querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeRef.current)}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tabs.length]);

  // Keep the active tab visible, even if it would be in the overflow.
  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, overflow]);

  // After moving by keyboard: the browser takes focus from a re-parented element; here it comes back.
  const refocus = useRef<string | null>(null);
  const order = tabs.map((tab) => tab.id).join("\n");
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`);
    element?.focus();
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [order]);

  const startRename = (id: string) => {
    if (onRename && tabs.find((tab) => tab.id === id)?.renamable) setEditing(id);
  };
  const endRename = (id: string, value: string | null, how: "key" | "blur") => {
    setEditing(null);
    // Finished with Enter or Esc: focus belongs to the tab again. After a click elsewhere it stays where the click was.
    if (how === "key") refocus.current = id;
    if (value !== null) onRename?.(id, value);
  };
  const requested = renameRequest?.nonce;
  useEffect(() => {
    if (renameRequest) startRename(renameRequest.id);
    // Only the request itself counts – not every new tab list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);
  // Focus returns to the tab as soon as the input field is gone.
  useLayoutEffect(() => {
    const id = refocus.current;
    if (editing !== null || !id) return;
    refocus.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"] [role="tab"]`)?.focus();
  }, [editing]);

  const tabElements = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? []);

  // The core places drops from other windows by the strip; it hears again when the layout changes.
  const report = useRef(onStripReport);
  report.current = onStripReport;
  const layoutKey = `${tabs.map((tab) => `${tab.id}\t${tab.title}`).join("\n")}\n${activeId}\n${overflow}`;
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !report.current) return;
    let timer: number | undefined;
    const send = () => {
      // The core works in window pixels; rectangles inside the zoomed root are layout pixels.
      const zoom = appliedZoom();
      const rect = bar.getBoundingClientRect();
      const tabMids = tabElements().map((element) => {
        const box = element.getBoundingClientRect();
        return (box.left + box.width / 2) * zoom;
      });
      const strip = { x: rect.left * zoom, y: rect.top * zoom, width: rect.width * zoom, height: rect.height * zoom };
      report.current?.({ strip, tabMids });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, STRIP_REPORT_DEBOUNCE_MS);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    window.addEventListener("resize", schedule);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);
  useEffect(() => () => report.current?.(null), []);

  /** Out of the strip: beyond the margin around the whole bar. */
  const outside = (at: PointerAt) => {
    const bar = barRef.current?.getBoundingClientRect();
    return Boolean(onDragOut && bar && leftStrip(visibleRect(bar, appliedZoom()), at.clientX, at.clientY));
  };

  /** Insertion position (0…n) under the mouse pointer (visible pixels; the rectangles are layout pixels). */
  const indexAt = (clientX: number) => {
    const elements = tabElements();
    const zoom = appliedZoom();
    for (let index = 0; index < elements.length; index++) {
      const rect = elements[index]!.getBoundingClientRect();
      if (clientX < (rect.left + rect.width / 2) * zoom) return index;
    }
    return elements.length;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || !onMove) return;
    pointer.current = {
      id,
      x: event.clientX,
      y: event.clientY,
      active: false,
      last: pointerAt(event),
      element: event.currentTarget,
      pointerId: event.pointerId,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = pointer.current;
    if (!state) return;
    if (!state.active) {
      // Any direction: a tab pulled straight down leaves the strip before it moves sideways.
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
      state.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    state.last = pointerAt(event);
    const out = outside(state.last) ? { x: event.clientX, y: event.clientY } : null;
    setDrag({ id: state.id, target: indexAt(event.clientX), out });
  };

  // The click after releasing should not additionally activate the tab; release again afterwards.
  const swallowClick = () => {
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  // Escape during a drag puts the tab back: nothing moves.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const state = pointer.current;
      if (event.key !== "Escape" || !state?.active) return;
      event.preventDefault();
      event.stopPropagation();
      pointer.current = null;
      setDrag(null);
      swallowClick();
      if (state.element.hasPointerCapture(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  // Also from `lostpointercapture`: some systems end the drag outside the window without a pointerup.
  const onPointerUp = () => {
    const state = pointer.current;
    pointer.current = null;
    setDrag(null);
    if (!state?.active) return;
    swallowClick();
    const { last } = state;
    if (outside(last)) {
      const inside = last.clientX >= 0 && last.clientY >= 0 && last.clientX < window.innerWidth && last.clientY < window.innerHeight;
      onDragOut?.(state.id, { x: last.screenX, y: last.screenY }, inside);
      return;
    }
    const from = tabs.findIndex((tab) => tab.id === state.id);
    const to = indexWithout(indexAt(last.clientX), from);
    if (from >= 0 && to !== from) onMove?.(state.id, to);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const elements = tabElements().map((element) => element.querySelector<HTMLElement>('[role="tab"]'));
    const index = elements.findIndex((element) => element === document.activeElement);
    if (index < 0) return;
    // Ctrl+Shift+←/→ moves the focused tab by one place (dragging without a mouse); focus stays with it.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const tab = tabs[index];
      const to = index + (event.key === "ArrowLeft" ? -1 : 1);
      if (tab && onMove && to >= 0 && to < tabs.length) {
        refocus.current = tab.id;
        onMove(tab.id, to);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // F2 renames the focused tab directly in the bar (like a file in the file manager).
    if (event.key === "F2" && !event.shiftKey && tabs[index]?.renamable && onRename) {
      event.preventDefault();
      startRename(tabs[index]!.id);
      return;
    }
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % elements.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + elements.length) % elements.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = elements.length - 1;
    else if (event.key === "Delete" && tabs[index]) {
      event.preventDefault();
      onClose?.(tabs[index]!.id);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      elements[next]?.focus();
    }
  };

  return (
    <div ref={barRef} className="flex h-tabbar shrink-0 items-end gap-px bg-surface-sunken px-1">
      {lead ? <div className="flex shrink-0 self-center pr-1">{lead}</div> : null}
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("ui.tabs.list")}
        className="flex min-w-0 items-end gap-px overflow-hidden"
        onKeyDown={onListKeyDown}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const label = tabLabel(tab);
          const renaming = editing === tab.id;
          // Insertion marker while dragging: on the left before this tab or on the right after the last one.
          const marking = drag !== null && drag.out === null && drag.id !== tab.id;
          const markLeft = marking && drag.target === index;
          const markRight = marking && index === tabs.length - 1 && drag.target === tabs.length;
          const body = (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onPointerDown={(event) => onPointerDown(event, tab.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onLostPointerCapture={() => {
                if (pointer.current?.active) onPointerUp();
              }}
              onPointerCancel={() => {
                pointer.current = null;
                setDrag(null);
              }}
              onMouseDown={(event) => {
                // Middle click: no auto-scroll, close instead (auxclick).
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose?.(tab.id);
                }
              }}
              className={cn(
                "group relative flex h-7.5 max-w-52 min-w-32 shrink items-center rounded-t-md pr-1 text-base",
                active ? "bg-bg text-text" : "text-text-muted hover:bg-surface hover:text-text",
                drag?.id === tab.id && "opacity-60",
                // While renaming, the tab gets its full width so the name fits into the field.
                renaming && "w-52 shrink-0",
              )}
            >
              {markLeft ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
              {markRight ? <span aria-hidden className="absolute inset-y-0 right-0 w-0.5 bg-accent" /> : null}
              {renaming ? <TabRename tab={tab} onDone={(value, how) => endRename(tab.id, value, how)} /> : null}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                // The full name applies for screen readers, even if the tab truncates it in the middle.
                aria-label={tab.dirty ? t("ui.tabs.dirtyLabel", { label }) : label}
                aria-keyshortcuts={tab.renamable && onRename ? "F2" : undefined}
                tabIndex={active ? 0 : -1}
                title={tab.path ?? label}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  onActivate?.(tab.id);
                }}
                onDoubleClick={() => startRename(tab.id)}
                // While editing, the tab stays there for screen readers; what is visible is the field.
                className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-t-md pr-1 pl-2.5", renaming && "sr-only")}
              >
                {tab.kind === "management" ? (
                  <LibraryBig className="size-3.5 shrink-0" aria-hidden />
                ) : tab.missing ? (
                  <FolderX className="size-3.5 shrink-0 text-danger" aria-hidden />
                ) : (
                  <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
                )}
                <MiddleText text={label} />
                {tab.dirty ? (
                  <span className="size-1.5 shrink-0 rounded-pill bg-warning" title={t("ui.tabs.dirty")}>
                    <span className="sr-only">{t("ui.tabs.dirtySuffix")}</span>
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("ui.tabs.close", { label })}
                title={t("ui.tabs.close", { label })}
                onClick={() => onClose?.(tab.id)}
                // While editing, the full width belongs to the field (hidden attribute: no class conflict with inline-flex).
                hidden={renaming}
                className={cn(
                  "size-5 shrink-0 items-center justify-center rounded-sm hover:bg-surface-raised",
                  !renaming && "inline-flex",
                  !active && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
                )}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
          // Only once the menu is closed and has returned focus – otherwise it would take it away from the input field again.
          const entries = menuFor?.(tab, {
            rename: () => window.requestAnimationFrame(() => window.setTimeout(() => startRename(tab.id), 60)),
          });
          return entries?.length ? (
            <ContextMenu key={tab.id} entries={entries}>
              {body}
            </ContextMenu>
          ) : (
            body
          );
        })}
      </div>
      {overflow ? (
        <DropdownMenu
          align="end"
          entries={tabs.map((tab) => ({
            label: tabLabel(tab),
            checked: tab.id === activeId,
            onSelect: () => onActivate?.(tab.id),
          }))}
        >
          <button
            type="button"
            aria-label={t("ui.tabs.all")}
            title={t("ui.tabs.all")}
            className="mb-1 inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"
          >
            <ChevronDown className="size-icon" aria-hidden />
          </button>
        </DropdownMenu>
      ) : null}
      <Tip label={t("ui.tabs.new")} shortcut="Mod+T">
        <button
          type="button"
          aria-label={t("ui.tabs.new")}
          onClick={onNew}
          className="mb-1 ml-1 inline-flex size-control-sm shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"
        >
          <Plus className="size-icon" aria-hidden />
        </button>
      </Tip>
      {/* Free space to the right of the tabs */}
      <div className="flex-1" />
      {drag?.out ? <DragGhost tab={tabs.find((tab) => tab.id === drag.id)} at={drag.out} /> : null}
    </div>
  );
}

const pointerAt = (event: PointerEvent): PointerAt => ({
  clientX: event.clientX,
  clientY: event.clientY,
  screenX: event.screenX,
  screenY: event.screenY,
});

/** The dragged tab under the pointer while it is outside the strip. */
function DragGhost({ tab, at }: { tab: RepoTab | undefined; at: { x: number; y: number } }) {
  if (!tab) return null;
  // Positioned inside the zoomed root element: pointer pixels become layout pixels.
  const zoom = appliedZoom();
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 flex h-7.5 max-w-52 min-w-32 items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 text-base text-text opacity-90 shadow-pop"
      style={{ left: at.x / zoom + 8, top: at.y / zoom + 8 }}
    >
      {tab.kind === "management" ? (
        <LibraryBig className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
      )}
      <MiddleText text={tabLabel(tab)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface ToolbarButtonProps {
  label: string;
  icon: ReactNode;
  shortcut?: string;
  /** Explains why the button is disabled, or what exactly it does. */
  hint?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Number on the icon, e.g. commits to push. */
  badge?: number;
  /** A dot on the icon instead of a number (pending without a count, e.g. a branch to create on the remote). */
  badgeDot?: boolean;
  /** Describes the number (or dot) for screen readers, e.g. "3 commits to push". */
  badgeLabel?: string;
  /** Turns the button into a split button with a selection menu. */
  menu?: MenuEntry[];
  /** Toggle (e.g. terminal): sets aria-pressed. */
  pressed?: boolean;
  /** Icon only, label only for screen readers (setting "Labels in the toolbar"). */
  compact?: boolean;
  onClick?: () => void;
}

/**
 * Button without visible text with a tooltip, suitable as the trigger of a menu: the menu's props and
 * ref land on the button, the tooltip names it on hover and on keyboard focus.
 */
const TipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function TipButton(
  { label, children, ...props },
  ref,
) {
  return (
    <Tip label={label}>
      <button ref={ref} type="button" aria-label={label} {...props}>
        {children}
      </button>
    </Tip>
  );
});

export function ToolbarButton({
  label,
  icon,
  shortcut,
  hint,
  disabled,
  busy,
  badge,
  badgeDot,
  badgeLabel,
  menu,
  pressed,
  compact,
  onClick,
}: ToolbarButtonProps) {
  const blocked = disabled || busy;
  const hintId = useId();
  // The reason for disabling (and what exactly the button does) also applies to screen readers, not only in the tooltip.
  const described = hint && hint !== label;
  const main = (
    <Tip label={hint ?? label} shortcut={shortcut}>
      <button
        type="button"
        aria-describedby={described ? hintId : undefined}
        // aria-disabled instead of disabled: the button stays focusable and the tooltip explains the reason.
        onClick={blocked ? undefined : onClick}
        aria-disabled={blocked || undefined}
        aria-busy={busy || undefined}
        aria-pressed={pressed}
        aria-label={(badge || badgeDot) && badgeLabel ? `${label}, ${badgeLabel}` : undefined}
        className={cn(
          "relative flex h-11 min-w-14 flex-col items-center justify-center gap-1 px-2 text-xs font-medium",
          menu ? "rounded-l-md" : "rounded-md",
          disabled
            ? "text-text-disabled"
            : pressed
              ? "bg-accent-surface text-accent"
              : "text-text-muted hover:bg-surface-raised hover:text-text active:bg-surface",
          busy && "cursor-progress",
        )}
      >
        <span className={cn("relative [&>svg]:size-5", busy && "animate-pulse")}>
          {icon}
          {badge ? (
            <span
              aria-hidden={badgeLabel ? true : undefined}
              // Anchored on the left: the pill grows with the number to the right out of the icon instead of covering it.
              className="absolute -top-1.5 left-3.5 min-w-3.5 rounded-pill bg-accent px-1 text-center text-xs leading-3.5 font-semibold whitespace-nowrap text-on-accent tabular-nums"
            >
              {badge > 999 ? "999+" : badge}
            </span>
          ) : badgeDot ? (
            <span
              aria-hidden={badgeLabel ? true : undefined}
              data-badge-dot=""
              className="absolute -top-0.5 left-4 size-2 rounded-pill bg-accent"
            />
          ) : null}
        </span>
        <span className={cn(compact && "sr-only")}>{label}</span>
        {described ? (
          <span id={hintId} className="sr-only">
            {hint}
          </span>
        ) : null}
      </button>
    </Tip>
  );

  if (!menu) return main;
  return (
    <div className="flex">
      {main}
      <DropdownMenu entries={menu}>
        <TipButton
          label={t("ui.toolbarOptions", { label })}
          className="flex h-11 w-6 items-center justify-center rounded-r-md text-text-muted hover:bg-surface-raised hover:text-text"
        >
          <ChevronDown className="size-3" aria-hidden />
        </TipButton>
      </DropdownMenu>
    </div>
  );
}

export function ToolbarSeparator() {
  return <div role="separator" aria-orientation="vertical" className="mx-1 h-6 w-px bg-border" />;
}

export function Toolbar({ children, label = t("ui.toolbar") }: { children: ReactNode; label?: string }) {
  return (
    <div role="toolbar" aria-label={label} className="flex h-toolbar shrink-0 items-center gap-0.5 border-b border-border bg-bg px-2">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export function StatusBar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <footer className="flex h-statusbar shrink-0 items-center gap-3 border-t border-border bg-surface px-2 text-xs text-text-muted [&_button]:-outline-offset-1">
      <div className="flex min-w-0 flex-1 items-center gap-3">{left}</div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </footer>
  );
}
