/**
 * Update notice. The core asks GitHub (`updateCheck`) and decides whether an automatic check is
 * due (setting `checkForUpdates`, at most once a day, also across restarts); the UI only asks the
 * core on start, every hour and when the setting changes, and shows the result:
 *
 * - status bar: "Forkyard 1.2.0 is available" until the version is skipped (`StatusLine`);
 * - a toast once per version (the core remembers it as "seen"), with an excerpt of the release
 *   notes as plain text, "View release" (opens the page the core checked) and "Skip this version"
 *   (no hint and no toast for that version any more; a newer one shows again);
 * - "Check for updates…" (palette, Settings › About) always asks and reports the result.
 *
 * Errors of the automatic check stay quiet – the HTTP call is in the activity log anyway.
 */
import { useEffect, useSyncExternalStore } from "react";
import { core, type UpdateInfo, type UpdateRelease } from "../core";
import { toast } from "../ui/Feedback";
import { t } from "../i18n";
import { openInBrowser } from "./actions/hosts";
import { runAction } from "./run";

/** How often the UI asks the core; the core itself only asks GitHub once a day. */
export const UPDATE_POLL_MS = 60 * 60 * 1000;
/** Length of the release notes excerpt in the toast. */
export const NOTES_EXCERPT = 240;

// --- State -------------------------------------------------------------------------------

let current: UpdateInfo | null = null;
const listeners = new Set<() => void>();

export function getUpdateInfo(): UpdateInfo | null {
  return current;
}

export function setUpdateInfo(info: UpdateInfo | null): void {
  current = info;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateInfo(): UpdateInfo | null {
  return useSyncExternalStore(subscribe, getUpdateInfo, getUpdateInfo);
}

// --- Rules -------------------------------------------------------------------------------

/** The release for the status bar hint: newer and not skipped. */
export function visibleUpdate(info: UpdateInfo | null): UpdateRelease | null {
  const latest = info?.latest ?? null;
  if (!latest || latest.version === info?.skippedVersion) return null;
  return latest;
}

/** A toast only once per version, and never for a skipped one. */
export function toastDue(info: UpdateInfo | null): boolean {
  const latest = visibleUpdate(info);
  return latest !== null && latest.version !== info?.notifiedVersion;
}

/** Release notes (Markdown) as a short line of plain text: no tags, links, images or code blocks. */
export function notesExcerpt(notes: string, max = NOTES_EXCERPT): string {
  const lines = notes
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/(\*\*|__|~~)/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const text = lines.join(" · ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s·]+$/, "")}…`;
}

// --- Actions -----------------------------------------------------------------------------

function showUpdateToast(release: UpdateRelease): void {
  toast({
    tone: "info",
    title: t("updates.available", { version: release.version }),
    description: notesExcerpt(release.notes) || undefined,
    action: { label: t("updates.view"), onClick: () => void openInBrowser(release.url, t("updates.page")) },
    secondaryAction: { label: t("updates.skip"), onClick: () => void skipVersion(release.version) },
  });
}

/** "Skip this version": no hint and no toast for it any more. */
export async function skipVersion(version: string): Promise<void> {
  const result = await runAction(t("updates.skip"), () => core.updateDismiss({ version, skip: true }));
  if (result.ok) setUpdateInfo(result.value);
}

/** Automatic check (start, hourly, setting changed): the core decides whether GitHub is asked. Quiet on errors. */
export async function checkAutomatically(): Promise<void> {
  let info: UpdateInfo;
  try {
    info = await core.updateCheck({ manual: false });
  } catch {
    return;
  }
  setUpdateInfo(info);
  const latest = info.latest;
  if (!latest || !toastDue(info)) return;
  showUpdateToast(latest);
  try {
    setUpdateInfo(await core.updateDismiss({ version: latest.version, skip: false }));
  } catch {
    // Not remembered: the toast may come once more on the next start.
  }
}

/** "Check for updates…": always asks GitHub and says what came out. */
export async function checkNow(): Promise<void> {
  const result = await runAction(t("updates.checking"), () => core.updateCheck({ manual: true }));
  if (!result.ok) return;
  setUpdateInfo(result.value);
  const latest = result.value.latest;
  if (!latest) {
    toast({ tone: "success", title: t("updates.upToDate", { version: result.value.current }) });
    return;
  }
  showUpdateToast(latest);
  if (latest.version !== result.value.notifiedVersion) {
    try {
      setUpdateInfo(await core.updateDismiss({ version: latest.version, skip: false }));
    } catch {
      // only the "seen" mark is missing
    }
  }
}

/**
 * Asks the core on start, every hour and whenever the setting changes (turned off: the hint goes
 * away; turned on: the check runs if it is due). `enabled` undefined = settings not loaded yet.
 */
export function useUpdateChecks(enabled: boolean | undefined): void {
  useEffect(() => {
    if (enabled === undefined) return;
    void checkAutomatically();
    const timer = window.setInterval(() => void checkAutomatically(), UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);
}
