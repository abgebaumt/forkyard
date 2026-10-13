/**
 * Rebase tool in the centre of the repo tab, in three modes:
 *   interactive  reorder, reword, squash, drop commits from `base`
 *   squash       combine selected consecutive commits into one
 *   cherry_pick  apply selected commits onto the checked-out branch in a chosen order
 * Esc or "Cancel" close without changing anything.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Id, Sha } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { hasOpenMenu } from "../../app/menus/host";
import type { RebaseToolMode } from "../../app/store";
import { useAppStore } from "../../app/store";
import { preventedByGuard } from "../../app/webviewGuards";
import { CherryPickMode } from "./CherryPickMode";
import { InteractiveRebase } from "./Interactive";
import { SquashMode } from "./SquashMode";
import { t } from "../../i18n";

export interface RebaseToolProps {
  repoId: Id;
  tabId: Id;
  /** Base of the rebase (branch name or SHA). */
  base: string;
  mode: RebaseToolMode;
  /** Preselected commits (squash, cherry-pick). */
  shas: Sha[];
}

const isTextField = (element: Element | null) => Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"));

/** Reorder, combine, transfer commits. */
export function RebaseTool({ repoId, tabId, base, mode, shas }: RebaseToolProps) {
  const root = useRef<HTMLElement>(null);
  const close = useCallback(() => useAppStore.getState().closeCenter(tabId), [tabId]);

  // Esc closes – unless a dialog, a menu, a running drag or a text field outside needs the key.
  //
  // Two phases: if focus is in the tool (or nowhere), Esc already acts in the capture phase.
  // Otherwise the same key would first only close a success toast that happens to still be visible
  // (Radix keeps toasts in the same stack as dialogs), and the tool would stay. If focus is
  // elsewhere (left panel, commit panel), the element there takes precedence; Esc then only arrives
  // while bubbling, and only if nobody handled it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
      if ((event.defaultPrevented && !preventedByGuard(event)) || hasOpenDialog() || hasOpenMenu() || useAppStore.getState().overlay) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]')) return;
      // A running drag is cancelled by the list itself.
      if (root.current?.querySelector("[data-dragging]")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menu"], [role="dialog"], [role="listbox"][data-radix-select-viewport], [data-toast]')) return;
      const inside = Boolean(target && root.current?.contains(target));
      const nowhere = !target || target === document.body || target === document.documentElement;
      if (event.eventPhase === Event.CAPTURING_PHASE && !inside && !nowhere) return;
      if (!inside && isTextField(target)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  // Ctrl+Enter starts from the list and from the fields. The key is always consumed here, so that
  // "Commit" behind it does not fire while the tool has focus.
  const startRef = useRef<(() => void) | null>(null);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
    event.preventDefault();
    startRef.current?.();
  };

  const key = `${mode}:${base}:${shas.join(",")}`;
  return (
    <section ref={root} aria-label={mode === "interactive" ? t("rebase.tool.interactive") : mode === "squash" ? t("rebase.tool.squash") : t("rebase.tool.cherryPick")} data-screen="rebase" data-mode={mode} onKeyDown={onKeyDown} className="@container flex h-full min-h-0 min-w-0 flex-col bg-bg">
      {mode === "interactive" ? (
        <InteractiveRebase key={key} repoId={repoId} tabId={tabId} base={base} onClose={close} startRef={startRef} />
      ) : mode === "squash" ? (
        <SquashMode key={key} repoId={repoId} tabId={tabId} shas={shas} onClose={close} startRef={startRef} />
      ) : (
        <CherryPickMode key={key} repoId={repoId} tabId={tabId} shas={shas} onClose={close} startRef={startRef} />
      )}
    </section>
  );
}
