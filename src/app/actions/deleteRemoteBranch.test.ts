import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushResult, Ref, RefsSnapshot } from "../../core";

type DeleteInput = { repoId: string; jobId: string; remote: string; name: string };
const branchDeleteRemote = vi.fn<(input: DeleteInput) => Promise<PushResult>>();
const confirmSpy = vi.fn<(options: { title: string; body: unknown; confirmLabel: string; danger?: boolean }) => Promise<boolean>>();
const toastSpy = vi.fn<(options: { tone: string; title: string; description?: string }) => void>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    branchDeleteRemote: (input: DeleteInput) => branchDeleteRemote(input),
    on: () => () => undefined,
  },
}));

vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirm: (options: { title: string; body: unknown; confirmLabel: string; danger?: boolean }) => confirmSpy(options),
}));

vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: (options: { tone: string; title: string; description?: string }) => toastSpy(options),
}));

const { qk, queryClient } = await import("../queries");
const { deleteRemoteBranch } = await import("./sync");

const REPO = "repo-1";
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
const remoteRef = ref({ name: "origin/feature/hafen", fullName: "refs/remotes/origin/feature/hafen", kind: "remote", remote: "origin" });
const snapshot = (locals: Ref[]): RefsSnapshot => ({ locals, remotes: [remoteRef], tags: [], head: { kind: "branch", branch: "main", sha: "a".repeat(40) } }) as unknown as RefsSnapshot;

beforeEach(() => {
  queryClient.clear();
  branchDeleteRemote.mockReset();
  confirmSpy.mockReset();
  toastSpy.mockReset();
});

describe("deleteRemoteBranch", () => {
  it("asks first, names remote and branch, and says it is deleted for everyone on the server", async () => {
    queryClient.setQueryData(qk.refs(REPO), snapshot([]));
    confirmSpy.mockResolvedValue(false);
    expect(await deleteRemoteBranch(REPO, remoteRef)).toBeNull();
    expect(branchDeleteRemote).not.toHaveBeenCalled();
    const asked = confirmSpy.mock.calls[0]![0];
    expect(asked.title).toBe("Delete “feature/hafen” on origin?");
    expect(asked.body).toMatch(/on the server – for everyone who uses origin/);
    expect(asked.confirmLabel).toBe("Delete on origin");
    expect(asked.danger).toBe(true);
  });

  it("names the local branch that tracks it – it stays", async () => {
    queryClient.setQueryData(qk.refs(REPO), snapshot([ref({ name: "hafen", fullName: "refs/heads/hafen", upstream: "origin/feature/hafen" })]));
    confirmSpy.mockResolvedValue(false);
    await deleteRemoteBranch(REPO, remoteRef);
    expect(confirmSpy.mock.calls[0]![0].body).toMatch(/Your local branch “hafen” stays/);
  });

  it("deletes with a job id on the named remote and reports success", async () => {
    queryClient.setQueryData(qk.refs(REPO), snapshot([]));
    confirmSpy.mockResolvedValue(true);
    branchDeleteRemote.mockResolvedValue({ status: "done", remote: "origin", branch: "feature/hafen", createdUpstream: false, forced: false });
    const result = await deleteRemoteBranch(REPO, remoteRef);
    expect(result?.ok).toBe(true);
    const input = branchDeleteRemote.mock.calls[0]![0];
    expect(input).toMatchObject({ repoId: REPO, remote: "origin", name: "feature/hafen" });
    expect(input.jobId).toBeTruthy();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", title: "“origin/feature/hafen” deleted on the server" }));
  });

  it("up_to_date means it was already gone: says so instead of claiming it deleted it", async () => {
    queryClient.setQueryData(qk.refs(REPO), snapshot([]));
    confirmSpy.mockResolvedValue(true);
    branchDeleteRemote.mockResolvedValue({ status: "up_to_date" });
    await deleteRemoteBranch(REPO, remoteRef);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const shown = toastSpy.mock.calls[0]![0];
    expect(shown.tone).toBe("info");
    expect(shown.title).toBe("“origin/feature/hafen” was already gone on the server");
    expect(shown.description).toMatch(/stale remote branch was removed here/);
  });

  it("a remote with a slash in its name keeps the whole branch name", async () => {
    const team = ref({ name: "team/a/fix", fullName: "refs/remotes/team/a/fix", kind: "remote", remote: "team/a" });
    queryClient.setQueryData(qk.refs(REPO), snapshot([]));
    confirmSpy.mockResolvedValue(true);
    branchDeleteRemote.mockResolvedValue({ status: "done", remote: "team/a", branch: "fix", createdUpstream: false, forced: false });
    await deleteRemoteBranch(REPO, team);
    expect(branchDeleteRemote.mock.calls[0]![0]).toMatchObject({ remote: "team/a", name: "fix" });
  });
});
