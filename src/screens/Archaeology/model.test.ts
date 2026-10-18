import { describe, expect, it, vi } from "vitest";
import { EMPTY_TREE_SHA, type ArchaeologyStep, type LineArchaeology } from "../../core";
import { t } from "../../i18n";
import { blameTarget, confidenceLabel, diffLineTarget, errorActions, explainView, isFixedRev, timelineRows, whyEntry, whyLabel } from "./model";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const file = { path: "neu ä.txt", oldPath: "alt name.txt" };
const row = (kind: "add" | "remove" | "context", oldNo: number | null, newNo: number | null) => ({ kind, oldNo, newNo });

describe("diffLineTarget", () => {
  it("diff rows map to the commit that has the line", () => {
    expect(diffLineTarget({ kind: "commit", sha: A }, file, row("add", null, 7))).toEqual({ target: { path: "neu ä.txt", line: 7, sha: A } });
    expect(diffLineTarget({ kind: "commit", sha: A }, file, row("context", 5, 6))).toEqual({ target: { path: "neu ä.txt", line: 6, sha: A } });
    expect(diffLineTarget({ kind: "commit", sha: A }, file, row("remove", 5, null))).toEqual({ target: { path: "alt name.txt", line: 5, sha: `${A}^` } });
    expect(diffLineTarget({ kind: "range", from: B, to: A }, file, row("remove", 2, null))).toEqual({ target: { path: "alt name.txt", line: 2, sha: B } });
    expect(diffLineTarget({ kind: "range", from: B, to: A }, file, row("add", null, 3))).toEqual({ target: { path: "neu ä.txt", line: 3, sha: A } });
    expect(diffLineTarget({ kind: "range", from: B, to: null }, file, row("context", 4, 9))).toEqual({ target: { path: "neu ä.txt", line: 9, sha: null } });
    expect(diffLineTarget({ kind: "staged" }, file, row("remove", 4, null))).toEqual({ target: { path: "alt name.txt", line: 4, sha: "HEAD" } });
    expect(diffLineTarget({ kind: "staged" }, file, row("context", 4, 5)), "the old side of a staged diff is HEAD").toEqual({ target: { path: "alt name.txt", line: 4, sha: "HEAD" } });
    expect(diffLineTarget({ kind: "unstaged" }, { path: "-a b.txt", oldPath: null }, row("context", 4, 6))).toEqual({ target: { path: "-a b.txt", line: 6, sha: null } });
  });

  it("uncommitted lines and stashes give a reason instead", () => {
    expect(t("diff.whyLine.notCommitted")).toBe("the line is not committed yet");
    expect(diffLineTarget({ kind: "unstaged" }, file, row("add", null, 3))).toEqual({ reason: t("diff.whyLine.notCommitted") });
    expect(diffLineTarget({ kind: "unstaged" }, file, row("remove", 3, null))).toEqual({ reason: t("diff.whyLine.indexOnly") });
    expect(diffLineTarget({ kind: "staged" }, file, row("add", null, 3))).toEqual({ reason: t("diff.whyLine.notCommitted") });
    expect(diffLineTarget({ kind: "range", from: B, to: null }, file, row("add", null, 3))).toEqual({ reason: t("diff.whyLine.notCommitted") });
    expect(diffLineTarget({ kind: "range", from: EMPTY_TREE_SHA, to: A }, file, row("remove", 1, null))).toEqual({ reason: t("diff.whyLine.notCommitted") });
    expect(diffLineTarget({ kind: "stash", index: 0 }, file, row("add", null, 1))).toEqual({ reason: t("diff.whyLine.stash") });
    expect(diffLineTarget({ kind: "commit", sha: A }, file, row("add", null, null))).toEqual({ reason: t("diff.whyLine.noLine") });
  });
});

describe("isFixedRev", () => {
  it("only a full SHA (or its parent) names a commit that never moves", () => {
    expect(isFixedRev(A)).toBe(true);
    expect(isFixedRev(`${A}^`)).toBe(true);
    expect(isFixedRev("f".repeat(64)), "SHA-256 repositories").toBe(true);
    expect(isFixedRev("HEAD")).toBe(false);
    expect(isFixedRev("main")).toBe(false);
    expect(isFixedRev(A.slice(0, 7))).toBe(false);
    expect(isFixedRev(`${A}~2`)).toBe(false);
    expect(isFixedRev(null)).toBe(false);
  });
});

describe("blame lines and the menu entry", () => {
  it("a committed blame line becomes a target, an uncommitted one a reason", () => {
    expect(blameTarget("src/station.py", null, 3, false)).toEqual({ target: { path: "src/station.py", line: 3, sha: null } });
    expect(blameTarget("src/station.py", `${A}^`, 3, false)).toEqual({ target: { path: "src/station.py", line: 3, sha: `${A}^` } });
    expect(blameTarget("src/station.py", null, 3, true)).toEqual({ reason: t("blame.archaeology.notCommitted") });
  });

  it("the entry says “Why is this so?” only while the AI function is visible", () => {
    expect(whyLabel(true)).toBe("Why is this so?");
    expect(whyLabel(false)).toBe("History of this line");
    const open = vi.fn();
    const target = { path: "a.txt", line: 2, sha: null };
    const entry = whyEntry({ target }, false, open, "W");
    expect(entry).toMatchObject({ label: "History of this line", shortcut: "W" });
    if ("onSelect" in entry) entry.onSelect?.();
    expect(open).toHaveBeenCalledWith(target);
    expect(whyEntry({ reason: "the line is not committed yet" }, true, open)).toMatchObject({ label: "Why is this so?", disabled: true, hint: "the line is not committed yet" });
  });
});

const step = (sha: string, path: string, summary: string, patch: Partial<ArchaeologyStep> = {}): ArchaeologyStep => ({
  commit: { sha, summary, author: { name: "Jörg Müller", email: "joerg@example.com" }, authoredAt: "2026-03-01T04:30:00.000Z", parents: [] },
  path,
  startLine: 3,
  endLine: 3,
  message: summary,
  diff: [],
  refs: [],
  ...patch,
});

const timeline = (steps: ArchaeologyStep[], mayHaveMore = false): LineArchaeology => ({
  path: steps[0]!.path,
  line: 3,
  sha: steps[0]!.commit.sha,
  codeStart: 1,
  code: ["a", "b", "c"],
  steps,
  mayHaveMore,
  hostLookup: "none",
});

describe("timelineRows", () => {
  it("names renames, line ranges, the kinds of changed lines and where the line starts", () => {
    const rows = timelineRows(
      timeline([
        step(A, "neu ä.txt", "Vier", { startLine: 3, endLine: 5, diff: ["-B", "+B2", " c", "… 2 more lines"] }),
        step(B, "alt name.txt", "Zwei"),
        step(C, "alt name.txt", ""),
      ]),
    );
    expect(rows.map((item) => [item.short, item.path, item.renamedFrom, item.lines])).toEqual([
      ["aaaaaaa", "neu ä.txt", "alt name.txt", "Lines 3–5"],
      ["bbbbbbb", "alt name.txt", null, "Line 3"],
      ["ccccccc", "alt name.txt", null, "Line 3"],
    ]);
    expect(rows[0]!.diff).toEqual([
      { kind: "remove", text: "B" },
      { kind: "add", text: "B2" },
      { kind: "context", text: "c" },
      { kind: "note", text: "… 2 more lines" },
    ]);
    expect(rows[2]!.summary).toBe(t("blame.noMessage"));
    expect(rows.map((item) => item.introduced)).toEqual([false, false, true]);
    expect(timelineRows(timeline([step(A, "x", "Eins")], true))[0]!.introduced).toBe(false);
  });

  it("puts each AI note next to its commit", () => {
    const data = timeline([step(A, "x", "Neu"), step(B, "x", "Alt")]);
    const rows = timelineRows(data, { summary: "s", notes: [{ sha: B, note: "Legt die Zeile an." }], confidence: "low", costUsd: null });
    expect(rows.map((item) => item.note)).toEqual([null, "Legt die Zeile an."]);
    expect(confidenceLabel("low")).toBe("The history says little about the reason");
  });
});

describe("explainView", () => {
  const answer = { summary: "s", notes: [], confidence: "high" as const, costUsd: null };

  it("idle explains, loading cancels with a seconds counter from 3 s, done offers again", () => {
    expect(explainView({ kind: "idle" }, 0, false)).toEqual({ button: "explain", label: "Explain", status: null, slow: null, urgent: false });
    const started = 1_000_000;
    expect(explainView({ kind: "loading", jobId: "j", startedAt: started }, started + 1_000, false)).toMatchObject({ button: "cancel", label: "Cancel", status: "Explaining …", slow: null });
    expect(explainView({ kind: "loading", jobId: "j", startedAt: started }, started + 12_400, false).status).toBe("Explaining … (12 s)");
    expect(explainView({ kind: "loading", jobId: "j", startedAt: started }, started + 31_000, true).slow).toBe(t("ai.state.slowLocal"));
    expect(explainView({ kind: "loading", jobId: "j", startedAt: started }, started + 31_000, false).slow).toBe(t("ai.state.slowRemote"));
    expect(explainView({ kind: "done", answer }, 0, false)).toEqual({ button: "again", label: "Explain again", status: "Explanation ready", slow: null, urgent: false });
  });

  it("errors are announced urgently with their text", () => {
    expect(explainView({ kind: "error", error: { kind: "unavailable", text: "Ollama is not responding (127.0.0.1:11434).", retryAt: null } }, 0, true)).toEqual({
      button: "again",
      label: "Explain again",
      status: "Ollama is not responding (127.0.0.1:11434).",
      slow: null,
      urgent: true,
    });
  });
});

describe("errorActions", () => {
  it("a signed-out command-line tool offers the sign-in in the terminal, an API provider only the settings", () => {
    const error = { kind: "notLoggedIn" as const, text: "Claude Code is not signed in." };
    expect(errorActions(error, "claude_code")).toEqual(["signIn", "setup"]);
    expect(errorActions(error, "codex")).toEqual(["signIn", "setup"]);
    expect(errorActions(error, "anthropic")).toEqual(["setup"]);
    expect(errorActions(error, null)).toEqual(["setup"]);
  });

  it("over the limit offers “Send this time” next to the settings", () => {
    expect(errorActions({ kind: "limit", text: "The daily limit of 1.00 USD is reached." }, "openai")).toEqual(["sendOnce", "setup"]);
  });

  it("setup, unusable answers and the rest", () => {
    expect(errorActions({ kind: "setup", text: "No provider." }, null)).toEqual(["setup"]);
    expect(errorActions({ kind: "invalid", text: "Answer unusable" }, "ollama")).toEqual(["showSent"]);
    expect(errorActions({ kind: "unavailable", text: "down", retryAt: null }, "ollama")).toEqual([]);
    expect(errorActions({ kind: "refused", text: "no" }, "anthropic")).toEqual([]);
    expect(errorActions({ kind: "other", text: "x" }, "anthropic")).toEqual([]);
  });
});
