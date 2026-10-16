import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCommitMessage, AiPreview, AiStatus, CommitDraft, RepoSettings } from "../../core";

// draft.ts saves through window.setTimeout; the node test environment has no window.
vi.stubGlobal("window", {
  setTimeout: (run: () => void) => {
    run();
    return 0;
  },
  clearTimeout: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const aiPreview = vi.fn<(input: unknown) => Promise<AiPreview>>();
const aiCommitMessage = vi.fn<(input: { repoId: string; jobId: string; locale: string }) => Promise<AiCommitMessage>>();
const jobCancel = vi.fn<(input: { jobId: string }) => Promise<void>>();
const confirmSend = vi.fn<(repoId: string | null, feature: string, preview: AiPreview) => Promise<boolean>>();
const openAiSetup = vi.fn<() => Promise<boolean>>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    aiPreview: (input: unknown) => aiPreview(input),
    aiCommitMessage: (input: { repoId: string; jobId: string; locale: string }) => aiCommitMessage(input),
    jobCancel: (input: { jobId: string }) => jobCancel(input),
    draftSet: () => Promise.resolve(),
    on: () => () => undefined,
  },
}));
vi.mock("../../app/ai/gate", () => ({
  confirmSend: (repoId: string | null, feature: string, preview: AiPreview) => confirmSend(repoId, feature, preview),
}));
vi.mock("../../app/ai/open", () => ({ openAiSetup: () => openAiSetup() }));

const { CoreError } = await import("../../core");
const { qk, queryClient } = await import("../../app/queries");
const { acceptOffer, aiDraftState, noteEdited, toggleWriteMessage, undoInsertion, useAiDraftStore, writeMessage } = await import("./aiDraftActions");
const { getDraft, updateDraft } = await import("./draft");

const REPO = "repo-1";
const ANSWER: AiCommitMessage = { summary: "Tagesmittel als CSV exportieren", body: "Schreibt je Station eine Zeile." };
const SUGGESTION = { summary: ANSWER.summary, description: ANSWER.body! };
const PREVIEW: AiPreview = { text: "t", omitted: [], shortened: [], chars: 1, estimatedTokens: 1, estimatedCostUsd: null, asks: [], fingerprint: "f", monthCostUsd: 0, limitUsd: null };

const fields = () => {
  const draft = getDraft(REPO);
  return { summary: draft.summary, description: draft.description };
};
const status = (patch: Partial<AiStatus>): AiStatus => ({
  state: "on",
  provider: "ollama",
  model: "qwen3:8b",
  connected: true,
  keyHint: null,
  local: true,
  price: null,
  introPending: false,
  featuresOff: [],
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  queryClient.clear();
  useAiDraftStore.setState({ repos: {} });
  queryClient.setQueryData(qk.aiStatus, status({}));
  queryClient.setQueryData<CommitDraft>(qk.draft(REPO), { summary: "", description: "", amend: false });
  aiPreview.mockReset().mockResolvedValue(PREVIEW);
  aiCommitMessage.mockReset().mockResolvedValue(ANSWER);
  jobCancel.mockReset().mockResolvedValue(undefined);
  confirmSend.mockReset().mockResolvedValue(true);
  openAiSetup.mockReset().mockResolvedValue(false);
});

describe("Write (commit message, spec 3.1)", () => {
  it("fills empty fields as a draft after the preview passed the gate", async () => {
    await writeMessage(REPO);
    expect(aiPreview).toHaveBeenCalledWith({ repoId: REPO, feature: "commit_message", input: { kind: "commit_message" }, locale: "en-US" });
    expect(confirmSend).toHaveBeenCalledWith(REPO, "commit_message", PREVIEW);
    expect(aiCommitMessage).toHaveBeenCalledWith(expect.objectContaining({ repoId: REPO, locale: "en-US" }));
    expect(fields()).toEqual(SUGGESTION);
    expect(aiDraftState(REPO).phase).toEqual({ kind: "done", inserted: true });
    expect(undoInsertion(REPO)).toBe(true);
    expect(fields()).toEqual({ summary: "", description: "" });
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
  });

  it("sends nothing when the confirmation is declined", async () => {
    confirmSend.mockResolvedValue(false);
    await writeMessage(REPO);
    expect(aiCommitMessage).not.toHaveBeenCalled();
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
    expect(fields()).toEqual({ summary: "", description: "" });
  });

  it("typing during the request only offers the suggestion", async () => {
    const answer = deferred<AiCommitMessage>();
    aiCommitMessage.mockReturnValue(answer.promise);
    const running = writeMessage(REPO);
    await vi.waitFor(() => expect(aiCommitMessage).toHaveBeenCalled());
    expect(aiDraftState(REPO).phase.kind).toBe("running");
    updateDraft(REPO, { summary: "F" });
    noteEdited(REPO);
    answer.resolve(ANSWER);
    await running;
    expect(fields().summary).toBe("F");
    expect(aiDraftState(REPO).phase).toEqual({ kind: "offer", reason: "ready", suggestion: SUGGESTION });
    acceptOffer(REPO, "replace");
    expect(fields()).toEqual(SUGGESTION);
    expect(undoInsertion(REPO)).toBe(true);
    expect(fields()).toEqual({ summary: "F", description: "" });
  });

  it("the user's text is never replaced unasked: append or discard", async () => {
    updateDraft(REPO, { summary: "WIP: Anmeldung" });
    await writeMessage(REPO);
    expect(fields().summary).toBe("WIP: Anmeldung");
    expect(aiDraftState(REPO).phase).toEqual({ kind: "offer", reason: "choose", suggestion: SUGGESTION });
    acceptOffer(REPO, "append");
    expect(fields()).toEqual({ summary: "WIP: Anmeldung", description: `${ANSWER.summary}\n\n${ANSWER.body}` });
    updateDraft(REPO, { summary: "Eigener Betreff", description: "" });
    noteEdited(REPO);
    expect(undoInsertion(REPO), "after an edit Mod+Z belongs to the field again").toBe(false);
    await writeMessage(REPO);
    acceptOffer(REPO, "discard");
    expect(fields()).toEqual({ summary: "Eigener Betreff", description: "" });
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
  });

  it("Cancel cancels the job and drops a late answer", async () => {
    const answer = deferred<AiCommitMessage>();
    aiCommitMessage.mockReturnValue(answer.promise);
    const running = writeMessage(REPO);
    await vi.waitFor(() => expect(aiCommitMessage).toHaveBeenCalled());
    const jobId = aiCommitMessage.mock.calls[0]![0].jobId;
    await toggleWriteMessage(REPO);
    expect(jobCancel).toHaveBeenCalledWith({ jobId });
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
    answer.resolve(ANSWER);
    await running;
    expect(fields()).toEqual({ summary: "", description: "" });
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
  });

  it("errors stay inline; a cancelled request leaves nothing behind", async () => {
    aiCommitMessage.mockRejectedValueOnce(new CoreError({ code: "ai_provider_unavailable", message: "Ollama is not responding (127.0.0.1:11434).", gitOutput: null, retryAt: null }));
    await writeMessage(REPO);
    expect(aiDraftState(REPO).phase).toEqual({ kind: "error", view: { kind: "unavailable", text: "Ollama is not responding (127.0.0.1:11434).", retryAt: null } });
    aiCommitMessage.mockRejectedValueOnce(new CoreError({ code: "cancelled", message: "Cancelled.", gitOutput: null, retryAt: null }));
    await writeMessage(REPO);
    expect(aiDraftState(REPO).phase.kind).toBe("idle");
  });

  it("on without a provider opens the setup instead of sending", async () => {
    queryClient.setQueryData(qk.aiStatus, status({ connected: false, provider: null, model: null }));
    await writeMessage(REPO);
    expect(openAiSetup).toHaveBeenCalledTimes(1);
    expect(aiPreview).not.toHaveBeenCalled();
  });

  it("the untouched commit template counts as an empty field", async () => {
    queryClient.setQueryData(qk.repoSettings(REPO), { commitTemplateText: "Bereich: Kurzbeschreibung\n\n# Warum?\nGrund\n" } as RepoSettings);
    updateDraft(REPO, { summary: "Bereich: Kurzbeschreibung", description: "Grund" });
    await writeMessage(REPO);
    expect(fields()).toEqual(SUGGESTION);
  });
});
