/**
 * "Suggest parts" in the stacked pull requests view: the AI proposes cuts, names and
 * pull request titles. Shown only while AI is on for this function and this repository; with AI on
 * but no provider connected a click opens the AI setup (1b). An untouched plan takes the suggestion
 * directly (marked as suggested); cuts the user made are never replaced unasked ("Take suggestion" /
 * "Discard"). The view stays usable meanwhile, cancelling drops the answer, errors stay inline and a
 * late answer never moves the focus.
 */
import { useRef, useState, type ReactNode } from "react";
import { core, type Id } from "../../core";
import { AiErrorNotice } from "../../app/ai/AiErrorNotice";
import { askAi, showWhatIsSent } from "../../app/ai/gate";
import { checkProvider } from "../../app/ai/checkProvider";
import { useAiJob } from "../../app/ai/useAiJob";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { useAiStatus, useRepoSettings } from "../../app/queries";
import { Button } from "../../ui/Button";
import { locale, t } from "../../i18n";
import { fromSuggestion, placeSplit, type DraftPart } from "./model";

const FEATURE = "stack_split" as const;

export interface StackSuggestInput {
  repoId: Id;
  branch: string;
  /** Full ref of the base; null while unknown. */
  base: string | null;
  commitCount: number;
  /** The current parts; null while the plan loads. */
  parts: DraftPart[] | null;
  /** Puts suggested parts into the plan. */
  onInsert: (parts: DraftPart[]) => void;
}

export interface StackSuggest {
  visible: boolean;
  /** "What is sent?" and "Suggest parts" / "Cancel" – for the toolbar. */
  control: ReactNode;
  /** Status, errors, the offer and "one pull request is enough". */
  notices: ReactNode;
  /** The plan is a suggestion nobody changed yet. */
  suggested: boolean;
  clearSuggested: () => void;
}

export function useStackSuggest({ repoId, branch, base, commitCount, parts, onInsert }: StackSuggestInput): StackSuggest {
  const status = useAiStatus();
  const repoSettings = useRepoSettings(repoId);
  const job = useAiJob(status.data?.local ?? false);
  const { run, running, loading } = job;
  const [offer, setOffer] = useState<{ parts: DraftPart[]; ready: boolean } | null>(null);
  const [onePart, setOnePart] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const latest = useRef(parts);
  latest.current = parts;

  const visible = featureVisible(status.data, FEATURE, repoSettings.data?.aiOff ?? false);
  const opensSetup = aiVisibility(status.data).elementsOpenSetup;
  const input = base ? { kind: FEATURE, branch, base } : null;

  const start = async () => {
    if (!checkProvider(status.data)) return;
    if (!input || job.busy() || commitCount === 0) return;
    setOffer(null);
    setOnePart(false);
    let atStart = latest.current;
    const answer = await job.start(
      (jobId) => {
        atStart = latest.current;
        return core.aiStackSplit({ repoId, jobId, branch, base: input.base, locale: locale() });
      },
      () => askAi(repoId, FEATURE, input),
    );
    if (answer) {
      const next = fromSuggestion(answer);
      setOnePart(next.length === 1);
      const placement = placeSplit(latest.current, atStart, commitCount);
      if (placement === "insert") {
        onInsert(next);
        setSuggested(true);
      } else {
        setOffer({ parts: next, ready: placement === "ready" });
      }
    }
  };

  const cancel = job.cancel;

  const take = () => {
    if (!offer) return;
    onInsert(offer.parts);
    setSuggested(true);
    setOffer(null);
  };

  const showSent = () => {
    if (input) void showWhatIsSent(repoId, FEATURE, input, job.fail);
  };

  const control: ReactNode = visible ? (
    <div className="flex shrink-0 items-center gap-1" data-stack-ai="">
      {opensSetup ? null : (
        <Button size="sm" variant="ghost" data-stack-what-is-sent="" disabled={!input || running} onClick={showSent}>
          {t("ui.whatIsSent")}
        </Button>
      )}
      {running ? (
        <Button size="sm" data-stack-suggest-cancel="" onClick={cancel}>
          {t("ui.cancel")}
        </Button>
      ) : (
        <Button size="sm" data-stack-suggest="" disabled={!opensSetup && (!input || commitCount === 0)} onClick={() => void start()}>
          {t("pullRequest.stack.suggest")}
        </Button>
      )}
    </div>
  ) : null;

  const notices: ReactNode = visible ? (
    <div className="flex flex-col gap-2" data-stack-ai-notices="">
      <p role="status" aria-live="polite" data-stack-suggest-status="" className="text-sm text-text-muted">
        {loading ? (loading.slow ? `${loading.text} – ${loading.slow}` : loading.text) : ""}
      </p>
      {run.kind === "failed" ? (
        <AiErrorNotice
          name="stack-suggest-error"
          view={run.view}
          provider={status.data?.provider ?? null}
          onAgain={() => void start()}
          onShowSent={showSent}
        />
      ) : null}
      {onePart && !offer ? (
        <p data-stack-one-part="" className="text-sm text-text-muted">
          {t("pullRequest.stack.onePart")}
        </p>
      ) : null}
      {offer ? (
        <div
          data-stack-offer={offer.ready ? "ready" : "choose"}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-sm text-text">
            {offer.ready ? t("ai.suggestion.ready") : t("pullRequest.stack.offer", { count: offer.parts.length })}
          </p>
          <Button size="sm" onClick={take}>
            {t("pullRequest.stack.take")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
            {t("ui.discard")}
          </Button>
        </div>
      ) : null}
    </div>
  ) : null;

  return { visible, control, notices, suggested, clearSuggested: () => setSuggested(false) };
}
