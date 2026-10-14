import { describe, expect, it } from "vitest";
import { t } from "../../i18n";
import { submoduleWarning } from "./submodules";

describe("submodule follow-up job", () => {
  it("stays quiet on success", () => {
    expect(submoduleWarning({ repoId: "r", ok: true, paths: ["libs/a"], message: null })).toBeNull();
  });

  it("warns with the reason and the affected submodules", () => {
    const warning = submoduleWarning({ repoId: "r", ok: false, paths: ["a", "b", "c", "d"], message: "Local changes in a submodule are in the way." });
    expect(warning?.title).toBe(t("submoduleSync.failedTitle"));
    expect(warning?.description).toBe(`Local changes in a submodule are in the way.\n${t("submoduleSync.failedPaths", { paths: "a, b, c …" })}`);
  });
});
