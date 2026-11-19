import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Settings } from "../../core";
import { qk } from "../../app/queries";
import { t } from "../../i18n";
import { KeybindingEditor } from "./KeybindingEditor";

function render(settings?: Partial<Settings>, client = new QueryClient()): string {
  if (settings) client.setQueryData(qk.settings, settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <KeybindingEditor filter="" />
    </QueryClientProvider>,
  );
}

describe("keybinding editor", () => {
  it("offers no edits before the settings are loaded – a write would replace every override", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).not.toContain("data-keybinding");
  });

  it("reports a failed settings load with a retry instead of an empty list", async () => {
    // Without retryOnMount the cached error is what the view sees (else it shows "loading" again while retrying).
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    await client.prefetchQuery({ queryKey: qk.settings, queryFn: () => Promise.reject(new Error("db locked")), retry: false });
    const html = render(undefined, client);
    expect(html).toContain(t("preferences.loadError.settings"));
    expect(html).not.toContain("data-keybinding");
  });

  it("shows the rows and the overridden command's reset once loaded", () => {
    const html = render({ keybindings: { "tab.new": ["Mod+Alt+T"] } });
    expect(html).toContain('data-keybinding="tab.new"');
    expect(html).toContain('data-keybinding-reset="tab.new"');
    expect(html).toContain("data-keys-reset-all");
  });
});
