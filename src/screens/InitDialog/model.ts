/** Pure parts of the init dialog: field checks and where a failure points. */
import type { CoreError } from "../../core";
import { branchNameError, folderNameError, isAbsolutePath } from "../../app/osPaths";
import { t } from "../../i18n";

export type FieldName = "name" | "parent" | "branch";

export interface InitForm {
  name: string;
  parent: string;
  branch: string;
}

/**
 * The message under each field. `submitted`: empty fields count only after the first attempt.
 * `failureFor`: a core error that belongs to the field. `knownAtTarget`: a repository the app
 * already lists at the target folder.
 */
export function fieldErrors(
  form: InitForm,
  ctx: {
    submitted: boolean;
    knownAtTarget: { alias: string | null; name: string } | undefined;
    failureFor: (field: FieldName) => string | null;
  },
): Record<FieldName, string | null> {
  const { name, parent, branch } = form;
  const { submitted, knownAtTarget, failureFor } = ctx;
  return {
    name: name
      ? (folderNameError(name) ??
        (knownAtTarget ? t("clone.validation.repoAtTarget", { name: knownAtTarget.alias ?? knownAtTarget.name }) : null) ??
        failureFor("name"))
      : submitted
        ? t("init.validation.nameMissing")
        : null,
    parent: parent.trim()
      ? isAbsolutePath(parent)
        ? failureFor("parent")
        : t("clone.validation.parentNotAbsolute")
      : submitted
        ? t("init.validation.parentMissing")
        : null,
    branch: branch.trim()
      ? (branchNameError(branch.trim()) ?? failureFor("branch"))
      : submitted
        ? t("init.validation.branchMissing")
        : null,
  };
}

/** The first field that stops an attempt; core errors on a field do not (the same attempt may be repeated). */
export function firstBadField(
  form: InitForm,
  errors: Record<FieldName, string | null>,
  failureFor: (field: FieldName) => string | null,
): FieldName | undefined {
  const required: Record<FieldName, boolean> = { name: !form.name, parent: !form.parent.trim(), branch: !form.branch.trim() };
  const order: FieldName[] = ["name", "parent", "branch"];
  return order.find((field) => required[field] || (errors[field] !== null && errors[field] !== failureFor(field)));
}

/**
 * The field a failed init points at, with its text; null for an error shown as a banner.
 * A duplicate request is not shown at all (the caller checks that first).
 */
export function failureField(error: CoreError): { field: FieldName; text: string } | null {
  if (error.code === "path_exists") return { field: "name", text: t("init.validation.pathExists") };
  if (error.code === "path_not_found") return { field: "parent", text: t("init.validation.pathNotFound") };
  if (error.code === "invalid_name") return { field: /branch/i.test(error.message) ? "branch" : "name", text: error.message };
  return null;
}
