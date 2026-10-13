/**
 * Operating system notifications – via the notification plugin on the Rust side, as offered by
 * the core (`core.notify`, `core.notifyPermission`). The WebView itself rejects
 * `Notification.requestPermission()`; only the plugin reaches the system's notification centre.
 *
 * This holds the state (allowed, blocked by the system, not asked yet) for the preferences and
 * for sending. Permission is requested on the first send – the core takes care of that.
 */
import { core } from "../../core";

/**
 * - `granted`: the system shows the app's notifications.
 * - `blocked`: the system (or the user there) does not allow them – or this build lacks the integration.
 * - `unknown`: not asked yet; the request comes with the first notification.
 */
export type SystemNotifications = "granted" | "blocked" | "unknown";

let state: SystemNotifications = "unknown";
let known = false;
let probing: Promise<SystemNotifications> | null = null;
const listeners = new Set<() => void>();

function update(next: SystemNotifications): SystemNotifications {
  const changed = state !== next || !known;
  state = next;
  known = true;
  if (changed) listeners.forEach((listener) => listener());
  return state;
}

async function probe(): Promise<SystemNotifications> {
  try {
    const permission = await core.notifyPermission();
    return update(permission === "granted" ? "granted" : permission === "denied" ? "blocked" : "unknown");
  } catch {
    // Outside Tauri (preview in the browser, tests): there is no system that could show anything.
    return update("blocked");
  }
}

/** Determines the state (once; again with `force`). Does not ask the system for permission. */
export function checkSystemNotifications(force = false): Promise<SystemNotifications> {
  if (typeof window === "undefined") return Promise.resolve("blocked");
  if (force) probing = null;
  probing ??= probe();
  return probing;
}

/** The last determined state – immediately, without asking. Before the first answer: "unknown". */
export const systemNotifications = (): SystemNotifications => state;

export function onSystemNotificationsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sends a notification to the system (the core asks for permission the first time).
 * Returns whether the system accepted it; afterwards the state is known as well.
 */
export async function sendSystemNotification(title: string, body: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  let sent = false;
  try {
    sent = await core.notify({ title, body });
  } catch {
    sent = false;
  }
  // After sending, it is clear how the system decided.
  if (sent) update("granted");
  else await checkSystemNotifications(true);
  return sent;
}

// Determine once on load so the preferences know the state right away.
if (typeof window !== "undefined") void checkSystemNotifications();
