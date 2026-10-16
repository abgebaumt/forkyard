import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../app/commandTypes";
import { getCommands } from "../../app/registry";
import { useAppStore } from "../../app/store";

const command = () => getCommands().find((entry) => entry.id === "repo.cleanup");
const context = (repoId: string | null) => ({ repoId, tabId: repoId ? "tab-1" : null, store: useAppStore.getState(), source: "palette" }) as unknown as CommandContext;

afterEach(() => useAppStore.getState().closeOverlay());

describe("Clean up repository in the command palette", () => {
  it("is a repository command without a shortcut, found by gc, garbage, prune, storage and size", () => {
    const found = command();
    expect(found?.group).toBe("Repository");
    expect(found?.shortcut).toBeUndefined();
    expect(found?.title).toBe("Clean up repository …");
    expect(found?.keywords).toEqual(expect.arrayContaining(["gc", "garbage", "prune", "storage", "size", "clean up"]));
  });

  it("needs an open repository and opens the dialog for it", () => {
    const found = command();
    expect(found?.when?.(context(null))).toBe(false);
    expect(found?.when?.(context("repo-1"))).toBe(true);
    void found?.run(context("repo-1"));
    expect(useAppStore.getState().overlay).toEqual({ kind: "repo_cleanup", repoId: "repo-1" });
  });
});
