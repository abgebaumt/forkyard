/** Pure parts of the Gitflow dialogs: kinds, the setup and start checks. */
import type { GitflowKind, GitflowPrefixes, GitflowStatus } from "../../core";
import { t } from "../../i18n";

export const GITFLOW_KINDS: GitflowKind[] = ["feature", "release", "hotfix"];

export const kindLabels: Record<GitflowKind, string> = {
  feature: t("actions.gitflow.kind.feature"),
  release: t("actions.gitflow.kind.release"),
  hotfix: t("actions.gitflow.kind.hotfix"),
};

/** Spaces turn into "-" while typing (as with branch names everywhere in the app). */
export const dashed = (value: string) => value.replace(/\s/g, "-");

/**
 * The main branch choice: the local branches (or only the core's suggestion while none are known).
 * The chosen one applies as long as that branch exists; otherwise the checked-out or the first one.
 */
export function mainChoice(
  locals: string[],
  head: string | undefined,
  chosen: string,
  suggested: string,
): { options: string[]; value: string } {
  const options = locals.length ? locals : [suggested];
  return { options, value: options.includes(chosen) ? chosen : (head ?? options[0] ?? chosen) };
}

/** What stops setting Gitflow up: develop missing or equal to main, an empty or duplicate prefix. */
export function setupBlocked(
  develop: string,
  main: string,
  prefixes: GitflowPrefixes,
): { developError: string | null; prefixError: string | null; blocked: string | null } {
  const developError = develop !== "" && develop === main ? t("gitflow.setup.sameBranch") : null;
  const emptyPrefix = GITFLOW_KINDS.find((kind) => !prefixes[kind].trim());
  const duplicate = new Set(GITFLOW_KINDS.map((kind) => prefixes[kind].trim())).size < GITFLOW_KINDS.length;
  const prefixError = emptyPrefix
    ? t("gitflow.setup.prefixMissing", { kind: kindLabels[emptyPrefix] })
    : duplicate
      ? t("gitflow.setup.prefixDuplicate")
      : null;
  return { developError, prefixError, blocked: !develop ? t("gitflow.setup.developMissing") : (developError ?? prefixError) };
}

/** What stops starting a branch; `reason`: Git's objection to the name (checked while typing). */
export function startBlocked(input: {
  ready: boolean;
  operation: boolean;
  running: GitflowStatus["active"][number] | undefined;
  kind: GitflowKind;
  name: string;
  reason: string | null;
}): string | null {
  const { running } = input;
  if (!input.ready) return t("gitflow.start.notReady");
  if (input.operation) return t("gitflow.start.operation");
  if (running) return t("gitflow.start.running", { kind: kindLabels[input.kind], name: running.name, branch: running.branch });
  if (!input.name.trim()) return t("gitflow.start.nameMissing");
  return input.reason;
}
