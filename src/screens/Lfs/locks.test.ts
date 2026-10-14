import { describe, expect, it } from "vitest";
import type { LfsLock, LfsLockList, LfsStatus } from "../../core";
import { lockIndex, locksWanted } from "./locks";

const lock = (path: string, owner: string, ours: boolean): LfsLock => ({ id: path, path, owner, lockedAt: "2026-01-02T03:04:05Z", ours });
const list = (...locks: LfsLock[]): LfsLockList => ({ locks, fetchedAt: "2026-01-02T03:05:00.000Z" });
const lfs = (patch: Partial<LfsStatus>): LfsStatus => ({ installed: true, version: "3.7.1", patterns: ["*.psd"], ...patch });

describe("LFS locks: when and where", () => {
  it("reads locks on its own only where the repository uses LFS", () => {
    expect(locksWanted(lfs({}))).toBe(true);
    expect(locksWanted(lfs({ patterns: [] }))).toBe(false);
    expect(locksWanted(lfs({ installed: false }))).toBe(false);
    expect(locksWanted(undefined)).toBe(false);
  });

  it("indexes the locks by path", () => {
    const index = lockIndex(list(lock("a.psd", "Lena Berg", false), lock("mit leer/Größe.psd", "Test Person", true)));
    expect(index.get("mit leer/Größe.psd")?.ours).toBe(true);
    expect(index.get("a.psd")?.owner).toBe("Lena Berg");
    expect(index.get("x.psd")).toBeUndefined();
    expect(lockIndex(undefined).size).toBe(0);
  });
});
