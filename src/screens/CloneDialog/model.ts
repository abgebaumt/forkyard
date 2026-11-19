/** Pure parts of the clone dialog: field checks, options, error mapping and texts. */
import type { CloneOptions, CoreError, ErrorCode } from "../../core";
import { branchNameError, folderNameError, isAbsolutePath } from "../../app/osPaths";
import { t } from "../../i18n";
import type { UrlCheck } from "./url";

export type FieldName = "url" | "parent" | "name" | "depth" | "since" | "branch" | "sparse";

/** The order the fields appear in (the first bad one takes the focus). */
export const FIELD_ORDER: FieldName[] = ["url", "parent", "name", "depth", "since", "branch", "sparse"];

/** Fields inside "Advanced" (it opens when one of them needs attention). */
export const isAdvancedField = (field: FieldName) => field === "depth" || field === "since" || field === "branch" || field === "sparse";

export interface CloneForm {
  url: string;
  parent: string;
  name: string;
  shallow: boolean;
  shallowBy: "depth" | "since";
  depth: string;
  since: string;
  branch: string;
  sparse: boolean;
  sparseText: string;
  submodules: boolean;
}

/** What can go wrong while cloning – in our own words, with the next step. */
export const CLONE_ERRORS: Partial<Record<ErrorCode, { title: string; hint: string; field?: FieldName }>> = {
  auth_failed: { title: t("ui.signInRejected"), hint: t("clone.errors.authFailed.hint") },
  offline: { title: t("ui.serverNotReachable"), hint: t("clone.errors.offline.hint") },
  not_found: { title: t("clone.errors.notFound.title"), hint: t("clone.errors.notFound.hint"), field: "url" },
  path_exists: { title: t("clone.errors.pathExists.title"), hint: t("clone.errors.pathExists.hint"), field: "name" },
  path_not_found: { title: t("clone.errors.pathNotFound.title"), hint: t("clone.errors.pathNotFound.hint"), field: "parent" },
  host_key_unknown: { title: t("clone.errors.hostKeyUnknown.title"), hint: t("clone.errors.hostKeyUnknown.hint") },
  timeout: { title: t("clone.errors.timeout.title"), hint: t("clone.errors.timeout.hint") },
  invalid_name: { title: t("clone.errors.invalidName"), hint: "", field: "name" },
  not_allowed: { title: t("clone.errors.notAllowed"), hint: "" },
};

/** Phases as Git reports them → our own words. */
export function phaseLabel(phase: string): string {
  const key = phase.toLowerCase();
  if (key.startsWith("enumerating") || key.startsWith("counting")) return t("clone.phase.enumerating");
  if (key.startsWith("compressing")) return t("clone.phase.compressing");
  if (key.startsWith("receiving")) return t("ui.transferringData");
  if (key.startsWith("resolving")) return t("ui.assemblingTheHistory");
  if (key.startsWith("updating files") || key.startsWith("checking out")) return t("ui.checkingOutFiles");
  if (key.startsWith("sparse")) return t("clone.phase.sparse");
  if (key.startsWith("filtering")) return t("clone.phase.filtering");
  return t("ui.connecting");
}

export function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
  );
}

/** One path per line, blank lines dropped. */
export const sparseLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The message under each field. `submitted`: empty required fields count only after the first
 * attempt. `failureFor`: a core error that belongs to the field. `knownAtTarget`: a repository the
 * app already lists at the target folder.
 */
export function fieldErrors(
  form: CloneForm,
  ctx: {
    parsed: UrlCheck;
    submitted: boolean;
    knownAtTarget: { alias: string | null; name: string } | undefined;
    failureFor: (field: FieldName) => string | null;
  },
): Record<FieldName, string | null> {
  const { parsed, submitted, knownAtTarget, failureFor } = ctx;
  const { url, parent, name, shallow, shallowBy, depth, since, branch, sparse } = form;
  return {
    url: url.trim() ? (parsed.ok ? failureFor("url") : parsed.reason) : submitted ? t("clone.validation.urlMissing") : null,
    parent: parent.trim()
      ? isAbsolutePath(parent)
        ? failureFor("parent")
        : t("clone.validation.parentNotAbsolute")
      : submitted
        ? t("clone.validation.parentMissing")
        : null,
    name: name
      ? (folderNameError(name) ??
        (knownAtTarget ? t("clone.validation.repoAtTarget", { name: knownAtTarget.alias ?? knownAtTarget.name }) : null) ??
        failureFor("name"))
      : submitted
        ? t("clone.folderName.missing")
        : null,
    depth: shallow && shallowBy === "depth" && !/^[1-9]\d{0,8}$/.test(depth.trim()) ? t("clone.validation.depth") : null,
    since:
      shallow && shallowBy === "since"
        ? since.trim()
          ? isRealDate(since.trim())
            ? null
            : t("clone.validation.dateFormat")
          : submitted
            ? t("clone.validation.dateMissing")
            : null
        : null,
    branch: branchNameError(branch.trim()) ?? failureFor("branch"),
    sparse: sparse && submitted && sparseLines(form.sparseText).length === 0 ? t("clone.validation.sparseMissing") : null,
  };
}

/**
 * The first field that stops a clone attempt: empty required fields, then field errors of our own.
 * Core errors on a field do not count: the same attempt may be repeated (e.g. after the folder was emptied).
 */
export function firstBadField(
  form: CloneForm,
  errors: Record<FieldName, string | null>,
  failureFor: (field: FieldName) => string | null,
): FieldName | undefined {
  const required: Partial<Record<FieldName, boolean>> = {
    url: !form.url.trim(),
    parent: !form.parent.trim(),
    name: !form.name,
    since: form.shallow && form.shallowBy === "since" && !form.since.trim(),
    sparse: form.sparse && sparseLines(form.sparseText).length === 0,
  };
  return FIELD_ORDER.find((field) => required[field] || (errors[field] !== null && errors[field] !== failureFor(field)));
}

export function cloneOptions(form: CloneForm): CloneOptions {
  return {
    depth: form.shallow && form.shallowBy === "depth" ? Number(form.depth.trim()) : null,
    shallowSince: form.shallow && form.shallowBy === "since" ? form.since.trim() : null,
    branch: form.branch.trim() || null,
    sparsePaths: form.sparse ? sparseLines(form.sparseText) : [],
    recurseSubmodules: form.submodules,
  };
}

/** The field a failed clone points at, with the text shown under it; null if it belongs to none. */
export function failureField(error: CoreError, branch: string | null): { field: FieldName; text: string } | null {
  // “Invalid branch name” and a missing branch belong to the branch field.
  const field: FieldName | undefined = /branch/i.test(error.message) && branch ? "branch" : CLONE_ERRORS[error.code]?.field;
  if (!field) return null;
  const text =
    error.code === "path_exists"
      ? t("clone.errors.fieldPathExists")
      : error.code === "path_not_found"
        ? t("clone.errors.fieldPathNotFound")
        : error.code === "not_found" && field === "url"
          ? t("clone.errors.fieldNotFound")
          : error.message;
  return { field, text };
}

/** The line under the closed "Advanced" section. */
export function advancedSummary(form: CloneForm): string[] {
  return [
    form.shallow
      ? form.shallowBy === "depth"
        ? t("clone.summary.depth", { depth: form.depth.trim() || "?" })
        : t("clone.summary.since", { date: form.since.trim() || "?" })
      : null,
    form.branch.trim() ? t("clone.summary.branch", { branch: form.branch.trim() }) : null,
    form.sparse ? t("ui.sparseCheckout") : null,
    form.submodules ? t("clone.summary.submodules") : null,
  ].filter((part): part is string => Boolean(part));
}
