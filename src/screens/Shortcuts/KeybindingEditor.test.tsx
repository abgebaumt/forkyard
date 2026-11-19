import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Settings } from "../../core";
import { qk } from "../../app/queries";
import { KeybindingEditor } from "./KeybindingEditor";

function render(settings?: Partial<Settings>): string {
  const client = new QueryClient();
  if (settings) client.setQueryData(qk.settings, settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <KeybindingEditor filter="" />
    </QueryClientProvider>,
  );
}

describe("keybinding editor", () => {
  it("offers no edits before the settings are loaded – a write would replace every override", () => {
    expect(render()).toBe("");
  });

  it("shows the rows and the overridden command's reset once loaded", () => {
    const html = render({ keybindings: { "tab.new": ["Mod+Alt+T"] } });
    expect(html).toContain('data-keybinding="tab.new"');
    expect(html).toContain('data-keybinding-reset="tab.new"');
    expect(html).toContain("data-keys-reset-all");
  });
});
