/**
 * Actions around the terminal, for the panel and the commands (src/app/commands/terminal.ts).
 * Without xterm.js: the sessions are only addressed through the remote control in control.ts.
 */
import type { Id } from "../../core";
import { confirm } from "../../app/dialogs";
import { afterFocusReturn } from "../../app/focusReturn";
import { getTabView, useAppStore } from "../../app/store";
import { requestTerminalFocus, terminalControl, type TerminalStatusKind } from "./control";
import { t } from "../../i18n";

const isLive = (status: TerminalStatusKind | null) => status === "starting" || status === "running";

/** Show the terminal (if needed) and put focus into it. */
export function showTerminal(tabId: Id): void {
  if (!getTabView(tabId).terminalOpen) useAppStore.getState().toggleTerminal(tabId);
  requestTerminalFocus(tabId);
}

/** Hide the terminal; the shell keeps running, the output stays. */
export function hideTerminal(tabId: Id): void {
  if (getTabView(tabId).terminalOpen) useAppStore.getState().toggleTerminal(tabId);
}

/** Restart the shell. If it is still running, ask first – whatever runs in it ends too. */
export async function restartTerminal(tabId: Id): Promise<boolean> {
  const status = terminalControl.statusOf(tabId);
  if (status === null) return false;
  if (isLive(status)) {
    const ok = await confirm({
      title: t("terminal.confirm.restartTitle"),
      body: t("terminal.confirm.restartBody"),
      confirmLabel: t("terminal.menu.restart"),
      danger: true,
    });
    if (!ok) return false;
  }
  terminalControl.restart(tabId);
  // Only once the prompt has returned focus, otherwise it would take it away again right away.
  afterFocusReturn(() => requestTerminalFocus(tabId));
  return true;
}

/** End the session: close the shell, discard the output, hide the region. */
export async function endTerminal(tabId: Id): Promise<boolean> {
  const status = terminalControl.statusOf(tabId);
  if (isLive(status)) {
    const ok = await confirm({
      title: t("terminal.confirm.endTitle"),
      body: t("terminal.confirm.endBody"),
      confirmLabel: t("terminal.menu.end"),
      danger: true,
    });
    if (!ok) return false;
  }
  // The last session closes the region; otherwise the neighbouring tab is shown.
  if (terminalControl.endActive(tabId) === 0) hideTerminal(tabId);
  return true;
}

/**
 * Before closing a tab: if one of its shells is still running and has been worked in, everything running
 * in it ends with the tab – that asks first. A shell that has only shown its prompt ends without
 * a prompt. (The core does not report whether a program is currently running; hence the rule:
 * always ask as soon as the shell has received input since its start.)
 */
export async function confirmCloseTerminal(tabId: Id, tabName?: string | null): Promise<boolean> {
  if (!terminalControl.hadInput(tabId)) return true;
  return confirm({
    title: tabName ? t("terminal.confirm.closeTabNamed", { name: tabName }) : t("terminal.confirm.closeTab"),
    body: t("terminal.confirm.closeTabBody"),
    confirmLabel: t("terminal.confirm.closeTabConfirm"),
    danger: true,
  });
}

/** Clear the scrollback: what has scrolled off the top. */
export function clearTerminal(tabId: Id): void {
  terminalControl.clear(tabId);
}

/** Another shell in the tab's terminal; it is shown and gets the focus. */
export function newTerminalShell(tabId: Id): void {
  terminalControl.newShell(tabId);
  requestTerminalFocus(tabId);
}

/** Close one terminal tab. A running session asks first – whatever runs in it ends too. */
export async function closeTerminalSession(tabId: Id, key: Id, name: string): Promise<boolean> {
  if (terminalControl.isLive(tabId, key)) {
    const ok = await confirm({
      title: t("terminal.confirm.closeSessionTitle", { name }),
      body: t("terminal.confirm.closeSessionBody"),
      confirmLabel: t("terminal.confirm.closeSessionConfirm"),
      danger: true,
    });
    if (!ok) return false;
  }
  if (terminalControl.close(tabId, key) === 0) hideTerminal(tabId);
  else afterFocusReturn(() => requestTerminalFocus(tabId));
  return true;
}
