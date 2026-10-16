/**
 * "Suggest parts" in the stacked pull requests view (Paket 8.1): the AI proposes cuts, names and
 * pull request titles. Shown only while AI is on for this function and this repository; with AI on
 * but no provider connected a click opens the AI setup (1b). An untouched plan takes the suggestion
 * directly (marked as suggested); cuts the user made are never replaced unasked ("Take suggestion" /
 * "Discard"). The view stays usable meanwhile, cancelling drops the answer, errors stay inline and a
 * late answer never moves the focus.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { core, type AiPreview, type Id } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { confirmSend, showWhatIsSent } from "../../app/ai/gate";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { useAiStatus, useRepoSettings } from "../../app/queries";
import { newJobId } from "../../app/run";
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

type FailedView = Exclude<AiErrorView, { kind: "cancelled" }>;
type Run = { kind: "idle" } | { kind: "running"; startedAt: number } | { kind: "failed"; view: FailedView };

export function useStackSuggest({ repoId, branch, base, commitCount, parts, onInsert }: StackSuggestInput): StackSuggest {
  const status = useAiStatus();
  const repoSettings = useRepoSettings(repoId);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [clock, setClock] = useState(() => Date.now());
  const [offer, setOffer] = useState<{ parts: DraftPart[]; ready: boolean } | null>(null);
  const [onePart, setOnePart] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const latest = useRef(parts);
  latest.current = parts;
  /** Job of the running request; null = none (a late answer of a cancelled one is dropped). */
  const active = useRef<string | null>(null);

  const visible = featureVisible(status.data, FEATURE, repoSettings.data?.aiOff ?? false);
  const opensSetup = aiVisibility(status.data).elementsOpenSetup;
  const input = base ? { kind: FEATURE, branch, base } : null;
  const running = run.kind === "running";

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Leaving the view cancels a running request; its answer is dropped.
  useEffect(
    () => () => {
      const jobId = active.current;
      active.current = null;
      if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    },
    [],
  );

  const fail = (error: unknown) => {
    const view = errorView(error);
    setRun(view.kind === "cancelled" ? { kind: "idle" } : { kind: "failed", view });
  };

  const start = async () => {
    if (opensSetup) {
      void openAiSetup();
      return;
    }
    if (!input || active.current || commitCount === 0) return;
    setRun({ kind: "idle" });
    setOffer(null);
    setOnePart(false);
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: FEATURE, input, locale: locale() });
    } catch (error) {
      fail(error);
      return;
    }
    if (!(await confirmSend(repoId, FEATURE, preview))) return;
    const jobId = newJobId();
    const atStart = latest.current;
    active.current = jobId;
    setClock(Date.now());
    setRun({ kind: "running", startedAt: Date.now() });
    try {
      const answer = await core.aiStackSplit({ repoId, jobId, branch, base: input.base, locale: locale() });
      if (active.current !== jobId) return;
      active.current = null;
      setRun({ kind: "idle" });
      const next = fromSuggestion(answer);
      setOnePart(next.length === 1);
      const placement = placeSplit(latest.current, atStart, commitCount);
      if (placement === "insert") {
        onInsert(next);
        setSuggested(true);
      } else {
        setOffer({ parts: next, ready: placement === "ready" });
      }
    } catch (error) {
      if (active.current !== jobId) return;
      active.current = null;
      fail(error);
    }
  };

  const cancel = () => {
    const jobId = active.current;
    active.current = null;
    setRun({ kind: "idle" });
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
  };

  const take = () => {
    if (!offer) return;
    onInsert(offer.parts);
    setSuggested(true);
    setOffer(null);
  };

  const showSent = () => {
    if (input) void showWhatIsSent(repoId, FEATURE, input).catch(fail);
  };

  const errorActions = (view: FailedView): ReactNode => {
    switch (view.kind) {
      case "setup":
        return (
          <Button size="sm" onClick={() => void openAiSetup()}>
            {t("ai.state.setup")}
          </Button>
        );
      case "notLoggedIn": {
        const provider = status.data?.provider ?? null;
        return provider ? (
          <Button size="sm" onClick={() => signInInTerminal(provider)}>
            {t("ai.setup.cli.signIn")}
          </Button>
        ) : (
          <Button size="sm" onClick={() => void openAiSetup()}>
            {t("ai.state.setup")}
          </Button>
        );
      }
      case "limit":
        return (
          <>
            <Button size="sm" onClick={() => void start()}>
              {t("ai.state.limitSend")}
            </Button>
            <Button size="sm" variant="ghost" onClick={openAiSettings}>
              {t("ai.state.limitChange")}
            </Button>
          </>
        );
      case "invalid":
      case "tooLarge":
        return (
          <>
            <Button size="sm" onClick={() => void start()}>
              {t("ai.state.again")}
            </Button>
            <Button size="sm" variant="ghost" onClick={showSent}>
              {t("ai.state.showSent")}
            </Button>
          </>
        );
      case "unavailable":
        return (
          <Button size="sm" onClick={() => void start()}>
            {t("ai.state.retry")}
          </Button>
        );
      default:
        return (
          <Button size="sm" onClick={() => void start()}>
            {t("ai.state.again")}
          </Button>
        );
    }
  };

  const loading = run.kind === "running" ? loadingView(clock - run.startedAt, status.data?.local ?? false) : null;

  const control: ReactNode = visible ? (
    <div className="flex shrink-0 items-center gap-1" data-stack-ai="">
      {opensSetup ? null : (
        <Button size="sm" variant="ghost" data-stack-what-is-sent="" disabled={!input || running} onClick={showSent}>
          {t("pullRequest.stack.whatIsSent")}
        </Button>
      )}
      {running ? (
        <Button size="sm" data-stack-suggest-cancel="" onClick={cancel}>
          {t("ai.state.cancel")}
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
        <div role="alert" data-stack-suggest-error={run.view.kind} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <p className="min-w-0 flex-1 text-sm break-words text-text">{run.view.text}</p>
          {errorActions(run.view)}
        </div>
      ) : null}
      {onePart && !offer ? (
        <p data-stack-one-part="" className="text-sm text-text-muted">
          {t("pullRequest.stack.onePart")}
        </p>
      ) : null}
      {offer ? (
        <div data-stack-offer={offer.ready ? "ready" : "choose"} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
          <p className="min-w-0 flex-1 text-sm text-text">{offer.ready ? t("ai.suggestion.ready") : t("pullRequest.stack.offer", { count: offer.parts.length })}</p>
          <Button size="sm" onClick={take}>
            {t("pullRequest.stack.take")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
            {t("pullRequest.stack.discard")}
          </Button>
        </div>
      ) : null}
    </div>
  ) : null;

  return { visible, control, notices, suggested, clearSuggested: () => setSuggested(false) };
}
