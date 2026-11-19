/** The "Write release notes" row: button (becomes Cancel), "What is sent?", status, error, waiting suggestion. */
import type { Id } from "../../core";
import { t } from "../../i18n";
import { Button } from "../../ui/Button";
import { AiPreviewDialog } from "../../app/ai/PreviewDialog";
import type { AiFailure } from "../../app/ai/useAiJob";
import { doneLine } from "./model";
import type { Writer } from "./useWriter";

function ErrorLine({ error, writer, onSetup, onSignIn }: { error: AiFailure; writer: Writer; onSetup: () => void; onSignIn?: () => void }) {
  const retry =
    error.kind === "unavailable" ||
    error.kind === "invalid" ||
    error.kind === "limit" ||
    error.kind === "notLoggedIn" ||
    error.kind === "other";
  const retryLabel =
    error.kind === "invalid" || error.kind === "notLoggedIn"
      ? t("ai.state.again")
      : error.kind === "limit"
        ? t("ui.sendThisTime")
        : t("ui.retry");
  return (
    <div role="alert" aria-live="assertive" data-release-notes-error="" className="flex flex-wrap items-center gap-2 text-sm text-danger">
      <span>{error.text}</span>
      {error.kind === "setup" ? (
        <Button size="sm" onClick={onSetup}>
          {t("ai.state.setup")}
        </Button>
      ) : null}
      {error.kind === "notLoggedIn" && onSignIn ? (
        <Button size="sm" data-release-notes-sign-in="" onClick={onSignIn}>
          {t("ai.setup.cli.signIn")}
        </Button>
      ) : null}
      {retry ? (
        <Button size="sm" onClick={() => void writer.write()}>
          {retryLabel}
        </Button>
      ) : null}
      {error.kind === "invalid" ? (
        <Button size="sm" variant="ghost" onClick={() => void writer.whatIsSent()}>
          {t("ai.state.showSent")}
        </Button>
      ) : null}
      {error.kind === "limit" ? (
        <Button size="sm" variant="ghost" onClick={onSetup}>
          {t("ai.state.limitChange")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * `onSetup` opens Settings › AI. The writer always sits inside a modal dialog, which keeps the
 * settings overlay unreachable, so the caller closes its dialog first and then opens the settings.
 * `onSignIn` likewise closes the dialog and opens the CLI's sign-in in the terminal; the caller
 * passes it only for a CLI provider. "What is sent?" opens nested in the surrounding dialog.
 */
export function ReleaseNotesWriter({
  writer,
  openSetup,
  onSetup,
  onSignIn,
}: {
  /** The writer (`useReleaseNotesWriter`) already knows repository and target; kept for the callers. */
  repoId: Id;
  to: string | null;
  writer: Writer;
  openSetup: boolean;
  onSetup: () => void;
  onSignIn?: () => void;
}) {
  const { state } = writer;
  const view = writer.loading;
  const loading = view !== null;
  const status = view
    ? view.slow
      ? `${view.text} – ${view.slow}`
      : view.text
    : (state.emptyText ?? (state.notes ? doneLine(state.notes) : ""));
  const onWrite = () => {
    if (openSetup) onSetup();
    else if (loading) writer.cancel();
    else void writer.write();
  };
  return (
    <div className="flex flex-col gap-1.5" data-release-notes="">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-release-notes-write="" onClick={onWrite}>
          {loading ? t("ui.cancel") : state.notes ? t("ui.writeAgain") : t("actions.tags.releaseNotes.write")}
        </Button>
        {openSetup ? null : (
          <Button size="sm" variant="ghost" data-release-notes-what="" onClick={() => void writer.whatIsSent()}>
            {t("ui.whatIsSent")}
          </Button>
        )}
      </div>
      <p aria-live="polite" data-release-notes-state="" className="text-sm text-text-muted">
        {status}
      </p>
      {writer.error ? <ErrorLine error={writer.error} writer={writer} onSetup={onSetup} onSignIn={onSignIn} /> : null}
      {state.draft ? (
        <p className="flex items-center gap-2 text-sm text-text-muted">
          <span className="font-medium text-text">{t("ui.draft")}</span>
          <Button size="sm" variant="ghost" onClick={writer.discardDraft}>
            {t("ui.discard")}
          </Button>
        </p>
      ) : null}
      {state.pending ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-text">
          <span>{state.pending.kind === "ready" ? t("ai.suggestion.ready") : t("actions.tags.releaseNotes.suggestion")}</span>
          <Button size="sm" onClick={() => writer.resolvePending("replace")}>
            {t("ui.replace")}
          </Button>
          <Button size="sm" onClick={() => writer.resolvePending("append")}>
            {t("ai.suggestion.append")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => writer.resolvePending("discard")}>
            {t("ui.discard")}
          </Button>
        </div>
      ) : null}
      {writer.preview ? <AiPreviewDialog preview={writer.preview.preview} mode={writer.preview.mode} onDone={writer.closePreview} /> : null}
    </div>
  );
}
