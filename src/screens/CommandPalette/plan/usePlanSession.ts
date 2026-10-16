/**
 * State and calls of the plan mode of the command palette (spec Paket 5). `start` shows "What is
 * sent?" where Grundregel 4 asks (`confirmSend`), then asks for a plan; the keys select, confirm,
 * edit, remove and run steps; Esc cancels a request, leaves the editor or goes back to the input –
 * the typed text stays. An answer that arrives after Esc or after a newer request is dropped
 * (`generation`), and nothing here moves the focus except into the editor the user opened with E
 * and back to the input when it closes.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { core, type AiPreview, type AiProviderKind, type Id, type PlanStep } from "../../../core";
import { signInInTerminal } from "../../../app/ai/cliLogin";
import { confirmSend } from "../../../app/ai/gate";
import { openAiSettings, openAiSetup } from "../../../app/ai/open";
import { showAiPreview } from "../../../app/ai/PreviewDialog";
import { errorView } from "../../../app/ai/requestState";
import { undo } from "../../../app/actions/undo";
import { afterFocusReturn } from "../../../app/focusReturn";
import { qk, queryClient, useAiStatus } from "../../../app/queries";
import { newJobId } from "../../../app/run";
import { toast } from "../../../ui/Feedback";
import { locale, t } from "../../../i18n";
import {
  MAX_REQUEST_CHARS,
  afterRun,
  applyDraft,
  draftOf,
  escapeAction,
  planErrorText,
  planKey,
  shiftConfirmed,
  stepProgress,
  toStep,
  withoutStep,
  type PlanPhase,
} from "./model";

type Editable = Extract<PlanPhase, { kind: "preview" | "editing" }>;

export interface PlanSession {
  phase: PlanPhase;
  active: boolean;
  /** The request of the current plan (one line). */
  text: string;
  notice: string | null;
  elapsedMs: number;
  local: boolean;
  /** The chosen provider (for "Sign in in the terminal"). */
  provider: AiProviderKind | null;
  progress: { n: number; total: number } | null;
  start(text: string): Promise<void>;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  escape(): void;
  select(index: number): void;
  setDraft(name: string, value: string | boolean): void;
  saveEdit(): void;
  retry(): void;
  /** `ai_not_configured`: 1b's setup dialog. */
  openSetup(): void;
  /** `ai_not_logged_in`: the built-in terminal with the CLI's sign-in (1b). */
  signIn(): void;
  /** `ai_limit_reached`: Settings › AI, where the limit lives. */
  changeLimit(): void;
  whatIsSent(text: string): Promise<void>;
  activeDescendant(prefix: string): string | undefined;
}

export function usePlanSession(repoId: Id | null, close: () => void, focusInput: () => void): PlanSession {
  const [phase, setPhaseState] = useState<PlanPhase>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [progress, setProgress] = useState<{ n: number; total: number } | null>(null);
  const status = useAiStatus();
  const current = useRef<PlanPhase>(phase);
  const generation = useRef(0);
  const setPhase = (next: PlanPhase) => {
    current.current = next;
    setPhaseState(next);
  };

  const timed = phase.kind === "loading" || phase.kind === "running";
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timed]);

  const runningJob = phase.kind === "running" ? phase.jobId : null;
  useEffect(() => {
    if (!runningJob) return;
    const stop = core.on("job:progress", (payload) => {
      if (payload.jobId === runningJob) setProgress(stepProgress(payload.line));
    });
    return () => stop();
  }, [runningJob]);

  const cancelRequest = (jobId: string) => {
    for (const id of [jobId, `${jobId}:check`]) void core.jobCancel({ jobId: id }).catch(() => undefined);
  };

  // Closing the palette while the AI still answers cancels the request; a late answer is dropped.
  useEffect(
    () => () => {
      generation.current += 1;
      const last = current.current;
      if (last.kind === "loading") cancelRequest(last.jobId);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const start = async (text: string) => {
    if (!repoId) return;
    const request = text.trim().slice(0, MAX_REQUEST_CHARS);
    if (!request) return;
    const mine = ++generation.current;
    setNotice(null);
    let preview: AiPreview;
    try {
      preview = await core.aiPreview({ repoId, feature: "plan", input: { kind: "plan", text: request }, locale: locale() });
    } catch (error) {
      if (generation.current === mine) setPhase({ kind: "failed", text: request, error });
      return;
    }
    if (generation.current !== mine || !(await confirmSend(repoId, "plan", preview)) || generation.current !== mine) return;
    const jobId = newJobId();
    setPhase({ kind: "loading", text: request, jobId, startedAt: Date.now() });
    try {
      const plan = await core.aiPlan({ repoId, jobId, text: request, locale: locale() });
      if (generation.current === mine) setPhase({ kind: "preview", text: request, preview: plan, selected: 0, confirmed: [], busy: false });
    } catch (error) {
      if (generation.current !== mine) return;
      setPhase(errorView(error).kind === "cancelled" ? { kind: "idle" } : { kind: "failed", text: request, error });
    }
  };

  const recheck = async (base: Editable, steps: PlanStep[], selected: number, confirmed: number[]) => {
    if (!repoId) return;
    const mine = generation.current;
    setPhase({ kind: "preview", text: base.text, preview: base.preview, selected: base.selected, confirmed: base.confirmed, busy: true });
    try {
      const next = await core.aiPlanCheck({ repoId, jobId: newJobId(), steps });
      if (generation.current !== mine) return;
      setPhase({ kind: "preview", text: base.text, preview: next, selected: Math.min(selected, Math.max(0, next.steps.length - 1)), confirmed, busy: false });
    } catch (error) {
      if (generation.current === mine) setPhase({ kind: "failed", text: base.text, error });
    }
  };

  const run = async (base: Extract<PlanPhase, { kind: "preview" }>) => {
    if (!repoId) return;
    const mine = generation.current;
    const jobId = newJobId();
    setProgress(null);
    setPhase({ kind: "running", text: base.text, preview: base.preview, confirmed: base.confirmed, jobId, startedAt: Date.now() });
    try {
      const result = await core.aiPlanRun({ repoId, jobId, text: base.text, steps: base.preview.steps.map(toStep), expect: base.preview.expect, confirmed: base.confirmed });
      void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
      if (generation.current !== mine) return;
      const next = afterRun(result);
      if (next.close) {
        setPhase({ kind: "idle" });
        close();
        toast({
          tone: "success",
          title: next.toast,
          ...(result.undoRecorded ? { action: { label: t("commands.repo.undo.title"), onClick: () => void undo(repoId) } } : {}),
        });
        return;
      }
      setPhase({ kind: "result", text: base.text, preview: base.preview, confirmed: base.confirmed, result });
    } catch (error) {
      if (generation.current === mine) setPhase({ kind: "failed", text: base.text, error });
    }
  };

  const escape = () => {
    const p = current.current;
    setNotice(null);
    switch (escapeAction(p)) {
      case "cancelRequest":
        if (p.kind === "loading") cancelRequest(p.jobId);
        generation.current += 1;
        setPhase({ kind: "idle" });
        return;
      case "cancelRun":
        // The core stops before the next step; the result arrives with `cancelled`.
        if (p.kind === "running") void core.jobCancel({ jobId: p.jobId }).catch(() => undefined);
        return;
      case "endEdit":
        if (p.kind === "editing") setPhase({ kind: "preview", text: p.text, preview: p.preview, selected: p.selected, confirmed: p.confirmed, busy: false });
        focusInput();
        return;
      case "close":
        close();
        return;
      case "back":
        generation.current += 1;
        setPhase({ kind: "idle" });
        focusInput();
        return;
      case "none":
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Esc goes through the dialog's own handler (`escape`); Tab keeps its meaning.
    if (event.key === "Escape" || event.key === "Tab") return;
    const p = current.current;
    const action = planKey(p, event);
    if (action.kind === "none") {
      // The input is read-only in plan mode; keys must not fall through to the palette.
      if (event.key === "Enter" || event.key === "Delete" || event.key.length === 1) event.preventDefault();
      return;
    }
    event.preventDefault();
    setNotice(null);
    switch (action.kind) {
      case "select":
        if (p.kind === "preview") setPhase({ ...p, selected: action.index });
        return;
      case "confirm":
        if (p.kind === "preview") {
          const confirmed = p.confirmed.includes(action.index) ? p.confirmed.filter((index) => index !== action.index) : [...p.confirmed, action.index];
          setPhase({ ...p, confirmed });
        }
        return;
      case "edit":
        if (p.kind === "preview") {
          const step = p.preview.steps[action.index];
          if (step) setPhase({ kind: "editing", text: p.text, preview: p.preview, selected: action.index, confirmed: p.confirmed, draft: draftOf(step) });
        }
        return;
      case "remove":
        if (p.kind === "preview") void recheck(p, withoutStep(p.preview, action.index), action.index, shiftConfirmed(p.confirmed, action.index));
        return;
      case "run":
        if (p.kind === "preview") void run(p);
        return;
      case "notice":
        setNotice(action.text);
        return;
      case "close":
        close();
        return;
    }
  };

  const select = (index: number) => {
    const p = current.current;
    if (p.kind === "preview") setPhase({ ...p, selected: index });
  };

  const setDraft = (name: string, value: string | boolean) => {
    const p = current.current;
    if (p.kind === "editing") setPhase({ ...p, draft: { ...p.draft, [name]: value } });
  };

  const saveEdit = () => {
    const p = current.current;
    if (p.kind !== "editing") return;
    const steps = p.preview.steps.map((step, index) => (index === p.selected ? applyDraft(step, p.draft) : toStep(step)));
    focusInput();
    // An edited step goes out differently: its own confirmation is asked again.
    void recheck(p, steps, p.selected, p.confirmed.filter((index) => index !== p.selected));
  };

  const retry = () => {
    const p = current.current;
    if (p.kind === "failed") void start(p.text);
  };

  // These leave the palette first, so the dialog or terminal they open gets the focus.
  const openSetup = () => {
    close();
    afterFocusReturn(() => void openAiSetup());
  };

  const signIn = () => {
    const provider = status.data?.provider ?? null;
    close();
    afterFocusReturn(() => {
      if (provider) signInInTerminal(provider);
    });
  };

  const changeLimit = () => {
    close();
    afterFocusReturn(() => openAiSettings());
  };

  const whatIsSent = async (text: string) => {
    if (!repoId) return;
    const request = text.trim().slice(0, MAX_REQUEST_CHARS);
    if (!request) return;
    try {
      const preview = await core.aiPreview({ repoId, feature: "plan", input: { kind: "plan", text: request }, locale: locale() });
      await showAiPreview(preview, "look");
    } catch (error) {
      setNotice(planErrorText(error));
    }
  };

  const activeDescendant = (prefix: string) =>
    (phase.kind === "preview" || phase.kind === "editing") && phase.preview.steps.length ? `${prefix}-plan-${phase.selected}` : undefined;

  return {
    phase,
    active: phase.kind !== "idle",
    text: "text" in phase ? phase.text : "",
    notice,
    elapsedMs: "startedAt" in phase ? Math.max(0, now - phase.startedAt) : 0,
    local: status.data?.local ?? false,
    provider: status.data?.provider ?? null,
    progress,
    start,
    onKeyDown,
    escape,
    select,
    setDraft,
    saveEdit,
    retry,
    openSetup,
    signIn,
    changeLimit,
    whatIsSent,
    activeDescendant,
  };
}
