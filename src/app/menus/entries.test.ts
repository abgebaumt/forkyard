import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
// Menu actions run once the menu has closed (next frame).
vi.stubGlobal("window", { requestAnimationFrame: (run: (time: number) => void) => run(0), setTimeout: (run: () => void) => run() });

import type { FileChange, Stash } from "../../core";
import type { MenuAction, MenuEntry } from "../../ui/Menu";
import { qk, queryClient } from "../queries";
import { fileMenu } from "./entries";

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
