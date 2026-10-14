import { describe, expect, it } from "vitest";
import type { LfsLock, LfsLockList, LfsStatus } from "../../core";
import { lockIndex, locksWanted, panelActions } from "./locks";

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

describe("LFS panel: what the buttons do with the selection", () => {
  const locks = [lock("a.psd", "Lena Berg", false), lock("b.psd", "Test Person", true), lock("c.psd", "Test Person", true)];

  it("“Unlock” takes only own locks, “Force” takes all selected", () => {
    expect(panelActions(locks, new Set(["a.psd", "b.psd"]))).toEqual({ unlock: ["b.psd"], force: ["a.psd", "b.psd"], foreign: 1 });
    expect(panelActions(locks, new Set(["b.psd", "c.psd"]))).toEqual({ unlock: ["b.psd", "c.psd"], force: ["b.psd", "c.psd"], foreign: 0 });
  });

  it("ignores selected paths that are no longer in the list", () => {
    expect(panelActions(locks, new Set(["weg.psd"]))).toEqual({ unlock: [], force: [], foreign: 0 });
    expect(panelActions([], new Set())).toEqual({ unlock: [], force: [], foreign: 0 });
  });
});
