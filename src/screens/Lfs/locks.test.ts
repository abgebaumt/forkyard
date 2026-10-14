import { describe, expect, it } from "vitest";
import type { FileChange, LfsLock, LfsLockList, LfsStatus } from "../../core";
import { fileLock, foreignStaged, foreignWarning, lockIndex, lockMenuState, locksWanted, panelActions } from "./locks";

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

describe("File lists: the lock symbol", () => {
  it("names the owner, or says it is your own lock", () => {
    expect(fileLock(lock("a.psd", "Lena Berg", false))).toEqual({ ours: false, label: "Locked by Lena Berg" });
    expect(fileLock(lock("b.psd", "Test Person", true))).toEqual({ ours: true, label: "Locked by you" });
    expect(fileLock(undefined)).toBeUndefined();
  });
});

describe("File menu: lock entries", () => {
  it("sorts the selected files into lockable, own and other people's locks", () => {
    const index = lockIndex(list(lock("fremd.psd", "Lena Berg", false), lock("meins.psd", "Test Person", true)));
    const state = lockMenuState(["frei.psd", "meins.psd", "fremd.psd", "auch-frei.psd"], index);
    expect(state.lockable).toEqual(["frei.psd", "auch-frei.psd"]);
    expect(state.ownLocked).toEqual(["meins.psd"]);
    expect(state.foreignLocked.map((l) => `${l.path} ${l.owner}`)).toEqual(["fremd.psd Lena Berg"]);
  });

  it("without known locks every file is lockable", () => {
    expect(lockMenuState(["a.psd"], lockIndex(undefined))).toEqual({ lockable: ["a.psd"], ownLocked: [], foreignLocked: [] });
  });
});

describe("Commit panel: staged files locked by others", () => {
  const staged = (path: string): FileChange => ({ path, oldPath: null, status: "modified", area: "staged", isBinary: true, isLfs: true, added: null, removed: null, conflict: null });
  const index = lockIndex(list(lock("plan.psd", "Lena Berg", false), lock("karte.psd", "Jonas Weiß", false), lock("meins.psd", "Test Person", true)));

  it("finds only other people's locks among the staged files", () => {
    expect(foreignStaged([staged("plan.psd"), staged("meins.psd"), staged("frei.psd")], index).map((l) => l.path)).toEqual(["plan.psd"]);
    expect(foreignStaged([], index)).toEqual([]);
  });

  it("names the file and owner – or counts and lists the owners once", () => {
    expect(foreignWarning([])).toBeNull();
    expect(foreignWarning(foreignStaged([staged("plan.psd")], index))).toBe("“plan.psd” is locked by Lena Berg. You can commit, but the push may be refused.");
    const many = foreignStaged([staged("plan.psd"), staged("karte.psd")], index);
    expect(foreignWarning(many)).toBe("2 staged files are locked by others (Lena Berg, Jonas Weiß). You can commit, but the push may be refused.");
    const sameOwner = [lock("a.psd", "Lena Berg", false), lock("b.psd", "Lena Berg", false)];
    expect(foreignWarning(sameOwner)).toBe("2 staged files are locked by others (Lena Berg). You can commit, but the push may be refused.");
  });
});
