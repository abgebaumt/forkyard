import { describe, expect, it } from "vitest";
import type { RebasePlanRow } from "../../core";
import type { OkPlan } from "../../app/rebasePlan/apply";
import { startRows } from "./model";

const row = (sha: string): RebasePlanRow => ({
  sha,
  summary: `Änderung ${sha}`,
  description: "",
  author: { name: "Lena", email: "lena@example.com" },
  authoredAt: "2026-01-01T00:00:00Z",
  action: "pick",
  message: null,
});

const plan = { status: "ok", base: "b", rows: [row("a"), row("b"), row("c")] } as unknown as OkPlan;
const edited = [row("c"), { ...row("a"), action: "drop" as const }, row("b")];

describe("startRows", () => {
  it("takes over the rows from the graph only for the same commits", () => {
    expect(startRows(plan, edited)).toBe(edited);
    expect(startRows(plan, edited.slice(1))).toBe(plan.rows);
    expect(startRows(plan, undefined)).toBe(plan.rows);
  });
});
