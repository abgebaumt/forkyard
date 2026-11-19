import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./open", () => ({ openAiSettings: vi.fn(), openAiSetup: vi.fn() }));
vi.mock("./cliLogin", () => ({ signInInTerminal: vi.fn() }));

import { AiErrorNotice } from "./AiErrorNotice";

const none = () => undefined;

describe("the inline error of an AI element", () => {
  it("offers the sign-in in the terminal when a command-line tool is signed out", () => {
    const text = "Claude Code is not signed in. Sign in in the terminal: claude auth login";
    const view = { kind: "notLoggedIn", text } as const;
    const cli = renderToStaticMarkup(
      <AiErrorNotice name="pr-ai-error" view={view} provider="claude_code" onAgain={none} onShowSent={none} />,
    );
    expect(cli).toContain('role="alert"');
    expect(cli).toContain('data-pr-ai-error="notLoggedIn"');
    expect(cli).toContain(text);
    expect(cli).toContain("data-ai-sign-in");
    expect(cli).toContain("Sign in in the terminal</button>");
    expect(cli).toContain("Again</button>");
    // An API provider has no terminal sign-in: the text and "Again" stay.
    const api = renderToStaticMarkup(
      <AiErrorNotice name="pr-ai-error" view={view} provider="anthropic" onAgain={none} onShowSent={none} />,
    );
    expect(api).not.toContain("data-ai-sign-in");
    expect(api).toContain("Again</button>");
  });

  it("offers “Show what was sent” for an unusable or too large answer, never a per-file “Leave out”", () => {
    const markup = renderToStaticMarkup(
      <AiErrorNotice
        name="pr-ai-error"
        view={{ kind: "tooLarge", text: "Too large." }}
        provider="ollama"
        onAgain={none}
        onShowSent={none}
      />,
    );
    expect(markup).toContain("Show what was sent</button>");
    expect(markup).not.toContain("Leave out");
  });
});
