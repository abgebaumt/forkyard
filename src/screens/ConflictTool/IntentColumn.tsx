/**
 * The column “Intent” of the conflict tool (v1.2, Teilpaket 6.1), to the right of the whole split.
 * Its content loads only on “Explain intent”: first the exact text (“What is sent?”, confirmed where
 * the core asks for it), then the request as a cancellable job. Per conflict a card with what each
 * side wanted and – where the block went out completely – the proposal as a small diff against the
 * block's current text, with “Apply” / “Discard”. “Apply” replaces only this block in the result (it
 * then counts as edited by hand); saving stays the user's Mod+S. An answer that arrives never moves
 * the focus; when another conflict becomes current (Alt+↑/↓, F7) its card scrolls into view.
 */
import { useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { core, type AiPreview, type AiProviderKind, type ConflictBlockRange, type ConflictIntentBlock, type Id } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { confirmSend } from "../../app/ai/gate";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { showAiPreview } from "../../app/ai/PreviewDialog";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { newJobId, runAction } from "../../app/run";
import { locale, t } from "../../i18n";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { blockNote, canApply, hasChange, intentReducer, suggestionDiff, type DiffRow, type IntentDecision, type IntentState } from "./intent";
import type { SideTitles } from "./titles";

export interface IntentColumnProps {
  repoId: Id;
  path: string;
  /** The conflict blocks of the tool's model (`conflictRanges`). */
  ranges: ConflictBlockRange[];
  /** Index of the current conflict, −1 = none. */
  current: number;
  /** Current text of a conflict block in the result. */
  blockText: (conflict: number) => string;
  titles: SideTitles;
  /** The provider runs on this computer (for the “slow” hint). */
  local: boolean;
  /** The chosen provider (for “Sign in in the terminal” when a command-line tool is not signed in). */
  provider: AiProviderKind | null;
  /** AI is on but no provider is connected: “Explain intent” opens the setup dialog (1b). */
  openSetup: boolean;
  /** Hidden by the toolbar switch; stays mounted so an answer survives. */
  hidden: boolean;
  onApply: (conflict: number, text: string) => void;
  onHide: () => void;
  style?: CSSProperties;
}

const SIGN: Record<DiffRow["kind"], string> = { same: " ", add: "+", del: "−" };
const IDLE: IntentState = { kind: "idle" };

export function IntentColumn({ repoId, path, ranges, current, blockText, titles, local, provider, openSetup, hidden, onApply, onHide, style }: IntentColumnProps) {
  const [state, dispatch] = useReducer(intentReducer, IDLE);
  const [now, setNow] = useState(() => Date.now());
  /** Increases with every start and cancel: a late step of an older run does nothing. */
  const run = useRef(0);
  const job = useRef<string | null>(null);
  const cards = useRef(new Map<number, HTMLElement>());
  const busy = state.kind === "preparing" || state.kind === "loading";

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // Leaving the tool cancels a running request.
  useEffect(
    () => () => {
      run.current++;
      if (job.current) void core.jobCancel({ jobId: job.current }).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (state.kind === "ready" && !hidden) cards.current.get(current)?.scrollIntoView({ block: "nearest" });
  }, [current, state.kind, hidden]);

  const input = { kind: "conflict_intent" as const, path, blocks: ranges };

  const explain = async () => {
    if (openSetup) {
      void openAiSetup();
      return;
    }
    const mine = ++run.current;
    const startedAt = Date.now();
    setNow(startedAt);
    dispatch({ type: "start", at: startedAt });
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: "conflict_intent", input, locale: locale() });
    } catch (error) {
      if (run.current === mine) dispatch({ type: "failed", jobId: null, view: errorView(error) });
      return;
    }
    if (run.current !== mine) return;
    const send = await confirmSend(repoId, "conflict_intent", preview);
    if (run.current !== mine) return;
    if (!send) {
      dispatch({ type: "cancel" });
      return;
    }
    const jobId = newJobId();
    job.current = jobId;
    dispatch({ type: "sending", jobId });
    try {
      const intent = await core.aiConflictIntent({ repoId, jobId, path, blocks: ranges, locale: locale() });
      dispatch({ type: "answer", jobId, intent });
    } catch (error) {
      dispatch({ type: "failed", jobId, view: errorView(error) });
    } finally {
      if (job.current === jobId) job.current = null;
    }
  };

  const cancel = () => {
    run.current++;
    if (job.current) void core.jobCancel({ jobId: job.current }).catch(() => undefined);
    job.current = null;
    dispatch({ type: "cancel" });
  };

  const whatIsSent = async () => {
    const result = await runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature: "conflict_intent", input, locale: locale() }));
    if (result.ok) await showAiPreview(result.value, "look");
  };

  const decide = (block: ConflictIntentBlock, decision: IntentDecision) => {
    if (decision === "taken" && block.text !== null) onApply(block.block, block.text);
    dispatch({ type: "decide", block: block.block, decision });
    cards.current.get(block.block)?.focus();
  };

  const errorActions = (view: AiErrorView): ReactNode => {
    switch (view.kind) {
      case "setup":
        return (
          <Button size="sm" onClick={() => void openAiSetup()}>
            {t("ai.state.setup")}
          </Button>
        );
      case "unavailable":
        return (
          <Button size="sm" onClick={() => void explain()}>
            {t("ai.state.retry")}
          </Button>
        );
      case "notLoggedIn":
        return provider ? (
          <Button size="sm" data-intent-sign-in="" onClick={() => signInInTerminal(provider)}>
            {t("ai.setup.cli.signIn")}
          </Button>
        ) : null;
      case "limit":
        return (
          <>
            <Button size="sm" onClick={() => void explain()}>
              {t("ai.state.limitSend")}
            </Button>
            <Button size="sm" variant="ghost" onClick={openAiSettings}>
              {t("ai.state.limitChange")}
            </Button>
          </>
        );
      case "tooLarge":
        return (
          <Button size="sm" variant="ghost" onClick={() => void whatIsSent()}>
            {t("conflict.intent.whatIsSent")}
          </Button>
        );
      case "invalid":
        return (
          <>
            <Button size="sm" onClick={() => void explain()}>
              {t("ai.state.again")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void whatIsSent()}>
              {t("ai.state.showSent")}
            </Button>
          </>
        );
      default:
        return (
          <Button size="sm" onClick={() => void explain()}>
            {t("ai.state.again")}
          </Button>
        );
    }
  };

  let content: ReactNode;
  let announcement = "";
  if (state.kind === "idle") {
    content = (
      <div className="flex flex-col items-start gap-2 px-3 py-3">
        <p className="m-0 text-sm text-text-muted">{t("conflict.intent.intro")}</p>
        <Button size="sm" variant="primary" data-intent-explain="" disabled={ranges.length === 0} onClick={() => void explain()}>
          {t("conflict.intent.explain")}
        </Button>
      </div>
    );
  } else if (state.kind === "preparing" || state.kind === "loading") {
    const view = loadingView(now - state.startedAt, local, t("conflict.intent.loading"));
    announcement = t("conflict.intent.loading");
    content = (
      <div className="flex flex-col items-start gap-2 px-3 py-3">
        <p className="m-0 text-sm text-text" data-intent-status="loading">
          {view.text}
          {view.slow ? <span className="block text-text-muted">{view.slow}</span> : null}
        </p>
        <Button size="sm" data-intent-cancel="" onClick={cancel}>
          {t("ai.state.cancel")}
        </Button>
      </div>
    );
  } else if (state.kind === "error") {
    content = (
      <div className="flex flex-col items-start gap-2 px-3 py-3">
        <p role="alert" className="m-0 text-sm text-text" data-intent-status="error" data-intent-error={state.view.kind}>
          {"text" in state.view ? state.view.text : null}
        </p>
        <div className="flex flex-wrap gap-1">{errorActions(state.view)}</div>
      </div>
    );
  } else {
    announcement = t("conflict.intent.ready", { count: state.intent.blocks.length });
    content = (
      <>
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <p className="m-0 min-w-0 flex-1 text-sm text-text-muted" data-intent-status="ready">
            {announcement}
          </p>
          <Button size="sm" variant="ghost" data-intent-again="" onClick={() => void explain()}>
            {t("conflict.intent.again")}
          </Button>
        </div>
        {state.intent.blocks.map((block) => (
          <IntentCard
            key={block.block}
            block={block}
            decision={state.decisions[block.block]}
            isCurrent={block.block === current}
            currentText={blockText(block.block)}
            titles={titles}
            register={(element) => {
              if (element) cards.current.set(block.block, element);
              else cards.current.delete(block.block);
            }}
            onDecide={(decision) => decide(block, decision)}
          />
        ))}
      </>
    );
  }

  return (
    <aside
      aria-label={t("conflict.intent.region")}
      data-intent-column=""
      data-intent-state={state.kind}
      style={style}
      className={cn(hidden ? "hidden" : "flex", "min-h-0 min-w-48 flex-col bg-surface")}
    >
      <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-medium text-text">{t("conflict.intent.title")}</h3>
        <Button size="sm" variant="ghost" data-intent-what-is-sent="" onClick={() => void whatIsSent()}>
          {t("conflict.intent.whatIsSent")}
        </Button>
        <Button size="sm" variant="ghost" data-intent-hide="" onClick={onHide}>
          {t("conflict.intent.hide")}
        </Button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto" data-intent-scroller="">
        {content}
      </div>
    </aside>
  );
}

interface IntentCardProps {
  block: ConflictIntentBlock;
  decision: IntentDecision | undefined;
  isCurrent: boolean;
  currentText: string;
  titles: SideTitles;
  register: (element: HTMLElement | null) => void;
  onDecide: (decision: IntentDecision) => void;
}

function IntentCard({ block, decision, isCurrent, currentText, titles, register, onDecide }: IntentCardProps) {
  const number = block.block + 1;
  const note = blockNote(block);
  const headingId = `intent-card-${block.block}`;
  const rows = canApply(block) ? suggestionDiff(currentText, block.text) : [];
  const changed = hasChange(rows);
  return (
    <article
      ref={register}
      tabIndex={-1}
      data-intent-card={block.block}
      data-intent-sent={block.sent}
      aria-current={isCurrent ? "true" : undefined}
      aria-labelledby={headingId}
      className={cn("border-b border-border px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent", isCurrent && "bg-surface-raised")}
    >
      <h4 id={headingId} className="m-0 text-sm font-medium text-text">
        {t("conflict.intent.card", { number })}
        {isCurrent ? <span className="font-normal text-text-muted"> · {t("conflict.intent.current")}</span> : null}
      </h4>
      {note === "leftOut" ? (
        <p className="m-0 mt-1 text-sm text-text-muted" data-intent-note="leftOut">
          {t("conflict.intent.leftOut")}
        </p>
      ) : (
        <>
          <dl className="m-0 mt-1 flex flex-col gap-1 text-sm">
            <div>
              <dt className="font-medium text-text">{titles.ours.heading}</dt>
              <dd className="m-0 text-text" data-intent-why="ours">
                {block.oursWhy}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-text">{titles.theirs.heading}</dt>
              <dd className="m-0 text-text" data-intent-why="theirs">
                {block.theirsWhy}
              </dd>
            </div>
          </dl>
          {note === "shortened" ? (
            <p className="m-0 mt-1 text-sm text-text-muted" data-intent-note="shortened">
              {t("conflict.intent.shortened")}
            </p>
          ) : null}
          {note === "redacted" ? (
            <p className="m-0 mt-1 text-sm text-text-muted" data-intent-note="redacted">
              {t("conflict.intent.redacted")}
            </p>
          ) : null}
          {decision === "taken" ? (
            <p className="m-0 mt-2 text-sm text-text" data-intent-decision="taken">
              {t("conflict.intent.applied")}
            </p>
          ) : decision === "discarded" ? (
            <p className="m-0 mt-2 text-sm text-text-muted" data-intent-decision="discarded">
              {t("conflict.intent.discarded")}
            </p>
          ) : canApply(block) ? (
            <div className="mt-2">
              <p className="m-0 text-xs text-text-muted">{t("conflict.intent.proposal")}</p>
              <pre
                aria-label={t("conflict.intent.diffLabel", { number })}
                data-intent-diff=""
                className="m-0 mt-1 max-h-64 overflow-auto rounded-sm border border-border bg-surface-sunken py-0.5 font-mono text-code"
              >
                {rows.map((row, index) => (
                  <span
                    key={index}
                    data-diff-row={row.kind}
                    className={cn(
                      "block px-1 whitespace-pre",
                      row.kind === "add" && "bg-success-surface text-text",
                      row.kind === "del" && "bg-danger-surface text-text-muted line-through",
                      row.kind === "same" && "text-text-muted",
                    )}
                  >
                    {`${SIGN[row.kind]} ${row.text}`}
                  </span>
                ))}
              </pre>
              {changed ? null : <p className="m-0 mt-1 text-sm text-text-muted">{t("conflict.intent.same")}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                {changed ? (
                  <Button size="sm" variant="primary" data-intent-apply="" onClick={() => onDecide("taken")}>
                    {t("conflict.intent.apply")}
                  </Button>
                ) : null}
                <Button size="sm" data-intent-discard="" onClick={() => onDecide("discarded")}>
                  {t("conflict.intent.discard")}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}
