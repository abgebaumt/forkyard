import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("../../app/ai/gate", () => ({ confirmSend: vi.fn() }));
vi.mock("../../app/ai/PreviewDialog", () => ({
  showAiPreview: vi.fn(),
  AiPreviewDialog: ({ mode }: { mode: string }) => <div data-test-preview={mode} />,
}));

import { TooltipProvider } from "../../ui/Tooltip";
import type { AiErrorView } from "../../app/ai/requestState";
import { AutopilotErrorLine } from "./AutopilotDialog";

const none = () => undefined;
const html = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const line = (view: AiErrorView, onSignIn?: () => void) =>
  html(<AutopilotErrorLine view={view} onRetry={none} onShowSent={none} onSetup={none} onSettings={none} onSignIn={onSignIn} />);

describe("bisect autopilot dialog: the AI states (spec “Zustände jedes KI-Elements”)", () => {
  it("not signed in: “Sign in in the terminal” for a terminal tool, plus trying again", () => {
    const markup = line({ kind: "notLoggedIn", text: "Codex is not signed in." }, none);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Codex is not signed in.");
    expect(markup).toContain("data-autopilot-sign-in");
    expect(markup).toContain(">Sign in in the terminal</button>");
    expect(markup).toContain(">Try again</button>");
  });

  it("not signed in without a terminal sign-in: only trying again", () => {
    const markup = line({ kind: "notLoggedIn", text: "Not signed in." });
    expect(markup).not.toContain("data-autopilot-sign-in");
    expect(markup).toContain(">Try again</button>");
  });

  it("no provider: “Set up AI …” instead of trying again", () => {
    const markup = line({ kind: "setup", text: "No AI provider is set up." });
    expect(markup).toContain(">Set up AI …</button>");
    expect(markup).not.toContain(">Try again</button>");
  });

  it("monthly limit: try again and change the limit", () => {
    const markup = line({ kind: "limit", text: "The monthly limit is reached." });
    expect(markup).toContain(">Try again</button>");
    expect(markup).toContain(">Change limit</button>");
  });

  it("unusable answer: again and show what was sent", () => {
    const markup = line({ kind: "invalid", text: "Answer unusable" });
    expect(markup).toContain(">Again</button>");
    expect(markup).toContain(">Show what was sent</button>");
  });

  it("a cancelled request shows nothing", () => {
    expect(line({ kind: "cancelled" })).toBe("");
  });
});
