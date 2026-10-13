import { describe, expect, it, vi } from "vitest";
import { otherProfileQuestion, openFromOtherProfile, type OtherProfileDeps } from "./otherProfile";

const privat = { id: "p", name: "Privat", authorName: "", authorEmail: "", syncGitconfig: false, isActive: true, color: null };
const arbeit = { id: "w", name: "Arbeit", authorName: "", authorEmail: "", syncGitconfig: false, isActive: false, color: 1 };

function deps(answer: string | null, overrides: Partial<OtherProfileDeps<string>> = {}): OtherProfileDeps<string> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    owners: async () => [{ id: "w", name: "Arbeit", color: 1 }],
    profiles: async () => [privat, arbeit],
    ask: async () => answer,
    switchTo: vi.fn(async (profile) => {
      calls.push(`switch:${profile.id}`);
      return true;
    }),
    open: async (path, add) => {
      calls.push(`open:${path}:${add}`);
      return "geöffnet";
    },
    ...overrides,
  };
}

describe("opening a repo of another profile", () => {
  it("asks with switch, add and the repo name", () => {
    const q = otherProfileQuestion("/x/backend", [{ id: "w", name: "Arbeit", color: 1 }], "Privat");
    expect(q.title).toBe("“backend” belongs to the profile “Arbeit”");
    expect(q.options.map((o) => o.key)).toEqual(["switch:w", "add"]);
    expect(q.options[1]?.label).toBe("Also open in “Privat”");
  });
  it("offers a switch for each of several profiles", () => {
    const q = otherProfileQuestion("C:\\\\repos\\\\backend", [{ id: "w", name: "Arbeit", color: 1 }, { id: "k", name: "Kunde", color: null }], "Privat");
    expect(q.title).toBe("“backend” belongs to other profiles");
    expect(q.options.map((o) => o.key)).toEqual(["switch:w", "switch:k", "add"]);
  });
  it("additionally opens it in the active profile", async () => {
    const d = deps("add");
    expect(await openFromOtherProfile("/x/backend", d)).toBe("geöffnet");
    expect(d.calls).toEqual(["open:/x/backend:true"]);
  });
  it("switches the profile and opens it there", async () => {
    const d = deps("switch:w");
    expect(await openFromOtherProfile("/x/backend", d)).toBe("geöffnet");
    expect(d.calls).toEqual(["switch:w", "open:/x/backend:false"]);
  });
  it("does nothing further on cancel or a failed switch", async () => {
    const cancelled = deps(null);
    expect(await openFromOtherProfile("/x/backend", cancelled)).toBeNull();
    expect(cancelled.calls).toEqual([]);
    const refused = deps("switch:w", { switchTo: async () => false });
    expect(await openFromOtherProfile("/x/backend", refused)).toBeNull();
    expect(refused.calls).toEqual([]);
  });
});
