/**
 * Pure helpers of the agent cockpit: status as dot + word (never colour alone), runtime, counts,
 * the start dialog's rules and the actions per agent. No React, no core calls.
 */
import type { Agent, AgentCleanupPreview, AgentStatus, AgentTemplateInfo, AgentTemplateKind, AgentTestResult, AiProviderKind, Id, Tab } from "../../core";
import { t } from "../../i18n";

export type StatusTone = "accent" | "warning" | "success" | "danger" | "muted";

const TONES: Record<AgentStatus, StatusTone> = {
  starting: "accent",
  running: "accent",
  waiting: "warning",
  done: "success",
  failed: "danger",
  stopped: "muted",
  orphaned: "warning",
};

const LABELS: Record<AgentStatus, string> = {
  starting: t("agents.status.starting"),
  running: t("agents.status.running"),
  waiting: t("agents.status.waiting"),
  done: t("agents.status.done"),
  failed: t("agents.status.failed"),
  stopped: t("agents.status.stopped"),
  orphaned: t("agents.status.orphaned"),
};

export const statusTone = (status: AgentStatus): StatusTone => TONES[status];
export const statusLabel = (status: AgentStatus): string => LABELS[status];

/** “according to Claude Code” / “guessed” – only while the agent's program runs. */
export function statusOrigin(agent: Pick<Agent, "terminalId" | "statusSource" | "templateName">): string | null {
  if (agent.terminalId === null) return null;
  return agent.statusSource === "agent" ? t("agents.source.agent", { name: agent.templateName }) : t("agents.source.guess");
}

export const hasSession = (agent: Pick<Agent, "terminalId">): boolean => agent.terminalId !== null;

/** Waits for the user or has finished its turn, while its program still runs. */
export const needsYou = (agent: Pick<Agent, "terminalId" | "status">): boolean => hasSession(agent) && (agent.status === "waiting" || agent.status === "done");

export function agentCounts(agents: Agent[]): { running: number; waiting: number } {
  return { running: agents.filter(hasSession).length, waiting: agents.filter(needsYou).length };
}

/** Agents that need the user first, then running ones, then ended ones; newest first within. */
export function sortAgents(agents: Agent[]): Agent[] {
  const rank = (agent: Agent) => (needsYou(agent) ? 0 : hasSession(agent) ? 1 : 2);
  return [...agents].sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}

export function formatRuntime(startedAt: string, endedAt: string | null, now: number): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return t("agents.runtime.seconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("agents.runtime.minutes", { count: minutes });
  return t("agents.runtime.hours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

export const displayName = (agent: Pick<Agent, "shortName" | "unattended">): string =>
  agent.unattended ? t("agents.withoutPrompts", { name: agent.shortName }) : agent.shortName;

export function testLabel(test: AgentTestResult | null): string | null {
  if (!test) return null;
  if (test.state === "running") return t("agents.test.running");
  if (test.state === "passed") return t("agents.test.passed");
  return t("agents.test.failed", { code: test.exitCode ?? "?" });
}

// --- Start dialog -------------------------------------------------------------------

export const startLabel = (unattended: boolean): string => (unattended ? t("agents.start.startUnattended") : t("agents.start.start"));

export interface UnattendedChoice {
  available: boolean;
  /** Why the switch is off. */
  reason: string | null;
  /** What it does not cover on this system. */
  note: string | null;
}

export function unattendedChoice(template: AgentTemplateInfo | undefined): UnattendedChoice {
  if (!template) return { available: false, reason: null, note: null };
  return { available: template.unattendedBlocked === null, reason: template.unattendedBlocked, note: template.unattendedNote };
}

/** "signed in" / "not signed in" for a found built-in tool; null when unknown or for own programs. */
export function templateLoginWord(template: AgentTemplateInfo): string | null {
  if (template.login === "logged_in") return t("agents.start.signedIn");
  if (template.login === "logged_out") return t("agents.start.signedOut");
  return null;
}

export function templateOptionLabel(template: AgentTemplateInfo): string {
  if (template.path === null) return t("agents.start.optionMissing", { name: template.name });
  const named = template.version ? t("agents.start.optionVersion", { name: template.name, version: template.version }) : template.name;
  return template.login === "logged_out" ? t("agents.start.optionSignedOut", { label: named }) : named;
}

const PROVIDERS: Record<AgentTemplateKind, AiProviderKind | null> = { claude: "claude_code", codex: "codex", opencode: "opencode", custom: null };

/** The tool to sign in in the terminal: a found built-in tool that says it is signed out. */
export function templateSignIn(template: AgentTemplateInfo | undefined): AiProviderKind | null {
  if (!template || template.path === null || template.login !== "logged_out") return null;
  return PROVIDERS[template.kind];
}

export const defaultTemplateId = (templates: AgentTemplateInfo[]): string | null => templates.find((item) => item.path !== null)?.id ?? null;

export interface StartDraft {
  templateId: string | null;
  task: string;
  branch: string;
  base: string;
  unattended: boolean;
}

/** The first reason the start button is disabled, or null. */
export function startBlocker(draft: StartDraft, templates: AgentTemplateInfo[], suggestion: { branchProblem: string | null } | null, checking: boolean): string | null {
  const template = templates.find((item) => item.id === draft.templateId);
  if (!template) return t("agents.start.chooseTemplate");
  if (template.path === null) return t("agents.start.notFound", { name: template.name });
  if (!draft.task.trim()) return t("agents.start.taskEmpty");
  if (!draft.branch.trim()) return t("agents.start.branchEmpty");
  if (checking || !suggestion) return t("agents.start.branchChecking");
  if (suggestion.branchProblem) return suggestion.branchProblem;
  if (draft.unattended && template.unattendedBlocked) return template.unattendedBlocked;
  return null;
}

export const MANY_AGENTS = 5;

export const manyAgentsHint = (running: number): string | null => (running >= MANY_AGENTS ? t("agents.start.manyRunning", { count: running }) : null);

// --- Actions ----------------------------------------------------------------------------

export type AgentAction = "terminal" | "stop" | "resume" | "copyPath" | "review" | "tests" | "pr" | "cleanup" | "forget";

/** Whether `actionsFor` could offer “resume” for one of `agents` – only then are the templates needed. */
export const mayResume = (agents: readonly Agent[]): boolean => agents.some((agent) => agent.status !== "orphaned" && !hasSession(agent));

export function actionsFor(agent: Agent, options: { canResume: boolean; hasTestCommand: boolean; hasHost: boolean }): AgentAction[] {
  if (agent.status === "orphaned") return ["forget"];
  const out: AgentAction[] = [];
  if (hasSession(agent)) out.push("terminal", "stop");
  else if (options.canResume) out.push("resume");
  out.push("copyPath");
  if (agent.changedFiles > 0 || agent.commitsAhead > 0) out.push("review");
  if (options.hasTestCommand) out.push("tests");
  if (options.hasHost && agent.commitsAhead > 0) out.push("pr");
  out.push("cleanup");
  return out;
}

export interface CleanupLine {
  tone: "info" | "warning";
  text: string;
}

/** The lines of the cleanup confirmation, the warning about unpushed commits first. */
export function cleanupLines(preview: AgentCleanupPreview): CleanupLine[] {
  const lines: CleanupLine[] = [];
  if (preview.unpushedCommits > 0) lines.push({ tone: "warning", text: t("agents.cleanup.unpushed", { count: preview.unpushedCommits }) });
  if (preview.changedFiles > 0) lines.push({ tone: "info", text: t("agents.cleanup.changes", { count: preview.changedFiles }) });
  if (preview.running) lines.push({ tone: "info", text: t("agents.cleanup.running") });
  lines.push({ tone: "info", text: t("agents.cleanup.removed") });
  return lines;
}

export interface StatusChange {
  agent: Agent;
  kind: "waiting" | "done" | "failed";
}

/**
 * Agents whose status became “waiting”, “done” or “failed” since `before` (status per agent id of the
 * previous list). Agents without an earlier status (first load, newly started) report nothing.
 */
export function statusChanges(before: Map<Id, AgentStatus>, agents: Agent[]): StatusChange[] {
  const out: StatusChange[] = [];
  for (const agent of agents) {
    const previous = before.get(agent.id);
    if (previous === undefined || previous === agent.status) continue;
    if (agent.status === "waiting" || agent.status === "done" || agent.status === "failed") out.push({ agent, kind: agent.status });
  }
  return out;
}

/**
 * Last known status per agent, kept per repository for the whole session: the first list of a
 * repository only sets the baseline, every later one reports what changed. Lives outside any
 * component, so a repository that is not in the active tab keeps its baseline.
 */
export function createStatusMemory() {
  const byRepo = new Map<Id, Map<Id, AgentStatus>>();
  return {
    observe(repoId: Id, agents: Agent[]): StatusChange[] {
      const before = byRepo.get(repoId);
      byRepo.set(repoId, new Map(agents.map((agent) => [agent.id, agent.status])));
      return before ? statusChanges(before, agents) : [];
    },
  };
}

/** Repositories whose agents are watched: every open repository tab (active or not) and every repository that reported agents. */
export function watchedRepos(tabs: Tab[], agentRepos: Iterable<Id>): Id[] {
  const out = new Set<Id>();
  for (const tab of tabs) if (tab.kind === "repo" && tab.repoId) out.add(tab.repoId);
  for (const repoId of agentRepos) out.add(repoId);
  return [...out];
}

export type CockpitKeyAction = "next" | "previous" | "first" | "last" | "details" | "cleanup" | "menu";

/**
 * The cockpit's list keys. `rowId` is the agent row the key was pressed on, null for anything
 * else (a button, the header): keys there belong to that element, so Enter still presses a button.
 */
export function cockpitKeyAction(key: string, shiftKey: boolean, rowId: Id | null): CockpitKeyAction | null {
  if (rowId === null) return null;
  switch (key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "details";
    case "Delete":
      return "cleanup";
    case "ContextMenu":
      return "menu";
    case "F10":
      return shiftKey ? "menu" : null;
    default:
      return null;
  }
}

/** “Agents n” with the agents whose program runs (spec: toolbar switch “Agenten n”); without any just “Agents”. */
export const toolbarLabel = (running: number): string => (running > 0 ? t("agents.toolbar.labelCount", { count: running }) : t("agents.toolbar.label"));
