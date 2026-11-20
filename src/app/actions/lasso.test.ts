import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError, type CommitResult, type ErrorCode, type Status } from "../../core";

const commitSelection = vi.fn<(input: Record<string, unknown>) => Promise<CommitResult>>();
const selectionToBranch = vi.fn<(input: Record<string, unknown>) => Promise<CommitResult>>();
const stagePaths = vi.fn<(input: Record<string, unknown>) => Promise<Status>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    commitSelection: (input: Record<string, unknown>) => commitSelection(input),
    selectionToBranch: (input: Record<string, unknown>) => selectionToBranch(input),
    stagePaths: (input: Record<string, unknown>) => stagePaths(input),
    on: () => () => undefined,
  },
}));
vi.mock("../actionDialogs", () => ({ askSelectionBranch: vi.fn() }));
vi.mock("./branches", () => ({ checkout: vi.fn() }));
vi.mock("../commands/focus", () => ({ focusSummarySoon: vi.fn() }));
vi.mock("../../ui/Feedback", async (original) => ({ ...(await original<typeof import("../../ui/Feedback")>()), toast: vi.fn() }));

const { t } = await import("../../i18n");
const { toast } = await import("../../ui/Feedback");
const { askSelectionBranch } = await import("../actionDialogs");
const { checkout } = await import("./branches");
const { qk, queryClient } = await import("../queries");
const { lassoSelections, useLassoStore } = await import("../lasso");
const { useWipStore } = await import("../../screens/WipPanel/state");
const { commitLasso, lassoToBranch } = await import("./lasso");
const { focusSummarySoon } = await import("../commands/focus");
const { getTabView, useAppStore } = await import("../store");
const { stageFiles } = await import("../../screens/WipPanel/actions");

const coreError = (code: ErrorCode) => new CoreError({ code, message: code, gitOutput: null });
const lastToast = () => vi.mocked(toast).mock.calls.at(-1)?.[0];
const setDraft = (repoId: string, draft: { summary: string; description: string }, amend = false) =>
  queryClient.setQueryData(qk.draft(repoId), { ...draft, amend });

const lasso = {
  "src/sitzung.ts": {
    token: "tok-a",
    keys: ["0:1", "0:2"],
    lines: 2,
    forced: false,
    selection: { path: "src/sitzung.ts", expect: "tok-a", hunks: [{ index: 0, lines: [1, 2] }] },
  },
};
const RESULT = { sha: "a".repeat(40), push: null } as unknown as CommitResult;

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.setQueryData(qk.status("r1"), {
    head: { kind: "branch", branch: "main", sha: "h1" },
    unstaged: [],
    staged: [],
  } as unknown as Status);
  setDraft("r1", { summary: "Nur das", description: "" });
  useLassoStore.getState().replace("t1", lasso);
  commitSelection.mockResolvedValue(RESULT);
  selectionToBranch.mockResolvedValue(RESULT);
});

describe("commit only this", () => {
  it("an empty commit field gets the focus and nothing is sent", async () => {
    setDraft("r1", { summary: "", description: "" });
    useAppStore.getState().setRightCollapsed("t1", true);
    await expect(commitLasso("r1", "t1")).resolves.toBe("needsMessage");
    expect(commitSelection).not.toHaveBeenCalled();
    expect(useWipStore.getState().tabs.t1?.summaryError?.text).toBe(t("wip.commit.summaryMissing"));
    expect(focusSummarySoon).toHaveBeenCalled();
    expect(getTabView("t1").rightCollapsed).toBe(false);
  });

  it("a checked Amend blocks it: nothing is sent, the flag stays", async () => {
    setDraft("r1", { summary: "Nur das", description: "" }, true);
    await expect(commitLasso("r1", "t1")).resolves.toBe("needsMessage");
    expect(commitSelection).not.toHaveBeenCalled();
    expect(useWipStore.getState().tabs.t1?.summaryError?.text).toBe(t("wip.lasso.amendOn"));
    expect(queryClient.getQueryData(qk.draft("r1"))).toMatchObject({ amend: true });
  });

  it("resets the amend state of the form on success", async () => {
    useWipStore.getState().patch("t1", { amendSha: "h1", amendFilled: { summary: "x", description: "" } });
    await commitLasso("r1", "t1");
    expect(useWipStore.getState().tabs.t1).toMatchObject({ amendSha: null, amendFilled: null });
  });

  it("sends the lasso with HEAD and clears lasso and draft on success", async () => {
    await expect(commitLasso("r1", "t1")).resolves.toBe("done");
    expect(commitSelection).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "r1", expectHead: "h1", summary: "Nur das", selections: lassoSelections(lasso) }),
    );
    expect(useLassoStore.getState().byTab.t1).toEqual({});
    expect(queryClient.getQueryData(qk.draft("r1"))).toMatchObject({ summary: "" });
    expect(lastToast()).toMatchObject({ title: t("wip.commit.created"), description: "aaaaaaa · Nur das" });
  });

  it("a refusal keeps the lasso", async () => {
    commitSelection.mockRejectedValueOnce(coreError("selection_conflicts_with_index"));
    await expect(commitLasso("r1", "t1")).resolves.toBe("failed");
    expect(useLassoStore.getState().byTab.t1).toEqual(lasso);
  });

  it("a stale HEAD writes nothing, keeps lasso and draft", async () => {
    commitSelection.mockRejectedValueOnce(coreError("stale_state"));
    await expect(commitLasso("r1", "t1")).resolves.toBe("failed");
    expect(useLassoStore.getState().byTab.t1).toEqual(lasso);
    expect(queryClient.getQueryData(qk.draft("r1"))).toMatchObject({ summary: "Nur das" });
  });
});

describe("move to a new branch", () => {
  it("prefills the dialog from the draft and does nothing when cancelled", async () => {
    vi.mocked(askSelectionBranch).mockResolvedValueOnce(null);
    await expect(lassoToBranch("r1", "t1")).resolves.toBe("cancelled");
    expect(vi.mocked(askSelectionBranch).mock.calls[0]![0]).toMatchObject({ repoId: "r1", summary: "Nur das", description: "" });
    expect(selectionToBranch).not.toHaveBeenCalled();
  });

  it("moving to a branch offers to switch to it", async () => {
    vi.mocked(askSelectionBranch).mockResolvedValueOnce({ branch: "auslagerung/ä", summary: "Ausgelagert", description: "" });
    await expect(lassoToBranch("r1", "t1")).resolves.toBe("done");
    expect(selectionToBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "auslagerung/ä", summary: "Ausgelagert", expectHead: "h1", selections: lassoSelections(lasso) }),
    );
    expect(lastToast()).toMatchObject({
      title: t("wip.lasso.movedTitle", { branch: "auslagerung/ä" }),
      action: { label: t("wip.lasso.switch") },
    });
    expect(useLassoStore.getState().byTab.t1).toEqual({});
    // The draft was only the dialog's prefill.
    expect(queryClient.getQueryData(qk.draft("r1"))).toMatchObject({ summary: "Nur das" });
    lastToast()?.action?.onClick();
    expect(checkout).toHaveBeenCalledWith("r1", "auslagerung/ä", { tabId: "t1" });
  });

  it("a stale HEAD keeps the lasso", async () => {
    vi.mocked(askSelectionBranch).mockResolvedValueOnce({ branch: "x", summary: "S", description: "" });
    selectionToBranch.mockRejectedValueOnce(coreError("stale_state"));
    await expect(lassoToBranch("r1", "t1")).resolves.toBe("failed");
    expect(useLassoStore.getState().byTab.t1).toEqual(lasso);
  });
});

describe("staging whole files", () => {
  it("forgets their lasso before the new status reaches the cache, so no “file has changed” notice", async () => {
    const after = { head: { kind: "branch", branch: "main", sha: "h1" }, unstaged: [], staged: [] } as unknown as Status;
    let answered = false;
    let lassoAtStatus: unknown = "unset";
    stagePaths.mockImplementation(async () => {
      answered = true;
      return after;
    });
    // The first status cache event after the core answered: the status is applied (or reloaded) here.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (answered && lassoAtStatus === "unset" && event.query.queryHash === JSON.stringify(qk.status("r1")))
        lassoAtStatus = useLassoStore.getState().byTab.t1;
    });
    await stageFiles("r1", "t1", ["src/sitzung.ts"]);
    unsubscribe();
    expect(lassoAtStatus).toEqual({});
  });
});
