import { describe, expect, it } from "vitest";
import { CoreError } from "../../core";
import { t } from "../../i18n";
import { failureField, fieldErrors, firstBadField, type FieldName } from "./model";

const none = (_field: FieldName): string | null => null;
const form = { name: "wetter", parent: "/home/anna/projekte", branch: "main" };

describe("init dialog fields", () => {
  it("a complete form passes", () => {
    const errors = fieldErrors(form, { submitted: true, knownAtTarget: undefined, failureFor: none });
    expect(errors).toEqual({ name: null, parent: null, branch: null });
    expect(firstBadField(form, errors, none)).toBeUndefined();
  });

  it("empty fields complain only after the first attempt but always stop it", () => {
    const empty = { name: "", parent: " ", branch: "" };
    expect(fieldErrors(empty, { submitted: false, knownAtTarget: undefined, failureFor: none })).toEqual({
      name: null,
      parent: null,
      branch: null,
    });
    const errors = fieldErrors(empty, { submitted: true, knownAtTarget: undefined, failureFor: none });
    expect(errors.branch).toBe(t("init.validation.branchMissing"));
    expect(firstBadField(empty, errors, none)).toBe("name");
  });

  it("checks the folder, a known repository there and the branch name", () => {
    const ctx = { submitted: false, knownAtTarget: { alias: null, name: "wetter" }, failureFor: none };
    expect(fieldErrors(form, ctx).name).toBe(t("clone.validation.repoAtTarget", { name: "wetter" }));
    expect(fieldErrors({ ...form, parent: "projekte" }, { ...ctx, knownAtTarget: undefined }).parent).toBe(
      t("clone.validation.parentNotAbsolute"),
    );
    expect(fieldErrors({ ...form, branch: "a..b" }, { ...ctx, knownAtTarget: undefined }).branch).not.toBeNull();
  });

  it("a core error on a field shows but does not stop a retry", () => {
    const failureFor = (field: FieldName) => (field === "name" ? "exists" : null);
    const errors = fieldErrors(form, { submitted: true, knownAtTarget: undefined, failureFor });
    expect(errors.name).toBe("exists");
    expect(firstBadField(form, errors, failureFor)).toBeUndefined();
  });
});

describe("init failures", () => {
  const error = (code: CoreError["code"], message = "") => new CoreError({ code, message, gitOutput: null });

  it("points at the field the failure belongs to", () => {
    expect(failureField(error("path_exists"))).toEqual({ field: "name", text: t("init.validation.pathExists") });
    expect(failureField(error("path_not_found"))).toEqual({ field: "parent", text: t("init.validation.pathNotFound") });
    expect(failureField(error("invalid_name", "invalid branch name"))).toEqual({ field: "branch", text: "invalid branch name" });
    expect(failureField(error("invalid_name", "bad folder"))).toEqual({ field: "name", text: "bad folder" });
    expect(failureField(error("io"))).toBeNull();
  });
});
