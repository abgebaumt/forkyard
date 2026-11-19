/**
 * "Clean up branches": the local branches that can go, grouped into safe, check first and can't be
 * deleted, each with the reasons as words. Safe branches are marked from the start; one button
 * deletes the marked ones (one undo entry), optionally also their branches on the remote.
 *
 * Keys: Tab through filter, checkboxes and buttons · Space toggles a branch · Esc: back.
 */
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { core, type BranchCleanupCandidate, type BranchCleanupReason, type Id } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { formatDateTime, formatRelative } from "../../app/format";
import { hostKindLabels } from "../../app/hosts";
import { qk } from "../../app/queries";
import { useBusy } from "../../app/store";
import { goBack } from "../../app/backNav";
import { keyBelongsToView } from "../../app/viewFocus";
import { LoadError } from "../../components/LoadError";
import { BackButton, isPlainEscape } from "../../components/ViewParts";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, Centered, SkeletonRows } from "../../ui/Feedback";
import { Checkbox, TextField } from "../../ui/Field";
import { t } from "../../i18n";
import { deleteSelected } from "./actions";
import { groupCandidates, initialSelection, lostCommits, remoteNames, selectionCount, toggleSelection } from "./model";

export interface BranchCleanupViewProps {
  repoId: Id;
  tabId: Id;
}

const reasonText = (reason: BranchCleanupReason): string =>
  reason.kind === "prMerged"
    ? t("cleanupBranches.reason.prMerged", { number: reason.number })
    : reason.kind === "unmerged" || reason.kind === "unpushed"
      ? t(`cleanupBranches.reason.${reason.kind}`, { count: reason.count })
      : t(`cleanupBranches.reason.${reason.kind}`);

export function BranchCleanupView({ repoId, tabId }: BranchCleanupViewProps) {
  const query = useQuery({ queryKey: qk.branchCleanup(repoId), queryFn: () => core.branchCleanupCandidates({ repoId }) });
  const candidates = useMemo(() => query.data?.candidates ?? [], [query.data]);
  const [filter, setFilter] = useState("");
  const [alsoRemote, setAlsoRemote] = useState(false);
  // The marks belong to one list: when names, SHAs or classes change, the safe ones are marked again.
  const listKey = candidates.map((candidate) => `${candidate.name}\0${candidate.sha}\0${candidate.class}`).join("\n");
  const [marked, setMarked] = useState<{ key: string; selection: Set<string> } | null>(null);
  const selection = marked?.key === listKey ? marked.selection : initialSelection(candidates);
  const toggle = (candidate: BranchCleanupCandidate) => setMarked({ key: listKey, selection: toggleSelection(selection, candidate) });
  // `running` also covers the remote deletions after the local one.
  const [running, setRunning] = useState(false);
  const busy = useBusy(busyKeys.branch(repoId)) || running;
  const runDelete = async () => {
    setRunning(true);
    try {
      await deleteSelected(repoId, candidates, selection, alsoRemote);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscape(event) || !keyBelongsToView(event)) return;
      event.preventDefault();
      goBack(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId]);

  const groups = groupCandidates(candidates, filter);
  const remotes = remoteNames(candidates);
  const { selected, total } = selectionCount(candidates, selection);
  const missingHost = query.data?.prDataMissing ?? null;

  let content;
  if (query.isPending) content = <SkeletonRows label={t("ui.loading")} />;
  else if (query.isError)
    content = <LoadError title={t("cleanupBranches.loadError")} error={query.error} onRetry={() => void query.refetch()} />;
  else if (candidates.length === 0)
    content = (
      <Centered data-cleanup-empty="">
        <p className="text-base text-text-muted">{t("cleanupBranches.empty")}</p>
      </Centered>
    );
  else
    content = (
      <>
        <div className="shrink-0 border-b border-border px-3 py-2">
          <TextField
            aria-label={t("cleanupBranches.filter")}
            placeholder={t("cleanupBranches.filter")}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            data-cleanup-filter=""
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.class} data-cleanup-group={group.class} aria-labelledby={`cleanup-${group.class}`}>
              <h3 id={`cleanup-${group.class}`} className="bg-surface-sunken px-3 py-1 text-sm font-medium text-text-muted">
                {t(`cleanupBranches.group.${group.class}`)} · {group.rows.length}
              </h3>
              <ul>
                {group.rows.map((candidate) => (
                  <CandidateRow key={candidate.name} candidate={candidate} checked={selection.has(candidate.name)} onToggle={toggle} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface px-3 py-2">
          {remotes.length > 0 ? (
            <div data-cleanup-remote="" className="min-w-0 flex-1">
              <Checkbox
                label={t("cleanupBranches.remote.option", { remotes: remotes.join(", ") })}
                hint={t("cleanupBranches.remote.warning")}
                checked={alsoRemote}
                onCheckedChange={setAlsoRemote}
              />
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <p role="status" aria-live="polite" data-cleanup-counter="" className="text-sm text-text-muted">
            {t("cleanupBranches.counter", { selected, total })}
          </p>
          <Button variant="danger" data-cleanup-delete="" disabled={selected === 0} loading={busy} onClick={() => void runDelete()}>
            {t("cleanupBranches.delete", { count: selected })}
          </Button>
        </footer>
      </>
    );

  return (
    <section aria-label={t("cleanupBranches.title")} data-screen="branch-cleanup" className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-md font-medium text-text">{t("cleanupBranches.title")}</h2>
        <BackButton tabId={tabId} />
      </header>
      {missingHost ? (
        <div data-cleanup-pr-missing="" className="shrink-0">
          <Banner tone="warning" title={t("cleanupBranches.prMissing", { host: hostKindLabels[missingHost] })} />
        </div>
      ) : null}
      {content}
    </section>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: BranchCleanupCandidate;
  checked: boolean;
  onToggle: (candidate: BranchCleanupCandidate) => void;
}) {
  const blocked = candidate.class === "blocked";
  const lost = lostCommits(candidate);
  return (
    <li
      data-cleanup-row={candidate.name}
      className="flex min-h-row flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1"
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={blocked || undefined}
        data-cleanup-check=""
        onClick={() => onToggle(candidate)}
        className={cn("flex min-w-0 items-center gap-2 rounded-sm text-left", blocked ? "cursor-default text-text-disabled" : "text-text")}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
            checked
              ? "border-accent bg-accent text-on-accent"
              : blocked
                ? "border-border bg-surface"
                : "border-border-input bg-surface-sunken",
          )}
        >
          {checked ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
        <span className="truncate font-mono text-code">{candidate.name}</span>
      </button>
      {candidate.reasons.map((reason) => (
        <span
          key={reason.kind}
          data-reason={reason.kind}
          className="inline-flex h-5 shrink-0 items-center rounded-sm border border-border px-1.5 text-xs whitespace-nowrap text-text-muted"
        >
          {reasonText(reason)}
        </span>
      ))}
      {lost !== null ? (
        <span data-cleanup-lost="" className="text-xs text-warning">
          {t("cleanupBranches.lost", { count: lost })}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-xs text-text-muted" title={formatDateTime(candidate.committedAt)}>
        {formatRelative(candidate.committedAt)}
      </span>
    </li>
  );
}
