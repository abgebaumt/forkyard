/**
 * Coding agents in the terminal tabs (Paket 0's program sessions). Starting opens a program
 * session whose opener asks the core to start the agent – so the terminal output is caught from the
 * first byte, as for a shell. A later start of the same session (the terminal's "Restart") resumes
 * the agent instead of creating a new one. The link session ↔ agent lets the cockpit show an agent's
 * terminal and the tab strip say "waiting for you".
 *
 * Imports xterm.js through sessions.ts: only screens import this module, never command files.
 */
import { useSyncExternalStore } from "react";
import { core, type Agent, type Id } from "../../core";
import { getTabView, useAppStore } from "../../app/store";
import { showTerminal } from "../Terminal/actions";
import { closeSession, openProgramSession, selectSession, sessionByKey, type Opener } from "../Terminal/sessions";
import { displayName, needsYou } from "./model";

interface Link {
  tabId: Id;
  key: Id;
}

const links = new Map<Id, Link>();
const waiting = new Set<Id>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the agent in this terminal tab waits for the user (for Paket 0's tab strip). */
export function useAgentSessionWaiting(key: Id): boolean {
  return useSyncExternalStore(subscribe, () => waiting.has(key));
}

export const agentSessionKey = (agentId: Id): Id | null => links.get(agentId)?.key ?? null;

/** Takes over the newest agent list of a repository: which agent tabs wait for the user. */
export function syncAgentSessions(agents: Agent[]): void {
  let changed = false;
  for (const agent of agents) {
    const link = links.get(agent.id);
    if (!link) continue;
    const wants = needsYou(agent);
    if (wants !== waiting.has(link.key)) {
      if (wants) waiting.add(link.key);
      else waiting.delete(link.key);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Makes the terminal region visible without moving the focus (the start's answer may come late). */
function revealTerminal(tabId: Id): void {
  if (!getTabView(tabId).terminalOpen) useAppStore.getState().toggleTerminal(tabId);
}

export interface StartInput {
  repoId: Id;
  tabId: Id;
  templateId: string;
  task: string;
  branch: string;
  base: string;
  unattended: boolean;
  /** For the tab title until the core answers. */
  shortName: string;
}

/** An opener that starts the agent the first time and resumes it every further time. */
function agentOpener(first: (size: { cols: number; rows: number }) => Promise<Agent>, onAgent: (agent: Agent) => void): Opener {
  let agentId: Id | null = null;
  return async (size) => {
    const agent = agentId ? await core.agentResume({ agentId, ...size }) : await first(size);
    agentId = agent.id;
    onAgent(agent);
    if (!agent.terminalId) throw new Error("The agent has no terminal.");
    return agent.terminalId;
  };
}

/** Starts the agent in a new terminal tab of the repository tab; resolves once the core has started it. */
export function startAgent(input: StartInput): Promise<Agent> {
  return new Promise<Agent>((resolve, reject) => {
    let key: Id | null = null;
    let settled = false;
    const opener = agentOpener(
      async (size) => {
        try {
          return await core.agentStart({ repoId: input.repoId, templateId: input.templateId, task: input.task, branch: input.branch, base: input.base, unattended: input.unattended, ...size });
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
            // The empty tab of the failed start goes away again.
            queueMicrotask(() => key && closeSession(input.tabId, key));
          }
          throw error;
        }
      },
      (agent) => {
        if (key) links.set(agent.id, { tabId: input.tabId, key });
        if (!settled) {
          settled = true;
          resolve(agent);
        }
      },
    );
    const session = openProgramSession(input.tabId, input.repoId, displayName({ shortName: input.shortName, unattended: input.unattended }), opener);
    key = session.key;
    revealTerminal(input.tabId);
  });
}

/** “Resume”: in the agent's old terminal tab if it is still there, otherwise in a new one. */
export function resumeAgent(tabId: Id, agent: Agent): Promise<Agent> {
  const link = links.get(agent.id);
  const old = link && link.tabId === tabId ? sessionByKey(tabId, link.key) : null;
  return new Promise<Agent>((resolve, reject) => {
    if (old) {
      // Its opener knows the agent and resumes it.
      const stop = old.subscribe(() => {
        const status = old.getStatus();
        if (status.kind === "running") {
          stop();
          resolve(agent);
        } else if (status.kind === "failed") {
          stop();
          reject(new Error(status.text));
        }
      });
      selectSession(tabId, old.key);
      old.start();
      revealTerminal(tabId);
      return;
    }
    let key: Id | null = null;
    const opener = agentOpener(
      (size) => core.agentResume({ agentId: agent.id, ...size }).catch((error) => {
        reject(error);
        throw error;
      }),
      (next) => {
        if (key) links.set(next.id, { tabId, key });
        resolve(next);
      },
    );
    const session = openProgramSession(tabId, agent.repoId, displayName(agent), opener);
    key = session.key;
    revealTerminal(tabId);
  });
}

/** Shows the agent's terminal tab and puts the focus there (a direct user action). False if it has none here. */
export function showAgentTerminal(tabId: Id, agentId: Id): boolean {
  const link = links.get(agentId);
  if (!link || link.tabId !== tabId || !sessionByKey(tabId, link.key)) return false;
  selectSession(tabId, link.key);
  showTerminal(tabId);
  return true;
}
