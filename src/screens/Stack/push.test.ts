import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ stackPush: [] as unknown[], results: [] as unknown[] }));
vi.mock("../PushCheck/SecretDialog", () => ({ showSecretFindings: vi.fn() }));
vi.mock("../../core", async (original) => {
  const actual = await original<typeof import("../../core")>();
  return {
    ...actual,
    core: {
      stackPush: vi.fn(async (input: unknown) => {
        calls.stackPush.push(input);
        return calls.results.shift();
      }),
    },
  };
});
vi.mock("../../app/run", () => ({
  newJobId: () => `job-${calls.stackPush.length + 1}`,
  runAction: async <T,>(_label: string, run: () => Promise<T>) => ({ ok: true, value: await run() }),
}));

import type { PushResult, SecretFinding } from "../../core";
import { pushStack } from "./push";

const ID = "f".repeat(64);
const finding: SecretFinding = { id: ID, path: "dienst/zugang.py", line: 1, commit: "c".repeat(40), rule: "known_token", excerpt: 'AWS_ZUGANG = "…W3NB"', hint: "…W3NB" };
const found: PushResult = { status: "secrets_found", findings: [finding], commits: 2, partial: false };
const multi: PushResult = { status: "multi", remote: "origin", atomic: true, refs: [] };
const parts = ["feature/auswertung-1-eins", "feature/auswertung-2-zwei"];

describe("pushStack", () => {
  it("stops at a key in a part and pushes again only with the accepted finding", async () => {
    calls.stackPush.length = 0;
    calls.results.push(found, multi);
    const show = vi.fn(async () => [ID]);
    const result = await pushStack("repo-1", parts, "origin", false, show);
    expect(show).toHaveBeenCalledWith("repo-1", found);
    expect(calls.stackPush).toEqual([
      { repoId: "repo-1", jobId: "job-1", branches: parts, remote: "origin", force: false, acceptedSecrets: null },
      { repoId: "repo-1", jobId: "job-2", branches: parts, remote: "origin", force: false, acceptedSecrets: [ID] },
    ]);
    expect(result).toEqual({ ok: true, value: multi });
  });

  it("“Back” pushes nothing more and ends as cancelled", async () => {
    calls.stackPush.length = 0;
    calls.results.push(found);
    const result = await pushStack("repo-1", parts, "origin", true, async () => null);
    expect(calls.stackPush).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
  });
});
