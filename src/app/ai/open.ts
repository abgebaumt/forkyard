/** Opens Settings › AI (start-page entry, palette, notice;). */
import type { AiStatus } from "../../core";
import { useAppStore } from "../store";
import { aiVisibility } from "./visibility";

export function openAiSettings(): void {
  useAppStore.getState().openOverlay({ kind: "preferences", section: "ai" });
}

/**
 * The setup dialog: from Settings › AI (“Set up …”, the master switch without a provider)
 * and from AI elements while no provider is connected (`aiVisibility(status).elementsOpenSetup`).
 * “What is sent?” and the sign-in run after the dialog closed – dialogs are queued, and a view must not
 * take the focus under a dialog. Returns whether AI was turned on.
 */
export async function openAiSetup(): Promise<boolean> {
  const [{ showAiSetup }, { showWhatIsSent }, { signInInTerminal }] = await Promise.all([
    import("./SetupDialog"),
    import("./gate"),
    import("./cliLogin"),
  ]);
  const result = await showAiSetup();
  if (result?.kind === "whatIsSent") await showWhatIsSent(result.repoId, "commit_message");
  if (result?.kind === "signIn") signInInTerminal(result.provider);
  return result?.kind === "on" || result?.kind === "whatIsSent";
}

/**
 * Before an AI element sends: with AI on but no provider connected the click opens the setup
 * instead. Returns whether the caller may go on.
 */
export function checkProvider(status: AiStatus | null | undefined): boolean {
  if (!aiVisibility(status).elementsOpenSetup) return true;
  void openAiSetup();
  return false;
}
