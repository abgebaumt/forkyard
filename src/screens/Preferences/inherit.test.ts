import { describe, expect, it } from "vitest";
import type { RepoSettings } from "../../core";
import { DEFAULT_SETTINGS } from "./defaults";
import { inheritedValue, overridePatch, ownCount, resetPatch, type InheritContext } from "./inherit";

const profile = { id: "p", name: "Privat", authorName: "Max Muster", authorEmail: "max@muster.example", syncGitconfig: true, isActive: true, color: 2 };
const ctx: InheritContext = { profile, settings: { ...DEFAULT_SETTINGS, defaultPullMode: "rebase", autoFetchMinutes: 15 }, defaultKeyId: "k1" };
const base: RepoSettings = {
  encoding: "utf-8",
  hooksPath: null,
  commitTemplate: null,
  commitTemplateText: null,
  defaultPullMode: null,
  autoFetch: true,
  authorName: null,
  authorEmail: null,
  sshKeyId: null,
  submodulesAutoUpdate: true,
  testCommand: null,
  linkRules: { hostRules: true, presets: [], custom: [] },
  aiReviewBeforePush: false,
  secretScanIgnoredCount: 0,
  aiOff: false,
  aiCommitInstruction: null,
};

describe("inheritance in the project", () => {
  it("without an own value the profile's applies", () => {
    expect(inheritedValue("authorEmail", base, ctx)).toEqual({ own: false, value: "max@muster.example", inherited: "max@muster.example" });
    expect(inheritedValue("defaultPullMode", base, ctx).value).toBe("rebase");
    expect(inheritedValue("sshKeyId", base, ctx).value).toBe("k1");
  });
  it("an own value wins and is counted per group", () => {
    const repo = { ...base, authorEmail: "max@forkyard.dev", sshKeyId: "k2" };
    expect(inheritedValue("authorEmail", repo, ctx)).toEqual({ own: true, value: "max@forkyard.dev", inherited: "max@muster.example" });
    expect(ownCount(repo, ["authorName", "authorEmail", "sshKeyId"])).toBe(2);
    expect(ownCount(repo, ["defaultPullMode", "autoFetch"])).toBe(0);
  });
  it("an empty own name does not count as an own value", () => {
    expect(inheritedValue("authorName", { ...base, authorName: "  " }, ctx).own).toBe(false);
  });
  it("auto-fetch off in the project is an own value", () => {
    expect(inheritedValue("autoFetch", base, ctx).own).toBe(false);
    expect(inheritedValue("autoFetch", { ...base, autoFetch: false }, ctx).own).toBe(true);
    expect(resetPatch("autoFetch")).toEqual({ autoFetch: true });
    expect(overridePatch("autoFetch", ctx)).toEqual({ autoFetch: false });
  });
  it("override takes over the inherited value, reset clears it", () => {
    expect(overridePatch("authorName", ctx)).toEqual({ authorName: "Max Muster" });
    expect(overridePatch("sshKeyId", ctx)).toEqual({ sshKeyId: "k1" });
    expect(overridePatch("defaultPullMode", ctx)).toEqual({ defaultPullMode: "rebase" });
    expect(resetPatch("authorName")).toEqual({ authorName: null });
    expect(resetPatch("sshKeyId")).toEqual({ sshKeyId: null });
  });
});
