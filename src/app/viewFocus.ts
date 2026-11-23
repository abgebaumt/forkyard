/**
 * May a view that is just appearing (file view, history, blame) take focus?
 *
 * Views load their content afterwards and set focus once it is there – that can take a
 * moment. If the user has opened something else in the meantime (a dialog, a menu, the
 * Command Palette, the preferences), focus belongs there: otherwise the view would take it
 * away, and whatever the user is typing would land in the view as shortcuts.
 */
import { hasOpenDialog } from "./dialogs";
import { hasOpenMenu } from "./menus/host";
import { useAppStore } from "./store";

export function viewMayTakeFocus(): boolean {
  return !hasOpenDialog() && !hasOpenMenu() && !useAppStore.getState().overlay;
}

/** Input, textarea or select – keys there belong to the field. */
export const isTextField = (element: Element | null) =>
  Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"));

/** A field that takes typed text: contenteditable, CodeMirror, and inputs that are not buttons, checkboxes and the like. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return Boolean(target.closest(".cm-editor"));
}

/**
 * Whether a key press belongs to the view: not in text fields, menus, dialogs; not while a
 * dialog, an overlay or a menu is open.
 */
export function keyBelongsToView(event: KeyboardEvent): boolean {
  if (!viewMayTakeFocus()) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (isTextField(target)) return false;
  return !target?.closest('[role="menu"], [role="dialog"], [role="listbox"][data-radix-select-viewport], .cm-panels');
}
