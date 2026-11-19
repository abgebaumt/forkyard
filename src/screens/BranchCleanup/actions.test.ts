import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError, type BranchCleanupCandidate, type BranchCleanupTarget, type PushResult, type RefsSnapshot } from "../../core";

type CleanupInput = { repoId: string; targets: BranchCleanupTarget[] };
type RemoteInput = { repoId: string; jobId: string; remote: string; name: string };
type ToastOptions = { tone: string; title: string; description?: string; action?: { label: string; onClick: () => void } };
const calls: string[] = [];
const branchCleanupDelete = vi.fn<(input: CleanupInput) => Promise<RefsSnapshot>>();
const branchDeleteRemote = vi.fn<(input: RemoteInput) => Promise<PushResult>>();
const confirmSpy = vi.fn<(options: { title: string; details?: string[]; danger?: boolean }) => Promise<boolean>>();
const toastSpy = vi.fn<(options: ToastOptions) => void>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    branchCleanupDelete: (input: CleanupInput) => {
      calls.push("local");
      return branchCleanupDelete(input);
    },
    branchDeleteRemote: (input: RemoteInput) => {
      calls.push(`remote:${input.remote}/${input.name}`);
      return branchDeleteRemote(input);
    },
    on: () => () => undefined,
  },
}));

vi.mock("../../app/dialogs", async (original) => ({
  ...(await original<typeof import("../../app/dialogs")>()),
  confirm: (options: { title: string; details?: string[]; danger?: boolean }) => confirmSpy(options),
}));

vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: (options: ToastOptions) => toastSpy(options),
}));

const { qk, queryClient } = await import("../../app/queries");
const { deleteSelected } = await import("./actions");

const REPO = "repo-1";
const candidate = (name: string, upstream: [string, string] | null, sha = "b".repeat(40)): BranchCleanupCandidate => ({
  name,
  sha,
  class: "safe",
  reasons: [{ kind: "merged" }],
  committedAt: "2026-01-01T00:00:00Z",
  upstreamRemote: upstream?.[0] ?? null,
  upstreamBranch: upstream?.[1] ?? null,
});
const list = [
  candidate("fertig", ["origin", "fertig"], "1".repeat(40)),
  candidate("feature/übersicht", ["origin", "feature/übersicht"], "2".repeat(40)),
  candidate("lokal", null, "3".repeat(40)),
  candidate("zweig", ["team", "zweig"], "4".repeat(40)),
];
const snapshot = { locals: [], remotes: [], tags: [] } as unknown as RefsSnapshot;
const done = (remote: string, branch: string): PushResult =>
  ({ status: "done", remote, branch, createdUpstream: false, forced: false }) as PushResult;

beforeEach(() => {
  queryClient.clear();
  calls.length = 0;
  branchCleanupDelete.mockReset().mockResolvedValue(snapshot);
  branchDeleteRemote.mockReset().mockImplementation(async (input) => done(input.remote, input.name));
  confirmSpy.mockReset().mockResolvedValue(true);
  toastSpy.mockReset();
});

describe("deleteSelected", () => {
  it("deletes locally in one call, then each remote branch on its own", async () => {
    await deleteSelected(REPO, list, new Set(["fertig", "lokal"]), true);
    expect(branchCleanupDelete).toHaveBeenCalledTimes(1);
    expect(branchCleanupDelete.mock.calls[0]![0]).toEqual({
      repoId: REPO,
      targets: [
        { name: "fertig", sha: "1".repeat(40) },
        { name: "lokal", sha: "3".repeat(40) },
      ],
    });
    expect(calls).toEqual(["local", "remote:origin/fertig"]);
    expect(confirmSpy.mock.calls[0]![0]).toMatchObject({ danger: true, details: ["origin/fertig"] });
    expect(queryClient.getQueryData(qk.refs(REPO))).toBe(snapshot);
    const local = toastSpy.mock.calls.find(([options]) => options.title === "2 branches deleted")?.[0];
    expect(local?.action?.label).toBe("Undo");
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", title: "1 remote branch deleted" }));
  });

  it("remote failures are reported one by one", async () => {
    branchDeleteRemote.mockImplementation(async (input) => {
      if (input.name === "feature/übersicht") throw new CoreError({ code: "push_rejected", message: "protected", gitOutput: null });
      return done(input.remote, input.name);
    });
    await deleteSelected(REPO, list, new Set(["fertig", "feature/übersicht", "zweig"]), true);
    expect(calls).toEqual(["local", "remote:origin/fertig", "remote:origin/feature/übersicht", "remote:team/zweig"]);
    expect(toastSpy.mock.calls.filter(([options]) => options.tone === "danger")).toHaveLength(1);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", title: "2 remote branches deleted" }));
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "3 branches deleted" }));
  });

  it("cancelling the remote confirmation cancels everything", async () => {
    confirmSpy.mockResolvedValue(false);
    await deleteSelected(REPO, list, new Set(["fertig"]), true);
    expect(branchCleanupDelete).not.toHaveBeenCalled();
    expect(branchDeleteRemote).not.toHaveBeenCalled();
  });

  it("without the remote option there is no confirmation", async () => {
    await deleteSelected(REPO, list, new Set(["fertig"]), false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(calls).toEqual(["local"]);
  });

  it("a failed local deletion touches no remote", async () => {
    branchCleanupDelete.mockRejectedValue(new CoreError({ code: "stale_state", message: "moved", gitOutput: null }));
    await deleteSelected(REPO, list, new Set(["fertig"]), true);
    expect(branchDeleteRemote).not.toHaveBeenCalled();
  });
});
