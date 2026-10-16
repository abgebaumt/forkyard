import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("../../app/ai/gate", () => ({ showWhatIsSent: vi.fn() }));
vi.mock("../../app/ai/open", () => ({ openAiSettings: vi.fn(), openAiSetup: vi.fn() }));
vi.mock("../../app/ai/cliLogin", () => ({ signInInTerminal: vi.fn() }));
vi.mock("./aiDraftActions", () => ({
  acceptOffer: vi.fn(),
  toggleWriteMessage: vi.fn(),
  writeMessage: vi.fn(),
  useAiDraft: () => ({ phase: { kind: "idle" }, undo: null }),
}));

import { TooltipProvider } from "../../ui/Tooltip";
import { AiDraftStatusView, AiWriteButtonView } from "./AiDraftControls";

const html = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const none = () => undefined;

describe("Write button (spec 3.1)", () => {
  it("is blocked with a reason while nothing is staged", () => {
    const markup = html(<AiWriteButtonView phase="idle" staged={0} onToggle={none} />);
    expect(markup).toContain('data-ai-write=""');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain(">Write</button>");
  });

  it("reads Cancel while writing and New afterwards", () => {
    const running = html(<AiWriteButtonView phase="running" staged={2} onToggle={none} />);
    expect(running).toContain(">Cancel</button>");
    expect(running).not.toContain("aria-disabled");
    expect(html(<AiWriteButtonView phase="done" staged={2} onToggle={none} />)).toContain(">New</button>");
  });
});

describe("status line (spec “Zustände jedes KI-Elements”)", () => {
  const running = { kind: "running", jobId: "job-1", startedAt: 0, atStart: { summary: "", description: "" } } as const;

  it("offers “What is sent?” before the first use, without a live region (Grundregel 4)", () => {
    const idle = html(<AiDraftStatusView repoId="r" phase={{ kind: "idle" }} local elapsedMs={0} staged={2} />);
    expect(idle).toContain("data-ai-write-idle");
    expect(idle).toContain("data-ai-commit-preview");
    expect(idle).toContain("What is sent?");
    expect(idle).not.toContain('role="status"');
    expect(html(<AiDraftStatusView repoId="r" phase={{ kind: "idle" }} local elapsedMs={0} staged={0} />), "nothing staged: nothing to show").toBe("");
  });

  it("counts seconds politely and names slow local models", () => {
    const markup = html(<AiDraftStatusView repoId="r" phase={running} local elapsedMs={12_400} staged={1} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Writing … (12 s)");
    expect(markup).not.toContain("Local models take longer");
    expect(html(<AiDraftStatusView repoId="r" phase={running} local elapsedMs={31_000} staged={1} />)).toContain("Local models take longer");
    expect(html(<AiDraftStatusView repoId="r" phase={running} local={false} elapsedMs={1_000} staged={1} />)).toContain(">Writing …</span>");
  });

  it("names the draft and links “What is sent?” afterwards", () => {
    const markup = html(<AiDraftStatusView repoId="r" phase={{ kind: "done", inserted: true }} local elapsedMs={0} staged={1} />);
    expect(markup).toContain(">Draft</span>");
    expect(markup).toContain("Draft from the staged diff, styled like the last 30 commits");
    expect(markup).toContain("data-ai-commit-preview");
    expect(markup).toContain("What is sent?");
  });

  it("offers a suggestion with Replace, Append and Discard", () => {
    const suggestion = { summary: "Tagesmittel als CSV exportieren", description: "" };
    const ready = html(<AiDraftStatusView repoId="r" phase={{ kind: "offer", reason: "ready", suggestion }} local elapsedMs={0} staged={1} />);
    expect(ready).toContain("Suggestion ready");
    expect(ready).toContain("Tagesmittel als CSV exportieren");
    for (const action of ["replace", "append", "discard"]) expect(ready).toContain(`data-ai-offer-action="${action}"`);
    expect(html(<AiDraftStatusView repoId="r" phase={{ kind: "offer", reason: "choose", suggestion }} local elapsedMs={0} staged={1} />)).toContain("Suggestion – your text stays until you choose");
  });

  it("shows errors inline as an alert with the way out", () => {
    const unavailable = html(<AiDraftStatusView repoId="r" phase={{ kind: "error", view: { kind: "unavailable", text: "Ollama is not responding (127.0.0.1:11434).", retryAt: null } }} local elapsedMs={0} staged={1} />);
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).toContain("Ollama is not responding (127.0.0.1:11434).");
    expect(unavailable).toContain("Try again");
    const invalid = html(<AiDraftStatusView repoId="r" phase={{ kind: "error", view: { kind: "invalid", text: "Answer unusable" } }} local elapsedMs={0} staged={1} />);
    expect(invalid).toContain("Again");
    expect(invalid).toContain("Show what was sent");
    const limit = html(<AiDraftStatusView repoId="r" phase={{ kind: "error", view: { kind: "limit", text: "Limit reached." } }} local elapsedMs={0} staged={1} />);
    expect(limit).toContain("Send this time");
    expect(limit).toContain("Change limit");
  });

  it("offers the sign-in in the terminal when a command-line tool is signed out", () => {
    const text = "Claude Code is not signed in. Sign in in the terminal: claude auth login";
    const phase = { kind: "error", view: { kind: "notLoggedIn", text } } as const;
    const cli = html(<AiDraftStatusView repoId="r" phase={phase} local={false} elapsedMs={0} staged={1} provider="claude_code" />);
    expect(cli).toContain('role="alert"');
    expect(cli).toContain(text);
    expect(cli).toContain("data-ai-sign-in");
    expect(cli).toContain("Sign in in the terminal</button>");
    // An API provider has no terminal sign-in: only the text stays.
    expect(html(<AiDraftStatusView repoId="r" phase={phase} local={false} elapsedMs={0} staged={1} provider="anthropic" />)).not.toContain("data-ai-sign-in");
  });
});
