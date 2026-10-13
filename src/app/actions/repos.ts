import { t } from "../../i18n";
import { core, type ErrorCode, type Id, type OpenedRepo, type Repo, type Settings, type Tab } from "../../core";
import { choose, confirm } from "../dialogs";
import { toast } from "../../ui/Feedback";
import { discardUnsaved, saveUnsaved, unsavedFiles } from "../../screens/FileView/buffer";
import { clip } from "./context";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { confirmLeaveCenter, useAppStore } from "../store";
import { confirmCloseTerminal } from "../../screens/Terminal/actions";
import { busyKeys } from "./keys";
import { openFromOtherProfile } from "./otherProfile";
import { switchProfile } from "./profiles";
import type { ActionResult } from "../run";

const setTabs = (tabs: Tab[]) => queryClient.setQueryData(qk.tabs, tabs);

/** System folder dialog, then open as a repository (the tab becomes active). */
export async function openRepository(defaultPath?: string) {
  const path = await core.pickFolder({ title: t("actions.repos.open"), defaultPath });
  if (!path) return null;
  return openRepositoryAt(path);
}

/**
 * `quiet`: return these errors without a message – the caller shows them itself ("not a repository" with an offer).
 * If only another profile lists the repository, the app asks whether to switch or list it here as well.
 */
export async function openRepositoryAt(path: string, options: { quiet?: ErrorCode[] } = {}): Promise<ActionResult<OpenedRepo>> {
  const open = (addToProfile: boolean) =>
    runAction(t("actions.repos.open"), () => core.repoOpen({ path, addToProfile }), { busyKey: busyKeys.openRepo, quiet: [...(options.quiet ?? []), "repo_other_profile"] });
  let result = await open(false);
  if (!result.ok && result.error.code === "repo_other_profile") {
    const answered = await openFromOtherProfile(path, {
      owners: (at) => core.repoProfiles({ path: at }),
      profiles: () => core.profileList(),
      ask: (question) => choose(question),
      switchTo: switchProfile,
      open: (_at, add) => open(add),
    });
    // Cancelled: silent, like a closed folder dialog.
    if (!answered) return result;
    result = answered;
  }
  if (result.ok) {
    void queryClient.invalidateQueries({ queryKey: qk.tabs });
    void queryClient.invalidateQueries({ queryKey: qk.repos });
  }
  return result;
}

/** New tab with the repository manager. */
export async function newTab() {
  const result = await runAction(t("actions.repos.newTab"), () => core.tabOpen({ repoId: null }));
  if (result.ok) setTabs(result.value);
  return result;
}

/** Opens the repository in a tab (or activates the existing one). */
export async function openRepoTab(repoId: Id) {
  const result = await runAction(t("actions.repos.openTab"), () => core.tabOpen({ repoId }));
  if (result.ok) {
    setTabs(result.value);
    void queryClient.invalidateQueries({ queryKey: qk.repos });
  }
  return result;
}

let activation = 0;

export async function activateTab(tabId: Id) {
  // Switch immediately, the core confirms.
  const ticket = ++activation;
  const previous = queryClient.getQueryData<Tab[]>(qk.tabs);
  if (previous) setTabs(previous.map((tab) => ({ ...tab, isActive: tab.id === tabId })));
  const result = await runAction(t("actions.repos.switchTab"), () => core.tabActivate({ tabId }));
  // If the user has switched on in the meantime (Ctrl+Tab several times quickly), the answer of the later switch applies –
  // otherwise the bar would briefly jump back, and Ctrl+W would hit the wrong tab.
  if (ticket !== activation) return result;
  if (result.ok) setTabs(result.value);
  else if (previous) setTabs(previous);
  return result;
}

/** What the tab is called in the bar (alias or folder name); null for the manager tab. */
function tabTitle(tabId: Id): string | null {
  const tab = queryClient.getQueryData<Tab[]>(qk.tabs)?.find((item) => item.id === tabId);
  const repo = tab?.repoId ? queryClient.getQueryData<Repo[]>(qk.repos)?.find((item) => item.id === tab.repoId) : undefined;
  return repo ? (repo.alias ?? repo.name) : null;
}

export async function closeTab(tabId: Id) {
  // Ask about unsaved work in the centre (conflict tool) first.
  if (!(await confirmLeaveCenter(tabId))) return null;
  // Unsaved text in this repository's editor: save, discard or keep open.
  const repoId = queryClient.getQueryData<Tab[]>(qk.tabs)?.find((item) => item.id === tabId)?.repoId ?? null;
  const unsaved = repoId ? unsavedFiles(repoId) : [];
  if (repoId && unsaved.length > 0) {
    const single = unsaved.length === 1;
    const answer = await choose({
      title: single
        ? t("actions.repos.unsaved.titleOne", { name: clip((unsaved[0]?.path ?? "").slice((unsaved[0]?.path ?? "").lastIndexOf("/") + 1), 40) })
        : t("actions.repos.unsaved.titleMany", { count: unsaved.length }),
      description: t("actions.repos.unsaved.description"),
      details: unsaved.map((file) => file.path),
      detailsLabel: t("actions.repos.unsaved.detailsLabel", { count: unsaved.length }),
      options: [
        {
          key: "save",
          label: t("actions.repos.unsaved.save"),
          description: t("actions.repos.unsaved.saveDescription", { count: unsaved.length }),
        },
        { key: "discard", label: t("actions.repos.unsaved.discard"), description: t("actions.repos.unsaved.discardDescription"), danger: true },
      ],
    });
    if (answer === null) return null;
    if (answer === "save") {
      const failed = await saveUnsaved(repoId);
      if (failed.length > 0) {
        toast({ tone: "danger", title: t("actions.repos.unsaved.failed"), description: t("actions.repos.unsaved.failedDescription", { files: failed.join(", ") }) });
        return null;
      }
    }
  }
  // A shell that was worked in ends with the tab: ask first.
  if (!(await confirmCloseTerminal(tabId, tabTitle(tabId)))) return null;
  const result = await runAction(t("actions.repos.closeTab"), () => core.tabClose({ tabId }));
  if (result.ok) {
    setTabs(result.value);
    useAppStore.getState().dropTabView(tabId);
    // The view is gone now; what was not meant to be saved does not linger as a draft.
    if (repoId && unsaved.length > 0) window.setTimeout(() => discardUnsaved(repoId), 0);
  }
  return result;
}

/** Closes all tabs except `keepId`. */
export async function closeOtherTabs(keepId: Id) {
  const tabs = queryClient.getQueryData<Tab[]>(qk.tabs) ?? [];
  for (const tab of tabs) {
    if (tab.id !== keepId) await closeTab(tab.id);
  }
}

export async function moveTab(tabId: Id, position: number) {
  const previous = queryClient.getQueryData<Tab[]>(qk.tabs);
  if (previous) {
    const moving = previous.find((tab) => tab.id === tabId);
    if (moving) {
      const rest = previous.filter((tab) => tab.id !== tabId).sort((a, b) => a.position - b.position);
      rest.splice(Math.max(0, Math.min(position, rest.length)), 0, moving);
      setTabs(rest.map((tab, index) => ({ ...tab, position: index })));
    }
  }
  const result = await runAction(t("actions.repos.moveTab"), () => core.tabMove({ tabId, position }));
  if (result.ok) setTabs(result.value);
  else if (previous) setTabs(previous);
  return result;
}

/** Removes the repository from the list (and closes its tabs). Everything on disk stays. */
export async function forgetRepo(repo: Pick<Repo, "id" | "name" | "alias" | "path">) {
  const ok = await confirm({
    title: t("actions.repos.forget.title", { name: repo.alias ?? repo.name }),
    body: t("actions.repos.forget.body", { path: repo.path }),
    confirmLabel: t("actions.repos.forget.action"),
  });
  if (!ok) return null;
  const result = await runAction(t("actions.repos.forget.label"), () => core.repoForget({ repoId: repo.id }));
  if (result.ok) {
    void queryClient.invalidateQueries({ queryKey: qk.repos });
    void queryClient.invalidateQueries({ queryKey: qk.tabs });
  }
  return result;
}

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

/** Set the zoom (0.8 to 2.0); applies immediately, the core stores it. How much of it takes effect in the window: zoom.ts. */
export async function setZoom(zoom: number) {
  const value = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) * 100) / 100;
  const previous = queryClient.getQueryData<Settings>(qk.settings);
  if (previous) queryClient.setQueryData<Settings>(qk.settings, { ...previous, zoom: value });
  const result = await runAction(t("actions.repos.zoom"), () => core.settingsSet({ patch: { zoom: value } }));
  if (result.ok) queryClient.setQueryData(qk.settings, result.value);
  else if (previous) queryClient.setQueryData(qk.settings, previous);
  return result;
}

export function changeZoom(delta: number) {
  const current = queryClient.getQueryData<Settings>(qk.settings)?.zoom ?? 1;
  return setZoom(current + delta);
}
