/**
 * Comment box and draft cards of the PR review in the diff (8.3). "Add to review" keeps the comment as a
 * local draft (sent with "Submit review"), "Comment now" sends it at once. Ctrl+Enter = "Add to review",
 * Esc closes. The text lives with the caller, so scrolling the box out of the virtual list keeps it.
 */
import { useState } from "react";
import { CircleAlert } from "lucide-react";
import type { Id, NewReviewComment, PrDetails, ReviewDraft } from "../../core";
import { commentNow, deleteDraft, resaveDraft, saveDraft } from "../../app/actions/review";
import { prBusyKeys } from "../../app/actions/pullrequests";
import { useBusy } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { SafeMarkdown } from "../../components/markdown/SafeMarkdown";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { t } from "../../i18n";
import { threadLines } from "./reviewModel";

export function ReviewComposer({
  repoId,
  pr,
  comment,
  draft,
  body,
  onBody,
  autoFocus = false,
  onFocused,
  onDone,
}: {
  repoId: Id;
  pr: PrDetails;
  /** Where the comment goes (commentFor, or the edited draft's lines). */
  comment: Omit<NewReviewComment, "body">;
  /** Editing this local draft: "Add to review" replaces it, "Comment now" is not offered. */
  draft?: ReviewDraft;
  body: string;
  onBody: (body: string) => void;
  /** Only when the box has just been opened: not again when it remounts (scrolling back, switching tabs). */
  autoFocus?: boolean;
  /** The box has taken focus once. */
  onFocused?: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const busy = useBusy(prBusyKeys.write(repoId, pr.number));
  const text = body.trim();

  const add = async () => {
    if (!text || busy) return;
    if (await saveDraft(repoId, pr.number, { ...comment, body: text }, draft?.id)) onDone();
  };
  const now = async () => {
    if (!text || busy) return;
    if (await commentNow(repoId, pr.number, { ...comment, body: text })) onDone();
  };

  return (
    <form
      data-review-composer=""
      className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void add();
        }
      }}
    >
      {preview ? (
        <SafeMarkdown
          source={body}
          origin={t("pullRequest.view.review.previewOrigin")}
          empty={t("pullRequest.view.markdown.empty")}
          className="min-h-16"
        />
      ) : (
        <TextArea
          label={t("pullRequest.view.review.composerLabel", { lines: threadLines(comment) })}
          name="review-comment"
          rows={3}
          value={body}
          // Opened by C or a click on a line number; never over a dialog.
          autoFocus={autoFocus && viewMayTakeFocus()}
          onFocus={autoFocus ? onFocused : undefined}
          onChange={(event) => onBody(event.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-pressed={preview} data-review-preview="" onClick={() => setPreview((on) => !on)}>
          {preview ? t("ui.write") : t("ui.preview")}
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("ui.cancel")}
        </Button>
        {draft ? null : (
          <Button size="sm" data-review-comment-now="" disabled={!text} loading={busy} onClick={() => void now()}>
            {t("pullRequest.view.review.commentNow")}
          </Button>
        )}
        <Button type="submit" size="sm" variant="primary" data-review-add="" disabled={!text} loading={busy}>
          {t("pullRequest.view.review.addToReview")}
        </Button>
      </div>
    </form>
  );
}

/** A draft of the own review: local ones can be edited and discarded, host ones were started in the browser. */
export function DraftCard({ repoId, pr, draft, onEdit }: { repoId: Id; pr: PrDetails; draft: ReviewDraft; onEdit: () => void }) {
  const busy = useBusy(prBusyKeys.write(repoId, pr.number));
  const local = draft.origin === "local";
  const lines = threadLines(draft);
  return (
    <li data-review-draft={draft.id} data-origin={draft.origin} className="rounded-md border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm text-text-muted">
        <span className="rounded-pill border border-border bg-surface-raised px-2 text-text">{t("ui.draft")}</span>
        <span className="selectable min-w-0 truncate font-mono text-code text-text" title={draft.path}>
          {draft.path}
        </span>
        {lines ? <span>{lines}</span> : null}
        {draft.side === "old" ? <span>{t("pullRequest.view.reviewThreads.oldSide")}</span> : null}
        {local ? null : <span data-review-draft-host="">{t("pullRequest.view.review.startedInBrowser")}</span>}
      </header>
      <SafeMarkdown
        source={draft.body}
        origin={t("pullRequest.view.review.previewOrigin")}
        empty={t("pullRequest.view.markdown.empty")}
        className="px-3 py-2"
      />
      {draft.error ? (
        <p data-review-draft-error="" className="flex items-start gap-1.5 px-3 pb-2 text-sm text-text">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
          <span className="selectable">{t("pullRequest.view.review.draftFailed", { error: draft.error })}</span>
        </p>
      ) : null}
      {local ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-1.5">
          {/* A failed draft written for an older head commit: same text and lines again on the current head. */}
          {draft.error && draft.commit !== pr.headSha && draft.line !== null ? (
            <Button
              size="sm"
              data-review-draft-resave=""
              disabled={busy}
              onClick={() => void resaveDraft(repoId, pr.number, draft, pr.headSha)}
            >
              {t("pullRequest.view.review.resave")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" data-review-draft-edit="" disabled={busy} onClick={onEdit}>
            {t("ui.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-review-draft-delete=""
            disabled={busy}
            onClick={() => void deleteDraft(repoId, pr.number, draft.id)}
          >
            {t("pullRequest.view.review.deleteDraft")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
