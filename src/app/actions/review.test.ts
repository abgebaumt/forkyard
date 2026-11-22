import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError, type NewReviewComment, type ReviewDraft, type ReviewSubmitResult } from "../../core";

const prReviewSubmit = vi.fn<(input: unknown) => Promise<ReviewSubmitResult>>();
const prReviewDraftSave = vi.fn<(input: unknown) => Promise<ReviewDraft>>();
const toastSpy = vi.fn<(options: { tone: string; title: string; description?: string }) => void>();

vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: {
    prReviewSubmit: (input: unknown) => prReviewSubmit(input),
    prReviewDraftSave: (input: unknown) => prReviewDraftSave(input),
    on: () => () => undefined,
  },
}));

vi.mock("../../ui/Feedback", async (original) => ({
  ...(await original<typeof import("../../ui/Feedback")>()),
  toast: (options: { tone: string; title: string; description?: string }) => toastSpy(options),
}));

const { qk, queryClient } = await import("../queries");
const { resaveDraft, submitReview } = await import("./review");

const REPO = "repo-1";
const HEAD = "b".repeat(40);
const draft = (partial: Partial<ReviewDraft>): ReviewDraft => ({
  id: "4",
  origin: "local",
  path: "src/größe.rs",
  line: 12,
  startLine: 10,
  side: "new",
  oldLine: null,
  commit: "a".repeat(40),
  body: "Bitte prüfen",
  error: null,
  ...partial,
});

beforeEach(() => {
  queryClient.clear();
  prReviewSubmit.mockReset();
  prReviewDraftSave.mockReset();
  toastSpy.mockReset();
});

describe("submitReview", () => {
  it("names the failed comments and reloads drafts and threads", async () => {
    prReviewSubmit.mockResolvedValue({ submitted: false, sent: 1, failed: [draft({ error: "HTTP 400" })] });
    queryClient.setQueryData(qk.prReviewDrafts(REPO, 7), { drafts: [], hostUnreadable: false });
    queryClient.setQueryData(qk.prReviewThreads(REPO, 7), []);
    const result = await submitReview(REPO, 7, "approve", "Sieht gut aus", HEAD);
    expect(result?.submitted).toBe(false);
    expect(prReviewSubmit).toHaveBeenCalledWith(expect.objectContaining({ repoId: REPO, number: 7, vote: "approve", commit: HEAD }));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "danger", title: "1 comment could not be sent", description: "HTTP 400" }),
    );
    expect(queryClient.getQueryState(qk.prReviewDrafts(REPO, 7))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.prReviewThreads(REPO, 7))?.isInvalidated).toBe(true);
  });

  it("says when the review went out", async () => {
    prReviewSubmit.mockResolvedValue({ submitted: true, sent: 2, failed: [] });
    await submitReview(REPO, 7, "comment", "", HEAD);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ tone: "success", title: "Review sent" }));
  });
});

describe("resaveDraft", () => {
  it("stores the draft again against the current head, same text and lines", async () => {
    prReviewDraftSave.mockResolvedValue(draft({ commit: HEAD }));
    expect(await resaveDraft(REPO, 7, draft({ error: "This draft was written for an older head commit." }), HEAD)).toBe(true);
    const expected: NewReviewComment = {
      commit: HEAD,
      path: "src/größe.rs",
      line: 12,
      startLine: 10,
      side: "new",
      oldLine: null,
      body: "Bitte prüfen",
    };
    expect(prReviewDraftSave).toHaveBeenCalledWith({ repoId: REPO, number: 7, comment: expected, draftId: "4" });
  });

  it("leaves host drafts alone", async () => {
    expect(await resaveDraft(REPO, 7, draft({ id: "PRRC_kw1", origin: "host" }), HEAD)).toBe(false);
    expect(prReviewDraftSave).not.toHaveBeenCalled();
  });

  it("reports a failed save and keeps the drafts fresh", async () => {
    prReviewDraftSave.mockRejectedValue(
      new CoreError({ code: "not_found", message: "This review draft no longer exists.", gitOutput: null }),
    );
    queryClient.setQueryData(qk.prReviewDrafts(REPO, 7), { drafts: [], hostUnreadable: false });
    expect(await resaveDraft(REPO, 7, draft({}), HEAD)).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ tone: "danger" }));
    expect(queryClient.getQueryState(qk.prReviewDrafts(REPO, 7))?.isInvalidated).toBe(true);
  });
});
