/**
 * Right panel “Why is this so?” / “History of this line” (v1.2, 7.1): the commits that shaped one
 * line, newest first – each with its message, the change of the line and the pull requests, issues
 * and tickets it names. The main button of a step opens that commit's diff of the file in the
 * centre (the panel stays); “In graph” shows the commit in the graph.
 *
 * With the AI function visible for this repository, “Explain” lets the provider summarise the
 * timeline (after “What is sent?” where Paket 1a asks). The answer is text only: it never changes
 * anything, never takes the focus, and a cancelled request is discarded.
 */
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AiInput, Id } from "../../core";
import { core } from "../../core";
import { signInInTerminal } from "../../app/ai/cliLogin";
import { confirmSend, showWhatIsSent } from "../../app/ai/gate";
import { openAiSetup } from "../../app/ai/open";
import { errorView } from "../../app/ai/requestState";
import { aiVisibility, featureVisible } from "../../app/ai/visibility";
import { describeError, toCoreError } from "../../app/errors";
import { formatDateTime, formatRelative } from "../../app/format";
import { useAiStatus, useLineArchaeology, useRepoSettings } from "../../app/queries";
import { newJobId } from "../../app/run";
import { useAppStore, type ArchaeologyTarget } from "../../app/store";
import { TicketLink } from "../../components/LinkedText";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Tip } from "../../ui/Tooltip";
import { showInGraph } from "../FileView/nav";
import { locale, t } from "../../i18n";
import { confidenceLabel, errorActions, explainView, timelineRows, whyLabel, type ExplainState, type TimelineRow } from "./model";

export interface ArchaeologyPanelProps {
  repoId: Id;
  tabId: Id;
  target: ArchaeologyTarget;
}

export function ArchaeologyPanel({ repoId, tabId, target }: ArchaeologyPanelProps) {
  const store = useAppStore.getState;
  const query = useLineArchaeology(repoId, target);
  const { data: aiStatus } = useAiStatus();
  const { data: repoSettings } = useRepoSettings(repoId);
  const aiVisible = featureVisible(aiStatus, "archaeology", repoSettings?.aiOff ?? false);
  const opensSetup = aiVisibility(aiStatus).elementsOpenSetup;

  const [state, setState] = useState<ExplainState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const running = useRef<string | null>(null);
  const answer = state.kind === "done" ? state.answer : null;
  const rows = useMemo(() => (query.data ? timelineRows(query.data, answer) : []), [query.data, answer]);
  const view = explainView(state, now, aiStatus?.local ?? false);
  const provider = aiStatus?.provider ?? null;
  const actions = state.kind === "error" ? errorActions(state.error, provider) : [];
  // Without an open repository tab there is no terminal for the sign-in: say so instead.
  const [noTerminal, setNoTerminal] = useState(false);
  const input: AiInput = { kind: "archaeology", path: target.path, line: target.line, sha: target.sha };

  useEffect(() => {
    if (state.kind !== "loading") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  // The panel is keyed by its line: closing it or picking another line ends a running request.
  useEffect(
    () => () => {
      const jobId = running.current;
      running.current = null;
      if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    },
    [],
  );

  const explain = async () => {
    if (opensSetup) {
      void openAiSetup();
      return;
    }
    const jobId = newJobId();
    const startedAt = Date.now();
    running.current = jobId;
    setNoTerminal(false);
    setNow(startedAt);
    setState({ kind: "loading", jobId, startedAt });
    const settle = (next: ExplainState) => {
      if (running.current !== jobId) return;
      running.current = null;
      setState(next);
    };
    try {
      const preview = await core.aiPreview({ repoId, feature: "archaeology", input, locale: locale() });
      if (running.current !== jobId) return;
      if (!(await confirmSend(repoId, "archaeology", preview))) {
        settle({ kind: "idle" });
        return;
      }
      if (running.current !== jobId) return;
      const result = await core.aiArchaeology({ repoId, jobId, path: target.path, line: target.line, sha: target.sha, locale: locale() });
      settle({ kind: "done", answer: result });
    } catch (error) {
      const shown = errorView(error);
      settle(shown.kind === "cancelled" ? { kind: "idle" } : { kind: "error", error: shown });
    }
  };

  const cancel = () => {
    const jobId = running.current;
    running.current = null;
    setState({ kind: "idle" });
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
  };

  const data = query.data;
  let body: ReactNode;
  if (query.isPending) {
    body = (
      <p className="px-3 py-3 text-sm text-text-muted" data-loading="">
        {t("blame.archaeology.loading")}
      </p>
    );
  } else if (query.isError || !data) {
    body = (
      <div className="flex flex-col items-start gap-2 px-3 py-3" data-archaeology-error="">
        <p className="text-sm font-medium text-text">{t("blame.archaeology.failed")}</p>
        <p className="text-sm text-text-muted">{describeError(toCoreError(query.error)).text}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("blame.archaeology.retry")}
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        <p className="px-3 pt-3 text-xs text-text-muted" data-archaeology-count={rows.length}>
          {t("blame.archaeology.steps", { count: rows.length })}
          {data.mayHaveMore ? ` · ${t("blame.archaeology.mayHaveMore")}` : ""}
        </p>
        {data.hostLookup === "not_connected" ? <p className="px-3 pt-1 text-xs text-text-muted">{t("blame.archaeology.hostNotConnected")}</p> : null}
        {data.hostLookup === "failed" ? <p className="px-3 pt-1 text-xs text-text-muted">{t("blame.archaeology.hostFailed")}</p> : null}
        <ol aria-label={t("blame.archaeology.timelineLabel")} data-archaeology-timeline="" className="flex flex-col gap-3 px-3 py-3">
          {rows.map((row) => (
            <Step key={row.sha} row={row} onOpen={() => store().openDiff(tabId, row.path, { kind: "commit", sha: row.sha })} onReveal={() => showInGraph(tabId, row.sha)} />
          ))}
        </ol>
      </>
    );
  }

  return (
    <section aria-label={t("blame.archaeology.ariaLabel", { line: target.line.toLocaleString(locale()), path: target.path })} data-screen="archaeology" className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text" data-archaeology-title="">
          {whyLabel(aiVisible)}
        </h2>
        <IconButton size="sm" label={t("blame.archaeology.close")} icon={<X className="size-icon" aria-hidden />} onClick={() => store().setRightPanel(tabId, "details")} />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <p className="px-3 pt-2 text-xs text-text-muted">{t("blame.archaeology.where", { line: target.line.toLocaleString(locale()), path: target.path })}</p>
        {data ? (
          <pre className="mx-3 mt-1 overflow-x-auto rounded-md bg-surface-sunken px-2 py-1 font-mono text-code text-text" data-archaeology-line="">
            {data.code[data.line - data.codeStart] ?? ""}
          </pre>
        ) : null}
        {aiVisible ? (
          <div className="mx-3 mt-3 flex flex-col gap-2 rounded-md border border-border p-2" data-archaeology-ai="">
            <div className="flex flex-wrap items-center gap-2">
              <Tip label={t("blame.archaeology.explainHint")}>
                <Button size="sm" variant={view.button === "cancel" ? "ghost" : "primary"} data-archaeology-explain={view.button} onClick={() => (view.button === "cancel" ? cancel() : void explain())}>
                  {view.label}
                </Button>
              </Tip>
              <Button size="sm" variant="ghost" data-archaeology-what-is-sent="" onClick={() => void showWhatIsSent(repoId, "archaeology", input)}>
                {t("blame.archaeology.whatIsSent")}
              </Button>
            </div>
            <p role={view.urgent ? "alert" : "status"} data-archaeology-status="" className={cn("min-h-4 text-xs", view.urgent ? "text-danger" : "text-text-muted")}>
              {view.status}
              {view.slow ? ` · ${view.slow}` : ""}
            </p>
            {actions.length ? (
              <div className="flex flex-wrap items-center gap-2" data-archaeology-error-actions="">
                {actions.map((action) => {
                  switch (action) {
                    case "signIn":
                      return (
                        <Button key={action} size="sm" data-archaeology-sign-in="" onClick={() => setNoTerminal(!(provider && signInInTerminal(provider)))}>
                          {t("ai.setup.cli.signIn")}
                        </Button>
                      );
                    case "sendOnce":
                      return (
                        <Button key={action} size="sm" data-archaeology-send-once="" onClick={() => void explain()}>
                          {t("ai.state.limitSend")}
                        </Button>
                      );
                    case "setup":
                      return (
                        <Button key={action} size="sm" variant="ghost" onClick={() => void openAiSetup()}>
                          {t("blame.archaeology.setup")}
                        </Button>
                      );
                    case "showSent":
                      return (
                        <Button key={action} size="sm" variant="ghost" onClick={() => void showWhatIsSent(repoId, "archaeology", input)}>
                          {t("blame.archaeology.showSent")}
                        </Button>
                      );
                  }
                })}
              </div>
            ) : null}
            {noTerminal ? <p className="text-xs text-text-muted">{t("ai.settings.signInNoRepo")}</p> : null}
            {answer ? (
              <div className="flex flex-col gap-1" aria-label={t("blame.archaeology.summaryLabel")} role="group">
                <p className="text-sm whitespace-pre-wrap text-text" data-archaeology-summary="">
                  {answer.summary}
                </p>
                <p className="text-xs text-text-muted" data-archaeology-confidence={answer.confidence}>
                  {confidenceLabel(answer.confidence)} · {t("blame.archaeology.fromAi")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
        {body}
      </div>
    </section>
  );
}

const SIGN = { add: "+", remove: "−", context: " ", note: "" } as const;

function Step({ row, onOpen, onReveal }: { row: TimelineRow; onOpen: () => void; onReveal: () => void }) {
  return (
    <li data-step-sha={row.sha} className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          data-step-open=""
          title={t("blame.archaeology.openStep", { sha: row.short })}
          onClick={onOpen}
          className="min-w-0 flex-1 rounded-sm text-left text-sm font-medium text-text hover:underline"
        >
          {row.summary}
        </button>
        <Button size="sm" variant="ghost" aria-label={t("blame.archaeology.inGraphLabel", { sha: row.short })} onClick={onReveal}>
          {t("blame.archaeology.inGraph")}
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        <span className="font-mono text-code">{row.short}</span> · {row.author} ·{" "}
        <time dateTime={row.authoredAt} title={formatDateTime(row.authoredAt)}>
          {formatRelative(row.authoredAt)}
        </time>{" "}
        · {row.lines}
      </p>
      {row.renamedFrom ? (
        <p className="text-xs text-text-muted" data-step-renamed="">
          {t("blame.archaeology.renamedFrom", { path: row.renamedFrom })}
        </p>
      ) : null}
      {row.diff.length ? (
        <pre className="overflow-x-auto rounded-md bg-surface-sunken px-2 py-1 font-mono text-code text-text">
          {row.diff.map((line, index) => (
            <span key={index} data-kind={line.kind} className={cn("block whitespace-pre", line.kind === "add" && "bg-diff-added", line.kind === "remove" && "bg-diff-removed", line.kind === "note" && "text-text-muted")}>
              <span aria-hidden>{SIGN[line.kind]}</span>
              {line.kind === "add" ? <span className="sr-only">{t("diff.line.added")}</span> : line.kind === "remove" ? <span className="sr-only">{t("diff.line.removed")}</span> : null}
              {line.text}
            </span>
          ))}
        </pre>
      ) : null}
      {row.refs.length ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-text-muted" data-step-refs="">
          <span>{t("blame.archaeology.linked")}:</span>
          {row.refs.map((reference) => (
            <span key={reference.url} className="inline-flex items-baseline gap-1">
              <TicketLink text={reference.text} url={reference.url} ruleId={reference.kind} focusable />
              {reference.title ? <span className="text-text">{reference.title}</span> : null}
            </span>
          ))}
        </p>
      ) : null}
      {row.note ? (
        <p className="text-sm text-text" data-step-note="">
          {row.note}
        </p>
      ) : null}
      {row.introduced ? (
        <p className="text-xs text-text-muted" data-step-introduced="">
          {t("blame.archaeology.introduced")}
        </p>
      ) : null}
    </li>
  );
}
