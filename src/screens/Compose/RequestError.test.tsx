import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../app/ai/open", () => ({ openAiSettings: vi.fn(), openAiSetup: vi.fn() }));
vi.mock("../../app/ai/cliLogin", () => ({ signInInTerminal: vi.fn() }));

import { RequestError } from "./RequestError";

const noop = () => {};

describe("Compose request error", () => {
  it("offers the sign-in in the terminal when a command-line tool is signed out", () => {
    const error = { kind: "notLoggedIn", text: "Claude Code is not signed in." } as const;
    const cli = renderToStaticMarkup(<RequestError error={error} provider="claude_code" onAgain={noop} onShowSent={noop} />);
    expect(cli).toContain('role="alert"');
    expect(cli).toContain("data-compose-sign-in");
    expect(cli).toContain("Sign in in the terminal");
    expect(cli).toContain("Claude Code is not signed in.");

    // An API provider has no terminal sign-in: only the text and "Again" stay.
    const api = renderToStaticMarkup(<RequestError error={error} provider="anthropic" onAgain={noop} onShowSent={noop} />);
    expect(api).not.toContain("data-compose-sign-in");
    expect(api).toContain("Again");
  });

  it("shows nothing for a cancelled request", () => {
    expect(renderToStaticMarkup(<RequestError error={{ kind: "cancelled" }} provider={null} onAgain={noop} onShowSent={noop} />)).toBe("");
  });
});
