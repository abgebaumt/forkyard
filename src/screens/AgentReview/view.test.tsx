import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, AgentReview, CommitDetails, DiffLine, FileChange, TextDiff } from "../../core";
import type { AgentReviewShow } from "../../app/store";
import { qk } from "../../app/queries";
import { AgentReviewView } from "./index";
import { rangeSource } from "./model";
import { DEFAULT_PANE, useReviewStore, type PaneState } from "./state";

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a1",
  repoId: "r1",
  worktreeRepoId: "w1",
  shortName: "liste",
  templateId: "claude",
  templateName: "Claude Code",
  task: "Liste groß schreiben\nund die Größe ergänzen",
  branch: "agent/liste",
  worktreePath: "/home/anna/web.agents/liste",
  base: "main",
  baseSha: "1".repeat(40),
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
const pinned: AgentReview = { agentId: "a1", repoId: "r1", worktreeRepoId: "w1", source: "snapshot", from: "1".repeat(40), to: "2".repeat(40), tip: "3".repeat(40), base: "main", uncommittedFiles: 2, running: false };
const file = (path: string, patch: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status: "modified", area: "commit", isBinary: false, isLfs: false, added: 2, removed: 2, conflict: null, ...patch });
const details: CommitDetails = { commit: null, files: [file("liste.txt"), file("bild.png", { status: "added", isBinary: true, added: null, removed: null })], added: 2, removed: 2, notCombinableReason: null };
const line = (kind: DiffLine["kind"], text: string, oldNo: number | null, newNo: number | null): DiffLine => ({ kind, text, oldNo, newNo, noNewline: false });
const listDiff: TextDiff = {
  kind: "text",
  path: "liste.txt",
  oldPath: null,
  status: "modified",
  hunks: [{ index: 0, oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: "", lines: [line("remove", "eins", 1, null), line("add", "EINS", null, 1), line("context", "zwei", 2, 2), line("remove", "drei", 3, null), line("add", "DREI", null, 3)] }],
  oldText: null,
  newText: null,
  encoding: "utf-8",
  token: null,
  rangeToken: "range-token",
};

function seed(client: QueryClient, agentId: string, latest: AgentReview, source: PaneState["source"] = "snapshot") {
  client.setQueryData(qk.agentReview("r1", agentId, source), latest);
  client.setQueryData(qk.commitDetails("r1", rangeSource(pinned)), details);
  client.setQueryData(qk.diff("r1", "liste.txt", rangeSource(pinned), { ignoreWhitespace: false }), listDiff);
}

function render(agents: Agent[], agentIds: string[], show: AgentReviewShow, fill: (client: QueryClient) => void): string {
  const client = new QueryClient();
  client.setQueryData(qk.agents("r1"), agents);
  fill(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentReviewView repoId="r1" tabId="t1" agentIds={agentIds} show={show} />
    </QueryClientProvider>,
  );
}

/** The markup of one file list. */
function list(html: string, name: "chosen" | "rest"): string {
  const start = html.indexOf(`data-review-list="${name}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

const pane = (patch: Partial<PaneState> = {}): PaneState => ({ ...DEFAULT_PANE, pinned, picks: { "liste.txt": { kind: "all" } }, active: "liste.txt", ...patch });

/**
 * renderToStaticMarkup reads a zustand store through its server snapshot, which is the store's initial
 * state – so the panes go into that state too, not only into the current one.
 */
function setPanes(panes: Record<string, PaneState>) {
  Object.assign(useReviewStore.getInitialState(), { panes, focus: {} });
  useReviewStore.setState({ panes, focus: {} });
}

beforeEach(() => setPanes({ "t1:a1": pane() }));

describe("AgentReviewView", () => {
  it("lists selected and not selected files with the reason, and the diff with check marks but without staging", () => {
    const html = render([agent()], ["a1"], "first", (client) => seed(client, "a1", pinned));
    expect(html).toContain('data-screen="agent-review"');
    expect(html).toContain("Review: liste");
    expect(list(html, "chosen")).toContain("Selected (1)");
    expect(list(html, "chosen")).toContain("liste.txt");
    expect(list(html, "rest")).toContain("Not selected (1)");
    expect(list(html, "rest")).toContain("bild.png");
    expect(list(html, "rest")).toContain("binary – only by merging the branch");
    expect(list(html, "rest")).not.toContain("data-review-toggle");
    expect(html).toContain('data-review-diff="liste.txt"');
    expect(html).toMatch(/role="grid"[^>]*aria-multiselectable="true"/);
    expect(html).not.toContain("data-selection-bar");
    expect(html).not.toContain("The agent has continued");
    expect(html).toContain("against main");
  });

  it("a newer state of the agent shows the reload notice; the selection stays", () => {
    const html = render([agent()], ["a1"], "first", (client) => seed(client, "a1", { ...pinned, to: "9".repeat(40) }));
    expect(html).toContain("The agent has continued since you opened the review.");
    expect(html).toContain('data-action="review-reload"');
    expect(list(html, "chosen")).toContain("liste.txt");
  });

  it("commits only: names the uncommitted files that are left out", () => {
    setPanes({ "t1:a1": pane({ source: "branch", pinned: { ...pinned, source: "branch" } }) });
    const html = render([agent()], ["a1"], "first", (client) => seed(client, "a1", { ...pinned, source: "branch", uncommittedFiles: 3 }, "branch"));
    expect(html).toContain("3 uncommitted files of the agent are not included.");
  });

  it("two agents side by side: two panes and the column switch with both names", () => {
    setPanes({ "t1:a1": pane(), "t1:a2": pane() });
    const html = render([agent(), agent({ id: "a2", shortName: "tabelle", branch: "agent/tabelle", unattended: true })], ["a1", "a2"], "both", (client) => {
      seed(client, "a1", pinned);
      seed(client, "a2", { ...pinned, agentId: "a2" });
    });
    expect(html.match(/data-review-pane=/g)?.length).toBe(2);
    expect(html).toContain("Review: liste and tabelle · without prompts");
    expect(html).toContain("Side by side");
    const one = render([agent(), agent({ id: "a2", shortName: "tabelle" })], ["a1", "a2"], "second", (client) => seed(client, "a2", { ...pinned, agentId: "a2" }));
    expect(one).toContain('data-review-pane="a2"');
    expect(one).not.toContain('data-review-pane="a1"');
  });

  it("an agent that no longer exists says so", () => {
    const html = render([], ["a1"], "first", () => undefined);
    expect(html).toContain("This coding agent no longer exists.");
  });
});

describe("AgentReviewView: comparing", () => {
  it("one agent offers “Compare with …”, two offer “Stop comparing”", () => {
    const one = render([agent(), agent({ id: "a2", shortName: "tabelle" })], ["a1"], "first", (client) => seed(client, "a1", pinned));
    expect(one).toContain('data-action="review-compare"');
    expect(one).toContain("Compare with …");
    expect(one).not.toContain('data-action="review-stop-comparing"');
    setPanes({ "t1:a1": pane(), "t1:a2": pane() });
    const two = render([agent(), agent({ id: "a2", shortName: "tabelle" })], ["a1", "a2"], "both", (client) => {
      seed(client, "a1", pinned);
      seed(client, "a2", { ...pinned, agentId: "a2" });
    });
    expect(two).toContain('data-action="review-stop-comparing"');
    expect(two).not.toContain('data-action="review-compare"');
  });
});
