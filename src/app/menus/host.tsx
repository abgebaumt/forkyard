/**
 * Open a menu at a position in the window without a trigger there:
 *
 *   openMenuAt({ x: event.clientX, y: event.clientY }, dropMenu({ repoId, tabId, source, target }), "Drop branch");
 *
 * Meant for the drop menu after dragging a branch and for menus opened by a command.
 * It is shown by the <MenuHost /> in the shell. Esc closes it without triggering anything.
 */
import { useSyncExternalStore } from "react";
import { PopupMenu, type MenuEntry } from "../../ui/Menu";

interface OpenMenu {
  id: number;
  point: { x: number; y: number };
  entries: MenuEntry[];
  label?: string;
}

let current: OpenMenu | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Opens `entries` at `point` (clientX/clientY). An empty menu opens nothing. */
export function openMenuAt(point: { x: number; y: number }, entries: MenuEntry[], label?: string): void {
  if (entries.length === 0) return;
  current = { id: nextId++, point, entries, label };
  emit();
}

/** Opens the menu below an element (bottom-left corner) – for the keyboard, where there is no mouse position. */
export function openMenuAtElement(element: Element | null, entries: MenuEntry[], label?: string): void {
  const rect = element?.getBoundingClientRect();
  const point = rect && rect.width + rect.height > 0 ? { x: rect.left, y: rect.bottom } : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  openMenuAt(point, entries, label);
}

export function closeMenu(): void {
  if (!current) return;
  current = null;
  emit();
}

export function hasOpenMenu(): boolean {
  return current !== null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mount once in the shell. */
export function MenuHost() {
  const menu = useSyncExternalStore(subscribe, () => current);
  if (!menu) return null;
  return (
    <PopupMenu
      key={menu.id}
      entries={menu.entries}
      point={menu.point}
      label={menu.label}
      onClose={() => {
        // An entry may already have opened the next menu; only close our own.
        if (current?.id === menu.id) closeMenu();
      }}
    />
  );
}
