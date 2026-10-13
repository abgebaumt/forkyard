/**
 * "Files" tab of a pull request: what it changes overall – from the LOCAL repository, with the
 * app's diff view. If its commits are not available locally yet, that is said, with "Fetch".
 */
import { useEffect, useState } from "react";
import { CloudDownload, FileQuestion, GitBranch, RefreshCw } from "lucide-react";
import type { Id } from "../../core";
import type { PrDetails } from "../../app/actions/hostTypes";
import { checkoutPr } from "../../app/actions/pullrequests";
import { busyKeys } from "../../app/actions/keys";
import { fetchAll } from "../../app/actions/sync";
import { describeError } from "../../app/errors";
import { locale, t } from "../../i18n";
import { useCommitDetails, usePrRange } from "../../app/queries";
import { useBusy } from "../../app/store";
import { FileList } from "../../components/FileList";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { DiffView } from "../DiffView";

export function PrFiles({ repoId, tabId, pr }: { repoId: Id; tabId: Id; pr: PrDetails }) {
  const range = usePrRange(repoId, pr);
  const fetching = useBusy(busyKeys.fetch(repoId));
  const checkingOut = useBusy(busyKeys.history(repoId));
  const local = range.data?.state === "local" ? range.data : null;
  const source = local ? ({ kind: "range", from: local.from, to: local.to } as const) : null;
  const details = useCommitDetails(repoId, source);
  const files = details.data?.files ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const active = files.find((file) => file.path === selected) ?? files[0] ?? null;

  // After "Fetch" or "Check out" the commits may be there: look again.
  useEffect(() => {
    if (!fetching && !checkingOut && range.data?.state === "missing") void range.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetching, checkingOut]);

  if (range.isPending) {
    return (
      <div role="status" aria-label={t("pullRequest.view.files.loading")} data-pr-files="loading" className="flex flex-col gap-2 p-4">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-4 w-2/3 animate-pulse rounded-sm bg-surface-raised" />
        ))}
      </div>
    );
  }

  if (range.isError) {
    return (
      <div data-pr-files="error" className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FileQuestion className="size-6" aria-hidden />}
          title={t("pullRequest.view.files.rangeError")}
          action={
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void range.refetch()}>
              {t("pullRequest.view.files.retry")}
            </Button>
          }
        >
          {describeError(range.error).text}
        </EmptyState>
      </div>
    );
  }

  if (range.data.state === "empty") {
    return (
      <div data-pr-files="empty" className="flex h-full items-center justify-center">
        <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t("pullRequest.view.files.noCommits")}>
          {t("pullRequest.view.files.noCommitsText")}
        </EmptyState>
      </div>
    );
  }

  if (range.data.state === "missing") {
    return (
      <div data-pr-files="missing" className="flex h-full items-center justify-center">
        <EmptyState
          icon={<CloudDownload className="size-6" aria-hidden />}
          title={t("pullRequest.view.files.missing")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="primary" loading={fetching} icon={<CloudDownload className="size-3.5" aria-hidden />} onClick={() => void fetchAll(repoId)}>
                {t("pullRequest.view.files.fetch")}
              </Button>
              <Button size="sm" loading={checkingOut} disabled={fetching} icon={<GitBranch className="size-3.5" aria-hidden />} onClick={() => void checkoutPr(repoId, pr)}>
                {t("pullRequest.view.files.checkout")}
              </Button>
            </div>
          }
        >
          {t(pr.isFork ? "pullRequest.view.files.missingTextFork" : "pullRequest.view.files.missingText", { branch: pr.sourceBranch })}
        </EmptyState>
      </div>
    );
  }

  if (details.isError) {
    return (
      <div data-pr-files="error" className="flex h-full items-center justify-center">
        <EmptyState
          icon={<FileQuestion className="size-6" aria-hidden />}
          title={t("pullRequest.view.files.loadError")}
          action={
            <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void details.refetch()}>
              {t("pullRequest.view.files.retry")}
            </Button>
          }
        >
          {describeError(details.error).text}
        </EmptyState>
      </div>
    );
  }

  return (
    <div data-pr-files="local" className="@container flex h-full min-h-0 flex-col">
      <p className="flex h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-sm text-text-muted">
        <span className="min-w-0 flex-1 truncate">
          {details.isPending
            ? t("pullRequest.view.files.loadingFiles")
            : t("pullRequest.view.files.summary", { count: files.length, added: details.data.added.toLocaleString(locale()), removed: details.data.removed.toLocaleString(locale()) })}
        </span>
      </p>
      {details.data?.notCombinableReason ? <p className="shrink-0 border-b border-border bg-warning-surface px-3 py-1 text-sm text-text">{details.data.notCombinableReason}</p> : null}
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <div className="max-h-48 min-h-20 shrink-0 overflow-auto border-b border-border bg-surface @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
          <FileList
            files={files}
            selected={active ? [active.path] : []}
            onSelect={(path) => setSelected(path)}
            ariaLabel={t("pullRequest.view.files.listLabel")}
            loading={details.isPending}
            empty={<span className="block px-3 py-2 text-base text-text-muted">{t("pullRequest.view.files.noneChanged")}</span>}
          />
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          {active && source ? (
            <DiffView key={active.path} repoId={repoId} tabId={tabId} path={active.path} source={source} embedded />
          ) : details.isPending ? null : (
            <div className="flex h-full items-center justify-center">
              <EmptyState icon={<FileQuestion className="size-6" aria-hidden />} title={t("pullRequest.view.files.noneSelected")} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
