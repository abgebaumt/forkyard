/**
 * Squash from the multi-selection in the graph: preview of the commits that get combined, and the
 * resulting message – prefilled with the messages of everyone involved.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Combine, ListOrdered } from "lucide-react";
import { core, type Id, type Sha } from "../../core";
import { busyKeys } from "../../app/actions/keys";
import { reportOpResult } from "../../app/actions/merge";
import { confirm } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { useSettings, useStatus } from "../../app/queries";
import { runAction } from "../../app/run";
import { withFreshStatus } from "../../app/statusCache";
import { useAppStore, useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { TextArea, TextField } from "../../ui/Field";
import { chainOldestFirst, combinedMessage, joinMessage } from "./model";
import { ColumnBar, CommitCells, LoadError, Name, SkeletonRows, StartButton, StatePanel, ToolFooter, ToolHeader, type StartRef } from "./parts";
import { ReorderList } from "./ReorderList";
import { useCommitRows } from "./useCommitRows";
import { t } from "../../i18n";

const SUMMARY_NOTICE = 50;
const SUMMARY_LIMIT = 72;

export function SquashMode({ repoId, tabId, shas, onClose, startRef }: { repoId: Id; tabId: Id; shas: Sha[]; onClose: () => void; startRef: StartRef }) {
  startRef.current = null;
  const unique = useMemo(() => [...new Set(shas)], [shas]);
  const { pending, error, commits, retry } = useCommitRows(repoId, unique);
  const { data: status } = useStatus(repoId);
  const { data: settings } = useSettings();
  const busy = useBusy(busyKeys.history(repoId));
  const [active, setActive] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const chain = useMemo(() => (pending || error ? null : chainOldestFirst(commits)), [pending, error, commits]);
  const ordered = useMemo(() => (chain ? chain.map((sha) => commits.find((commit) => commit.sha === sha)!) : []), [chain, commits]);

  // Prefill as soon as all commits are there – once; after that the field belongs to the user.
  useEffect(() => {
    if (summary !== null || ordered.length < 2) return;
    const message = combinedMessage(ordered);
    setSummary(message.summary);
    setDescription(message.description);
  }, [ordered, summary]);

  useEffect(() => {
    if (ordered.length >= 2) listRef.current?.focus({ preventScroll: true });
  }, [ordered.length]);

  const branch = status?.head.kind === "branch" ? status.head.branch : null;
  const header = (
    <ToolHeader
      icon={<Combine className="size-icon" aria-hidden />}
      title={t("rebase.tool.squash")}
      onClose={onClose}
      subtitle={
        <>
          <span className="shrink-0">{t("rebase.commits", { count: unique.length })}</span>
          {branch ? (
            <>
              <span className="shrink-0">{t("rebase.squash.on")}</span>
              <Name>{branch}</Name>
            </>
          ) : null}
          <span className="shrink-0">{t("rebase.squash.becomeOne")}</span>
        </>
      }
    />
  );

  if (unique.length < 2) {
    return (
      <>
        {header}
        <StatePanel state="empty" icon={<Combine className="size-8" aria-hidden />} title={t("rebase.squash.tooFewTitle")} actions={<Button onClick={onClose}>{t("rebase.backToGraph")}</Button>}>
          {t("rebase.squash.tooFewBody")}
        </StatePanel>
      </>
    );
  }
  if (pending) {
    return (
      <>
        {header}
        <ColumnBar direction={t("rebase.direction.oldestTop")} lead={<span className="w-6 shrink-0" />} />
        <SkeletonRows rows={Math.min(unique.length, 8)} />
      </>
    );
  }
  if (error) {
    return (
      <>
        {header}
        <LoadError error={error} icon={<Combine className="size-8" aria-hidden />} onRetry={retry} onClose={onClose} />
      </>
    );
  }
  if (!chain) {
    const merge = commits.some((commit) => commit.parents.length > 1);
    // The oldest of the selection: its parent is the base for an interactive rebase.
    const shaSet = new Set(commits.map((commit) => commit.sha));
    const roots = commits.filter((commit) => !commit.parents.some((parent) => shaSet.has(parent)));
    const oldest = roots.length ? roots.reduce((a, b) => (a.authoredAt <= b.authoredAt ? a : b)) : null;
    const base = oldest?.parents[0] ?? null;
    return (
      <>
        {header}
        <StatePanel
          state={merge ? "refused-merge" : "refused-gap"}
          icon={<AlertTriangle className="size-8 text-warning" aria-hidden />}
          title={merge ? t("rebase.squash.mergeTitle") : t("rebase.squash.gapTitle")}
          actions={
            <>
              <Button variant={base && !merge ? "secondary" : "primary"} onClick={onClose}>
                {t("rebase.backToGraph")}
              </Button>
              {base && !merge ? (
                <Button variant="primary" icon={<ListOrdered className="size-icon" aria-hidden />} onClick={() => useAppStore.getState().openRebase(tabId, base, "interactive")}>
                  {t("rebase.squash.interactiveInstead")}
                </Button>
              ) : null}
            </>
          }
        >
          {merge
            ? t("rebase.squash.mergeBody")
            : t("rebase.squash.gapBody")}
        </StatePanel>
      </>
    );
  }

  const cleanSummary = (summary ?? "").trim();
  const length = [...cleanSummary].length;
  const blocked = busy ? null : !cleanSummary ? t("rebase.squash.summaryEmpty") : status?.operation ? t("rebase.squash.operationRunning") : null;
  const pushed = ordered.some((commit) => commit.isPushed);

  const submit = async () => {
    if (blocked || busy) return;
    if (pushed) {
      // Rewriting pushed commits costs being in sync with the remote: ask first.
      const ok = await confirm({
        title: t("rebase.squash.confirmTitle", { count: ordered.length }),
        body: branch ? t("rebase.squash.confirmBodyBranch", { branch }) : t("rebase.squash.confirmBody"),
        confirmLabel: t("rebase.squash.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    const message = joinMessage({ summary: cleanSummary, description });
    const result = await runAction(t("rebase.squash.label"), withFreshStatus(repoId, () => core.squashCommits({ repoId, shas: chain, message })), { busyKey: busyKeys.history(repoId) });
    if (!result.ok) return;
    onClose();
    reportOpResult(t("rebase.squash.label"), result.value, tabId, { reveal: true });
  };
  startRef.current = () => void submit();

  return (
    <>
      {header}
      {pushed ? (
        <Banner tone="warning" title={t("rebase.squash.pushedTitle")}>
          {t("rebase.squash.pushedBody")}
        </Banner>
      ) : null}
      <ColumnBar direction={t("rebase.squash.direction")} lead={<span className="w-6 shrink-0" />} />
      <div className="min-h-0 flex-1">
        <ReorderList
          listRef={listRef}
          count={ordered.length}
          getKey={(index) => ordered[index]!.sha}
          active={active}
          onActiveChange={setActive}
          ariaLabel={t("rebase.squash.listLabel")}
          reorderable={false}
          rowLabel={(index) => {
            const commit = ordered[index]!;
            return `${commit.summary}, ${commit.author.name}, ${shortSha(commit.sha)}`;
          }}
          renderRow={(index) => {
            const commit = ordered[index]!;
            return (
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-3">
                <span aria-hidden className="flex w-6 shrink-0 justify-center font-mono text-xs text-text-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-text" data-summary="">
                  {commit.summary}
                </span>
                <CommitCells authorName={commit.author.name} authorEmail={commit.author.email} authoredAt={commit.authoredAt} sha={commit.sha} dateFormat={settings?.dateFormat ?? "relative"} />
              </div>
            );
          }}
        />
      </div>
      <form
        aria-label={t("rebase.squash.formLabel")}
        className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface px-3 pt-2 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("rebase.squash.summary")}
          value={summary ?? ""}
          maxLength={2000}
          spellCheck
          autoComplete="off"
          error={summary !== null && !cleanSummary ? t("rebase.squash.summaryEmpty") : undefined}
          hint={length >= SUMMARY_NOTICE ? (length > SUMMARY_LIMIT ? t("rebase.squash.charsTooMany", { count: length, limit: SUMMARY_LIMIT }) : t("rebase.squash.chars", { count: length })) : undefined}
          onChange={(event) => setSummary(event.target.value.replace(/[\r\n]+/g, " "))}
        />
        <TextArea label={t("rebase.squash.description")} value={description} rows={4} spellCheck className="font-mono text-code" onChange={(event) => setDescription(event.target.value)} />
        <button type="submit" hidden />
      </form>
      <ToolFooter
        keys={[["Mod+Enter", t("rebase.squash.keySquash")]]}
        info={
          <span className="flex min-w-0 items-center gap-1.5" role="status">
            <span className="shrink-0 font-medium">{t("rebase.commits", { count: ordered.length })} → {t("rebase.commits", { count: 1 })}</span>
            <span className="truncate text-text-muted">· {t("rebase.squash.laterRebased")}</span>
          </span>
        }
      >
        <Button variant="ghost" onClick={onClose}>
          {t("rebase.cancel")}
        </Button>
        <StartButton action="start" label={t("rebase.squash.start")} blocked={blocked} loading={busy} icon={<Combine className="size-icon" aria-hidden />} onClick={() => void submit()} />
      </ToolFooter>
    </>
  );
}
