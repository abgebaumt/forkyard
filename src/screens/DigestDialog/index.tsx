/**
 * "What's new" as a dialog: the last 24 hours as numbers and rows to jump to, and – while the AI
 * function is visible – one paragraph by the AI as plain text. Opens after a fetch with news and from the palette.
 */
import { useState } from "react";
import { core, type Digest, type Id, type RefsSnapshot } from "../../core";
import { AiErrorNotice } from "../../app/ai/AiErrorNotice";
import { checkProvider } from "../../app/ai/checkProvider";
import { askAi, showWhatIsSent } from "../../app/ai/gate";
import { useAiJob } from "../../app/ai/useAiJob";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { showInGraph } from "../../app/backNav";
import { openPr } from "../../app/actions/pullrequests";
import { showDialog } from "../../app/dialogs";
import { hostKindLabels } from "../../app/hosts";
import { qk, queryClient, useAiStatus, useRepo, useRepoSettings } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { Button, Spinner } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { locale, t } from "../../i18n";
import { digestNumbers, digestRows, type DigestNumbers, type DigestRow } from "./model";

const AI_FEATURE = "digest" as const;
const AI_INPUT = { kind: AI_FEATURE };

function openRow(repoId: Id, tabId: Id, row: DigestRow, base: string | null): void {
  switch (row.kind) {
    case "ref":
    case "commit":
      if (row.sha) showInGraph(tabId, row.sha);
      return;
    case "pr":
      openPr(tabId, row.number);
      return;
    case "file":
      useAppStore.getState().openHistory(tabId, row.path);
      return;
    case "behind": {
      // The base is a remote branch, or the local default branch when there is none.
      const refs = queryClient.getQueryData<RefsSnapshot>(qk.refs(repoId));
      const sha = [...(refs?.remotes ?? []), ...(refs?.locals ?? [])].find((ref) => ref.name === base)?.sha;
      if (sha) showInGraph(tabId, sha);
      return;
    }
  }
}

/** The numbers, announced politely. */
export function DigestSummary({ numbers }: { numbers: DigestNumbers }) {
  return (
    <p className="text-text-muted" aria-live="polite">
      <span data-digest-number="commits">{t("digest.numbers.commits", { count: numbers.commits })}</span>
      {" · "}
      <span data-digest-number="prs">{t("digest.numbers.prs", { count: numbers.prs })}</span>
      {" · "}
      <span data-digest-number="files">{t("digest.numbers.files", { count: numbers.files })}</span>
    </p>
  );
}

export function showDigestDialog(repoId: Id, tabId: Id, digest: Digest): Promise<null> {
  return showDialog<null>((done) => <DigestDialog repoId={repoId} tabId={tabId} digest={digest} onClose={() => done(null)} />);
}

function DigestDialog({ repoId, tabId, digest, onClose }: { repoId: Id; tabId: Id; digest: Digest; onClose: () => void }) {
  const status = useAiStatus();
  const { data: repo } = useRepo(repoId);
  const repoSettings = useRepoSettings(repoId);
  const job = useAiJob(status.data?.local ?? false);
  const [paragraph, setParagraph] = useState<string | null>(null);

  const numbers = digestNumbers(digest);
  const rows = digestRows(digest);
  const aiVisible = !digest.isEmpty && featureVisible(status.data, AI_FEATURE, repoSettings.data?.aiOff ?? false);
  const opensSetup = aiVisibility(status.data).elementsOpenSetup;
  const summarise = async () => {
    if (!checkProvider(status.data) || job.busy()) return;
    const answer = await job.start(
      (jobId) => core.aiDigest({ repoId, jobId, locale: locale() }),
      () => askAi(repoId, AI_FEATURE, AI_INPUT),
    );
    if (answer) setParagraph(answer.paragraph);
  };
  const showSent = () => void showWhatIsSent(repoId, AI_FEATURE, AI_INPUT, job.fail);
  // The dialog closes first: the view the row points to may take focus only then.
  const jump = (row: DigestRow) => {
    job.cancel();
    onClose();
    openRow(repoId, tabId, row, digest.behind?.base ?? null);
  };
  return (
    <Dialog
      open
      size="lg"
      title={t("digest.title", { repo: repo?.name ?? "" })}
      onOpenChange={(open) => {
        if (!open) {
          job.cancel();
          onClose();
        }
      }}
      footer={
        <>
          {aiVisible && !opensSetup ? (
            <Button data-digest-what-is-sent onClick={showSent} disabled={job.running}>
              {t("ui.whatIsSent")}
            </Button>
          ) : null}
          {aiVisible && job.running ? (
            <>
              <Spinner label={job.loading?.text} />
              <Button data-digest-summarise-cancel onClick={job.cancel}>
                {t("ui.cancel")}
              </Button>
            </>
          ) : aiVisible ? (
            <Button data-digest-summarise onClick={() => void summarise()}>
              {t("digest.summarise")}
            </Button>
          ) : null}
          <Button variant="primary" data-autofocus data-digest-close onClick={onClose}>
            {t("ui.close")}
          </Button>
        </>
      }
    >
      <div data-screen="digest" className="flex flex-col gap-2 text-sm">
        {aiVisible && paragraph ? (
          <p data-digest-paragraph className="selectable">
            {paragraph}
          </p>
        ) : null}
        {aiVisible && job.run.kind === "failed" ? (
          <AiErrorNotice
            name="digest-summarise-error"
            view={job.run.view}
            provider={status.data?.provider ?? null}
            onAgain={() => void summarise()}
            onShowSent={showSent}
          />
        ) : null}
        {digest.isEmpty ? (
          <p data-digest-empty className="text-text-muted">
            {t("digest.empty")}
          </p>
        ) : (
          <DigestSummary numbers={numbers} />
        )}
        {digest.prDataMissing ? (
          <p data-digest-pr-missing className="text-text-muted">
            {t("digest.prMissing", { host: hostKindLabels[digest.prDataMissing] })}
          </p>
        ) : null}
        <ul aria-label={t("digest.rows")} className="flex max-h-[50vh] flex-col overflow-y-auto">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                data-digest-row={row.key}
                onClick={() => jump(row)}
                className="w-full truncate rounded-sm px-1 py-0.5 text-left hover:bg-surface-raised"
              >
                {row.kind === "commit" ? <span className="pl-4">{row.label}</span> : row.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
