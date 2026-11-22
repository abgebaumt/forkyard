/**
 * "Submit review" dialog (8.3): text, vote (only what the host allows here) and every draft in one go.
 * When drafts fail, the dialog stays open and lists them with their error; then no vote was sent.
 */
import { useState } from "react";
import { Send } from "lucide-react";
import type { Id, PrDetails, ReviewDraft, ReviewVote } from "../../core";
import { submitReview } from "../../app/actions/review";
import { prBusyKeys } from "../../app/actions/pullrequests";
import { showDialog } from "../../app/dialogs";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea } from "../../ui/Field";
import { RadioChoice } from "../../ui/Radio";
import { t } from "../../i18n";
import { threadLines } from "./reviewModel";

const voteLabels: Record<ReviewVote, string> = {
  comment: t("pullRequest.view.review.voteComment"),
  approve: t("pullRequest.view.review.voteApprove"),
  request_changes: t("pullRequest.view.review.voteRequestChanges"),
};

function SubmitReviewDialog({
  repoId,
  pr,
  choices,
  drafts,
  onDone,
}: {
  repoId: Id;
  pr: PrDetails;
  choices: ReviewVote[];
  drafts: number;
  onDone: (vote: ReviewVote | null) => void;
}) {
  const [vote, setVote] = useState<ReviewVote>("comment");
  const [body, setBody] = useState("");
  const [failed, setFailed] = useState<ReviewDraft[]>([]);
  const busy = useBusy(prBusyKeys.write(repoId, pr.number));

  const submit = async () => {
    if (busy) return;
    const result = await submitReview(repoId, pr.number, vote, body.trim(), pr.headSha);
    if (result?.submitted) onDone(vote);
    else if (result) setFailed(result.failed);
  };

  return (
    <Dialog
      open
      size="sm"
      title={t("pullRequest.view.review.submit")}
      description={drafts > 0 ? t("pullRequest.view.review.draftCount", { count: drafts }) : t("pullRequest.view.review.noDrafts")}
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      footer={
        <>
          <Button disabled={busy} onClick={() => onDone(null)}>
            {t("ui.cancel")}
          </Button>
          <Button variant="primary" loading={busy} icon={<Send className="size-icon" aria-hidden />} onClick={() => void submit()}>
            {t("pullRequest.view.review.submit")}
          </Button>
        </>
      }
    >
      <div data-screen="pr-review-submit" className="flex flex-col gap-3">
        <TextArea
          label={t("pullRequest.view.review.bodyLabel")}
          name="review-body"
          rows={4}
          value={body}
          data-autofocus
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {choices.length > 1 ? (
          <RadioChoice
            label={t("pullRequest.view.review.voteLabel")}
            value={vote}
            options={choices.map((value) => ({ value, label: voteLabels[value] }))}
            onValueChange={setVote}
          />
        ) : null}
        <div aria-live="polite" data-review-submit-failed="">
          {failed.length > 0 ? (
            <>
              <p className="text-sm font-medium text-text">{t("pullRequest.view.review.failed", { count: failed.length })}</p>
              <ul className="mt-1 flex flex-col gap-1 text-sm text-text-muted">
                {failed.map((draft) => (
                  <li key={draft.id} className="selectable">
                    <span className="font-mono text-code text-text">{draft.path}</span> {threadLines(draft)}: {draft.error}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** Opens the dialog; the vote that went out, or null (cancelled, or drafts failed and the user gave up). */
export function openSubmitReview(repoId: Id, pr: PrDetails, choices: ReviewVote[], drafts: number): Promise<ReviewVote | null> {
  return showDialog<ReviewVote>((done) => <SubmitReviewDialog repoId={repoId} pr={pr} choices={choices} drafts={drafts} onDone={done} />);
}
