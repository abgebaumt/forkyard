/**
 * "Write release notes": "What is sent?" first (the core asks only when a confirmation is due),
 * then the request as a job; the answer goes into the field by the rules for suggestions. While
 * it runs the field stays editable; Cancel (or closing the dialog) discards the answer; a late
 * answer never moves the focus. The writer always sits inside a dialog and the dialog host shows
 * one dialog at a time, so "What is sent?" (look and confirm) is a dialog nested in that one
 * (`preview`, rendered by the writer row) instead of a queued one that would wait behind it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { core, type AiPreview, type Id, type ReleaseNotes } from "../../core";
import { locale, t } from "../../i18n";
import { confirmSend } from "../../app/ai/gate";
import { showAiPreview, type PreviewChoice } from "../../app/ai/PreviewDialog";
import type { AiLoadingView } from "../../app/ai/requestState";
import { applySuggestion } from "../../app/ai/suggestion";
import { useAiJob, type AiFailure } from "../../app/ai/useAiJob";
import { runAction } from "../../app/run";
import { answerPlacement } from "./model";

export interface WriterState {
  phase: "idle" | "done";
  notes: ReleaseNotes | null;
  /** Inserted into an empty field: marked as draft until the user edits or discards it. */
  draft: { before: string } | null;
  /** The field had text ("choose") or was edited meanwhile ("ready"): the suggestion waits. */
  pending: { text: string; kind: "choose" | "ready" } | null;
  emptyText: string | null;
}

/** The nested "What is sent?" dialog while it is open. */
export interface WriterPreview {
  preview: AiPreview;
  mode: "look" | "confirm";
}

export interface Writer {
  state: WriterState;
  /** Loading text while the request runs, else null. */
  loading: AiLoadingView | null;
  error: AiFailure | null;
  preview: WriterPreview | null;
  write(): Promise<void>;
  /** "What is sent?" without sending, in the nested dialog. */
  whatIsSent(): Promise<void>;
  closePreview(choice: PreviewChoice | null): void;
  cancel(): void;
  resolvePending(how: "replace" | "append" | "discard"): void;
  discardDraft(): void;
  edited(): void;
}

const IDLE: WriterState = { phase: "idle", notes: null, draft: null, pending: null, emptyText: null };

const inputFor = (to: string | null) => ({ kind: "release_notes" as const, from: null, to });

export async function showReleaseNotesPreview(
  repoId: Id,
  to: string | null,
  show: (preview: AiPreview, mode: "look") => Promise<PreviewChoice | null> = showAiPreview,
): Promise<void> {
  const result = await runAction(t("ai.preview.loading"), () =>
    core.aiPreview({ repoId, feature: "release_notes", input: inputFor(to), locale: locale() }),
  );
  if (result.ok) await show(result.value, "look");
}

export function useReleaseNotesWriter(options: {
  repoId: Id;
  to: string | null;
  /** The provider runs on this machine (slower hint). */
  local: boolean;
  current: () => string;
  apply: (text: string) => void;
}): Writer {
  const [state, setState] = useState<WriterState>(IDLE);
  const [preview, setPreview] = useState<WriterPreview | null>(null);
  const answer = useRef<((choice: PreviewChoice | null) => void) | null>(null);
  const job = useAiJob(options.local, t("actions.tags.releaseNotes.writing"));
  const opts = useRef(options);
  const stateRef = useRef(state);
  useEffect(() => {
    opts.current = options;
  });
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const ask = useCallback(
    (shown: AiPreview, mode: "look" | "confirm") =>
      new Promise<PreviewChoice | null>((resolve) => {
        answer.current?.(null);
        answer.current = resolve;
        setPreview({ preview: shown, mode });
      }),
    [],
  );

  const closePreview = useCallback((choice: PreviewChoice | null) => {
    const resolve = answer.current;
    answer.current = null;
    setPreview(null);
    resolve?.(choice);
  }, []);

  useEffect(
    () => () => {
      answer.current?.(null);
      answer.current = null;
    },
    [],
  );

  const write = async () => {
    const { repoId, to } = opts.current;
    let atStart = "";
    const notes = await job.start(
      (jobId) => {
        atStart = opts.current.current();
        setState(IDLE);
        return core.aiReleaseNotes({ repoId, jobId, from: null, to, locale: locale() });
      },
      async () => {
        const preview = await runAction(t("ui.releaseNotes"), () =>
          core.aiPreview({ repoId, feature: "release_notes", input: inputFor(to), locale: locale() }),
        );
        return preview.ok && (await confirmSend(repoId, "release_notes", preview.value, ask));
      },
    );
    if (!notes) return;
    const outcome = answerPlacement(opts.current.current(), atStart, notes);
    if (outcome.kind === "empty") {
      setState({ ...IDLE, phase: "done", notes, emptyText: outcome.text });
    } else if (outcome.kind === "insert") {
      opts.current.apply(outcome.text);
      setState({ ...IDLE, phase: "done", notes, draft: { before: atStart } });
    } else {
      setState({ ...IDLE, phase: "done", notes, pending: { text: notes.markdown, kind: outcome.kind } });
    }
  };

  const whatIsSent = useCallback(() => showReleaseNotesPreview(opts.current.repoId, opts.current.to, ask), [ask]);

  const cancel = () => {
    job.cancel();
    setState(IDLE);
  };

  const resolvePending = useCallback((how: "replace" | "append" | "discard") => {
    const pending = stateRef.current.pending;
    if (!pending) return;
    if (how !== "discard") opts.current.apply(applySuggestion(opts.current.current(), pending.text, how));
    setState((s) => ({ ...s, pending: null }));
  }, []);

  const discardDraft = useCallback(() => {
    const draft = stateRef.current.draft;
    if (!draft) return;
    opts.current.apply(draft.before);
    setState((s) => ({ ...s, draft: null }));
  }, []);

  const edited = useCallback(() => setState((s) => (s.draft ? { ...s, draft: null } : s)), []);

  return {
    state,
    loading: job.loading,
    error: job.run.kind === "failed" ? job.run.view : null,
    preview,
    write,
    whatIsSent,
    closePreview,
    cancel,
    resolvePending,
    discardDraft,
    edited,
  };
}
