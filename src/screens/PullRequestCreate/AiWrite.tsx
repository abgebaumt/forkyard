/**
 * "Write from commits" in the pull request form: the AI suggests title and description
 * from the commits of the branch. Shown only while AI is on for this function and this repository;
 * with AI on but no provider connected a click opens Settings › AI. The form stays usable while the
 * request runs: a description the user wrote is never replaced unasked (Replace / Append / Discard),
 * typing meanwhile turns the answer into "Suggestion ready", the title is replaced only while it is
 * still the automatic suggestion ("Replace title?" otherwise). Mod+Z right after an insertion takes
 * it back. Cancelling drops the answer. Errors stay inline (never a toast), and an answer that
 * arrives later never moves the focus.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { core, type AiInput, type AiPrDescription, type Id } from "../../core";
import { AiErrorNotice } from "../../app/ai/AiErrorNotice";
import { askAi, showWhatIsSent } from "../../app/ai/gate";
import { checkProvider } from "../../app/ai/open";
import { applySuggestion } from "../../app/ai/suggestion";
import { useAiJob } from "../../app/ai/useAiJob";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { useAiStatus, useRepoSettings } from "../../app/queries";
import { Button } from "../../ui/Button";
import { locale, t } from "../../i18n";
import { isUndoKey, placeDescription, titleDecision, undoInsertion, writeBlockedReason, type InsertUndo } from "./aiModel";

const FEATURE = "pr_description" as const;

export interface PrAiFields {
  title: string;
  setTitle: (next: string) => void;
  /** The automatic title (`suggestTitle`) as the form last computed it. */
  autoTitle: string;
  text: string;
  setText: (next: string) => void;
  /** The description is still the repository's template, untouched. */
  untouchedTemplate: boolean;
}

export interface PrAiWriterInput {
  repoId: Id;
  /** Full ref names (`refs/heads/…`, `refs/remotes/…`); null while unknown. */
  source: string | null;
  target: string | null;
  /** Commits the source has ahead of the target; null = unknown. */
  ahead: number | null;
  sameBranch: boolean;
  fields: PrAiFields;
}

export interface PrAiWriter {
  visible: boolean;
  /** "What is sent?" and "Write from commits" / "Cancel" – for the description's header row. */
  control: ReactNode;
  /** Status, errors and the offers – below the description. */
  notices: ReactNode;
  /** The description is an inserted suggestion nobody edited yet. */
  draft: boolean;
  onTitleKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBodyKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

type PrInput = Extract<AiInput, { kind: "pr_description" }>;

interface BodyOffer {
  suggestion: string;
  ready: boolean;
}

export function usePrAiWriter({ repoId, source, target, ahead, sameBranch, fields }: PrAiWriterInput): PrAiWriter {
  const status = useAiStatus();
  const repoSettings = useRepoSettings(repoId);
  const job = useAiJob(status.data?.local ?? false);
  const { run, running, loading } = job;
  const [bodyOffer, setBodyOffer] = useState<BodyOffer | null>(null);
  const [titleOffer, setTitleOffer] = useState<string | null>(null);
  const [bodyUndo, setBodyUndo] = useState<InsertUndo | null>(null);
  const [titleUndo, setTitleUndo] = useState<InsertUndo | null>(null);
  const [inserted, setInserted] = useState<string | null>(null);
  const latest = useRef(fields);
  latest.current = fields;

  const visible = featureVisible(status.data, FEATURE, repoSettings.data?.aiOff ?? false);
  const opensSetup = aiVisibility(status.data).elementsOpenSetup;
  const input: PrInput | null = source && target ? { kind: "pr_description", source, target } : null;
  const blocked = writeBlockedReason({ source, target, ahead, sameBranch });

  const place = (answer: AiPrDescription, atStart: { text: string; untouchedTemplate: boolean }) => {
    const now = latest.current;
    const placement = placeDescription(now.text, atStart.text, atStart.untouchedTemplate && now.untouchedTemplate, answer.body);
    if (placement.kind === "insert") {
      setBodyOffer(null);
      setBodyUndo({ before: now.text, after: placement.text });
      setInserted(placement.text);
      now.setText(placement.text);
    } else {
      setBodyOffer({ suggestion: answer.body, ready: placement.kind === "ready" });
    }
    const decision = titleDecision(now.title, now.autoTitle, answer.title);
    if (decision === "replace") {
      setTitleOffer(null);
      setTitleUndo({ before: now.title, after: answer.title });
      now.setTitle(answer.title);
    } else {
      setTitleOffer(decision === "ask" ? answer.title : null);
    }
  };

  const start = async () => {
    if (!checkProvider(status.data)) return;
    if (!input || blocked || job.busy()) return;
    job.reset();
    try {
      if (!(await askAi(repoId, FEATURE, input))) return;
    } catch (error) {
      job.fail(error);
      return;
    }
    const atStart = { text: latest.current.text, untouchedTemplate: latest.current.untouchedTemplate };
    const answer = await job.start((jobId) =>
      core.aiPrDescription({ repoId, jobId, source: input.source, target: input.target, locale: locale() }),
    );
    if (answer) place(answer, atStart);
  };

  const cancel = job.cancel;

  const showSent = async () => {
    if (input) await showWhatIsSent(repoId, FEATURE, input, job.fail);
  };

  const takeBody = (how: "replace" | "append") => {
    if (!bodyOffer) return;
    const before = latest.current.text;
    const next = applySuggestion(before, bodyOffer.suggestion, how);
    setBodyOffer(null);
    setBodyUndo({ before, after: next });
    setInserted(how === "replace" ? next : null);
    latest.current.setText(next);
  };

  const replaceTitle = () => {
    if (titleOffer === null) return;
    setTitleUndo({ before: latest.current.title, after: titleOffer });
    latest.current.setTitle(titleOffer);
    setTitleOffer(null);
  };

  const onBodyKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!isUndoKey(event)) return;
    const restored = undoInsertion(latest.current.text, bodyUndo);
    if (restored === null) return;
    event.preventDefault();
    setBodyUndo(null);
    setInserted(null);
    latest.current.setText(restored);
  };

  const onTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!isUndoKey(event)) return;
    const restored = undoInsertion(latest.current.title, titleUndo);
    if (restored === null) return;
    event.preventDefault();
    setTitleUndo(null);
    latest.current.setTitle(restored);
  };

  const control: ReactNode = visible ? (
    <div className="flex shrink-0 items-center gap-1" data-pr-ai="">
      {opensSetup ? null : (
        <Button size="sm" variant="ghost" data-pr-ai-what-is-sent="" disabled={!input || running} onClick={() => void showSent()}>
          {t("pullRequest.create.ai.whatIsSent")}
        </Button>
      )}
      {running ? (
        <Button size="sm" data-pr-ai-cancel="" onClick={cancel}>
          {t("ai.state.cancel")}
        </Button>
      ) : (
        <Button size="sm" data-pr-ai-write="" disabled={!opensSetup && Boolean(blocked)} onClick={() => void start()}>
          {t("pullRequest.create.ai.write")}
        </Button>
      )}
    </div>
  ) : null;

  const notices: ReactNode = visible ? (
    <div className="flex flex-col gap-2" data-pr-ai-notices="">
      <p role="status" aria-live="polite" data-pr-ai-status="" className="text-sm text-text-muted">
        {loading ? (loading.slow ? `${loading.text} – ${loading.slow}` : loading.text) : ""}
      </p>
      {!running && !opensSetup && blocked ? (
        <p data-pr-ai-blocked="" className="text-sm text-text-muted">
          {blocked}
        </p>
      ) : null}
      {run.kind === "failed" ? (
        <AiErrorNotice
          name="pr-ai-error"
          view={run.view}
          provider={status.data?.provider ?? null}
          onAgain={() => void start()}
          onShowSent={() => void showSent()}
        />
      ) : null}
      {titleOffer !== null ? (
        <div data-pr-ai-title-offer="" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <p className="min-w-0 flex-1 text-sm text-text">
            {t("pullRequest.create.ai.titleOffer")} <span className="selectable font-medium">{titleOffer}</span>
          </p>
          <Button size="sm" onClick={replaceTitle}>
            {t("pullRequest.create.ai.replaceTitle")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTitleOffer(null)}>
            {t("pullRequest.create.ai.keepTitle")}
          </Button>
        </div>
      ) : null}
      {bodyOffer ? (
        <div
          data-pr-ai-body-offer={bodyOffer.ready ? "ready" : "choose"}
          className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
        >
          <p className="text-sm text-text">{bodyOffer.ready ? t("ai.suggestion.ready") : t("pullRequest.create.ai.bodyOffer")}</p>
          <pre
            aria-label={t("pullRequest.create.ai.suggested")}
            tabIndex={0}
            className="selectable max-h-40 overflow-auto rounded-sm bg-surface-sunken px-2 py-1 font-mono text-code whitespace-pre-wrap text-text"
          >
            {bodyOffer.suggestion}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => takeBody("replace")}>
              {t("ai.suggestion.replace")}
            </Button>
            <Button size="sm" onClick={() => takeBody("append")}>
              {t("ai.suggestion.append")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBodyOffer(null)}>
              {t("ai.suggestion.discard")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  ) : null;

  return { visible, control, notices, draft: inserted !== null && fields.text === inserted, onTitleKeyDown, onBodyKeyDown };
}
