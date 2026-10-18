/**
 * Bisect autopilot (9.1): description and optional test command → the AI writes a test script (only
 * a suggestion: shown and editable, nothing runs) → "Run" hands script and time limit back. A late
 * answer never moves the focus; typing into the script while the AI writes turns the answer into
 * "Suggestion ready". Closing the dialog cancels a running request. The dialog host shows one dialog
 * at a time, so "What is sent?" (look and confirm) opens nested in this dialog.
 */
import { useEffect, useRef, useState } from "react";
import { core, type Id, type Sha } from "../../core";
import { confirmSend } from "../../app/ai/gate";
import { openAiSettings, openAiSetup } from "../../app/ai/open";
import { AiPreviewDialog } from "../../app/ai/PreviewDialog";
import { errorView, loadingView, type AiErrorView } from "../../app/ai/requestState";
import { placeSuggestion } from "../../app/ai/suggestion";
import { showDialog } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { useAiStatus } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea, TextField } from "../../ui/Field";
import { NumberField } from "../../ui/NumberField";
import { locale, platform, t } from "../../i18n";
import { signInFor } from "../ReleaseNotes/Dialog";
import { DEFAULT_STEP_MINUTES, MAX_DESCRIPTION, MAX_STEP_MINUTES, MAX_TEST_COMMAND, scriptProblem, shellFor, stepTimeoutSecs } from "./autopilotModel";
import { nestedPreview, type NestedPreviewState } from "./nestedPreview";

export interface AutopilotRange {
  bad: Sha;
  good: Sha[];
}

export interface AutopilotPlan {
  script: string;
  stepTimeoutSecs: number;
}

type Writing = { kind: "idle" } | { kind: "loading"; jobId: string; startedAt: number } | { kind: "error"; view: AiErrorView };

interface Pending {
  script: string;
  summary: string;
  /** The user typed into the script while the AI wrote. */
  typed: boolean;
}

const SHELL_LABEL = { sh: t("bisect.autopilot.shell.sh"), powershell: t("bisect.autopilot.shell.powershell") };
const SHELL = shellFor(platform);

/** `onSignIn` only for a terminal tool (closes the dialog first: the terminal sits behind it). */
export function AutopilotErrorLine({
  view,
  onRetry,
  onShowSent,
  onSetup,
  onSettings,
  onSignIn,
}: {
  view: AiErrorView;
  onRetry: () => void;
  onShowSent: () => void;
  onSetup: () => void;
  onSettings: () => void;
  onSignIn?: () => void;
}) {
  if (view.kind === "cancelled") return null;
  return (
    <div role="alert" aria-live="assertive" data-autopilot-error={view.kind} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 text-danger">{view.kind === "invalid" ? `${t("ai.state.invalid")} – ${view.text}` : view.text}</span>
      {view.kind === "notLoggedIn" && onSignIn ? (
        <Button size="sm" data-autopilot-sign-in onClick={onSignIn}>
          {t("ai.setup.cli.signIn")}
        </Button>
      ) : null}
      {view.kind === "setup" ? (
        <Button size="sm" onClick={onSetup}>
          {t("ai.state.setup")}
        </Button>
      ) : (
        <Button size="sm" onClick={onRetry}>
          {view.kind === "invalid" ? t("ai.state.again") : t("ai.state.retry")}
        </Button>
      )}
      {view.kind === "invalid" ? (
        <Button size="sm" variant="ghost" onClick={onShowSent}>
          {t("ai.state.showSent")}
        </Button>
      ) : null}
      {view.kind === "limit" ? (
        // "Try again" repeats preview + confirmSend, where 1a asks "Send this time"; here the limit itself.
        <Button size="sm" variant="ghost" onClick={onSettings}>
          {t("ai.state.limitChange")}
        </Button>
      ) : null}
    </div>
  );
}

function AutopilotDialog({ repoId, range, onDone }: { repoId: Id; range: AutopilotRange; onDone: (plan: AutopilotPlan | null) => void }) {
  const { data: ai } = useAiStatus();
  const [description, setDescription] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [script, setScript] = useState("");
  const [draft, setDraft] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [writing, setWriting] = useState<Writing>({ kind: "idle" });
  const [minutes, setMinutes] = useState(DEFAULT_STEP_MINUTES);
  const [now, setNow] = useState(() => Date.now());
  const [nested, setNested] = useState<NestedPreviewState | null>(null);
  const asker = useRef(nestedPreview(setNested)).current;
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const jobRef = useRef<string | null>(null);

  useEffect(() => {
    if (writing.kind !== "loading") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [writing.kind]);
  // Closing the dialog while the AI writes cancels the request; its answer is discarded.
  useEffect(
    () => () => {
      asker.close(null);
      if (jobRef.current) void core.jobCancel({ jobId: jobRef.current });
    },
    [asker],
  );

  const request = () => ({ description: description.trim(), testCommand: testCommand.trim() || null, bad: range.bad, good: range.good });
  const preview = () =>
    runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature: "bisect_script", input: { kind: "bisect_script", ...request() }, locale: locale() }));

  const showSent = async () => {
    const result = await preview();
    if (result.ok) await asker.ask(result.value, "look");
  };

  const write = async () => {
    const asked = request();
    const shown = await preview();
    if (!shown.ok || !(await confirmSend(repoId, "bisect_script", shown.value, asker.ask))) return;
    const jobId = newJobId();
    const atStart = scriptRef.current;
    jobRef.current = jobId;
    setPending(null);
    setNow(Date.now());
    setWriting({ kind: "loading", jobId, startedAt: Date.now() });
    try {
      const answer = await core.bisectAutopilotScript({ repoId, jobId, request: asked, locale: locale() });
      if (jobRef.current !== jobId) return;
      jobRef.current = null;
      setWriting({ kind: "idle" });
      setSummary(answer.summary || null);
      const placement = placeSuggestion(scriptRef.current, atStart, answer.script);
      if (placement.kind === "insert") {
        setScript(placement.text);
        setDraft(true);
      } else {
        setPending({ script: answer.script, summary: answer.summary, typed: placement.kind === "ready" });
      }
    } catch (raw) {
      if (jobRef.current !== jobId) return;
      jobRef.current = null;
      const view = errorView(raw);
      setWriting(view.kind === "cancelled" ? { kind: "idle" } : { kind: "error", view });
    }
  };

  const cancelWriting = () => {
    const jobId = jobRef.current;
    jobRef.current = null;
    setWriting({ kind: "idle" });
    if (jobId) void core.jobCancel({ jobId });
  };

  const loading = writing.kind === "loading" ? loadingView(now - writing.startedAt, ai?.local ?? false) : null;
  const problem = scriptProblem(script);
  const canRun = problem === null && writing.kind !== "loading";
  const noDescription = description.trim() === "";

  return (
    <Dialog
      open
      size="lg"
      title={t("bisect.autopilot.title")}
      description={t("bisect.autopilot.range", { bad: shortSha(range.bad), good: range.good.map(shortSha).join(", ") })}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("bisect.autopilot.cancel")}</Button>
          <Button variant="primary" data-autopilot-run disabled={!canRun} onClick={() => onDone({ script, stepTimeoutSecs: stepTimeoutSecs(minutes) })}>
            {t("bisect.autopilot.run")}
          </Button>
        </>
      }
    >
      <div data-bisect-autopilot-dialog className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">{t("bisect.autopilot.intro")}</p>
        <TextArea
          data-autofocus
          data-autopilot-description
          label={t("bisect.autopilot.description")}
          placeholder={t("bisect.autopilot.descriptionPlaceholder")}
          value={description}
          rows={3}
          maxLength={MAX_DESCRIPTION}
          spellCheck
          onChange={(event) => setDescription(event.target.value)}
        />
        <TextField
          data-autopilot-test-command
          mono
          label={t("bisect.autopilot.testCommand")}
          hint={t("bisect.autopilot.testCommandHint")}
          value={testCommand}
          maxLength={MAX_TEST_COMMAND}
          autoComplete="off"
          onChange={(event) => setTestCommand(event.target.value.replace(/[\r\n]+/g, " "))}
        />
        <div className="flex items-center gap-2">
          {writing.kind === "loading" ? (
            <Button size="sm" data-autopilot-write onClick={cancelWriting}>
              {t("ai.state.cancel")}
            </Button>
          ) : (
            <Button size="sm" data-autopilot-write disabled={noDescription} onClick={() => void write()}>
              {script.trim() || summary ? t("bisect.autopilot.writeAgain") : t("bisect.autopilot.write")}
            </Button>
          )}
          <Button size="sm" variant="ghost" data-autopilot-what-is-sent disabled={noDescription} onClick={() => void showSent()}>
            {t("bisect.autopilot.whatIsSent")}
          </Button>
          <p aria-live="polite" data-autopilot-writing className="min-w-0 flex-1 truncate text-sm text-text-muted">
            {loading ? `${loading.text}${loading.slow ? ` · ${loading.slow}` : ""}` : ""}
          </p>
        </div>
        {writing.kind === "error" ? (
          <AutopilotErrorLine
            view={writing.view}
            onRetry={() => void write()}
            onShowSent={() => void showSent()}
            onSetup={() => {
              onDone(null);
              void openAiSetup();
            }}
            onSettings={() => {
              onDone(null);
              openAiSettings();
            }}
            onSignIn={signInFor(ai?.provider ?? null, () => onDone(null))}
          />
        ) : null}
        {pending ? (
          <div data-autopilot-pending className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2 py-1 text-sm">
            <span className="min-w-0 flex-1">{pending.typed ? t("ai.suggestion.ready") : pending.summary}</span>
            <Button
              size="sm"
              onClick={() => {
                setScript(pending.script);
                setDraft(true);
                setPending(null);
              }}
            >
              {t("ai.suggestion.replace")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {t("ai.suggestion.discard")}
            </Button>
          </div>
        ) : null}
        <TextArea
          data-autopilot-script
          label={`${t("bisect.autopilot.script", { shell: SHELL_LABEL[SHELL] })}${draft ? ` · ${t("ai.suggestion.draft")}` : ""}`}
          hint={t("bisect.autopilot.scriptHint")}
          value={script}
          rows={12}
          spellCheck={false}
          className="font-mono text-code"
          onChange={(event) => {
            setScript(event.target.value);
            setDraft(false);
          }}
        />
        {summary ? (
          <p data-autopilot-summary className="text-sm text-text-muted">
            {summary}
          </p>
        ) : null}
        {problem === "tooLong" ? (
          <p role="alert" className="text-sm text-danger">
            {t("bisect.autopilot.scriptTooLong")}
          </p>
        ) : null}
        <NumberField
          label={t("bisect.autopilot.stepTimeout")}
          hint={t("bisect.autopilot.stepTimeoutHint")}
          value={minutes}
          min={1}
          max={MAX_STEP_MINUTES}
          unit={t("bisect.autopilot.minutes")}
          onCommit={setMinutes}
        />
      </div>
      {nested ? <AiPreviewDialog preview={nested.preview} mode={nested.mode} onDone={asker.close} /> : null}
    </Dialog>
  );
}

export function showAutopilotDialog(repoId: Id, range: AutopilotRange): Promise<AutopilotPlan | null> {
  return showDialog<AutopilotPlan>((done) => <AutopilotDialog repoId={repoId} range={range} onDone={done} />);
}
