/**
 * "Files" tab of a pull request: what it changes overall – from the LOCAL repository, with the
 * app's diff view. If its commits are not available locally yet, that is said, with "Fetch".
 *
 * PR review (8.3): threads and drafts sit between the lines; C or a click on a line number opens the
 * comment box (only while the local diff is the PR head). What has no line in the diff – outdated
 * threads, and those on files the pull request no longer changes – is listed in "Outdated" above it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CloudDownload, FileQuestion, GitBranch, RefreshCw } from "lucide-react";
import type { HostCapabilities, Id, NewReviewComment, PrDetails, ReviewDraft, ReviewThread } from "../../core";
import { checkoutPr } from "../../app/actions/pullrequests";
import { busyKeys } from "../../app/actions/keys";
import { fetchAll } from "../../app/actions/sync";
import { describeError } from "../../app/errors";
import { locale, t } from "../../i18n";
import { useCommitDetails, usePrRange, usePrReviewDrafts, usePrReviewThreads } from "../../app/queries";
import { useBusy } from "../../app/store";
import { FileList } from "../../components/FileList";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { DiffView, type DiffReviewLayer } from "../DiffView";
import type { LineRow, ReviewRow, Row } from "../DiffView/model";
import { DraftCard, ReviewComposer } from "./ReviewComposer";
import { ThreadCard, useReviewAi } from "./ReviewThreads";
import { anchorKey, canComment, commentFor, placeThreads, type Anchor, type Placement } from "./reviewPlacement";

/** "Show in diff" from the thread list: this file, this line. A new object each time (consumed once). */
export type PrJump = { path: string; anchor: Anchor };

/** The open comment box: where it goes, the text so far, the draft it edits. Kept by the view across tabs. */
export type Composing = {
  comment: Omit<NewReviewComment, "body">;
  body: string;
  draftId?: string;
  /** Just opened: the box takes focus once, not on every remount. */
  focus?: boolean;
};

const NO_THREADS: ReviewThread[] = [];
const NO_DRAFTS: ReviewDraft[] = [];
const noop = () => {};

/** The lines of a local draft being edited; its commit stays (re-saving on the head is "Save again"). */
const draftComment = (draft: ReviewDraft, head: string): Omit<NewReviewComment, "body"> => ({
  commit: draft.commit ?? head,
  path: draft.path,
  line: draft.line ?? 0,
  startLine: draft.startLine,
  side: draft.side,
  oldLine: draft.oldLine,
});

export function PrFiles({
  repoId,
  tabId,
  pr,
  capabilities,
  hostName,
  jumpTo,
  composing,
  onComposing,
}: {
  repoId: Id;
  tabId: Id;
  pr: PrDetails;
  capabilities: HostCapabilities;
  hostName: string;
  jumpTo: PrJump | null;
  composing: Composing | null;
  onComposing: (next: Composing | null) => void;
}) {
  const range = usePrRange(repoId, pr);
  const fetching = useBusy(busyKeys.fetch(repoId));
  const checkingOut = useBusy(busyKeys.history(repoId));
  const local = range.data?.state === "local" ? range.data : null;
  const source = local ? ({ kind: "range", from: local.from, to: local.to } as const) : null;
  const details = useCommitDetails(repoId, source);
  const files = details.data?.files ?? [];
  const [jump, setJump] = useState(jumpTo);
  const [selected, setSelected] = useState<string | null>(jumpTo?.path ?? null);
  const active = files.find((file) => file.path === selected) ?? files[0] ?? null;
  useEffect(() => {
    if (!jumpTo) return;
    setSelected(jumpTo.path);
    setJump(jumpTo);
  }, [jumpTo]);

  // --- Review ------------------------------------------------------------------
  const threads = usePrReviewThreads(repoId, pr.number, capabilities.reviewThreads).data ?? NO_THREADS;
  const draftsQuery = usePrReviewDrafts(repoId, capabilities.reviewComment ? pr.number : null);
  const drafts = draftsQuery.data?.drafts ?? NO_DRAFTS;
  const ai = useReviewAi(repoId);
  const commentable = canComment(range.data, pr, capabilities);
  const [outdatedOpen, setOutdatedOpen] = useState(true);
  const [foreignOpen, setForeignOpen] = useState(true);
  const path = active?.path ?? "";
  const openKey =
    composing && !composing.draftId && composing.comment.path === path
      ? anchorKey({ side: composing.comment.side, line: composing.comment.line })
      : undefined;
  /** The placement of the last `place` – `renderRow` runs in the same render, right after it. */
  const placement = useRef<Placement | null>(null);
  const place = useCallback(
    (rows: Row[]) => {
      placement.current = placeThreads(rows, path, threads, drafts, openKey);
      return placement.current.rows;
    },
    [path, threads, drafts, openKey],
  );

  const startComposing = (next: Composing) => {
    // A box with text stays: show it instead of throwing the text away.
    if (composing?.body.trim()) {
      setSelected(composing.comment.path);
      setJump({ path: composing.comment.path, anchor: { side: composing.comment.side, line: composing.comment.line } });
      return;
    }
    onComposing({ ...next, focus: true });
  };
  const onComment = (first: LineRow, last: LineRow) => startComposing({ comment: commentFor(path, first, last, pr.headSha), body: "" });

  const composer = (comment: Omit<NewReviewComment, "body">, draft?: ReviewDraft) =>
    composing ? (
      <li key="composer">
        <ReviewComposer
          repoId={repoId}
          pr={pr}
          comment={comment}
          draft={draft}
          body={composing.body}
          onBody={(body) => onComposing({ ...composing, body })}
          autoFocus={composing.focus}
          onFocused={() => onComposing({ ...composing, focus: false })}
          onDone={() => onComposing(null)}
        />
      </li>
    ) : null;

  const cards = (list: ReviewThread[], draftList: ReviewDraft[]) => (
    <>
      {list.map((thread) => (
        <ThreadCard
          key={thread.id}
          repoId={repoId}
          pr={pr}
          thread={thread}
          ai={ai}
          quotes={capabilities.reviewReplyQuotes}
          hostName={hostName}
          onApplied={noop}
          resolvable={capabilities.reviewResolve}
        />
      ))}
      {draftList.map((draft) =>
        composing?.draftId === draft.id && draft.line !== null ? (
          composer(draftComment(draft, pr.headSha), draft)
        ) : (
          <DraftCard
            key={draft.id}
            repoId={repoId}
            pr={pr}
            draft={draft}
            onEdit={() => startComposing({ comment: draftComment(draft, pr.headSha), body: draft.body, draftId: draft.id })}
          />
        ),
      )}
    </>
  );

  const review: DiffReviewLayer = {
    place,
    renderRow: (row: ReviewRow) => {
      const entry = placement.current?.at.get(row.anchor);
      return (
        <ul className="flex max-w-200 flex-col gap-2">
          {entry ? cards(entry.threads, entry.drafts) : null}
          {row.anchor === openKey && composing ? composer(composing.comment) : null}
        </ul>
      );
    },
    onComment: commentable ? onComment : undefined,
    range: capabilities.reviewCommentRange,
    jumpTo: jump?.path === path ? jump.anchor : null,
    renderAbove: (rows: Row[]) => {
      const here = placeThreads(rows, path, threads, drafts);
      return block(
        "outdated",
        t("pullRequest.view.review.outdated", { count: here.stale.length + here.staleDrafts.length }),
        outdatedOpen,
        setOutdatedOpen,
        here.stale,
        here.staleDrafts,
      );
    },
  };

  /** A collapsible list of cards above the diff; nothing when empty. */
  function block(
    name: string,
    title: string,
    open: boolean,
    setOpen: (open: boolean) => void,
    list: ReviewThread[],
    draftList: ReviewDraft[],
  ) {
    if (list.length + draftList.length === 0) return null;
    return (
      <div data-review-block={name} className="max-h-64 shrink-0 overflow-y-auto border-b border-border bg-bg px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 rounded-sm text-sm font-medium text-text-muted hover:text-text"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown className="size-icon" aria-hidden /> : <ChevronRight className="size-icon" aria-hidden />}
          {title}
        </button>
        {open ? <ul className="mt-1.5 mb-1 flex max-w-200 flex-col gap-2">{cards(list, draftList)}</ul> : null}
      </div>
    );
  }
  // Threads and drafts on files the pull request no longer changes: once for the whole tab, not per file.
  const listed = new Set(files.map((file) => file.path));
  const foreign = details.data ? threads.filter((thread) => !listed.has(thread.path)) : NO_THREADS;
  const foreignDrafts = details.data ? drafts.filter((draft) => !listed.has(draft.path)) : NO_DRAFTS;

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
              {t("ui.retry")}
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
              <Button
                size="sm"
                variant="primary"
                loading={fetching}
                icon={<CloudDownload className="size-3.5" aria-hidden />}
                onClick={() => void fetchAll(repoId)}
              >
                {t("pullRequest.view.files.fetch")}
              </Button>
              <Button
                size="sm"
                loading={checkingOut}
                disabled={fetching}
                icon={<GitBranch className="size-3.5" aria-hidden />}
                onClick={() => void checkoutPr(repoId, pr)}
              >
                {t("ui.checkOutBranch")}
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
              {t("ui.retry")}
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
            : t("pullRequest.view.files.summary", {
                count: files.length,
                added: details.data.added.toLocaleString(locale()),
                removed: details.data.removed.toLocaleString(locale()),
              })}
        </span>
      </p>
      {draftsQuery.data?.hostUnreadable ? (
        <p data-review-host-unreadable="" className="shrink-0 border-b border-border bg-surface px-3 py-1 text-sm text-text-muted">
          {t("pullRequest.view.review.hostDraftsUnreadable")}
        </p>
      ) : null}
      {block(
        "not-in-diff",
        t("pullRequest.view.review.notInDiff", { count: foreign.length + foreignDrafts.length }),
        foreignOpen,
        setForeignOpen,
        foreign,
        foreignDrafts,
      )}
      {capabilities.reviewComment && !commentable ? (
        <p
          data-review-fetch-hint=""
          className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-0.5 text-sm text-text-muted"
        >
          <span className="min-w-0 flex-1">{t("pullRequest.view.review.fetchToComment")}</span>
          <Button
            size="sm"
            variant="ghost"
            loading={fetching}
            icon={<CloudDownload className="size-3.5" aria-hidden />}
            onClick={() => void fetchAll(repoId)}
          >
            {t("pullRequest.view.files.fetch")}
          </Button>
        </p>
      ) : null}
      {details.data?.notCombinableReason ? (
        <p className="shrink-0 border-b border-border bg-warning-surface px-3 py-1 text-sm text-text">{details.data.notCombinableReason}</p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col @3xl:flex-row">
        <div className="max-h-48 min-h-20 shrink-0 overflow-auto border-b border-border bg-surface @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0">
          <FileList
            files={files}
            selected={active ? [active.path] : []}
            onSelect={(next) => {
              setSelected(next);
              setJump(null);
            }}
            ariaLabel={t("pullRequest.view.files.listLabel")}
            loading={details.isPending}
            empty={<span className="block px-3 py-2 text-base text-text-muted">{t("pullRequest.view.files.noneChanged")}</span>}
          />
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          {active && source ? (
            <DiffView key={active.path} repoId={repoId} tabId={tabId} path={active.path} source={source} embedded review={review} />
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
