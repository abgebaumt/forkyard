/**
 * Texts and choices of the collision warning (package 2b): line ranges, banner titles, which
 * collisions a view shows, who can be informed and the prefilled note. Pure functions – the
 * check itself runs in the core (`agentCollisions`, event `agents:collisions`).
 */
import type { Agent, AgentCollision, CollisionFile, CollisionReport, Id, LineRange } from "../../core";
import { t } from "../../i18n";
import { hasSession } from "./model";

const span = (range: LineRange): string => (range.start === range.end ? String(range.start) : `${range.start}–${range.end}`);

/** "line 7", "lines 40–62", "lines 7, 40–62"; empty without ranges. Line numbers are not grouped. */
export function formatRanges(ranges: LineRange[]): string {
  const [first] = ranges;
  if (!first) return "";
  if (ranges.length === 1 && first.start === first.end) return t("agents.collision.lineOne", { line: String(first.start) });
  return t("agents.collision.lines", { list: ranges.map(span).join(", ") });
}

/** "src/auth.ts (lines 40–62)", or only the path. */
export function fileLabel(file: CollisionFile): string {
  const lines = formatRanges(file.ranges);
  return lines ? t("agents.collision.file", { path: file.path, lines }) : file.path;
}

/** Agent id → short name (the name in banners and notes). */
export const agentNames = (agents: Agent[]): Map<Id, string> => new Map(agents.map((agent) => [agent.id, agent.shortName]));

const nameOf = (names: Map<Id, string>, id: Id): string => names.get(id) ?? id;

/** The banner title: who, would collide / both change, where. */
export function collisionTitle(collision: AgentCollision, names: Map<Id, string>): string {
  const first = collision.files[0];
  const plain = {
    a: nameOf(names, collision.agentId),
    b: collision.otherAgentId === null ? "" : nameOf(names, collision.otherAgentId),
    base: collision.base ?? "",
    file: first ? fileLabel(first) : "",
  };
  const count = Math.max(0, collision.files.length - 1);
  const more = { ...plain, count };
  const pair = collision.otherAgentId !== null;
  if (collision.kind === "conflict") {
    if (pair) return count > 0 ? t("agents.collision.conflictPairMore", more) : t("agents.collision.conflictPair", plain);
    return count > 0 ? t("agents.collision.conflictBaseMore", more) : t("agents.collision.conflictBase", plain);
  }
  if (pair) return count > 0 ? t("agents.collision.overlapPairMore", more) : t("agents.collision.overlapPair", plain);
  return count > 0 ? t("agents.collision.overlapBaseMore", more) : t("agents.collision.overlapBase", plain);
}

/** Labels of the two sides of a preview: the first agent, then the other agent or the base. */
export function sideLabels(collision: AgentCollision, names: Map<Id, string>): [string, string] {
  const other = collision.otherAgentId === null ? t("agents.collision.theBase", { base: collision.base ?? "" }) : nameOf(names, collision.otherAgentId);
  return [nameOf(names, collision.agentId), other];
}

export const conflictFiles = (collision: AgentCollision): CollisionFile[] => collision.files.filter((file) => file.conflict);

/** The collisions a view shows: of agents the list knows, optionally only those of `agentId`; none while failed. */
export function collisionsOf(report: CollisionReport | undefined, agents: Agent[], agentId: Id | null = null): AgentCollision[] {
  if (!report || report.state === "failed") return [];
  const known = new Set(agents.map((agent) => agent.id));
  return report.collisions.filter(
    (collision) =>
      known.has(collision.agentId) &&
      (collision.otherAgentId === null || known.has(collision.otherAgentId)) &&
      (agentId === null || collision.agentId === agentId || collision.otherAgentId === agentId),
  );
}

/** Ids of collisions that were not shown before (for the live region). */
export const newCollisionIds = (before: Set<string>, collisions: AgentCollision[]): string[] => collisions.map((collision) => collision.id).filter((id) => !before.has(id));

/** Running agents of the collision, the one started later first (the default recipient). */
export function informTargets(collision: AgentCollision, agents: Agent[]): Agent[] {
  return agents
    .filter((agent) => (agent.id === collision.agentId || agent.id === collision.otherAgentId) && hasSession(agent))
    .sort((x, y) => y.startedAt.localeCompare(x.startedAt) || y.id.localeCompare(x.id));
}

/** The prefilled note for `recipient`: names the other side and the files. */
export function informText(collision: AgentCollision, recipient: Id, names: Map<Id, string>): string {
  const files = collision.files.map(fileLabel).join(", ");
  if (collision.otherAgentId === null) return t("agents.collision.messageBase", { base: collision.base ?? "", files });
  const other = recipient === collision.agentId ? collision.otherAgentId : collision.agentId;
  return t("agents.collision.messagePair", { other: nameOf(names, other), files });
}
