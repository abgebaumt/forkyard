/**
 * Writing settings: visible immediately (optimistic), the core confirms, or the UI jumps back and
 * reports the reason.
 */
import { core, type ErrorCode, type Id, type RepoSettings, type Settings } from "../../core";
import { qk, queryClient } from "../../app/queries";
import { runAction, type ActionResult } from "../../app/run";
import { enqueueWrite } from "../../app/writeQueue";
import { t } from "../../i18n";

/** Errors shown at the field itself and therefore not raising a toast. */
const FIELD_ERRORS: ErrorCode[] = ["invalid_name", "not_allowed", "name_exists"];

/**
 * Changes run one after another: each builds on the state the previous one left behind.
 * The queries for this data wait until then (see src/app/writeQueue.ts).
 */
export const enqueue = enqueueWrite;

/**
 * Changes global settings. `atField: true` means the caller shows input errors itself at the field.
 */
export function applySettings(patch: Partial<Settings>, options: { atField?: boolean; quiet?: ErrorCode[] } = {}): Promise<ActionResult<Settings>> {
  return enqueue(async () => {
    // A reload in progress would otherwise immediately overwrite the optimistic state again.
    await queryClient.cancelQueries({ queryKey: qk.settings });
    const previous = queryClient.getQueryData<Settings>(qk.settings);
    if (previous) queryClient.setQueryData<Settings>(qk.settings, { ...previous, ...patch });
    // `quiet`: further errors the caller shows itself at the field (e.g. `path_not_found` for a file path).
    const result = await runAction(t("preferences.save.setting"), () => core.settingsSet({ patch }), { quiet: options.quiet ?? (options.atField ? FIELD_ERRORS : undefined) });
    if (result.ok) {
      queryClient.setQueryData(qk.settings, result.value);
    } else {
      if (previous) queryClient.setQueryData(qk.settings, previous);
      void queryClient.invalidateQueries({ queryKey: qk.settings });
    }
    return result;
  });
}

/** Changes a repository's settings, also optimistically. */
export function applyRepoSettings(repoId: Id, patch: Partial<RepoSettings>, options: { atField?: boolean } = {}): Promise<ActionResult<RepoSettings>> {
  return enqueue(async () => {
    const key = qk.repoSettings(repoId);
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData<RepoSettings>(key);
    if (previous) queryClient.setQueryData<RepoSettings>(key, { ...previous, ...patch });
    const result = await runAction(t("preferences.save.repoSetting"), () => core.repoSettingsSet({ repoId, patch }), {
      quiet: options.atField ? FIELD_ERRORS : undefined,
    });
    if (result.ok) {
      queryClient.setQueryData(key, result.value);
    } else {
      if (previous) queryClient.setQueryData(key, previous);
      void queryClient.invalidateQueries({ queryKey: key });
    }
    return result;
  });
}

/** For `CommitText.onCommit`: the core's error text for the field, or null on success. runAction has already reported other errors. */
export function fieldError(result: ActionResult<unknown>): string | null {
  if (result.ok) return null;
  return FIELD_ERRORS.includes(result.error.code) ? result.error.message || t("preferences.save.notAllowed") : t("preferences.save.notSaved");
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** The same rule as in the core: something before and after the @, no spaces. Empty is allowed. */
export function checkEmail(value: string): string | null {
  if (!value) return null;
  return EMAIL.test(value) ? null : t("preferences.check.email");
}

/** Rough pre-check of a branch name; the core has the final word. */
export function checkBranchName(value: string): string | null {
  if (!value) return t("preferences.check.branchEmpty");
  if (/\s/.test(value)) return t("preferences.check.branchSpaces");
  if (/\.\.|[~^:?*[\\]|@\{/.test(value)) return t("preferences.check.branchChars");
  if (/^[-/.]|[/.]$|\.lock$|\/\//.test(value)) return t("preferences.check.branchEdges");
  return null;
}
