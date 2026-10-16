import { describe, expect, it } from "vitest";
import { CoreError, type ErrorCode } from "../../core";
import { errorView, loadingView } from "./requestState";

const coreError = (code: ErrorCode, message: string, retryAt: string | null = null) => new CoreError({ code, message, gitOutput: null, retryAt });

describe("states of an AI element (spec “Zustände jedes KI-Elements”)", () => {
  it("counts seconds only from 3 s and adds the slow hint after 30 s", () => {
    expect(loadingView(0, false)).toEqual({ text: "Writing …", slow: null });
    expect(loadingView(2_999, false)).toEqual({ text: "Writing …", slow: null });
    expect(loadingView(3_000, false)).toEqual({ text: "Writing … (3 s)", slow: null });
    expect(loadingView(12_400, true)).toEqual({ text: "Writing … (12 s)", slow: null });
    expect(loadingView(30_000, true).slow, "exactly 30 s is not slow yet").toBeNull();
    expect(loadingView(30_001, true)).toEqual({ text: "Writing … (30 s)", slow: "Local models take longer" });
    expect(loadingView(95_000, false).slow).toBe("The provider is answering slowly");
    expect(loadingView(-5, false).text, "a clock that went backwards").toBe("Writing …");
  });

  it("maps every AI error to the state the spec names", () => {
    expect(errorView(coreError("cancelled", "Cancelled."))).toEqual({ kind: "cancelled" });
    expect(errorView(coreError("ai_not_configured", "No AI provider is chosen yet.")).kind).toBe("setup");
    expect(errorView(coreError("ai_provider_unavailable", "Ollama is not responding (127.0.0.1:11434).", "2026-10-16T10:00:30Z"))).toEqual({
      kind: "unavailable",
      text: "Ollama is not responding (127.0.0.1:11434).",
      retryAt: "2026-10-16T10:00:30Z",
    });
    expect(errorView(coreError("offline", "Not reachable.")).kind, "offline is shown inline as well").toBe("unavailable");
    expect(errorView(coreError("timeout", "Timeout.")).kind).toBe("unavailable");
    expect(errorView(coreError("ai_not_logged_in", "Claude Code is not signed in.")).kind).toBe("notLoggedIn");
    expect(errorView(coreError("ai_invalid_answer", "The AI's answer could not be used ($.summary: expected text)."))).toEqual({ kind: "invalid", text: "Answer unusable" });
    expect(errorView(coreError("ai_too_large", "The request has about 160000 tokens.")).kind).toBe("tooLarge");
    expect(errorView(coreError("ai_limit_reached", "This month's AI costs are about 12.50 USD.")).kind).toBe("limit");
    expect(errorView(coreError("ai_refused", "The provider declined the request: No."))).toEqual({ kind: "refused", text: "The provider declined the request: No." });
    expect(errorView(new Error("boom"))).toEqual({ kind: "other", text: "boom" });
  });
});
