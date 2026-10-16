/**
 * “Sign in in the terminal” (spec “Zustände”: `ai_not_logged_in`): opens a terminal tab in the active
 * repository tab that runs the tool's own sign-in in an empty folder of the app (`aiCliLogin`, never the
 * repository). A terminal belongs to a repository tab: without one, the caller shows the command as text.
 */
import { core, type AiProviderKind, type Tab } from "../../core";
import { t } from "../../i18n";
import { showTerminal } from "../../screens/Terminal/actions";
import { openProgramSession } from "../../screens/Terminal/sessions";
import { qk, queryClient } from "../queries";
import { useAppStore } from "../store";

export function signInInTerminal(provider: AiProviderKind): boolean {
  const tab = queryClient.getQueryData<Tab[]>(qk.tabs)?.find((entry) => entry.isActive && entry.repoId !== null);
  const repoId = tab?.repoId;
  if (!tab || !repoId) return false;
  // The settings overlay would cover the terminal.
  useAppStore.getState().closeOverlay();
  openProgramSession(tab.id, repoId, t(`ai.names.${provider}`), (size) => core.aiCliLogin({ repoId, provider, cols: size.cols, rows: size.rows }));
  showTerminal(tab.id);
  return true;
}
