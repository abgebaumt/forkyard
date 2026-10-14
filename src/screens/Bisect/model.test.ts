import { describe, expect, it } from "vitest";
import type { BisectStatus } from "../../core";
import { bisectBar, bisectMarks } from "./model";

const status = (patch: Partial<BisectStatus>): BisectStatus => ({
  active: true,
  bad: null,
  good: [],
  skipped: [],
  current: null,
  remainingSteps: null,
  stepsDone: 0,
  result: null,
  onlySkippedLeft: false,
  ...patch,
});

describe("bisectBar", () => {
  it("is off without a bisect", () => {
    expect(bisectBar(undefined)).toEqual({ kind: "off" });
    expect(bisectBar(status({ active: false }))).toEqual({ kind: "off" });
  });

  it("waits until a bad and a good commit are known", () => {
    expect(bisectBar(status({}))).toEqual({ kind: "waiting", needs: "both" });
    expect(bisectBar(status({ bad: "b" }))).toEqual({ kind: "waiting", needs: "good" });
    expect(bisectBar(status({ good: ["g"] }))).toEqual({ kind: "waiting", needs: "bad" });
  });

  it("counts the step under test and Git's estimate after it", () => {
    expect(bisectBar(status({ bad: "b", good: ["g"], current: "c", remainingSteps: 3 }))).toEqual({ kind: "running", step: 1, total: 4, current: "c" });
    expect(bisectBar(status({ bad: "b", good: ["g"], current: "c", remainingSteps: 1, stepsDone: 2 }))).toEqual({ kind: "running", step: 3, total: 4, current: "c" });
  });

  it("names the result or says that only skipped commits are left", () => {
    expect(bisectBar(status({ bad: "b", good: ["g"], result: "b", stepsDone: 3 }))).toEqual({ kind: "found", sha: "b" });
    expect(bisectBar(status({ bad: "b", good: ["g"], skipped: ["s"], onlySkippedLeft: true }))).toEqual({ kind: "only_skipped" });
  });
});

describe("bisectMarks", () => {
  it("marks good, skipped and bad commits", () => {
    const marks = bisectMarks(status({ bad: "b", good: ["g1", "g2"], skipped: ["s"] }));
    expect([...marks.entries()]).toEqual([
      ["g1", "good"],
      ["g2", "good"],
      ["s", "skip"],
      ["b", "bad"],
    ]);
    expect(bisectMarks(status({ active: false, bad: "b" })).size).toBe(0);
    expect(bisectMarks(undefined).size).toBe(0);
  });
});
