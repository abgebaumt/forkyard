/**
 * "Write" for the commit message (spec 3.1): one request per repository at a time. The state starts
 * at the click and covers "What is sent?" (`aiPreview`), the confirmation of 1a's gate and the request
 * (`aiCommitMessage`, a job). The fields stay editable throughout; what arrives is placed by the rules
 * of `aiDraft.ts`. Cancel cancels the job and drops a late answer – there are no half results.
 * Errors stay in the state (the form shows them inline, never as a toast). Nothing here moves focus.
 */
import { create } from "zustand";
import { core, type AiStatus, type Id } from "../../core";
import { confirmSend } from "../../app/ai/gate";
import { openAiSetup } from "../../app/ai/open";
import { errorView } from "../../app/ai/requestState";
import { aiVisibility } from "../../app/ai/visibility";
import { qk, queryClient } from "../../app/queries";
import { newJobId } from "../../app/run";
import { locale } from "../../i18n";
import { placeCommitSuggestion, resolveOffer, suggestionParts, undoTarget, type AiDraftState } from "./aiDraft";
import { cachedTemplate, getDraft, updateDraft, type MessageParts } from "./draft";

const IDLE: AiDraftState = { phase: { kind: "idle" }, undo: null };

interface AiDraftStore {
  repos: Record<Id, AiDraftState>;
  set(repoId: Id, next: AiDraftState): void;
}

export const useAiDraftStore = create<AiDraftStore>()((set) => ({
  repos: {},
  set: (repoId, next) => set((state) => ({ repos: { ...state.repos, [repoId]: next } })),
}));

export const aiDraftState = (repoId: Id): AiDraftState => useAiDraftStore.getState().repos[repoId] ?? IDLE;
export const useAiDraft = (repoId: Id): AiDraftState => useAiDraftStore((state) => state.repos[repoId] ?? IDLE);

const put = (repoId: Id, next: AiDraftState) => useAiDraftStore.getState().set(repoId, next);

const fields = (repoId: Id): MessageParts => {
  const draft = getDraft(repoId);
  return { summary: draft.summary, description: draft.description };
};

const runningJob = (repoId: Id): string | null => {
  const phase = aiDraftState(repoId).phase;
  return phase.kind === "running" ? phase.jobId : null;
};

function place(repoId: Id, atStart: MessageParts, suggestion: MessageParts) {
  const current = fields(repoId);
  const placement = placeCommitSuggestion(current, atStart, cachedTemplate(repoId), suggestion);
  if (placement.kind === "insert") {
    updateDraft(repoId, suggestion);
    put(repoId, { phase: { kind: "done", inserted: true }, undo: { before: current, inserted: suggestion } });
  } else {
    put(repoId, { phase: { kind: "offer", reason: placement.kind, suggestion }, undo: null });
  }
}

export async function writeMessage(repoId: Id): Promise<void> {
  if (runningJob(repoId)) return;
  // "On" without a connected provider: the click leads to the setup, nothing is sent.
  if (aiVisibility(queryClient.getQueryData<AiStatus>(qk.aiStatus)).elementsOpenSetup) {
    void openAiSetup();
    return;
  }
  const jobId = newJobId();
  const atStart = fields(repoId);
  put(repoId, { phase: { kind: "running", jobId, startedAt: Date.now(), atStart }, undo: null });
  const stillMine = () => runningJob(repoId) === jobId;
  try {
    const preview = await core.aiPreview({ repoId, feature: "commit_message", input: { kind: "commit_message" }, locale: locale() });
    if (!stillMine()) return;
    if (!(await confirmSend(repoId, "commit_message", preview))) {
      if (stillMine()) put(repoId, IDLE);
      return;
    }
    if (!stillMine()) return;
    const answer = await core.aiCommitMessage({ repoId, jobId, locale: locale() });
    // Cancelled meanwhile: the answer is dropped.
    if (!stillMine()) return;
    place(repoId, atStart, suggestionParts(answer));
  } catch (error) {
    if (!stillMine()) return;
    const view = errorView(error);
    put(repoId, view.kind === "cancelled" ? IDLE : { phase: { kind: "error", view }, undo: null });
  }
}

export function cancelWriteMessage(repoId: Id): void {
  const jobId = runningJob(repoId);
  if (!jobId) return;
  put(repoId, IDLE);
  void core.jobCancel({ jobId }).catch(() => undefined);
}

/** The button, Mod+Shift+M and the palette: start, or cancel while it runs. */
export function toggleWriteMessage(repoId: Id): Promise<void> {
  if (runningJob(repoId)) {
    cancelWriteMessage(repoId);
    return Promise.resolve();
  }
  return writeMessage(repoId);
}

export function acceptOffer(repoId: Id, how: "replace" | "append" | "discard"): void {
  const phase = aiDraftState(repoId).phase;
  if (phase.kind !== "offer") return;
  if (how === "discard") {
    put(repoId, IDLE);
    return;
  }
  const before = fields(repoId);
  const next = resolveOffer(before, phase.suggestion, how);
  updateDraft(repoId, next);
  put(repoId, { phase: { kind: "done", inserted: true }, undo: { before, inserted: next } });
}

/** Mod+Z in the summary or description: takes the last insertion back while it is untouched. */
export function undoInsertion(repoId: Id): boolean {
  const target = undoTarget(aiDraftState(repoId).undo, fields(repoId));
  if (!target) return false;
  updateDraft(repoId, target);
  put(repoId, IDLE);
  return true;
}

/** The user typed: from now on Mod+Z belongs to the field's own history. */
export function noteEdited(repoId: Id): void {
  const state = aiDraftState(repoId);
  if (state.undo) put(repoId, { ...state, undo: null });
}

/** Both fields are empty again (after the commit, or cleared by hand): the draft hint goes. */
export function settleAiDraft(repoId: Id): void {
  if (aiDraftState(repoId).phase.kind === "done") put(repoId, IDLE);
}
