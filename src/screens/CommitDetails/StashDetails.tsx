/**
 * A stash: description, branch, date, files – and apply, pop, delete.
 */
import { ArchiveRestore, GitBranch, Trash2 } from "lucide-react";
import type { Id } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { applyStash, dropStash, popStash } from "../../app/actions/stash";
import { useCommitDetails, useSettings, useStashes } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Tip } from "../../ui/Tooltip";
import { FilesSection } from "./FilesSection";
import { t } from "../../i18n";
import { DateText, errorParts, HeaderSkeleton, PanelBar, PanelError, ShaLink, SkeletonRows } from "./parts";

export interface StashDetailsProps {
  repoId: Id;
  tabId: Id;
  index: number;
}

export function StashDetails({ repoId, tabId, index }: StashDetailsProps) {
  const source = { kind: "stash", index } as const;
  const stashes = useStashes(repoId);
  const query = useCommitDetails(repoId, source);
  const { data: settings } = useSettings();
  const busy = useBusy(busyKeys.pop(repoId));
  const store = useAppStore.getState;
  const stash = stashes.data?.find((item) => item.index === index);
  const name = `stash@{${index}}`;

  const bar = (
    <PanelBar title="Stash">
      <code className="ml-1 font-mono text-code text-text-muted">{name}</code>
    </PanelBar>
  );

  if (stashes.isPending || (query.isPending && !stashes.isError)) {
    return (
      <>
        {bar}
        <HeaderSkeleton label={t("commitDetails.stash.loading")} />
        <div className="border-t border-border pt-1">
          <SkeletonRows count={4} label={t("commitDetails.files.loading")} />
        </div>
      </>
    );
  }

  const failure = stashes.isError ? stashes.error : query.isError ? query.error : null;
  if (failure || !stash) {
    const { code, text, hint } = failure ? errorParts(failure) : { code: "not_found", text: t("commitDetails.stash.missing", { index }), hint: "" };
    const gone = code === "not_found";
    return (
      <>
        {bar}
        <PanelError
          title={gone ? t("commitDetails.stash.gone") : t("commitDetails.stash.loadFailed")}
          detail={text}
          onRetry={() => {
            void stashes.refetch();
            void query.refetch();
          }}
          action={{ label: t("commitDetails.compare.clearSelection"), onClick: () => store().clearSelection(tabId) }}
        >
          {gone ? t("commitDetails.stash.goneHint") : hint || undefined}
        </PanelError>
      </>
    );
  }

  const message = stash.message || query.data?.commit?.summary || name;
  // With the SHA the actions find the stash again even if the list has shifted meanwhile.
  const ref = { index, message, sha: stash.sha };

  return (
    <>
      {bar}
      <header className="flex max-h-3/5 shrink-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 py-3">
        <h2 data-testid="stash-message" className="selectable text-lg font-semibold wrap-anywhere whitespace-pre-wrap text-text">
          {message}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-sm">
          <dt className="text-text-muted">Branch</dt>
          <dd data-testid="stash-branch" className="flex min-w-0 items-center gap-1.5 text-text">
            <GitBranch className="size-3.5 shrink-0 text-text-muted" aria-hidden />
            <span className="truncate" title={stash.branch ?? undefined}>
              {stash.branch ?? t("commitDetails.stash.noBranch")}
            </span>
          </dd>
          <dt className="text-text-muted">{t("commitDetails.stash.created")}</dt>
          <dd>
            <DateText value={stash.createdAt} format={settings?.dateFormat ?? "relative"} className="text-text" />
          </dd>
          <dt className="text-text-muted">{t("commitDetails.stash.base")}</dt>
          <dd className="-ml-1">
            <ShaLink sha={stash.baseSha} label={t("commitDetails.stash.jumpBase")} onOpen={(sha) => store().revealCommit(tabId, sha)} />
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Tip label={t("commitDetails.stash.applyTip")}>
            <Button size="sm" disabled={busy} onClick={() => void applyStash(repoId, ref, tabId)}>
              {t("commitDetails.stash.apply")}
            </Button>
          </Tip>
          <Tip label={t("commitDetails.stash.popTip")}>
            <Button
              size="sm"
              loading={busy}
              icon={<ArchiveRestore className="size-3.5" aria-hidden />}
              onClick={() => {
                void popStash(repoId, ref, tabId).then((result) => {
                  // After a pop without conflict the stash is gone; the changes are in the working directory.
                  if (result?.ok && result.value.status !== "conflict") store().selectWip(tabId);
                });
              }}
            >
              Pop
            </Button>
          </Tip>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            disabled={busy}
            icon={<Trash2 className="size-3.5" aria-hidden />}
            onClick={() => {
              void dropStash(repoId, ref).then((result) => {
                // The numbers of the remaining stashes move up; the selection must not land on a different one.
                if (result?.ok) store().selectWip(tabId);
              });
            }}
          >
            {t("commitDetails.stash.delete")}
          </Button>
        </div>
      </header>
      <FilesSection
        repoId={repoId}
        tabId={tabId}
        source={source}
        details={query.data}
        loading={query.isPending}
        error={query.isError ? query.error : null}
        onRetry={() => void query.refetch()}
        listLabel={t("commitDetails.stash.listLabel")}
        emptyText={t("commitDetails.stash.empty")}
      />
    </>
  );
}
