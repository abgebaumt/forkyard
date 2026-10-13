/**
 * Operating system notifications for things that happen while the window is not in the
 * foreground (fetch brought something new, an action failed). If the window has focus, the
 * toast in the app is enough.
 *
 * Deliberately without a dependency on queries.ts: the caller says whether the setting is on.
 *
 * Sending goes through the notification plugin on the Rust side (`core.notify`, see
 * notifications/system.ts). If the system does not allow notifications, the toasts in the app
 * remain – nothing is lost, and the preferences show the state.
 * The plugin does not report a click on the notification; the window does not come to the
 * front by itself because of it.
 *
 * For automated tests there is a redirect: if `window.__gcTestNotifications` is set, nothing
 * goes to the system – every notification lands in `sent`, and `focused` replaces the question
 * whether the window is in front (otherwise the invisible test window always counts as focused).
 */
import { checkSystemNotifications, sendSystemNotification, systemNotifications, type SystemNotifications } from "./notifications/system";
import { t } from "../i18n";

export type { SystemNotifications } from "./notifications/system";

export interface SentNotification {
  title: string;
  body: string;
}

declare global {
  interface Window {
    __gcTestNotifications?: { focused: boolean; sent: SentNotification[] };
  }
}

/** Whether the window is currently in front of the user (visible and focused). */
function windowInFront(): boolean {
  const test = window.__gcTestNotifications;
  if (test) return test.focused;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Multi-line messages are shortened to the essentials for the system. */
function clip(text: string | undefined, max = 240): string {
  const value = (text ?? "").replace(/\s*\n+\s*/g, " · ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Shows a system notification if `enabled` and the window is not in the foreground right now. */
export function desktopNotify(enabled: boolean | undefined, title: string, body?: string): void {
  if (!enabled || typeof window === "undefined") return;
  if (windowInFront()) return;
  const text = clip(body);
  const test = window.__gcTestNotifications;
  if (test) {
    test.sent.push({ title, body: text });
    return;
  }
  // If the system refuses or sending fails, the message is still shown in the window.
  if (systemNotifications() !== "blocked") void sendSystemNotification(title, text);
}

/** Whether the system allows the app's notifications – the last determined state, immediately. */
export function systemNotificationState(): SystemNotifications {
  if (typeof window === "undefined") return "blocked";
  if (window.__gcTestNotifications) return "granted";
  return systemNotifications();
}

/** Determines the state afresh (without asking the system for permission) and returns it. */
export async function readSystemNotifications(): Promise<SystemNotifications> {
  if (typeof window === "undefined") return "blocked";
  if (window.__gcTestNotifications) return "granted";
  return checkSystemNotifications(true);
}

/**
 * Test from the preferences: sends a notification now, even if the window is in front (and asks
 * the system for permission if that is still open). Returns null on success, otherwise the reason.
 */
export async function sendTestNotification(): Promise<string | null> {
  const title = t("app.notify.testTitle");
  const body = t("app.notify.testBody");
  const test = window.__gcTestNotifications;
  if (test) {
    test.sent.push({ title, body });
    return null;
  }
  if (await sendSystemNotification(title, body)) return null;
  return systemNotifications() === "blocked"
    ? t("app.notify.blocked")
    : t("app.notify.rejected");
}

const manualSync = new Map<string, number>();

/** Records that the user has just triggered fetch, pull or push themselves (start and end). */
export function markManualSync(repoId: string): void {
  manualSync.set(repoId, Date.now());
}

/** Whether a fetch in the log belongs to an action just triggered by the user – then it is not an auto-fetch. */
export function wasManualSync(repoId: string, withinMs = 4000): boolean {
  const at = manualSync.get(repoId);
  return at !== undefined && Date.now() - at < withinMs;
}
