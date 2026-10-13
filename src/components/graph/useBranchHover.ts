/**
 * Highlighting from outside (left panel): pointer or keyboard focus on a branch highlights its
 * commits in the graph. The handlers go on the list's container; the rows carry
 * `data-ref-hover="<fullName>"`.
 */
import { useMemo, type FocusEvent, type PointerEvent } from "react";
import type { Id } from "../../core";
import { endHoverHighlight, hoverHighlight } from "./highlightStore";

const fullNameOf = (target: EventTarget | null): string | null => (target instanceof Element ? (target.closest("[data-ref-hover]")?.getAttribute("data-ref-hover") ?? null) : null);

export function useBranchHover(repoId: Id) {
  return useMemo(
    () => ({
      onPointerOver(event: PointerEvent) {
        // While a branch is being dragged, the graph stays as it is.
        if (event.pointerType === "mouse" && event.buttons !== 0) return;
        const fullName = fullNameOf(event.target);
        if (fullName) hoverHighlight(repoId, fullName);
        else endHoverHighlight(repoId);
      },
      onPointerLeave() {
        endHoverHighlight(repoId);
      },
      onFocus(event: FocusEvent) {
        // Only for keyboard use: a click should not leave anything behind.
        const fullName = event.target.matches(":focus-visible") ? fullNameOf(event.target) : null;
        if (fullName) hoverHighlight(repoId, fullName, { delay: false });
        else endHoverHighlight(repoId);
      },
      onBlur(event: FocusEvent) {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) endHoverHighlight(repoId);
      },
    }),
    [repoId],
  );
}
