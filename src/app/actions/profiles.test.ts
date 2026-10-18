import { describe, expect, it } from "vitest";
import { profileColor, switchAuthorNote, switchLosses, switchWarning } from "./profiles";

describe("profileColor", () => {
  it("takes the stored colour, otherwise the position in the list", () => {
    expect(profileColor({ color: 4 }, 0)).toBe(4);
    expect(profileColor({ color: null }, 0)).toBe(1);
    expect(profileColor({ color: null }, 7)).toBe(8);
    expect(profileColor({ color: null }, 9)).toBe(2);
  });
});

describe("switchWarning", () => {
  const nothing = { files: [], views: false, jobs: [], agents: 0 };
  it("without open work there is no prompt", () => {
    expect(switchWarning(nothing)).toBeNull();
  });
  it("names running actions, unsaved views and files", () => {
    expect(switchWarning({ ...nothing, jobs: ["Push"] })).toContain("“Push” is still running");
    expect(switchWarning({ ...nothing, jobs: ["Push", "Fetch"] })).toContain("2 actions are still running");
    expect(switchWarning({ ...nothing, views: true })).toContain("unsaved work");
    expect(switchWarning({ ...nothing, files: ["a.txt", "b.txt"] })).toContain("2 files");
  });
});

describe("switchLosses", () => {
  it("counts every running action, not only those with a prompt on quit", () => {
    const job = (title: string, askBeforeQuit: boolean) => ({ id: title, title, repoId: null, phase: "", percent: null, line: "", startedAt: 0, askBeforeQuit });
    const now = switchLosses({ jobs: { a: job("Push", false), b: job("Klonen", true) }, busy: {} }, [], false);
    expect(now.jobs).toEqual(["Push", "Klonen"]);
  });
  it("also counts actions that only run as \"busy\" (e.g. a commit)", () => {
    expect(switchLosses({ jobs: {}, busy: { "r1:commit": true } }, [], false).jobs).toEqual(["A Git action"]);
    expect(switchLosses({ jobs: {}, busy: {} }, ["a.txt"], true)).toEqual({ jobs: [], files: ["a.txt"], views: true, agents: 0 });
  });
});

describe("switchAuthorNote", () => {
  it("promises the profile's author only when the profile writes it to the global gitconfig", () => {
    expect(switchAuthorNote({ authorName: "Lena Firma", syncGitconfig: true })).toBe("Commits are now authored by Lena Firma.");
    // Without sync Git keeps the identity from its own configuration.
    expect(switchAuthorNote({ authorName: "Lena Firma", syncGitconfig: false })).toBeUndefined();
    expect(switchAuthorNote({ authorName: "  ", syncGitconfig: true })).toBeUndefined();
  });
});
