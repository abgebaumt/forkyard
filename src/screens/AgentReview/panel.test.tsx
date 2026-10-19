import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, AgentReview, FileChange, Status } from "../../core";
import { qk } from "../../app/queries";
import { ReviewCommitPanel } from "./CommitPanel";
import { ReviewActions } from "./ReviewActions";
import { DEFAULT_PANE, useReviewStore } from "./state";

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
const latest: AgentReview = { agentId: "a1", repoId: "r1", worktreeRepoId: "w1", source: "snapshot", from: "1".repeat(40), to: "2".repeat(40), tip: "3".repeat(40), base: "main", uncommittedFiles: 2, running: false };
const staged = (path: string): FileChange => ({ path, oldPath: null, status: "added", area: "staged", isBinary: false, isLfs: false, added: 1, removed: 0, conflict: null });
const status = (patch: Partial<Status> = {}): Status => ({
  head: { kind: "branch", branch: "main", sha: "4".repeat(40) },
  upstream: null,
  unpublished: null,
  unstaged: [],
  staged: [],
  conflicted: [],
  operation: null,
  identitySet: true,
  token: "t",
  ...patch,
});

/** The opening tag of the button with this `data-action` (a disabled one has `disabled=""`; class names may contain "disabled:"). */
const tag = (html: string, action: string): string => {
  const match = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html);
  expect(match, action).not.toBeNull();
  return match![0];
};

function client(agents: Agent[], repoStatus: Status): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(qk.agents("r1"), agents);
  qc.setQueryData(qk.agentReview("r1", "a1", "snapshot"), latest);
  qc.setQueryData(qk.agentReview("r1", "a2", "snapshot"), { ...latest, agentId: "a2" });
  qc.setQueryData(qk.status("r1"), repoStatus);
  return qc;
}

const panel = (agents: Agent[], repoStatus: Status, agentIds = ["a1"]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client(agents, repoStatus)}>
      <ReviewCommitPanel repoId="r1" tabId="t1" agentIds={agentIds} />
    </QueryClientProvider>,
  );

const actions = (item: Agent, chosen = 1, review: AgentReview | null = latest) =>
  renderToStaticMarkup(
    <QueryClientProvider client={client([item], status())}>
      <ReviewActions repoId="r1" tabId="t1" agent={item} latest={review} chosen={chosen} />
    </QueryClientProvider>,
  );

/**
 * zustand 5 reads a store during renderToStaticMarkup through its server snapshot (the initial
 * state), so every change the tests make is copied there as well.
 */
function sync() {
  const { panes, focus } = useReviewStore.getState();
  Object.assign(useReviewStore.getInitialState(), { panes, focus });
}

beforeEach(() => {
  useReviewStore.setState({
    panes: { "t1:a1": { ...DEFAULT_PANE, pinned: latest, picks: { "liste.txt": { kind: "all" } } }, "t1:a2": { ...DEFAULT_PANE, pinned: latest, picks: {} } },
    focus: {},
  });
  sync();
});

describe("ReviewCommitPanel", () => {
  it("starts from the task and commits the selection on the checked-out branch", () => {
    const html = panel([agent()], status());
    expect(html).toContain('data-panel="review-commit"');
    expect(html).toContain('value="Liste groß schreiben"');
    expect(html).toContain("und die Größe ergänzen</textarea>");
    expect(html).toContain("Commits the selected changes of liste on main.");
    expect(html).toContain("Commit selection (1 file)");
    expect(tag(html, "review-commit")).not.toContain(' disabled=""');
    expect(html).not.toContain("data-review-blocker");
  });

  it("names why it cannot commit: own staged changes, nothing selected", () => {
    const blocked = panel([agent()], status({ staged: [staged("eigen.txt")] }));
    expect(tag(blocked, "review-commit")).toContain(' disabled=""');
    expect(blocked).toContain("Your staging area isn&#x27;t empty. Commit or unstage your own changes first.");
    useReviewStore.getState().setFocus("t1", "a2");
    sync();
    const second = panel([agent(), agent({ id: "a2", shortName: "tabelle", task: "Tabelle sortieren" })], status(), ["a1", "a2"]);
    expect(second).toContain('value="Tabelle sortieren"');
    expect(second).toContain("Commit selection (0 files)");
    expect(second).toContain("Nothing is selected.");
  });

  it("an edited message wins over the task", () => {
    useReviewStore.getState().patch("t1", "a1", { message: { summary: "Eigene Zusammenfassung", description: "" } });
    sync();
    expect(panel([agent()], status())).toContain('value="Eigene Zusammenfassung"');
  });
});

describe("ReviewActions", () => {
  it("offers the takeover, merge and discard; rebase waits for the uncommitted files", () => {
    const html = actions(agent());
    expect(tag(html, "review-take-over")).not.toContain(' disabled=""');
    expect(tag(html, "review-merge")).not.toContain(' disabled=""');
    expect(tag(html, "review-rebase")).toContain(' disabled=""');
    expect(tag(html, "review-rebase")).toContain("The agent&#x27;s worktree has 2 uncommitted files. Commit them there or discard the rest first.");
    expect(html).toContain("Rebase onto main");
    expect(tag(html, "review-discard")).not.toContain(' disabled=""');
    expect(html).toContain("(destructive)");
    expect(html).toContain("Unstaged");
    expect(html).toContain("Staged");
  });

  it("a running agent keeps its worktree; nothing selected blocks the takeover with a reason", () => {
    const running = actions(agent({ terminalId: "t9", status: "waiting" }), 0);
    expect(tag(running, "review-discard")).toContain(' disabled=""');
    expect(tag(running, "review-discard")).toContain("Stop the agent first – it is still working in its worktree.");
    expect(tag(running, "review-take-over")).toContain(' disabled=""');
    expect(running).toContain('data-review-blocker="take-over"');
    expect(running).toContain("Nothing is selected.");
  });
});
