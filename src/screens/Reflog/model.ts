/** Pure helpers of the reflog view: the ref filter and the action names. */
import type { ReflogAction, RefsSnapshot } from "../../core";
import type { SelectOption } from "../../ui/Select";
import { t } from "../../i18n";

/** Filter value for HEAD (the select list needs a non-empty value). */
export const HEAD_VALUE = "HEAD";

export const refValue = (ref: string | null): string => ref ?? HEAD_VALUE;
export const refFromValue = (value: string): string | null => (value === HEAD_VALUE ? null : value);

/** HEAD first, then the local branches; a remote branch opened from its menu stays selectable. */
export function refOptions(refs: RefsSnapshot | undefined, current: string | null): SelectOption[] {
  const options: SelectOption[] = [{ value: HEAD_VALUE, label: "HEAD" }];
  for (const ref of refs?.locals ?? []) options.push({ value: ref.fullName, label: ref.name });
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current.replace(/^refs\/(heads|remotes)\//, "") });
  }
  return options;
}

const ACTION_LABELS: Record<ReflogAction, string> = {
  checkout: t("reflog.action.checkout"),
  commit: t("reflog.action.commit"),
  reset: t("reflog.action.reset"),
  rebase: t("reflog.action.rebase"),
  merge: t("reflog.action.merge"),
  pull: t("reflog.action.pull"),
  cherry_pick: t("reflog.action.cherryPick"),
  amend: t("reflog.action.amend"),
  other: t("reflog.action.other"),
};

export const actionLabel = (action: ReflogAction): string => ACTION_LABELS[action];
