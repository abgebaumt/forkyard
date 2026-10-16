import { describe, expect, it } from "vitest";
import type { Agent, AgentReview, DiffLine, FileChange, FileDiff, TextDiff } from "../../core";
import {
  blocker,
  buildSelections,
  changedKeys,
  commitMessageFromTask,
  compareCandidates,
  initialPicks,
  keysOf,
  notPickable,
  rangeSource,
  reviewColumns,
  selectionFor,
  splitFiles,
  toggleFile,
  withLines,
  type ReviewFacts,
} from "./model";

const line = (kind: DiffLine["kind"], text: string, oldNo: number | null, newNo: number | null): DiffLine => ({ kind, text, oldNo, newNo, noNewline: false });

/** Two hunks of a long list. Git numbered them 3 and 7 (their `index`), the view shows them at positions 0 and 1. */
const diff: TextDiff = {
  kind: "text",
  path: "liste.txt",
  oldPath: null,
  status: "modified",
  hunks: [
    { index: 3, oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "", lines: [line("remove", "eins", 1, null), line("add", "EINS", null, 1), line("context", "zwei", 2, 2), line("remove", "drei", 3, null), line("add", "DREI", null, 3)] },
    { index: 7, oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, section: "", lines: [line("context", "neununddreißig", 40, 40), line("remove", "vierzig", 41, null), line("add", "VIERZIG", null, 41)] },
  ],
  oldText: null,
  newText: null,
  encoding: "utf-8",
  token: null,
  rangeToken: "range-token-of-liste",
};

const binary: FileDiff = { kind: "binary", path: "bild.png", oldPath: null, status: "added", oldSize: null, newSize: 2048 };

const file = (path: string, patch: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status: "modified", area: "commit", isBinary: false, isLfs: false, added: 1, removed: 1, conflict: null, ...patch });

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a1",
  repoId: "r",
  worktreeRepoId: "w",
  shortName: "fix-login",
  templateId: "claude",
  templateName: "Claude Code",
  task: "Fix login",
  branch: "agent/fix-login",
  worktreePath: "/home/anna/web.agents/fix-login",
  base: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  unattended: false,
  status: "done",
  statusSource: "agent",
  terminalId: null,
  startedAt: "2026-10-16T08:00:00.000Z",
  endedAt: "2026-10-16T08:30:00.000Z",
  exitCode: 0,
  lastLine: null,
  changedFiles: 2,
  commitsAhead: 1,
  test: null,
  ...patch,
});

const review = (patch: Partial<AgentReview> = {}): AgentReview => ({
  agentId: "a1",
  repoId: "r",
  worktreeRepoId: "w",
  source: "snapshot",
  from: "1".repeat(40),
  to: "2".repeat(40),
  tip: "3".repeat(40),
  base: "main",
  uncommittedFiles: 2,
  running: false,
  ...patch,
});

describe("agent review: files", () => {
  it("only line-pickable files start selected; the others name why", () => {
    const files = [file("liste.txt"), file("bild.png", { isBinary: true }), file("video.mp4", { isLfs: true }), file("neu.txt", { status: "renamed", oldPath: "alt.txt" }), file("weg.txt", { status: "deleted" })];
    expect(initialPicks(files)).toEqual({ "liste.txt": { kind: "all" }, "weg.txt": { kind: "all" } });
    expect(notPickable(files[1]!)).toBe("binary – only by merging the branch");
    expect(notPickable(files[2]!)).toBe("Git LFS – only by merging the branch");
    expect(notPickable(files[3]!)).toBe("renamed – only by merging the branch");
    expect(notPickable(file("x", { status: "conflicted" }))).toBe("conflicted – only by merging the branch");
    expect(notPickable(files[0]!)).toBeNull();
  });

  it("splits into selected and not selected in the list order, and toggles only pickable files", () => {
    const files = [file("b.txt"), file("-a ä.txt"), file("bild.png", { isBinary: true })];
    const picks = { "-a ä.txt": { kind: "all" } as const };
    expect(splitFiles(files, picks)).toEqual({ chosen: [files[1]], rest: [files[0], files[2]] });
    expect(toggleFile(picks, files[0]!)).toEqual({ "-a ä.txt": { kind: "all" }, "b.txt": { kind: "all" } });
    expect(toggleFile(picks, files[1]!)).toEqual({});
    expect(toggleFile(picks, files[2]!)).toBe(picks);
  });
});

describe("agent review: lines", () => {
  it("knows every changed line by position", () => {
    expect(changedKeys(diff)).toEqual(["0:0", "0:1", "0:3", "0:4", "1:1", "1:2"]);
    expect(keysOf(undefined, diff)).toEqual(new Set());
    expect(keysOf({ kind: "all" }, diff)).toEqual(new Set(["0:0", "0:1", "0:3", "0:4", "1:1", "1:2"]));
    expect(keysOf({ kind: "lines", keys: ["0:1"] }, diff)).toEqual(new Set(["0:1"]));
  });

  it("the line selection of the diff becomes all, some or nothing; context lines never count", () => {
    const all = withLines({}, "liste.txt", new Set(["0:0", "0:1", "0:2", "0:3", "0:4", "1:1", "1:2"]), diff);
    expect(all).toEqual({ "liste.txt": { kind: "all" } });
    const some = withLines(all, "liste.txt", new Set(["1:2", "0:2", "0:0"]), diff);
    expect(some).toEqual({ "liste.txt": { kind: "lines", keys: ["0:0", "1:2"] } });
    expect(withLines(some, "liste.txt", new Set(["0:2"]), diff)).toEqual({});
  });
});

describe("agent review: selections for rangeApply", () => {
  it("selections_follow_the_picks_and_refuse_files_without_a_range_token", () => {
    expect(selectionFor(diff, { kind: "all" })).toEqual({ path: "liste.txt", hunks: [{ index: 3, lines: null }, { index: 7, lines: null }], expect: "range-token-of-liste" });
    expect(selectionFor(diff, { kind: "lines", keys: ["1:2", "0:1", "0:0", "0:2"] })).toEqual({
      path: "liste.txt",
      hunks: [
        { index: 3, lines: [0, 1] },
        { index: 7, lines: [2] },
      ],
      expect: "range-token-of-liste",
    });
    expect(selectionFor(diff, { kind: "lines", keys: ["0:2"] })).toBeNull();
    expect(selectionFor({ ...diff, rangeToken: null }, { kind: "all" })).toBeNull();
    expect(selectionFor(binary, { kind: "all" })).toBeNull();

    const diffs = new Map<string, FileDiff>([
      ["liste.txt", diff],
      ["bild.png", binary],
    ]);
    const built = buildSelections({ "liste.txt": { kind: "all" }, "fehlt.txt": { kind: "all" }, "bild.png": { kind: "all" } }, diffs);
    expect(built.selections.map((selection) => selection.path)).toEqual(["liste.txt"]);
    expect(built.refused).toEqual(["bild.png", "fehlt.txt"]);
  });

  it("diffs and takeovers use exactly the two pinned commits", () => {
    expect(rangeSource(review())).toEqual({ kind: "range", from: "1".repeat(40), to: "2".repeat(40) });
  });
});

describe("agent review: commit message from the task", () => {
  it("first line as summary, the rest as description", () => {
    expect(commitMessageFromTask("Liste groß schreiben\nund die Größe ergänzen")).toEqual({ summary: "Liste groß schreiben", description: "und die Größe ergänzen" });
    expect(commitMessageFromTask("\r\n  Fix   the\tlogin  \r\n\r\nSee issue 12\r\n")).toEqual({ summary: "Fix the login", description: "See issue 12" });
    expect(commitMessageFromTask("   \n")).toEqual({ summary: "", description: "" });
  });

  it("cuts a long first line at the last space within 72 characters", () => {
    // 84 characters; the space at position 72 is the last one within the limit.
    expect(commitMessageFromTask("Repariere die Anmeldung für Konten mit Umlauten im Namen und sehr langen Passwörtern\nDetails folgen")).toEqual({
      summary: "Repariere die Anmeldung für Konten mit Umlauten im Namen und sehr langen",
      description: "Passwörtern\n\nDetails folgen",
    });
    expect(commitMessageFromTask("x".repeat(90))).toEqual({ summary: "x".repeat(72), description: "x".repeat(18) });
  });
});

describe("agent review: columns and comparison", () => {
  it("one agent, or two with first, second or both", () => {
    expect(reviewColumns([], "both")).toEqual([]);
    expect(reviewColumns(["a1"], "second")).toEqual(["a1"]);
    expect(reviewColumns(["a1", "a2"], "first")).toEqual(["a1"]);
    expect(reviewColumns(["a1", "a2"], "second")).toEqual(["a2"]);
    expect(reviewColumns(["a1", "a2"], "both")).toEqual(["a1", "a2"]);
  });

  it("offers the other agents that still exist", () => {
    const list = [agent({ id: "a1" }), agent({ id: "a2" }), agent({ id: "a3", status: "orphaned" })];
    expect(compareCandidates(list, ["a1"]).map((item) => item.id)).toEqual(["a2"]);
  });
});

describe("agent review: why an action is not available", () => {
  const facts = (patch: Partial<ReviewFacts> = {}): ReviewFacts => ({ agent: agent(), latest: review(), chosen: 2, status: { staged: [], operation: null }, summary: "Fix login", ...patch });

  it("everything is possible for a finished agent with work", () => {
    for (const action of ["takeOver", "commit", "merge", "rebase", "discard"] as const) if (action !== "rebase") expect(blocker(action, facts())).toBeNull();
    expect(blocker("rebase", facts({ latest: review({ uncommittedFiles: 0 }) }))).toBeNull();
  });

  it("names the reason", () => {
    expect(blocker("takeOver", facts({ latest: null }))).toBe("The review is still loading.");
    expect(blocker("takeOver", facts({ chosen: 0 }))).toBe("Nothing is selected.");
    expect(blocker("commit", facts({ status: { staged: [file("eigen.txt", { area: "staged" })], operation: null } }))).toBe("Your staging area isn't empty. Commit or unstage your own changes first.");
    expect(blocker("commit", facts({ summary: "  " }))).toBe("Enter a summary.");
    expect(blocker("commit", facts({ status: { staged: [], operation: { kind: "merge", source: "feature", target: "main", step: null, totalSteps: null, message: null } } }))).toBe(
      "A merge, rebase or cherry-pick is in progress in your repository.",
    );
    expect(blocker("merge", facts({ agent: agent({ commitsAhead: 0 }) }))).toBe("The agent has not committed anything yet.");
    expect(blocker("rebase", facts({ agent: agent({ terminalId: "t1", status: "waiting" }) }))).toBe("Stop the agent first – it is still working in its worktree.");
    expect(blocker("rebase", facts())).toBe("The agent's worktree has 2 uncommitted files. Commit them there or discard the rest first.");
    expect(blocker("discard", facts({ agent: agent({ worktreeRepoId: null }) }))).toBe("The agent's worktree is missing.");
    expect(blocker("discard", facts({ latest: review({ uncommittedFiles: 0 }) }))).toBe("There is nothing uncommitted in the agent's worktree.");
  });
});
