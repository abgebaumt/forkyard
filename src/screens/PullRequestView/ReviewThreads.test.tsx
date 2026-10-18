import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../app/ai/gate", () => ({ confirmSend: vi.fn() }));
vi.mock("../../app/ai/open", () => ({ openAiSettings: vi.fn() }));
vi.mock("../../app/ai/PreviewDialog", () => ({ showAiPreview: vi.fn() }));
vi.mock("../../app/ai/cliLogin", () => ({ signInInTerminal: vi.fn() }));

import { FailedNote } from "./ReviewThreads";

const none = () => undefined;

describe("errors of “Suggest fix” (spec “Zustände jedes KI-Elements”)", () => {
  it("offers the sign-in in the terminal when a command-line tool is signed out", () => {
    const text = "Codex is not signed in. Sign in in the terminal: codex login";
    const view = { kind: "notLoggedIn", text } as const;
    const cli = renderToStaticMarkup(<FailedNote view={view} provider="codex" onAgain={none} onLook={none} />);
    expect(cli).toContain('role="alert"');
    expect(cli).toContain('data-review-error="notLoggedIn"');
    expect(cli).toContain(text);
    expect(cli).toContain("data-review-sign-in");
    expect(cli).toContain("Sign in in the terminal</button>");
    expect(cli).toContain("Again</button>");
    // An API provider has no terminal sign-in: the text and "Again" stay.
    const api = renderToStaticMarkup(<FailedNote view={view} provider="openai" onAgain={none} onLook={none} />);
    expect(api).not.toContain("data-review-sign-in");
    expect(api).toContain("Again</button>");
  });

  it("offers “Send this time” next to “Change limit” over the limit", () => {
    const markup = renderToStaticMarkup(<FailedNote view={{ kind: "limit", text: "The daily limit of 20 requests is reached." }} provider="ollama" onAgain={none} onLook={none} />);
    expect(markup).toContain('data-review-error="limit"');
    expect(markup).toContain("Send this time</button>");
    expect(markup).toContain("Change limit</button>");
    expect(markup).not.toContain("Open settings");
  });
});
