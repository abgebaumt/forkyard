/**
 * "Review and push …": the AI provider looks at what the push sends and names
 * leftovers – debug output, commented-out code, likely mistakes. Hints without a promise of
 * severity; keys come from the local scan only. "Push anyway" is always possible; "Back" (or
 * Escape) never pushes and cancels a running request. Waiting, slowness and errors are shown here,
 * never as a toast, and an answer that arrives later never moves the focus. "Show what was sent"
 * and "Send this time" stay inside this dialog: the dialog host shows one dialog at a time.
 */
import { useEffect, useState } from "react";
import { core, type AiInput, type AiProviderKind, type AiPushReview, type Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { useAiJob } from "../../app/ai/useAiJob";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { locale, t } from "../../i18n";
import { reviewPushLabel, reviewRows, reviewSummary } from "./model";

export interface ReviewTarget {
  branch: string | null;
  remote: string | null;
  remoteBranch: string | null;
}

function ReviewDialog({
  repoId,
  target,
  local,
  provider,
  onDone,
}: {
  repoId: Id;
  target: ReviewTarget;
  local: boolean;
  provider: AiProviderKind | null;
  onDone: (push: boolean) => void;
}) {
  const job = useAiJob(local, t("pushCheck.review.loading"));
  const [review, setReview] = useState<AiPushReview | null>(null);
  const [round, setRound] = useState(0);
  const [sent, setSent] = useState<string | null>(null);
  const input: AiInput = { kind: "outgoing_changes", branch: target.branch, remote: target.remote, remoteBranch: target.remoteBranch };

  // Starts on open and on "Again"; "Back" closes the dialog, which cancels the job (useAiJob).
  useEffect(() => {
    setReview(null);
    void job
      .start((jobId) =>
        core.aiPushReview({
          repoId,
          jobId,
          branch: target.branch,
          remote: target.remote,
          remoteBranch: target.remoteBranch,
          locale: locale(),
        }),
      )
      .then((answer) => {
        if (answer) setReview(answer);
      });
    return job.cancel;
  }, [repoId, target, round]);

  const again = () => {
    setSent(null);
    setRound((value) => value + 1);
  };
  const showSent = async () => {
    try {
      const preview = await core.aiPreview({ repoId, feature: "push_review", input, locale: locale() });
      setSent(preview.text);
    } catch (error) {
      job.fail(error);
    }
  };
  /** "Send this time" at the monthly limit: the click is the confirmation for exactly this text. */
  const sendThisTime = async () => {
    try {
      const preview = await core.aiPreview({ repoId, feature: "push_review", input, locale: locale() });
      await core.aiPreviewConfirm({
        repoId,
        feature: "push_review",
        fingerprint: preview.fingerprint,
        triggers: preview.asks,
        dontAskAgain: false,
      });
      again();
    } catch (error) {
      job.fail(error);
    }
  };

  const loading = job.loading;
  const failure = job.run.kind === "failed" ? job.run.view : null;
  const phase = failure ? "error" : review ? "done" : "loading";
  const findings = review?.findings.length ?? 0;

  return (
    <Dialog
      open
      size="lg"
      title={t("pushCheck.review.title")}
      description={t("pushCheck.review.description")}
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
      footer={
        <>
          <Button data-autofocus data-action="review-back" onClick={() => onDone(false)}>
            {t("pushCheck.review.back")}
          </Button>
          <Button variant="primary" data-action="review-push" onClick={() => onDone(true)}>
            {reviewPushLabel(phase, findings)}
          </Button>
        </>
      }
    >
      <div data-screen="push-review" className="flex flex-col gap-3">
        {loading ? (
          <div aria-live="polite">
            <p className="m-0 text-base text-text">{loading.text}</p>
            {loading.slow ? <p className="m-0 text-sm text-text-muted">{loading.slow}</p> : null}
          </div>
        ) : null}
        {failure ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="m-0 text-base text-text">{failure.text}</p>
            <div className="flex flex-wrap gap-2">
              {failure.kind === "setup" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    // The review dialog closes first; dialogs are queued (1b's setup dialog follows).
                    onDone(false);
                    void openAiSetup();
                  }}
                >
                  {t("ai.state.setup")}
                </Button>
              ) : null}
              {failure.kind === "notLoggedIn" && provider ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onDone(false);
                    signInInTerminal(provider);
                  }}
                >
                  {t("ai.setup.cli.signIn")}
                </Button>
              ) : null}
              {failure.kind === "limit" ? (
                <>
                  <Button size="sm" onClick={() => void sendThisTime()}>
                    {t("ai.state.limitSend")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onDone(false);
                      openAiSettings();
                    }}
                  >
                    {t("ai.state.limitChange")}
                  </Button>
                </>
              ) : null}
              {failure.kind === "unavailable" ? (
                <Button size="sm" onClick={again}>
                  {t("ai.state.retry")}
                </Button>
              ) : null}
              {failure.kind !== "setup" &&
              failure.kind !== "limit" &&
              failure.kind !== "unavailable" &&
              !(failure.kind === "notLoggedIn" && provider) ? (
                <Button size="sm" onClick={again}>
                  {t("ai.state.again")}
                </Button>
              ) : null}
              {failure.kind === "invalid" || failure.kind === "tooLarge" ? (
                <Button size="sm" variant="ghost" onClick={() => void showSent()}>
                  {t("ai.state.showSent")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {review ? (
          <>
            <p aria-live="polite" className="m-0 text-base font-medium text-text">
              {reviewSummary(review)}
            </p>
            {review.partial ? <p className="m-0 text-sm text-text-muted">{t("pushCheck.review.partial")}</p> : null}
            {review.findings.length ? (
              <ul aria-label={t("pushCheck.review.listLabel")} className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-auto p-0">
                {reviewRows(review).map((row) => (
                  <li key={row.key} data-review-finding={row.location} className="rounded-md border border-border bg-surface-sunken p-2">
                    <p className="m-0 font-mono text-code break-all text-text">{row.location}</p>
                    <p className="m-0 text-sm text-text-muted">{row.kind}</p>
                    <p className="selectable m-0 mt-1 text-base text-text">{row.note}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
        {sent !== null ? (
          <pre
            data-ai-preview-text
            className="selectable m-0 max-h-64 overflow-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-code break-words whitespace-pre-wrap text-text"
          >
            {sent}
          </pre>
        ) : null}
      </div>
    </Dialog>
  );
}

export async function showPushReview(repoId: Id, target: ReviewTarget, local: boolean, provider: AiProviderKind | null): Promise<boolean> {
  return (
    (await showDialog<boolean>((done) => (
      <ReviewDialog repoId={repoId} target={target} local={local} provider={provider} onDone={done} />
    ))) === true
  );
}
