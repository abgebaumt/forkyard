/**
 * PR review (8.3): local drafts, single comments, resolving threads and submitting the review – at the
 * repository's host through the core. Errors show the core's message, which says what already went out.
 */
import { core, type Id, type NewReviewComment, type ReviewDraft, type ReviewSubmitResult, type ReviewVote, type Sha } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runHostAction } from "./hosts";
import { prBusyKeys } from "./pullrequests";

const reloadDrafts = (repoId: Id, number: number) => queryClient.invalidateQueries({ queryKey: qk.prReviewDrafts(repoId, number) });
const reloadThreads = (repoId: Id, number: number) => queryClient.invalidateQueries({ queryKey: qk.prReviewThreads(repoId, number) });

/** Stores a new local draft, or replaces `draftId` (which clears its error). Nothing is sent. */
export async function saveDraft(repoId: Id, number: number, comment: NewReviewComment, draftId?: string): Promise<boolean> {
  const result = await runHostAction(
    t("pullRequest.view.review.saveDraft"),
    () => core.prReviewDraftSave({ repoId, number, comment, ...(draftId ? { draftId } : {}) }),
    { busyKey: prBusyKeys.write(repoId, number) },
  );
  void reloadDrafts(repoId, number);
  return result.ok;
}

/**
 * Stores a local draft again against `head`, same text and lines – for a draft that failed because it was
 * written for an older head commit. Replaces it in one step, so the text is never lost in between.
 */
export function resaveDraft(repoId: Id, number: number, draft: ReviewDraft, head: Sha): Promise<boolean> {
  const { path, line, startLine, side, oldLine, body } = draft;
  // Only host drafts lose their line; those are read only and not re-saved here.
  if (line === null) return Promise.resolve(false);
  return saveDraft(repoId, number, { commit: head, path, line, startLine, side, oldLine, body }, draft.id);
}

export async function deleteDraft(repoId: Id, number: number, draftId: string): Promise<boolean> {
  const result = await runHostAction(
    t("pullRequest.view.review.deleteDraft"),
    () => core.prReviewDraftDelete({ repoId, number, draftId }),
    {
      busyKey: prBusyKeys.write(repoId, number),
    },
  );
  void reloadDrafts(repoId, number);
  return result.ok;
}

/** Sends one comment on a line (or range) at once, without a draft. */
export async function commentNow(repoId: Id, number: number, comment: NewReviewComment): Promise<boolean> {
  const result = await runHostAction(
    t("pullRequest.view.review.commentNow"),
    () => core.prReviewCommentCreate({ repoId, number, comment }),
    {
      busyKey: prBusyKeys.write(repoId, number),
    },
  );
  if (result.ok) void reloadThreads(repoId, number);
  return result.ok;
}

export async function setResolved(repoId: Id, number: number, resolveId: string, resolved: boolean): Promise<boolean> {
  const result = await runHostAction(
    t(resolved ? "pullRequest.view.review.resolve" : "pullRequest.view.review.reopen"),
    () => core.prReviewThreadResolve({ repoId, number, resolveId, resolved }),
    { busyKey: prBusyKeys.write(repoId, number) },
  );
  void reloadThreads(repoId, number);
  return result.ok;
}

/** Submits vote, text and every draft. Failed drafts stay with their error; then the vote is not sent. */
export async function submitReview(
  repoId: Id,
  number: number,
  vote: ReviewVote,
  body: string,
  commit: Sha,
): Promise<ReviewSubmitResult | null> {
  const result = await runHostAction(
    t("pullRequest.view.review.submit"),
    () => core.prReviewSubmit({ repoId, number, vote, body, commit }),
    {
      busyKey: prBusyKeys.write(repoId, number),
    },
  );
  // Even a failure can have sent drafts (the core's message says so): reload details, threads and drafts.
  void queryClient.invalidateQueries({ queryKey: qk.pr(repoId, number) });
  if (!result.ok) return null;
  const { submitted, failed } = result.value;
  if (submitted) toast({ tone: "success", title: t("pullRequest.view.review.submitted") });
  else
    toast({
      tone: "danger",
      title: t("pullRequest.view.review.failed", { count: failed.length }),
      description: failed.find((draft) => draft.error)?.error ?? undefined,
      sticky: true,
    });
  return result.value;
}
