import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Menu actions run once the menu has closed (next frame).
vi.stubGlobal("window", { requestAnimationFrame: (run: (time: number) => void) => run(0), setTimeout: (run: () => void) => run() });

import type { FileChange, Ref, RefsSnapshot, Stash, Status } from "../../core";
import type { MenuAction, MenuEntry } from "../../ui/Menu";
import { qk, queryClient } from "../queries";
import { branchMenu, fileMenu } from "./entries";

const stash: Stash = { index: 0, sha: "a".repeat(40), message: "Halbfertig", branch: "main", baseSha: "c".repeat(40), createdAt: "2026-10-15T08:00:00Z", fileCount: 2 };
const file = (path: string, status: FileChange["status"]) => ({ path, status }) as unknown as FileChange;
const find = (entries: MenuEntry[], label: string) => entries.find((entry): entry is MenuAction => "label" in entry && entry.label === label);

describe("file menu of a stash", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (name: string) => {
      if (name === "stash_list") return [stash];
      if (name === "status_get") return { unstaged: [], staged: [], conflicted: [] };
      return { unstaged: [], staged: [], conflicted: [] };
    });
    queryClient.setQueryData(qk.stashes("r1"), [stash]);
  });

  it("applies an untracked file through the stash itself, not as a file of the stash commit", async () => {
    const entries = fileMenu({ repoId: "r1", tabId: "t1", files: [file("notizen/neu.txt", "untracked")], source: { kind: "stash", index: 0 } });
    const apply = find(entries, "Apply only this file from the stash …");
    expect(apply?.disabled).toBeFalsy();
    apply!.onSelect!();
    await vi.waitFor(() => expect(invoke.mock.calls.map(([name]) => name)).toContain("stash_apply_paths"));
    const call = invoke.mock.calls.find(([name]) => name === "stash_apply_paths")!;
    expect(call[1]).toMatchObject({ repoId: "r1", index: 0, paths: ["notizen/neu.txt"] });
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("file_restore");
  });

  it("restores tracked files from the stash commit and untracked ones through the stash, found again by SHA", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "stash_list") return [{ ...stash, index: 0, sha: "b".repeat(40) }, { ...stash, index: 1 }];
      return { unstaged: [], staged: [], conflicted: [] };
    });
    const entries = fileMenu({ repoId: "r1", tabId: "t1", files: [file("a.txt", "modified"), file("notizen/neu.txt", "untracked")], source: { kind: "stash", index: 0 } });
    find(entries, "Apply only these 2 files from the stash …")!.onSelect!();
    await vi.waitFor(() => expect(invoke.mock.calls.map(([name]) => name)).toContain("stash_apply_paths"));
    expect(invoke.mock.calls.find(([name]) => name === "file_restore")![1]).toMatchObject({ sha: stash.sha, paths: ["a.txt"] });
    expect(invoke.mock.calls.find(([name]) => name === "stash_apply_paths")![1]).toMatchObject({ index: 1, paths: ["notizen/neu.txt"] });
  });

  it("says that an untracked file comes back untracked", () => {
    const entries = fileMenu({ repoId: "r1", tabId: "t1", files: [file("notizen/neu.txt", "untracked")], source: { kind: "stash", index: 0 } });
    expect(find(entries, "Apply only this file from the stash …")?.hint).toBe("new file from the stash, stays untracked");
  });
});

const ref = (partial: Partial<Ref>): Ref => ({
  name: "",
  fullName: "",
  kind: "local",
  sha: "a".repeat(40),
  isHead: false,
  upstream: null,
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  remote: null,
  annotation: null,
  isAnnotated: false,
  worktreePath: null,
  ...partial,
});

describe("deleting a branch on the remote", () => {
  const remote = ref({ name: "origin/feature/hafen", fullName: "refs/remotes/origin/feature/hafen", kind: "remote", remote: "origin" });
  const local = ref({ name: "hafen", fullName: "refs/heads/hafen", upstream: "origin/feature/hafen" });
  const last = (entries: MenuEntry[]) => entries[entries.length - 1] as MenuAction;

  beforeEach(() => {
    queryClient.clear();
    queryClient.setQueryData(qk.refs("r1"), { locals: [local], remotes: [remote], tags: [] } as unknown as RefsSnapshot);
    queryClient.setQueryData(qk.remotes("r1"), [{ name: "origin" }]);
    queryClient.setQueryData(qk.status("r1"), { operation: null } as unknown as Status);
  });

  it("is the last entry of a remote branch, in its own group, red", () => {
    const entries = branchMenu({ repoId: "r1", tabId: "t1", ref: remote });
    const entry = last(entries);
    expect(entry.label).toBe("Delete “feature/hafen” on origin …");
    expect(entry.danger).toBe(true);
    expect(entry.disabled).toBeFalsy();
    expect(entries[entries.length - 2]).toEqual({ type: "separator" });
  });

  it("is blocked while a merge is running, with the reason", () => {
    queryClient.setQueryData(qk.status("r1"), { operation: { kind: "merge" } } as unknown as Status);
    const entry = last(branchMenu({ repoId: "r1", tabId: "t1", ref: remote }));
    expect(entry.label).toBe("Delete “feature/hafen” on origin …");
    expect(entry.disabled).toBe(true);
    expect(entry.hint).toMatch(/^finish the running merge first$/);
  });

  it("a local branch with an upstream offers to delete the upstream on the remote next to delete", () => {
    const entries = branchMenu({ repoId: "r1", tabId: "t1", ref: local });
    const labels = entries.flatMap((entry) => ("label" in entry ? [entry.label] : []));
    expect(labels.slice(-2)).toEqual(["Delete “hafen” …", "Delete “origin/feature/hafen” on remote …"]);
    expect(find(entries, "Delete “origin/feature/hafen” on remote …")?.danger).toBe(true);
  });

  it("not for a local branch without upstream or with a gone upstream", () => {
    for (const plain of [ref({ name: "solo", fullName: "refs/heads/solo" }), ref({ name: "alt", fullName: "refs/heads/alt", upstream: "origin/alt", upstreamGone: true })]) {
      const labels = branchMenu({ repoId: "r1", tabId: "t1", ref: plain }).flatMap((entry) => ("label" in entry ? [entry.label] : []));
      expect(labels.some((label) => /on remote/.test(label))).toBe(false);
    }
  });
});

describe("release notes in the tag menu", () => {
  const tag = ref({ name: "v1.1.0", fullName: "refs/tags/v1.1.0", kind: "tag" });
  const on = { state: "on", provider: "ollama", model: "qwen3:8b", connected: true, keyHint: null, local: true, price: null, introPending: false, featuresOff: [] as string[] };
  const entries = () => branchMenu({ repoId: "r1", tabId: "t1", ref: tag });

  beforeEach(() => {
    queryClient.clear();
    queryClient.setQueryData(qk.remotes("r1"), []);
  });

  it("offers “Write release notes …” while AI is on for this repository", () => {
    queryClient.setQueryData(qk.aiStatus, on);
    queryClient.setQueryData(qk.repoSettings("r1"), { aiOff: false });
    expect(find(entries(), "Write release notes …")).toBeTruthy();
  });

  it("hides it when AI is not set up, off, the function is off, the repository has AI off or its settings are unknown", () => {
    const cases: [object | undefined, object | undefined][] = [
      [undefined, { aiOff: false }],
      [{ ...on, state: "unset" }, { aiOff: false }],
      [{ ...on, state: "off" }, { aiOff: false }],
      [{ ...on, featuresOff: ["release_notes"] }, { aiOff: false }],
      [on, { aiOff: true }],
      [on, undefined],
    ];
    for (const [status, settings] of cases) {
      queryClient.clear();
      queryClient.setQueryData(qk.remotes("r1"), []);
      if (status) queryClient.setQueryData(qk.aiStatus, status);
      if (settings) queryClient.setQueryData(qk.repoSettings("r1"), settings);
      expect(find(entries(), "Write release notes …"), JSON.stringify({ status, settings })).toBeUndefined();
    }
  });
});
