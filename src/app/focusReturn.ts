/**
 * Focus return for overlays without their own trigger (Command Palette, shortcuts).
 *
 * Radix returns focus to its trigger on close – these overlays have none (they open via a
 * shortcut), so focus landed on <body> and the keyboard was left hanging. The helper remembers
 * on mount who had focus and gives it back on close. If the element no longer exists (list
 * rebuilt, view switched), the area it was in gets focus – otherwise the view in the middle.
 */
import { useRef } from "react";
import { areaOf, focusArea, type AreaId } from "./commands/focus";

interface Opener {
  element: HTMLElement | null;
  area: AreaId | null;
}

function capture(): Opener {
  if (typeof document === "undefined") return { element: null, area: null };
  const active = document.activeElement;
  const element = active instanceof HTMLElement && active !== document.body ? active : null;
  return { element, area: areaOf(element) };
}

function usable(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  if (element.closest("[inert], [aria-hidden='true']")) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Returns focus to where it was before the overlay. Returns true if it landed somewhere. */
export function returnFocus(opener: Opener): boolean {
  if (usable(opener.element)) {
    opener.element.focus();
    if (document.activeElement === opener.element) return true;
  }
  return focusArea(opener.area ?? "center") || focusArea("center") || focusArea("toolbar");
}

/**
 * Call inside the overlay (it is only mounted while it is open):
 * `onCloseAutoFocus={focus.onCloseAutoFocus}` on RadixDialog.Content.
 */
export function useFocusReturn() {
  const opener = useRef<Opener | null>(null);
  if (opener.current === null) opener.current = capture();
  return {
    onCloseAutoFocus(event: Event) {
      event.preventDefault();
      // If something else has taken focus in the meantime (a dialog of the executed action), it stays there.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (opener.current) returnFocus(opener.current);
    },
  };
}

/**
 * Runs something only once a just-closed overlay has returned focus. Radix does that in a timer
 * after unmounting; a dialog opened by the action should open after that – then it remembers the
 * right place and returns focus there when it closes.
 */
export function afterFocusReturn(run: () => void): void {
  requestAnimationFrame(() => window.setTimeout(run, 0));
}
