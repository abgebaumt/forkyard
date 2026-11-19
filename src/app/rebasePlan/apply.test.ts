import { describe, expect, it } from "vitest";
import type { RebasePlanRow } from "../../core";
import { applyRebasePlan, type OkPlan } from "./apply";

const row = (sha: string): RebasePlanRow => ({
  sha,
  summary: `Änderung ${sha}`,
  description: "",
  author: { name: "Lena", email: "lena@example.com" },
  authoredAt: "2026-01-01T00:00:00Z",
  action: "pick",
  message: null,
});

describe("applyRebasePlan", () => {
  it("does not start a blocked plan and says so", async () => {
    const plan = {
      status: "ok",
      base: "b",
      branch: "main",
      rows: [row("a"), row("b")],
      rewritesPushed: false,
      dependentBranches: [],
    } as unknown as OkPlan;
    const options = { updateRefs: false, askForPushed: false, label: "Anwenden" };
    expect(await applyRebasePlan("r", "t", plan, plan.rows, options)).toBe("blocked");
    expect(await applyRebasePlan("r", "t", plan, [{ ...row("a"), action: "squash" }, row("b")], options)).toBe("blocked");
  });
});
