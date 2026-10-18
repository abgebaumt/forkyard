import { describe, expect, it } from "vitest";
import type { Agent, Tab } from "../../core";
import { cockpitKeyAction, createStatusMemory, watchedRepos } from "./model";

const agent = (id: string, status: Agent["status"]): Agent => ({
  id,
  repoId: "repo-web",
  worktreeRepoId: `wt-${id}`,
  shortName: `task-${id}`,
  templateId: "claude",
  templateName: "Claude Code",
  task: "Fix login",
  branch: `agent/task-${id}`,
  worktreePath: `/home/anna/web.agents/task-${id}`,
  base: "main",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
  unattended: false,
  status,
  statusSource: "agent",
  terminalId: status === "running" || status === "waiting" ? "t1" : null,
  exitCode: status === "failed" ? 2 : null,
  lastLine: null,
  changedFiles: 0,
  commitsAhead: 0,
  startedAt: "2026-10-16T08:00:00Z",
  endedAt: null,
  test: null,
});

const tab = (id: string, kind: Tab["kind"], repoId: string | null, isActive: boolean, position: number): Tab => ({ id, kind, repoId, position, isActive, title: repoId ?? "", path: repoId ? `/home/anna/${repoId}` : null });

describe("agent watch across repository tabs", () => {
  it("follows every open repository tab, not only the active one, plus repositories that reported agents", () => {
    const tabs = [tab("t-web", "repo", "repo-web", false, 0), tab("t-api", "repo", "repo-api", true, 1), tab("t-manage", "management", null, false, 2), tab("t-web2", "repo", "repo-web", false, 3)];
    expect(watchedRepos(tabs, ["repo-closed", "repo-api"]).sort()).toEqual(["repo-api", "repo-closed", "repo-web"]);
    // Only the repository manager is open: the agent's repository is still watched.
    expect(watchedRepos([tab("t-manage", "management", null, true, 0)], ["repo-web"])).toEqual(["repo-web"]);
  });

  it("reports the change of an agent in a background repository and keeps each repository's last state apart", () => {
    const memory = createStatusMemory();
    // First list per repository: only the baseline, nothing announced.
    expect(memory.observe("repo-web", [agent("1", "running")])).toEqual([]);
    expect(memory.observe("repo-api", [agent("9", "running")])).toEqual([]);
    // The active tab (repo-api) does something unrelated; the background agent then waits.
    expect(memory.observe("repo-api", [agent("9", "running")])).toEqual([]);
    expect(memory.observe("repo-web", [agent("1", "waiting")]).map((change) => [change.agent.id, change.kind])).toEqual([["1", "waiting"]]);
    // The same list again: no second announcement.
    expect(memory.observe("repo-web", [agent("1", "waiting")])).toEqual([]);
    expect(memory.observe("repo-web", [agent("1", "failed")]).map((change) => change.kind)).toEqual(["failed"]);
  });
});

describe("cockpit keys", () => {
  it("acts only when the key is pressed on an agent row, never on a button", () => {
    expect(cockpitKeyAction("Enter", false, "a1")).toBe("details");
    expect(cockpitKeyAction("Enter", false, null)).toBeNull();
    expect(cockpitKeyAction("Delete", false, null)).toBeNull();
    expect(cockpitKeyAction("ContextMenu", false, null)).toBeNull();
    expect(cockpitKeyAction("F10", true, null)).toBeNull();
    expect(cockpitKeyAction(" ", false, null)).toBeNull();
    expect(cockpitKeyAction("ArrowDown", false, null)).toBeNull();
  });

  it("maps the list keys on a row", () => {
    expect(["ArrowDown", "ArrowUp", "Home", "End", "Delete", "ContextMenu"].map((key) => cockpitKeyAction(key, false, "a1"))).toEqual(["next", "previous", "first", "last", "cleanup", "menu"]);
    expect(cockpitKeyAction("F10", true, "a1")).toBe("menu");
    expect(cockpitKeyAction("F10", false, "a1")).toBeNull();
    expect(cockpitKeyAction("a", false, "a1")).toBeNull();
  });
});
