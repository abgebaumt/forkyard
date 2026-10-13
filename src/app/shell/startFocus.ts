/**
 * Start focus: right after program start, keyboard focus in the browser is on <body> – the
 * first key (arrow, Enter, J/K) would go nowhere. So the shell sets it once per start:
 *
 * - Start without an open repository (repository management): on the first action, "Open …".
 * - With an open repository: into the graph (selected row; until it has loaded, the view itself).
 *
 * The start focus takes nothing away from anyone: if focus is already somewhere (a dialog, a
 * credentials prompt, a click by the user), it stays there.
 */
import { useEffect, useRef } from "react";
import { focusArea, focusAreaSoon } from "../commands/focus";

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"]';
const MANAGEMENT = 'main[data-area="manage"]';
// Only once the list has loaded: before that, repo-management still swaps its layout (skeleton → empty or list),
// and an already focused button would disappear again.
const FIRST_ACTION = `${MANAGEMENT} [data-screen="repo-management"]:not([data-state="loading"]) button:not([disabled]):not([aria-disabled="true"])`;

/** Focus is free if it is nowhere – or only on the view itself (fallback target of the focus guard). */
const focusIsFree = () => {
  const active = document.activeElement;
  return (!active || active === document.body || active.matches(MANAGEMENT)) && !document.querySelector(OVERLAY);
};

/** For about five seconds, once per frame: onto the first action as soon as it exists. */
function focusFirstAction(tries = 300): void {
  if (!focusIsFree()) return;
  const button = document.querySelector<HTMLElement>(FIRST_ACTION);
  if (button) {
    button.focus({ preventScroll: true });
    if (document.activeElement === button) return;
  }
  if (tries > 0) requestAnimationFrame(() => focusFirstAction(tries - 1));
}

/**
 * `ready`: the tab list has loaded and the shell is up. `kind`: what the active tab shows.
 * Takes effect exactly once; later tab switches are handled by the actions and the focus guard.
 */
export function useStartFocus(ready: boolean, kind: "repo" | "management"): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    // Wait one frame: the active tab's view only mounts during this pass.
    const frame = requestAnimationFrame(() => {
      done.current = true;
      if (!focusIsFree()) return;
      if (kind === "repo") focusGraph();
      else focusFirstAction();
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, kind]);
}

/**
 * Into the graph: onto the selected row as soon as it has loaded – not onto some button of the
 * view. If none arrives within two seconds, the view itself takes focus and passes it on.
 */
function focusGraph(tries = 120): void {
  if (!focusIsFree()) return;
  if (focusArea("center", { strict: true, scroll: false })) return;
  if (tries > 0) requestAnimationFrame(() => focusGraph(tries - 1));
  else focusAreaSoon("center", 0);
}
