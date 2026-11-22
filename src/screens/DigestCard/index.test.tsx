import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Digest } from "../../core";

const digestGet = vi.fn<() => Promise<Digest | null>>();
vi.mock("../../core", async (original) => ({
  ...(await original<typeof import("../../core")>()),
  core: { digestGet: () => digestGet(), digestMarkSeen: vi.fn(), on: () => () => undefined },
}));

const { qk, queryClient } = await import("../../app/queries");
const { useAppStore } = await import("../../app/store");
const { digestFetchedWhileOpen, markDigestSeen } = await import("./actions");
const { DigestSummary } = await import("./index");

const numbers = { commits: 3, prs: 1, files: 0 };
const sample = {
  seenAt: "2026-11-19T08:00:00Z",
  refs: [],
  newCommits: 3,
  yourFiles: [],
  behind: null,
  prs: null,
  prDataMissing: null,
  mark: { composedAt: "2026-11-20T08:00:00Z", refs: {}, prMaxNumber: null, prOpen: null },
  isEmpty: false,
} satisfies Digest;

describe("DigestSummary", () => {
  it("shows the hint in the announced paragraph after a reload", async () => {
    queryClient.setQueryData(qk.digest("r1"), sample);
    useAppStore.getState().openDigest("r1");
    digestGet.mockResolvedValue(sample);
    digestFetchedWhileOpen("r1");
    const reloaded = (await markDigestSeen("r1", sample.mark)) === "reloaded";
    const markup = renderToStaticMarkup(<DigestSummary numbers={numbers} reloaded={reloaded} />);
    expect(markup).toMatch(/^<p [^>]*aria-live="polite"[^>]*>.*New changes arrived – check them, then mark as seen<\/span><\/p>$/);
  });

  it("shows only the numbers otherwise", () => {
    const markup = renderToStaticMarkup(<DigestSummary numbers={numbers} reloaded={false} />);
    expect(markup).toContain("3 new commits");
    expect(markup).not.toContain("data-digest-reloaded");
  });
});
