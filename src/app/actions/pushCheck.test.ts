import { describe, expect, it, vi } from "vitest";

vi.mock("../../screens/PushCheck/SecretDialog", () => ({ showSecretFindings: vi.fn() }));

import { CoreError, type PushResult, type SecretFinding } from "../../core";
import type { ActionResult } from "../run";
import { guardSecrets } from "./pushCheck";

const A = "a".repeat(64);
const B = "b".repeat(64);
const finding: SecretFinding = { id: A, path: "dienst.py", line: 1, commit: "c".repeat(40), rule: "known_token", excerpt: 'AWS = "…W3NB"', hint: "…W3NB" };
const found: PushResult = { status: "secrets_found", findings: [finding], commits: 1, partial: false };
const done: PushResult = { status: "done", remote: "origin", branch: "main", createdUpstream: false, forced: false };
const ok = (value: PushResult): ActionResult<PushResult> => ({ ok: true, value });

describe("guardSecrets", () => {
  it("pushes at once when the scan finds nothing", async () => {
    const attempt = vi.fn(async () => ok(done));
    const show = vi.fn();
    expect(await guardSecrets("repo-1", attempt, show)).toEqual(ok(done));
    expect(attempt.mock.calls).toEqual([[null]]);
    expect(show).not.toHaveBeenCalled();
  });

  it("Back pushes nothing and ends quietly as cancelled", async () => {
    const attempt = vi.fn(async () => ok(found));
    const show = vi.fn(async () => null);
    const result = await guardSecrets("repo-1", attempt, show);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith("repo-1", found);
  });

  it("Push anyway repeats with exactly the accepted IDs; new findings ask again", async () => {
    const second: PushResult = { status: "secrets_found", findings: [finding, { ...finding, id: B, line: 7 }], commits: 2, partial: false };
    const attempt = vi.fn<(accepted: string[] | null) => Promise<ActionResult<PushResult>>>().mockResolvedValueOnce(ok(found)).mockResolvedValueOnce(ok(second)).mockResolvedValueOnce(ok(done));
    const show = vi.fn<(repoId: string, value: unknown) => Promise<string[] | null>>().mockResolvedValueOnce([A]).mockResolvedValueOnce([A, B]);
    expect(await guardSecrets("repo-1", attempt, show)).toEqual(ok(done));
    expect(attempt.mock.calls).toEqual([[null], [[A]], [[A, B]]]);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("errors and other results pass through untouched", async () => {
    const failed: ActionResult<PushResult> = { ok: false, error: new CoreError({ code: "no_upstream", message: "x", gitOutput: null }) };
    const show = vi.fn();
    expect(await guardSecrets("repo-1", async () => failed, show)).toBe(failed);
    const rejected = ok({ status: "rejected", reason: "non-fast-forward" });
    expect(await guardSecrets("repo-1", async () => rejected, show)).toBe(rejected);
    expect(show).not.toHaveBeenCalled();
  });
});
