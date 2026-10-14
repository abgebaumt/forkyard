import { describe, expect, it } from "vitest";
import type { PreviewOp } from "../core";
import { t } from "../i18n";
import { previewKey, previewText } from "./conflictPreview";

const short = (sha: string) => sha.slice(0, 7);

describe("conflict preview texts", () => {
  it("names the state in one line", () => {
    expect(previewText({ state: "idle" }, short)).toBeNull();
    expect(previewText({ state: "checking" }, short)).toBe(t("conflictPreview.checking"));
    expect(previewText({ state: "failed" }, short)).toBe(t("conflictPreview.failed"));
    expect(previewText({ state: "done", result: { status: "clean" } }, short)).toBe(t("conflictPreview.clean"));
    expect(previewText({ state: "done", result: { status: "unknown", reason: "zu viele" } }, short)).toBe(t("conflictPreview.unknown", { reason: "zu viele" }));
  });

  it("counts the files and names the first conflicting commit of a series", () => {
    const files = t("conflictPreview.conflicts", { count: 2 });
    expect(previewText({ state: "done", result: { status: "conflicts", files: ["a", "b"], atCommit: null } }, short)).toBe(files);
    expect(previewText({ state: "done", result: { status: "conflicts", files: ["a", "b"], atCommit: "abcdef1234567" } }, short)).toBe(
      t("conflictPreview.conflictsFrom", { files, sha: "abcdef1" }),
    );
  });

  it("the key only changes with the operation", () => {
    const op: PreviewOp = { kind: "cherry_pick", commits: ["a", "b"] };
    expect(previewKey({ kind: "cherry_pick", commits: ["a", "b"] })).toBe(previewKey(op));
    expect(previewKey({ kind: "cherry_pick", commits: ["b", "a"] })).not.toBe(previewKey(op));
    expect(previewKey(null)).toBe("");
  });
});
