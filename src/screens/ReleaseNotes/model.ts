/**
 * Release notes (v1.2, Teilpaket 7.2) without React: which targets a place offers and in which
 * order they run, the range and status lines, where an answer goes (rules for suggestions), and
 * whether the function is visible. The tag message is the tag dialog's annotation field itself.
 */
import type { AiStatus, ReleaseNotes, ReleaseNotesRange } from "../../core";
import { t } from "../../i18n";
import { hostKindLabels, type HostRepo } from "../../app/actions/hostTypes";
import { placeSuggestion, type Placement } from "../../app/ai/suggestion";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";

export type ReleaseTarget = "changelog" | "host_release" | "clipboard";
/** A tag has a version (changelog section, release); a commit has none. */
export type ReleaseSubjectKind = "tag" | "commit";

/** The order the targets run in: local first, the external step before the clipboard. */
export const TARGET_ORDER: ReleaseTarget[] = ["changelog", "host_release", "clipboard"];

export function availableTargets(kind: ReleaseSubjectKind, hostReleases: boolean): ReleaseTarget[] {
  if (kind === "commit") return ["clipboard"];
  return TARGET_ORDER.filter((target) => target !== "host_release" || hostReleases);
}

export function toggleTarget(selected: ReleaseTarget[], target: ReleaseTarget, on: boolean): ReleaseTarget[] {
  const next = new Set(selected);
  if (on) next.add(target);
  else next.delete(target);
  return TARGET_ORDER.filter((item) => next.has(item));
}

/** Leaves this computer and cannot be undone: never preselected, confirmed on its own. */
export const isExternal = (target: ReleaseTarget) => target === "host_release";

export function targetLabel(target: ReleaseTarget, hostName: string | null): string {
  switch (target) {
    case "changelog":
      return t("actions.tags.releaseNotes.targets.changelog");
    case "host_release":
      return t("actions.tags.releaseNotes.targets.hostRelease", { host: hostName ?? "" });
    case "clipboard":
      return t("actions.tags.releaseNotes.targets.clipboard");
  }
}

export function targetHint(target: ReleaseTarget, remote: string | null): string | null {
  if (target === "changelog") return t("actions.tags.releaseNotes.targets.changelogHint");
  if (target === "host_release") return `${t("actions.tags.releaseNotes.external")}: ${t("actions.tags.releaseNotes.targets.hostReleaseHint", { remote: remote ?? "" })}`;
  return null;
}

export function rangeLine(range: ReleaseNotesRange): string {
  const base = range.from
    ? t("actions.tags.releaseNotes.range", { count: range.commits, from: range.from })
    : t("actions.tags.releaseNotes.rangeFromStart", { count: range.commits });
  return range.included < range.commits ? `${base} – ${t("actions.tags.releaseNotes.rangeCut", { included: range.included })}` : base;
}

export function doneLine(notes: ReleaseNotes): string {
  const { range } = notes;
  const base = range.from
    ? t("actions.tags.releaseNotes.drafted", { count: range.included, from: range.from })
    : t("actions.tags.releaseNotes.draftedFromStart", { count: range.included });
  return notes.unmentioned > 0 ? `${base} ${t("actions.tags.releaseNotes.unmentioned", { count: notes.unmentioned })}` : base;
}

export type NotesOutcome = { kind: "empty"; text: string } | Placement;

export function answerPlacement(current: string, atStart: string, notes: ReleaseNotes): NotesOutcome {
  if (!notes.markdown.trim()) {
    return { kind: "empty", text: notes.range.from ? t("actions.tags.releaseNotes.empty", { from: notes.range.from }) : t("actions.tags.releaseNotes.emptyFromStart") };
  }
  return placeSuggestion(current, atStart, notes.markdown);
}

export interface ReleaseNotesAvailability {
  /** The button and the menu entries are shown. */
  visible: boolean;
  /** AI on but no provider: a click opens the setup instead of sending. */
  openSetup: boolean;
  local: boolean;
  hostReleases: boolean;
  hostName: string | null;
  remote: string | null;
}

export function availabilityOf(status: AiStatus | null | undefined, repoAiOff: boolean, host: HostRepo | null): ReleaseNotesAvailability {
  const visible = featureVisible(status, "release_notes", repoAiOff);
  return {
    visible,
    openSetup: visible && aiVisibility(status).elementsOpenSetup,
    local: status?.local ?? false,
    hostReleases: Boolean(host?.kind && host.account && host.remote && host.capabilities.releases),
    hostName: host?.kind ? hostKindLabels[host.kind] : null,
    remote: host?.remote ?? null,
  };
}

/** "YYYY-MM-DD" of the local calendar day (the changelog's date). */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
