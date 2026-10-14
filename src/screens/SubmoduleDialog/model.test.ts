import { describe, expect, it } from "vitest";
import type { Submodule } from "../../core";
import { submoduleStateText } from "../../app/actions/submodules";
import { matchesSubmodule, moveTargetProblem, normalizePath, pathProblem, splitPath, submoduleSecondary, suggestPath } from "./model";
import { t } from "../../i18n";

const sub = (patch: Partial<Submodule>): Submodule => ({
  name: "libs/kern",
  path: "libs/kern",
  url: "https://git.example/gruppe/kern.git",
  sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  headSha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  state: "initialized",
  branch: null,
  trackingBranch: null,
  ...patch,
});

describe("submodule: path from the address", () => {
  it("takes the last part without .git", () => {
    expect(suggestPath("https://git.example/gruppe/wetter-symbole.git")).toBe("wetter-symbole");
    expect(suggestPath("git@git.example:werkzeuge/karten.git")).toBe("karten");
    expect(suggestPath("C:\\quellen\\sensor-treiber.git")).toBe("sensor-treiber");
  });
  it("returns nothing for an address that isn't one", () => {
    expect(suggestPath("")).toBe("");
    expect(suggestPath("ftp://server/x.git")).toBe("");
  });
});

describe("submodule: checking the path", () => {
  const existing = [{ path: "libs/kern" }];
  it("lets ordinary paths through and normalises the notation", () => {
    expect(pathProblem("libs/neu", existing)).toBeNull();
    expect(pathProblem("libs\\neu\\", existing)).toBeNull();
    expect(normalizePath(" ./libs\\neu/ ")).toBe("libs/neu");
  });
  it("names the reason for paths that don't work", () => {
    expect(pathProblem("", existing)).toMatch(/Enter the folder/);
    expect(pathProblem("/absolut", existing)).toMatch(/no drive/);
    expect(pathProblem("C:\\anderswo", existing)).toMatch(/no drive/);
    expect(pathProblem("../raus", existing)).toMatch(/leads out of the repository/);
    expect(pathProblem("a//b", existing)).toMatch(/folder name is missing/);
    expect(pathProblem(".git/x", existing)).toMatch(/belongs to Git/);
    expect(pathProblem("a/b?c", existing)).toMatch(/“\?”/);
    expect(pathProblem("a/con", existing)).toMatch(/reserved by Windows/);
    expect(pathProblem("ende./x", existing)).toMatch(/dot or space/);
  });
  it("detects taken and nested paths case-insensitively", () => {
    expect(pathProblem("Libs/Kern", existing)).toMatch(/already a submodule/);
    expect(pathProblem("libs/kern/unter", existing)).toMatch(/inside another submodule/);
    expect(pathProblem("libs/kern-zwei", existing)).toBeNull();
  });
});

describe("submodule: row", () => {
  it("states the state as a word, followed by the commit", () => {
    expect(submoduleSecondary(sub({}))).toBe(`${submoduleStateText.initialized} · 1111111`);
    expect(submoduleSecondary(sub({ state: "uninitialized", headSha: null }))).toBe(submoduleStateText.uninitialized);
    expect(submoduleSecondary(sub({ state: "out_of_sync", headSha: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }))).toBe(`${submoduleStateText.out_of_sync} · 2222222 instead of 1111111`);
    expect(submoduleSecondary(sub({ state: "modified", branch: "main" }))).toBe(`${submoduleStateText.modified} · 1111111 · main`);
  });
  it("splits the path into name and folder", () => {
    expect(splitPath("libs/kern")).toEqual({ name: "kern", dir: "libs/" });
    expect(splitPath("kern")).toEqual({ name: "kern", dir: "" });
  });
  it("filters by path, URL and name", () => {
    expect(matchesSubmodule(sub({}), "KERN")).toBe(true);
    expect(matchesSubmodule(sub({}), "git.example")).toBe(true);
    expect(matchesSubmodule(sub({}), "nirgends")).toBe(false);
    expect(matchesSubmodule(sub({ url: null }), "  ")).toBe(true);
  });
});

describe("submodule: move target", () => {
  const all = [sub({ path: "libs/kern" }), sub({ path: "libs/rand" })];
  it("accepts a free path inside the repository", () => {
    expect(moveTargetProblem("extern/kern", all[0]!, all)).toBeNull();
    expect(moveTargetProblem(" ./extern\\kern/ ", all[0]!, all)).toBeNull();
  });
  it("refuses the same place, other submodules, outside and the Git directory", () => {
    expect(moveTargetProblem("libs/kern", all[0]!, all)).toBe(t("submoduleMove.same"));
    expect(moveTargetProblem("libs/rand", all[0]!, all)).toBe(t("submodules.path.taken"));
    expect(moveTargetProblem("libs/kern/innen", all[0]!, all)).toBe(t("submodules.path.nested"));
    expect(moveTargetProblem("../draußen", all[0]!, all)).toBe(t("submodules.path.parent"));
    expect(moveTargetProblem(".git/x", all[0]!, all)).toBe(t("submodules.path.git"));
  });
});
