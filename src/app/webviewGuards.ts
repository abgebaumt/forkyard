/**
 * The app runs in a WebView, and that brings browser behaviour that has no place in a desktop
 * program: "Find in page", printing, reload, the context menu with "Back" and "Save as". It is
 * switched off here – in ONE place, regardless of whether a dialog is open right now or an app
 * command would be available.
 *
 * Text editing (copy, paste, select all, undo in the field) stays untouched.
 */

const guarded = new WeakSet<Event>();

/** Intercepted by the guard here – for the command handler the key does NOT count as handled. */
export function preventedByGuard(event: Event): boolean {
  return guarded.has(event);
}

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Is this a shortcut the WebView itself would act on?
 * `dev` lets reload and the developer tools through.
 */
export function isBrowserAccelerator(event: KeyLike, mac: boolean, dev: boolean): boolean {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const reload = key === "F5" || (mod && key === "r");
  const devtools = key === "F12" || (mod && event.shiftKey && ["i", "j", "c"].includes(key)) || (mac && event.metaKey && event.altKey && ["i", "j", "c"].includes(key));
  if (reload || devtools) return !dev;
  // Find in page, caret browsing
  if (key === "F3" || key === "F7") return true;
  // History: Alt+Arrow (on macOS Option+Arrow is text editing), mouse and media keys
  if (key === "BrowserBack" || key === "BrowserForward" || key === "BrowserRefresh" || key === "BrowserSearch") return true;
  if (!mac && event.altKey && !mod && (key === "ArrowLeft" || key === "ArrowRight")) return true;
  if (mac && mod && !event.altKey && (key === "[" || key === "]")) return true;
  if (!mod || event.altKey) return false;
  // Find, print, view source, save, open, history, downloads, bookmarks, address bar, new window
  return ["f", "g", "p", "u", "s", "o", "h", "j", "d", "e", "l", "n"].includes(key);
}

function allowsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // In input fields and editors the menu with cut/copy/paste belongs there.
  if (target.closest("input, textarea, [contenteditable='true'], [contenteditable=''], .cm-editor")) return true;
  // Selected text (error messages, SHA, diff): "Copy" should stay reachable.
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && target.closest(".selectable, pre, code"));
}

/** Call once at startup, BEFORE all other keyboard handlers on the window. */
export function installWebviewGuards({ mac, dev }: { mac: boolean; dev: boolean }): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // If an editor has already handled the key, there is nothing left to do.
    if (event.defaultPrevented) return;
    if (!isBrowserAccelerator(event, mac, dev)) return;
    event.preventDefault();
    guarded.add(event);
  };
  const onContextMenu = (event: MouseEvent) => {
    // Our own context menus (Radix) have already taken the event.
    if (event.defaultPrevented) return;
    // In the development build the WebView's menu stays reachable with Shift ("Inspect").
    if (dev && event.shiftKey) return;
    if (!allowsNativeMenu(event.target)) event.preventDefault();
  };
  // A file or link dragged onto the window would make the WebView navigate there – away from
  // the app and to foreign content. Whoever handles drag and drop itself (tabs, branches, file
  // lists) has already taken the event; everything else is discarded here.
  const onDragOver = (event: DragEvent) => {
    if (!event.defaultPrevented && isForeignDrag(event.dataTransfer)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!event.defaultPrevented && isForeignDrag(event.dataTransfer)) event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}

/** Does the dragged item come from outside the app (files, a link from the browser)? */
export function isForeignDrag(data: Pick<DataTransfer, "types"> | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types);
  return types.includes("Files") || types.includes("text/uri-list");
}
