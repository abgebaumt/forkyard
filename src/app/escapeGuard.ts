/**
 * Esc belongs to the dialog (or the view) – not to the tooltip and not to the success message.
 *
 * Radix keeps dialogs, menus, toasts and tooltips in ONE stack; Esc closes only the topmost
 * piece. Two things end up on top without the person at the keyboard meaning them:
 *
 * - Tooltips. They appear immediately on keyboard focus. Anyone who had tabbed onto a button
 *   closed only the tooltip with the first Esc; the dialog or view stayed open (seen in the
 *   preferences and in the file view). Tooltips therefore disappear before Radix sees the key,
 *   and the same Esc reaches whatever lies beneath.
 * - Toasts. If one appears while a dialog, a menu or the Command Palette is open, the first Esc
 *   closed only the toast. If something modal is open and focus is not inside a toast, the
 *   toasts that would have gone away on their own anyway disappear immediately. Error toasts
 *   stay (they are meant to be read); if one is on top, Esc closes it first as before.
 */
import { flushSync } from "react-dom";
import { dismissTransientToasts, hasTransientToasts } from "../ui/Feedback";
import { closeTooltips, hasOpenTooltips } from "../ui/Tooltip";

const MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** Call once at startup. Hooks into the window's capture phase, i.e. before Radix (document). */
export function installEscapeGuard(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    // Synchronous, so the stack is already right when Radix gets the same event right after.
    if (hasOpenTooltips()) flushSync(() => closeTooltips());
    if (!hasTransientToasts()) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest("[data-toast]")) return;
    if (!document.querySelector(MODAL)) return;
    flushSync(() => dismissTransientToasts());
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
