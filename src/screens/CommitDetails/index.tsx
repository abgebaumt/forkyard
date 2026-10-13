import type { Id, Sha } from "../../core";
import type { CommitSelection } from "../../app/store";
import { MultiCommits, TwoCommits } from "./Compare";
import { SingleCommit } from "./SingleCommit";
import { StashDetails } from "./StashDetails";
import { t } from "../../i18n";

export interface CommitDetailsPanelProps {
  repoId: Id;
  tabId: Id;
  /** One or more commits (comparison, range) or a stash. */
  selection: CommitSelection;
}

/**
 * Commit panel for a selection in the graph:
 * one commit (details, edit message, all files), two commits (comparison),
 * several (combined diff or explanation), a stash.
 */
export function CommitDetailsPanel({ repoId, tabId, selection }: CommitDetailsPanelProps) {
  return (
    <section data-screen="commit-details" data-selection={selection.kind === "stash" ? "stash" : String(selection.shas.length)} aria-label={t("commitDetails.panel")} className="flex h-full min-h-0 flex-col bg-surface text-base text-text">
      <Content repoId={repoId} tabId={tabId} selection={selection} />
    </section>
  );
}

function Content({ repoId, tabId, selection }: CommitDetailsPanelProps) {
  if (selection.kind === "stash") return <StashDetails key={`stash-${selection.index}`} repoId={repoId} tabId={tabId} index={selection.index} />;
  // Duplicate SHAs count once; the order of the selection is kept.
  const shas = [...new Set(selection.shas)];
  const [first, second] = shas;
  if (first === undefined) return null;
  if (shas.length === 1) return <SingleCommit key={first} repoId={repoId} tabId={tabId} sha={first} />;
  if (shas.length === 2 && second !== undefined) {
    return <TwoCommits key={[...shas].sort().join("-")} repoId={repoId} tabId={tabId} shas={[first, second] as [Sha, Sha]} />;
  }
  return <MultiCommits repoId={repoId} tabId={tabId} shas={shas} />;
}
