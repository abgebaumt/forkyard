/**
 * Scenarios for screenshots and tests. Every screen folder can have a `scenario.ts` with
 *
 *   export const scenarios: Record<string, Scenario> = { conflict: async (ctx) => { … } };
 *
 * in it. `?scenario=WipPanel.conflict` runs `scenarios.conflict` from the folder `WipPanel` after
 * start (prefix = folder name up to the first `_`). The result is then in `document.documentElement.dataset.scenario`
 * ("running" | "done" | "error" | "unknown") – Playwright can wait for that.
 */
import type { QueryClient } from "@tanstack/react-query";
import { core, type Core, type Id, type Tab } from "../core";
import { qk } from "../app/queries";
import { useAppStore } from "../app/store";

export interface ScenarioContext {
  core: Core;
  /** The zustand store: `ctx.store.getState().openOverlay(...)`. */
  store: typeof useAppStore;
  queryClient: QueryClient;
  /** Active tab according to the core (freshly loaded). */
  activeTab(): Promise<Tab | null>;
  /** Opens a repository by path (without the folder dialog) and waits until the tabs are reloaded. */
  openRepo(path: string): Promise<{ repoId: Id; tabId: Id }>;
  /** Waits until `check()` is true (at most `timeoutMs`). */
  waitFor(check: () => boolean | Promise<boolean>, timeoutMs?: number): Promise<void>;
  /** All URL parameters, e.g. `ctx.params.get("file")` – the E2E driver sets them via `params`. */
  params: URLSearchParams;
  /** Path of the test repository from `?fixture=…` (set by `shot.mjs --fixture`), otherwise null. */
  fixture: string | null;
  /**
   * The repository the scenario works on: opens `fixture` if given, otherwise the active
   * repo tab applies. Throws if there is none.
   */
  repo(): Promise<{ repoId: Id; tabId: Id }>;
}

export type Scenario = (ctx: ScenarioContext) => Promise<void>;

const modules = import.meta.glob<{ scenarios?: Record<string, Scenario> }>("./*/scenario.ts", { eager: true });

/** All scenarios as "WipPanel.conflict" → function. */
export function listScenarios(): Map<string, Scenario> {
  const result = new Map<string, Scenario>();
  for (const [file, module] of Object.entries(modules)) {
    // "./WipPanel/scenario.ts" → "WipPanel"
    const folder = file.split("/")[1] ?? "";
    const prefix = folder.split("_")[0] ?? folder;
    for (const [name, scenario] of Object.entries(module.scenarios ?? {})) result.set(`${prefix}.${name}`, scenario);
  }
  return result;
}

export function createScenarioContext(queryClient: QueryClient): ScenarioContext {
  const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting in scenario.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const params = new URLSearchParams(window.location.search);
  const context: ScenarioContext = {
    core,
    store: useAppStore,
    queryClient,
    params,
    fixture: params.get("fixture"),
    async activeTab() {
      const tabs = await queryClient.fetchQuery({ queryKey: qk.tabs, queryFn: () => core.tabsList(), staleTime: 0 });
      return tabs.find((tab) => tab.isActive) ?? null;
    },
    async openRepo(path) {
      const opened = await core.repoOpen({ path });
      await queryClient.invalidateQueries({ queryKey: qk.tabs });
      await queryClient.invalidateQueries({ queryKey: qk.repos });
      return { repoId: opened.repo.id, tabId: opened.tab.id };
    },
    async repo() {
      if (context.fixture) return context.openRepo(context.fixture);
      const tab = await context.activeTab();
      if (!tab || tab.kind !== "repo" || !tab.repoId) throw new Error("The scenario needs an open repository (?fixture=<path> or an active repo tab).");
      return { repoId: tab.repoId, tabId: tab.id };
    },
    waitFor,
  };
  return context;
}

/** Runs the scenario from the URL (if one is given). Call once after start. */
export async function runScenarioFromUrl(queryClient: QueryClient): Promise<void> {
  const id = new URLSearchParams(window.location.search).get("scenario");
  if (!id) return;
  const root = document.documentElement;
  const scenario = listScenarios().get(id);
  if (!scenario) {
    root.dataset.scenario = "unknown";
    console.warn(`Scenario "${id}" does not exist. Available: ${[...listScenarios().keys()].join(", ") || "none"}`);
    return;
  }
  root.dataset.scenario = "running";
  try {
    await scenario(createScenarioContext(queryClient));
    root.dataset.scenario = "done";
  } catch (error) {
    root.dataset.scenario = "error";
    console.error(`Scenario "${id}" failed:`, error);
  }
}
