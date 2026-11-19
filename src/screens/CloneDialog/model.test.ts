import { describe, expect, it } from "vitest";
import { CoreError } from "../../core";
import { t } from "../../i18n";
import {
  advancedSummary,
  cloneOptions,
  failureField,
  fieldErrors,
  firstBadField,
  isRealDate,
  phaseLabel,
  sparseLines,
  type CloneForm,
  type FieldName,
} from "./model";
import { parseCloneUrl } from "./url";

const form = (patch: Partial<CloneForm> = {}): CloneForm => ({
  url: "https://github.com/anna/wetter.git",
  parent: "/home/anna/projekte",
  name: "wetter",
  shallow: false,
  shallowBy: "depth",
  depth: "1",
  since: "",
  branch: "",
  sparse: false,
  sparseText: "",
  submodules: false,
  ...patch,
});
const none = (_field: FieldName): string | null => null;
const errorsOf = (f: CloneForm, submitted = true, failureFor = none) =>
  fieldErrors(f, { parsed: parseCloneUrl(f.url), submitted, knownAtTarget: undefined, failureFor });

describe("clone dialog fields", () => {
  it("a complete form has no errors and no bad field", () => {
    const f = form();
    const errors = errorsOf(f);
    expect(Object.values(errors).every((error) => error === null)).toBe(true);
    expect(firstBadField(f, errors, none)).toBeUndefined();
  });

  it("empty required fields only complain after the first attempt", () => {
    const f = form({ url: "", parent: "", name: "" });
    expect(errorsOf(f, false).url).toBeNull();
    expect(errorsOf(f, true).url).toBe(t("clone.validation.urlMissing"));
    expect(errorsOf(f, true).parent).toBe(t("clone.validation.parentMissing"));
    expect(firstBadField(f, errorsOf(f, false), none), "required counts before submitting").toBe("url");
  });

  it("checks a relative folder, the depth, the date and the sparse paths", () => {
    expect(errorsOf(form({ parent: "projekte" })).parent).toBe(t("clone.validation.parentNotAbsolute"));
    expect(errorsOf(form({ shallow: true, depth: "0" })).depth).toBe(t("clone.validation.depth"));
    expect(errorsOf(form({ shallow: true, depth: "12" })).depth).toBeNull();
    expect(errorsOf(form({ shallow: false, depth: "x" })).depth, "only while shallow").toBeNull();
    expect(errorsOf(form({ shallow: true, shallowBy: "since", since: "2026-02-30" })).since).toBe(t("clone.validation.dateFormat"));
    expect(errorsOf(form({ shallow: true, shallowBy: "since", since: "" })).since).toBe(t("clone.validation.dateMissing"));
    expect(errorsOf(form({ sparse: true, sparseText: " \n" })).sparse).toBe(t("clone.validation.sparseMissing"));
  });

  it("names a repository the app already lists at the target", () => {
    const errors = fieldErrors(form(), {
      parsed: parseCloneUrl(form().url),
      submitted: false,
      knownAtTarget: { alias: "Wetter", name: "wetter" },
      failureFor: none,
    });
    expect(errors.name).toBe(t("clone.validation.repoAtTarget", { name: "Wetter" }));
  });

  it("a core error on a field shows, but does not stop a new attempt", () => {
    const failureFor = (field: FieldName) => (field === "name" ? "exists" : null);
    const f = form();
    const errors = errorsOf(f, true, failureFor);
    expect(errors.name).toBe("exists");
    expect(firstBadField(f, errors, failureFor)).toBeUndefined();
  });

  it("the first bad field follows the field order", () => {
    const f = form({ parent: "", shallow: true, depth: "0" });
    expect(firstBadField(f, errorsOf(f), none)).toBe("parent");
    const g = form({ shallow: true, depth: "0", branch: "-x" });
    expect(firstBadField(g, errorsOf(g), none)).toBe("depth");
  });
});

describe("clone options and errors", () => {
  it("builds the options from the form", () => {
    expect(cloneOptions(form())).toEqual({ depth: null, shallowSince: null, branch: null, sparsePaths: [], recurseSubmodules: false });
    expect(
      cloneOptions(form({ shallow: true, depth: " 5 ", branch: " dev ", sparse: true, sparseText: "src\r\n\n docs ", submodules: true })),
    ).toEqual({ depth: 5, shallowSince: null, branch: "dev", sparsePaths: ["src", "docs"], recurseSubmodules: true });
    expect(cloneOptions(form({ shallow: true, shallowBy: "since", since: " 2026-01-02 " })).shallowSince).toBe("2026-01-02");
    expect(cloneOptions(form({ sparse: false, sparseText: "src" })).sparsePaths).toEqual([]);
  });

  it("points a failure at its field with our own text", () => {
    const error = (code: CoreError["code"], message = "") => new CoreError({ code, message, gitOutput: null });
    expect(failureField(error("path_exists"), null)).toEqual({ field: "name", text: t("clone.errors.fieldPathExists") });
    expect(failureField(error("path_not_found"), null)).toEqual({ field: "parent", text: t("clone.errors.fieldPathNotFound") });
    expect(failureField(error("not_found"), null)).toEqual({ field: "url", text: t("clone.errors.fieldNotFound") });
    expect(failureField(error("not_found", "Remote branch dev not found"), "dev")).toEqual({
      field: "branch",
      text: "Remote branch dev not found",
    });
    expect(failureField(error("offline"), null)).toBeNull();
  });

  it("summarises the advanced options", () => {
    expect(advancedSummary(form())).toEqual([]);
    expect(advancedSummary(form({ shallow: true, depth: "", branch: "dev", submodules: true }))).toEqual([
      t("clone.summary.depth", { depth: "?" }),
      t("clone.summary.branch", { branch: "dev" }),
      t("clone.summary.submodules"),
    ]);
  });

  it("reads real dates, sparse lines and Git's phases", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2023-02-29")).toBe(false);
    expect(isRealDate("2024-2-1")).toBe(false);
    expect(sparseLines(" a \n\r\nb")).toEqual(["a", "b"]);
    expect(phaseLabel("Receiving objects")).toBe(t("clone.phase.receiving"));
    expect(phaseLabel("Checking out files")).toBe(t("clone.phase.checkout"));
    expect(phaseLabel("")).toBe(t("clone.phase.connecting"));
  });
});
