/**
 * Actions around issues: open the view, create a branch for an issue, open in the browser,
 * reload. Plus the view's filter (per repository) and the state of the section in the left panel.
 */
import { create } from "zustand";
import type { Id } from "../../core";
import { createBranch } from "../../app/actions/branches";
import { copyText } from "../../app/actions/clipboard";
import { currentBranch } from "../../app/actions/context";
import { openInBrowser } from "../../app/actions/hosts";
import type { HostRepo } from "../../app/actions/hostTypes";
import { qk, queryClient } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import type { IssueListState, IssueSummary } from "./api";
import { issueBranchName } from "./model";

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Opens the issue view in the centre; with `number` directly on that issue. */
export function openIssues(tabId: Id, number: number | null = null): void {
  useAppStore.getState().setCenter(tabId, { kind: "issues", number });
}

/** Reloads the list and open detail views (the host does not report changes by itself). */
export function refreshIssues(repoId: Id): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "repo" && query.queryKey[1] === repoId && (query.queryKey[2] === "issues" || query.queryKey[2] === "issue" || query.queryKey[2] === "hostRepo"),
  });
}

/** Address of the issue list at the host. */
export function issuesWebUrl(repo: HostRepo | null | undefined): string | null {
  if (!repo?.webUrl) return null;
  const base = repo.webUrl.replace(/\/+$/, "");
  return repo.kind === "gitlab" ? `${base}/-/issues` : `${base}/issues`;
}

export const openIssueInBrowser = (issue: Pick<IssueSummary, "webUrl">) => openInBrowser(issue.webUrl);

export const copyIssueLink = (issue: Pick<IssueSummary, "webUrl" | "key">) => (issue.webUrl ? copyText(issue.webUrl, t("issues.linkTo", { key: issue.key })) : Promise.resolve(false));

/**
 * "Create branch for this issue": the name is suggested from number and title and can be
 * changed. The branch starts at the current commit and is checked out – everything else
 * (invalid name, changes in the way) is handled by the same action as "New branch".
 */
export function createIssueBranch(repoId: Id, tabId: Id | null, issue: Pick<IssueSummary, "number" | "title" | "key">) {
  const branch = currentBranch(repoId);
  return createBranch(repoId, {
    tabId,
    suggestedName: issueBranchName(issue),
    title: t("issues.branch.title", { key: issue.key }),
    description: t("issues.branch.description", { at: branch ? ` (${branch})` : "" }),
  });
}

// ---------------------------------------------------------------------------
// The view's filter, per repository
// ---------------------------------------------------------------------------

export interface IssueViewFilter {
  state: IssueListState;
  /** What is in the search field (the search runs at the host, shortly after typing). */
  query: string;
  /** Only issues assigned to the connected account. */
  mine: boolean;
}

export const DEFAULT_FILTER: IssueViewFilter = { state: "open", query: "", mine: false };

interface FilterStore {
  filters: Record<Id, IssueViewFilter>;
  patch(repoId: Id, change: Partial<IssueViewFilter>): void;
}

export const useIssueFilters = create<FilterStore>((set) => ({
  filters: {},
  patch: (repoId, change) => set((state) => ({ filters: { ...state.filters, [repoId]: { ...(state.filters[repoId] ?? DEFAULT_FILTER), ...change } } })),
}));

export const useIssueFilter = (repoId: Id): IssueViewFilter => useIssueFilters((state) => state.filters[repoId] ?? DEFAULT_FILTER);

// ---------------------------------------------------------------------------
// Section in the left panel: collapsed, hidden (per repository, on this device)
// ---------------------------------------------------------------------------

export interface IssueSectionState {
  collapsed: boolean;
  hidden: boolean;
}

const SECTION_KEY = "gc.issuesSection";
const SECTION_DEFAULT: IssueSectionState = { collapsed: true, hidden: false };

function readSections(): Record<Id, IssueSectionState> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SECTION_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<Id, IssueSectionState>) : {};
  } catch {
    return {};
  }
}

interface SectionStore {
  sections: Record<Id, IssueSectionState>;
  set(repoId: Id, change: Partial<IssueSectionState>): void;
}

export const useIssueSections = create<SectionStore>((set) => ({
  sections: typeof window === "undefined" ? {} : readSections(),
  set: (repoId, change) =>
    set((state) => {
      const sections = { ...state.sections, [repoId]: { ...SECTION_DEFAULT, ...state.sections[repoId], ...change } };
      try {
        window.localStorage.setItem(SECTION_KEY, JSON.stringify(sections));
      } catch {
        // Storage full or blocked: the state then only lasts until restart.
      }
      return { sections };
    }),
}));

export const issueSectionState = (repoId: Id): IssueSectionState => ({ ...SECTION_DEFAULT, ...useIssueSections.getState().sections[repoId] });
export const useIssueSection = (repoId: Id): IssueSectionState => {
  const stored = useIssueSections((state) => state.sections[repoId]);
  return { ...SECTION_DEFAULT, ...stored };
};
export const setIssueSection = (repoId: Id, change: Partial<IssueSectionState>) => useIssueSections.getState().set(repoId, change);

/** The open issues of the first page – what the section in the left panel shows. */
export const SECTION_FILTER = { state: "open", query: "" } as const;

export const cachedHostRepo = (repoId: Id) => queryClient.getQueryData<HostRepo | null>(qk.hostRepo(repoId));
