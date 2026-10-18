/**
 * State of the search by meaning: preview → confirmation (only when the core asks) → search job.
 * A newer question or "Cancel" drops the older answer (no half results); an answer never moves the focus.
 */
import { useCallback, useRef, useState } from "react";
import { core, type AiSemanticResult, type CoreError, type Id } from "../../core";
import { confirmSend } from "../../app/ai/gate";
import { showAiPreview } from "../../app/ai/PreviewDialog";
import { qk, queryClient } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { locale, t } from "../../i18n";
import { runMeaning } from "./meaningModel";

export interface MeaningSearchState {
  submitted: string | null;
  result: AiSemanticResult | null;
  error: CoreError | null;
  running: boolean;
  jobId: string | null;
  startedAt: number | null;
}

const IDLE: MeaningSearchState = { submitted: null, result: null, error: null, running: false, jobId: null, startedAt: null };

export function useMeaningSearch(repoId: Id) {
  const [state, setState] = useState<MeaningSearchState>(IDLE);
  const runs = useRef(0);
  const job = useRef<string | null>(null);

  const run = useCallback(
    async (question: string) => {
      const id = ++runs.current;
      const jobId = newJobId();
      job.current = jobId;
      setState({ submitted: question, result: null, error: null, running: true, jobId, startedAt: Date.now() });
      const input = { kind: "semantic_search" as const, query: question };
      const outcome = await runMeaning(
        {
          preview: () => core.aiPreview({ repoId, feature: "semantic_search", input, locale: locale() }),
          confirm: (preview) => confirmSend(repoId, "semantic_search", preview),
          search: () => core.aiSemanticSearch({ repoId, jobId, query: question, locale: locale() }),
        },
        () => runs.current === id,
      );
      if (outcome.kind === "stale") return;
      job.current = null;
      if (outcome.kind === "done") {
        setState({ ...IDLE, submitted: question, result: outcome.result });
        void queryClient.invalidateQueries({ queryKey: qk.aiSemanticStatus(repoId) });
      } else if (outcome.kind === "failed") {
        setState({ ...IDLE, submitted: question, error: outcome.error });
      } else {
        setState(IDLE);
      }
    },
    [repoId],
  );

  const cancel = useCallback(() => {
    runs.current += 1;
    const jobId = job.current;
    job.current = null;
    if (jobId) void core.jobCancel({ jobId }).catch(() => undefined);
    setState(IDLE);
  }, []);

  const showSent = useCallback(
    async (question: string) => {
      const result = await runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature: "semantic_search", input: { kind: "semantic_search", query: question }, locale: locale() }));
      if (result.ok) await showAiPreview(result.value, "look");
    },
    [repoId],
  );

  return { ...state, run, cancel, showSent };
}
