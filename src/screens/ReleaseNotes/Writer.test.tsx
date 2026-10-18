import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("../../app/ai/gate", () => ({ confirmSend: vi.fn() }));
vi.mock("../../app/ai/PreviewDialog", () => ({ showAiPreview: vi.fn(), AiPreviewDialog: () => null }));

import { TooltipProvider } from "../../ui/Tooltip";
import type { Writer, WriterState } from "./useWriter";
import { ReleaseNotesWriter } from "./Writer";

const none = () => undefined;
const IDLE: WriterState = { phase: "idle", startedAt: 0, now: 0, notes: null, error: null, draft: null, pending: null, emptyText: null };
const writerWith = (state: Partial<WriterState>): Writer => ({
  state: { ...IDLE, ...state },
  preview: null,
  write: () => Promise.resolve(),
  whatIsSent: () => Promise.resolve(),
  closePreview: none,
  cancel: none,
  resolvePending: none,
  discardDraft: none,
  edited: none,
});
const html = (node: ReactNode) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const notLoggedIn = writerWith({ phase: "error", error: { kind: "notLoggedIn", text: "Claude Code is not signed in." } });

describe("release notes writer: not signed in (spec “Zustände jedes KI-Elements”)", () => {
  it("offers “Sign in in the terminal” when the surrounding dialog can hand over to the terminal", () => {
    const markup = html(<ReleaseNotesWriter repoId="r" to={null} writer={notLoggedIn} openSetup={false} local={false} onSetup={none} onSignIn={none} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Claude Code is not signed in.");
    expect(markup).toContain('data-release-notes-sign-in=""');
    expect(markup).toContain(">Sign in in the terminal</button>");
    expect(markup).toContain(">Again</button>");
  });

  it("shows no sign-in button for providers without a terminal sign-in", () => {
    const markup = html(<ReleaseNotesWriter repoId="r" to={null} writer={notLoggedIn} openSetup={false} local={false} onSetup={none} />);
    expect(markup).not.toContain("data-release-notes-sign-in");
    expect(markup).toContain(">Again</button>");
  });
});
