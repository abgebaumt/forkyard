import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LfsLock, LfsLockList, LfsLockOutcome } from "../../core";

const lfsLock = vi.fn<(input: { repoId: string; paths: string[] }) => Promise<LfsLockOutcome>>();
const lfsUnlock = vi.fn<(input: { repoId: string; paths: string[]; force: boolean }) => Promise<LfsLockOutcome>>();
const lfsLocks = vi.fn<(input: { repoId: string; filter?: string | null }) => Promise<LfsLockList>>();
const confirmSpy = vi.fn<(options: { title: string; details?: string[]; danger?: boolean }) => Promise<boolean>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    lfsLock: (input: { repoId: string; paths: string[] }) => lfsLock(input),
    lfsUnlock: (input: { repoId: string; paths: string[]; force: boolean }) => lfsUnlock(input),
    lfsLocks: (input: { repoId: string; filter?: string | null }) => lfsLocks(input),
    on: () => () => undefined,
  },
}));

vi.mock("../dialogs", async (original) => ({
  ...(await original<typeof import("../dialogs")>()),
  confirm: (options: { title: string; details?: string[]; danger?: boolean }) => confirmSpy(options),
}));

const { qk, queryClient } = await import("../queries");
const { lockFiles, unlockFiles } = await import("./lfs");

const REPO = "repo-1";
const lock = (path: string, owner: string, ours: boolean): LfsLock => ({ id: path, path, owner, lockedAt: null, ours });
const list = (...locks: LfsLock[]): LfsLockList => ({ locks, fetchedAt: "2026-01-02T03:05:00.000Z" });

beforeEach(() => {
  queryClient.clear();
  lfsLock.mockReset();
  lfsUnlock.mockReset();
  confirmSpy.mockReset();
  lfsLocks.mockReset();
});

describe("LFS lock actions", () => {
  it("locking stores the fresh list for file lists and menus", async () => {
    const fresh = list(lock("plan.psd", "Test Person", true));
    lfsLock.mockResolvedValue({ locks: fresh, failed: [] });
    const result = await lockFiles(REPO, ["plan.psd"]);
    expect(result.ok).toBe(true);
    expect(lfsLock).toHaveBeenCalledWith({ repoId: REPO, paths: ["plan.psd"] });
    expect(queryClient.getQueryData(qk.lfsLocks(REPO))).toEqual(fresh);
  });

  it("own locks are unlocked without asking", async () => {
    queryClient.setQueryData(qk.lfsLocks(REPO), list(lock("plan.psd", "Test Person", true)));
    lfsUnlock.mockResolvedValue({ locks: list(), failed: [] });
    await unlockFiles(REPO, ["plan.psd"], false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(lfsUnlock).toHaveBeenCalledWith({ repoId: REPO, paths: ["plan.psd"], force: false });
  });

  it("forcing someone else's lock asks first and names owner and file", async () => {
    queryClient.setQueryData(qk.lfsLocks(REPO), list(lock("karte.psd", "Lena Berg", false), lock("plan.psd", "Test Person", true)));
    confirmSpy.mockResolvedValue(false);
    expect(await unlockFiles(REPO, ["karte.psd", "plan.psd"], true)).toBeNull();
    expect(lfsUnlock).not.toHaveBeenCalled();
    const asked = confirmSpy.mock.calls[0]?.[0];
    expect(asked?.title).toBe("Remove the lock held by Lena Berg?");
    expect(asked?.details).toEqual(["karte.psd – Lena Berg"]);
    expect(asked?.danger).toBe(true);

    confirmSpy.mockResolvedValue(true);
    lfsUnlock.mockResolvedValue({ locks: list(), failed: [] });
    await unlockFiles(REPO, ["karte.psd", "plan.psd"], true);
    expect(lfsUnlock).toHaveBeenCalledWith({ repoId: REPO, paths: ["karte.psd", "plan.psd"], force: true });
  });

  it("forcing only own locks needs no prompt", async () => {
    queryClient.setQueryData(qk.lfsLocks(REPO), list(lock("plan.psd", "Test Person", true)));
    lfsUnlock.mockResolvedValue({ locks: list(), failed: [] });
    await unlockFiles(REPO, ["plan.psd"], true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(lfsUnlock).toHaveBeenCalledWith({ repoId: REPO, paths: ["plan.psd"], force: true });
  });

  it("forcing under an active filter still asks when the unfiltered list is gone from the cache", async () => {
    // The panel observes only the filtered key; the unfiltered entry was collected.
    queryClient.setQueryData(qk.lfsLocks(REPO, "lena"), list(lock("karte.psd", "Lena Berg", false)));
    lfsLocks.mockRejectedValue(new Error("no read expected"));
    confirmSpy.mockResolvedValue(false);
    expect(await unlockFiles(REPO, ["karte.psd"], true)).toBeNull();
    expect(confirmSpy.mock.calls[0]?.[0].details).toEqual(["karte.psd – Lena Berg"]);
    expect(lfsUnlock).not.toHaveBeenCalled();
  });

  it("forcing asks for the locks the caller hands in even with an empty cache", async () => {
    confirmSpy.mockResolvedValue(false);
    expect(await unlockFiles(REPO, ["karte.psd"], true, [lock("karte.psd", "Lena Berg", false)])).toBeNull();
    expect(confirmSpy.mock.calls[0]?.[0].details).toEqual(["karte.psd – Lena Berg"]);
    expect(lfsLocks).not.toHaveBeenCalled();
    expect(lfsUnlock).not.toHaveBeenCalled();
  });

  it("forcing an unknown path reads the locks again before deciding no prompt is needed", async () => {
    lfsLocks.mockResolvedValue(list(lock("karte.psd", "Lena Berg", false)));
    confirmSpy.mockResolvedValue(false);
    expect(await unlockFiles(REPO, ["karte.psd"], true)).toBeNull();
    expect(lfsLocks).toHaveBeenCalledWith({ repoId: REPO, filter: null });
    expect(confirmSpy.mock.calls[0]?.[0].details).toEqual(["karte.psd – Lena Berg"]);
    expect(lfsUnlock).not.toHaveBeenCalled();
  });

  it("forcing still asks when the owner cannot be found out", async () => {
    lfsLocks.mockRejectedValue(new Error("offline"));
    confirmSpy.mockResolvedValue(false);
    expect(await unlockFiles(REPO, ["karte.psd"], true)).toBeNull();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(lfsUnlock).not.toHaveBeenCalled();
  });
});
