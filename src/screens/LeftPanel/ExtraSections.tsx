/**
 * The "Worktrees", "Submodules" and "Pull Requests" sections below the ref sections of the left
 * panel. They bring their own list, keyboard handling and menus; here they are only mounted.
 */
import type { Id, RepoViewState } from "../../core";
import type { MenuEntry } from "../../ui/Menu";
import { AgentsSection } from "../Agents/Section";
import { PullRequestsSection } from "../PullRequestView/Section";
import { SubmodulesSection } from "../SubmoduleDialog/Section";
import { issueSectionState, setIssueSection } from "../Issues/actions";
import { IssuesSection } from "../Issues/Section";
import { WorktreesSection } from "../Worktrees/Section";
import { sectionState, setSection } from "./viewState";
import { t } from "../../i18n";

export function ExtraSections({ repoId, tabId, query }: { repoId: Id; tabId: Id; query: string }) {
  return (
    <>
      <WorktreesSection repoId={repoId} tabId={tabId} query={query} />
      <AgentsSection repoId={repoId} tabId={tabId} query={query} />
      <SubmodulesSection repoId={repoId} tabId={tabId} query={query} />
      {/* Only for repositories whose remote belongs to GitHub or GitLab. */}
      <PullRequestsSection repoId={repoId} tabId={tabId} query={query} />
      <IssuesSection repoId={repoId} tabId={tabId} query={query} />
    </>
  );
}

/** Entries for a section header's menu: show and hide worktrees and submodules. */
export function extraSectionEntries(repoId: Id, view: RepoViewState): MenuEntry[] {
  // The "Issues" section remembers its state on this device (the core does not know it as a section).
  const issuesHidden = issueSectionState(repoId).hidden;
  const issues: MenuEntry = { label: t("sidebar.section.issues"), checked: !issuesHidden, onSelect: () => setIssueSection(repoId, { hidden: !issuesHidden }) };
  return [...builtIn(repoId, view), issues];
}

function builtIn(repoId: Id, view: RepoViewState): MenuEntry[] {
  return (
    [
      ["worktrees", t("sidebar.section.worktrees")],
      ["agents", t("agents.section.title")],
      ["submodules", t("sidebar.section.submodules")],
    ] as const
  ).map(([id, label]) => {
    const hidden = sectionState(view, id).hidden;
    return { label, checked: !hidden, onSelect: () => void setSection(repoId, id, { hidden: !hidden }) };
  });
}
