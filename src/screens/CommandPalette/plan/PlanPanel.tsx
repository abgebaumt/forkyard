/**
 * Body and footer of the command palette in plan mode ("Git in plain language", spec Paket 5): the
 * steps with class (word + dot), conflict check and – for steps that go out – their own
 * confirmation; the editor of one step; loading, failure and the result of a run. Status is never
 * shown by colour alone. Keyboard handling lives in `usePlanSession`.
 */
import { useEffect, useRef } from "react";
import type { PlanArgField, PlanStepOutcome, PlanStepView } from "../../../core";
import { errorView, loadingView } from "../../../app/ai/requestState";
import { Button, Spinner } from "../../../ui/Button";
import { Checkbox, SegmentedControl, TextField } from "../../../ui/Field";
import { Kbd } from "../../../ui/Kbd";
import { cn } from "../../../ui/cn";
import { t } from "../../../i18n";
import { ARG_LABELS, MODE_WORDS, checkView, classView, footerKeys, liveText, outcomeView, planErrorText, resultText, stepTitle, type PlanPhase, type Tone } from "./model";
import type { PlanSession } from "./usePlanSession";

const TONE_TEXT: Record<Tone, string> = {
  muted: "text-text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

const TONE_DOT: Record<Tone, string> = {
  muted: "bg-text-muted",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

type WithPlan = Extract<PlanPhase, { preview: unknown }>;

function Status({ word, tone }: { word: string; tone: Tone }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", TONE_TEXT[tone])}>
      <span className={cn("inline-flex size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} aria-hidden />
      {word}
    </span>
  );
}

export function PlanPanel({ session, idPrefix }: { session: PlanSession; idPrefix: string }) {
  const { phase } = session;
  if (phase.kind === "idle") return null;
  if (phase.kind === "loading") return <PlanLoading session={session} />;
  if (phase.kind === "failed") return <PlanFailure session={session} phase={phase} />;
  return <PlanSteps session={session} phase={phase} idPrefix={idPrefix} />;
}

function PlanLoading({ session }: { session: PlanSession }) {
  const view = loadingView(session.elapsedMs, session.local, t("palette.plan.loading"));
  return (
    <div className="flex flex-col gap-1 px-3 py-4 text-sm" data-plan-state="loading">
      <span className="flex items-center gap-2 text-text" aria-live="polite">
        <Spinner label={view.text} />
        {view.text}
      </span>
      {view.slow ? <span className="text-text-muted">{view.slow}</span> : null}
    </div>
  );
}

/** The states of „Zustände jedes KI-Elements“, inline and never as a toast. */
function PlanFailure({ session, phase }: { session: PlanSession; phase: Extract<PlanPhase, { kind: "failed" }> }) {
  const view = errorView(phase.error);
  const signIn = view.kind === "notLoggedIn" && session.provider !== null;
  return (
    <div role="alert" className="m-1 flex flex-col gap-2 rounded-md bg-danger-surface px-3 py-2 text-sm text-text" data-plan-state="failed">
      <span data-plan-error>{planErrorText(phase.error)}</span>
      <span className="flex flex-wrap gap-2">
        {view.kind === "setup" ? (
          <Button size="sm" onClick={session.openSetup}>
            {t("ai.state.setup")}
          </Button>
        ) : null}
        {signIn ? (
          <Button size="sm" onClick={session.signIn}>
            {t("ai.setup.cli.signIn")}
          </Button>
        ) : null}
        {view.kind === "limit" ? (
          <>
            {/* A new request: `confirmSend` shows the `limit` trigger, the click there confirms this text. */}
            <Button size="sm" onClick={session.retry}>
              {t("ai.state.limitSend")}
            </Button>
            <Button size="sm" variant="ghost" onClick={session.changeLimit}>
              {t("ai.state.limitChange")}
            </Button>
          </>
        ) : null}
        {view.kind === "unavailable" ? (
          <Button size="sm" onClick={session.retry}>
            {t("ai.state.retry")}
          </Button>
        ) : null}
        {view.kind === "invalid" ? (
          <>
            <Button size="sm" onClick={session.retry}>
              {t("ai.state.again")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void session.whatIsSent(phase.text)}>
              {t("ai.state.showSent")}
            </Button>
          </>
        ) : null}
        {view.kind === "tooLarge" || view.kind === "refused" || view.kind === "other" || (view.kind === "notLoggedIn" && !signIn) ? (
          <Button size="sm" onClick={session.retry}>
            {t("ai.state.again")}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function PlanSteps({ session, phase, idPrefix }: { session: PlanSession; phase: WithPlan; idPrefix: string }) {
  const { preview } = phase;
  const selected = phase.kind === "preview" || phase.kind === "editing" ? phase.selected : -1;
  const outcomes = phase.kind === "result" ? phase.result.steps : null;
  return (
    <div className="flex flex-col gap-2 p-1" data-plan-state={phase.kind}>
      <p className="sr-only" aria-live="polite">
        {liveText(phase)}
      </p>
      {preview.blocked ? (
        <p role="alert" className="rounded-md bg-warning-surface px-3 py-2 text-sm text-text" data-plan-blocked>
          {t("palette.plan.blocked")}
        </p>
      ) : null}
      {preview.steps.length === 0 ? (
        <div className="flex flex-col gap-1 px-3 py-4 text-sm" data-plan-empty>
          <p className="font-medium text-text">{t("palette.plan.empty")}</p>
          {preview.note ? <p className="text-text-muted">{preview.note}</p> : null}
        </div>
      ) : (
        <ol role="listbox" aria-label={t("palette.plan.steps")} className="flex flex-col">
          {preview.steps.map((step, index) => (
            <PlanStepRow
              key={index}
              id={`${idPrefix}-plan-${index}`}
              index={index}
              step={step}
              selected={index === selected}
              confirmed={phase.confirmed.includes(index)}
              outcome={outcomes?.[index] ?? null}
              onSelect={() => session.select(index)}
            />
          ))}
        </ol>
      )}
      {phase.kind === "editing" ? <StepEditor session={session} phase={phase} /> : null}
      {session.notice ? (
        <p role="status" className="rounded-md bg-warning-surface px-3 py-1.5 text-sm text-text" data-plan-notice>
          {session.notice}
        </p>
      ) : null}
      {phase.kind === "running" ? (
        <p className="flex items-center gap-2 px-2 text-sm text-text-muted" aria-live="polite" data-plan-progress>
          <Spinner label={t("palette.plan.running")} />
          {session.progress ? t("palette.plan.stepOf", session.progress) : t("palette.plan.running")}
        </p>
      ) : null}
      {phase.kind === "result" ? (
        <p role="alert" className="px-2 text-sm text-text" data-plan-result>
          {resultText(phase.result)}
        </p>
      ) : (
        <p className="px-2 text-xs text-text-muted" data-plan-undo-hint>
          {t("palette.plan.undoHint")}
        </p>
      )}
    </div>
  );
}

function PlanStepRow({
  id,
  index,
  step,
  selected,
  confirmed,
  outcome,
  onSelect,
}: {
  id: string;
  index: number;
  step: PlanStepView;
  selected: boolean;
  confirmed: boolean;
  outcome: PlanStepOutcome | null;
  onSelect: () => void;
}) {
  const kind = classView(step);
  const check = checkView(step.check);
  const result = outcome ? outcomeView(outcome) : null;
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-plan-step={index + 1}
      data-plan-command={step.command}
      data-plan-class={step.class}
      data-plan-check={step.check.status}
      data-plan-confirmed={step.class === "outward" ? String(confirmed) : undefined}
      data-plan-outcome={outcome?.status}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn("flex flex-col gap-0.5 rounded-md px-2 py-1.5", selected ? "bg-accent-surface" : "hover:bg-surface-raised")}
    >
      <span className="flex min-w-0 items-baseline gap-2 text-base text-text">
        <span className="w-5 shrink-0 text-right text-sm text-text-muted tabular-nums">{index + 1}.</span>
        <span className="min-w-0 flex-1 truncate" data-plan-title>
          {stepTitle(step)}
        </span>
        <Status word={kind.word} tone={kind.tone} />
        {check.word ? <Status word={check.word} tone={check.tone} /> : null}
        {result ? <Status word={result.word} tone={result.tone} /> : null}
      </span>
      {step.why ? <span className="pl-7 text-sm text-text-muted">{step.why}</span> : null}
      {check.detail ? (
        <span className="pl-7 text-sm text-text-muted" data-plan-check-detail>
          {check.detail}
        </span>
      ) : null}
      {step.class === "outward" ? (
        <span className="flex items-center gap-2 pl-7 text-sm" data-plan-confirm>
          <span className={cn("font-medium", confirmed ? "text-text" : "text-danger")}>{confirmed ? t("palette.plan.confirmed") : t("palette.plan.unconfirmed")}</span>
          <span className="text-text-muted">{t("palette.plan.irreversible")}</span>
        </span>
      ) : null}
      {result?.detail ? <span className="pl-7 text-sm text-danger">{result.detail}</span> : null}
    </li>
  );
}

function StepEditor({ session, phase }: { session: PlanSession; phase: Extract<PlanPhase, { kind: "editing" }> }) {
  const form = useRef<HTMLFormElement>(null);
  const step = phase.preview.steps[phase.selected];
  // The user pressed E: the editor takes the focus (the only place plan mode moves it).
  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input, button, [role='radio']")?.focus();
  }, [phase.selected]);
  if (!step) return null;
  return (
    <form
      ref={form}
      data-plan-editor
      aria-label={t("palette.plan.editTitle", { n: phase.selected + 1 })}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-2"
      onSubmit={(event) => {
        event.preventDefault();
        session.saveEdit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          session.saveEdit();
        }
      }}
    >
      {step.fields.map((field) => (
        <FieldInput key={field.name} field={field} value={phase.draft[field.name]} onChange={(value) => session.setDraft(field.name, value)} />
      ))}
      <span className="flex items-center gap-3 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <Kbd>Enter</Kbd> {t("palette.plan.footer.apply")}
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>Esc</Kbd> {t("palette.plan.footer.cancelEdit")}
        </span>
      </span>
      <button type="submit" className="sr-only">
        {t("palette.plan.save")}
      </button>
    </form>
  );
}

function FieldInput({ field, value, onChange }: { field: PlanArgField; value: string | boolean | undefined; onChange: (value: string | boolean) => void }) {
  const label = ARG_LABELS[field.name] ?? field.name;
  if (field.kind === "boolean") return <Checkbox label={label} checked={value === true} onCheckedChange={onChange} />;
  if (field.kind === "choice" || field.kind === "optional_choice") {
    const options = [
      ...(field.kind === "optional_choice" ? [{ value: "", label: t("palette.plan.default") }] : []),
      ...field.choices.map((choice) => ({ value: choice, label: MODE_WORDS[choice] ?? choice })),
    ];
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-text-muted">{label}</span>
        <SegmentedControl label={label} value={typeof value === "string" ? value : ""} options={options} onValueChange={onChange} />
      </div>
    );
  }
  const prose = field.name === "message" || field.name === "summary" || field.name === "description";
  return <TextField label={label} mono={!prose} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
}

export function PlanFooter({ session }: { session: PlanSession }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 truncate" data-plan-footer>
      {footerKeys(session.phase).map(([key, label]) => (
        <span key={`${key}-${label}`} className="inline-flex items-center gap-1">
          <Kbd>{key}</Kbd> {label}
        </span>
      ))}
    </span>
  );
}
