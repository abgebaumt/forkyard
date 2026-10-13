import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronDown, FolderGit2, FolderX, LibraryBig, Plus, X } from "lucide-react";
import { cn } from "./cn";
import { ContextMenu, DropdownMenu, type MenuEntry } from "./Menu";
import { Tip } from "./Tooltip";
import { t } from "../i18n";

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

export function TabBar({ tabs, activeId, onActivate, onClose, onNew, onMove, onRename, menuFor, renameRequest, lead }: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; target: number } | null>(null);
  const pointer = useRef<{ id: string; x: number; active: boolean } | null>(null);
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
      list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeRef.current)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  /** Insertion position (0…n) under the mouse pointer. */
  const indexAt = (clientX: number) => {
    const elements = tabElements();
    for (let index = 0; index < elements.length; index++) {
      const rect = elements[index]!.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return index;
    }
    return elements.length;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || !onMove) return;
    pointer.current = { id, x: event.clientX, active: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = pointer.current;
    if (!state) return;
    if (!state.active) {
      if (Math.abs(event.clientX - state.x) < DRAG_THRESHOLD) return;
      state.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDrag({ id: state.id, target: indexAt(event.clientX) });
  };

  const onPointerUp = () => {
    const state = pointer.current;
    pointer.current = null;
    if (!state?.active || !drag) {
      setDrag(null);
      return;
    }
    // The click after releasing should not additionally activate the tab; release again afterwards.
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const from = tabs.findIndex((tab) => tab.id === drag.id);
    const to = drag.target > from ? drag.target - 1 : drag.target;
    setDrag(null);
    if (from >= 0 && to !== from) onMove?.(drag.id, to);
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
    <div className="flex h-tabbar shrink-0 items-end gap-px bg-surface-sunken px-1">
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
          const markLeft = drag !== null && drag.target === index && drag.id !== tab.id;
          const markRight = drag !== null && index === tabs.length - 1 && drag.target === tabs.length && drag.id !== tab.id;
          const body = (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onPointerDown={(event) => onPointerDown(event, tab.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
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
          const entries = menuFor?.(tab, { rename: () => window.requestAnimationFrame(() => window.setTimeout(() => startRename(tab.id), 60)) });
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
  /** Describes the number for screen readers, e.g. "3 commits to push". */
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
const TipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function TipButton({ label, children, ...props }, ref) {
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
        aria-label={badge && badgeLabel ? `${label}, ${badgeLabel}` : undefined}
        className={cn(
          "relative flex h-9 min-w-12 flex-col items-center justify-center gap-0.5 px-2 text-xs font-medium",
          menu ? "rounded-l-md" : "rounded-md",
          disabled
            ? "text-text-disabled"
            : pressed
              ? "bg-accent-surface text-accent"
              : "text-text-muted hover:bg-surface-raised hover:text-text active:bg-surface",
          busy && "cursor-progress",
        )}
      >
        <span className={cn("relative", busy && "animate-pulse")}>
          {icon}
          {badge ? (
            <span
              aria-hidden={badgeLabel ? true : undefined}
              // Anchored on the left: the pill grows with the number to the right out of the icon instead of covering it.
              className="absolute -top-1.5 left-3 min-w-3.5 rounded-pill bg-accent px-1 text-center text-xs leading-3.5 font-semibold whitespace-nowrap text-on-accent tabular-nums"
            >
              {badge > 999 ? "999+" : badge}
            </span>
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
        <TipButton label={t("ui.toolbarOptions", { label })} className="flex h-9 w-6 items-center justify-center rounded-r-md text-text-muted hover:bg-surface-raised hover:text-text">
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
