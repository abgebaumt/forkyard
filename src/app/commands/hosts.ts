/**
 * Commands for the host accounts (GitHub, GitLab): open integrations, connect an account, check accounts.
 */
import { t } from "../../i18n";
import { cachedHostAccounts, checkAccount, openIntegrations } from "../actions/hosts";
import { hostApi } from "../actions/hostTypes";
import { kw, type AppCommand } from "../commandTypes";
import { qk } from "../queries";
import { runAction } from "../run";
import { toast } from "../../ui/Feedback";
import { openConnectDialog } from "../../screens/Hosts";

// Deliberately without "Pull Request": whoever types "pull" in the palette means the pull – the commands around
// pull requests have their own entries (commands/pullrequests.ts).
const KEYWORDS = () => kw("commands.hosts.keywords");

export const commands: AppCommand[] = [
  {
    id: "hosts.open",
    title: t("commands.hosts.open.title"),
    group: "Allgemein",
    keywords: [...KEYWORDS(), ...kw("commands.hosts.open.keywords")],
    run: () => openIntegrations(),
  },
  {
    id: "hosts.connect",
    title: t("commands.hosts.connect.title"),
    group: "Allgemein",
    keywords: [...KEYWORDS(), ...kw("commands.hosts.connect.keywords")],
    run: () => openConnectDialog(),
  },
  {
    id: "hosts.check",
    title: t("commands.hosts.check.title"),
    group: "Allgemein",
    keywords: [...KEYWORDS(), ...kw("commands.hosts.check.keywords")],
    when: () => (cachedHostAccounts()?.length ?? 1) > 0,
    disabledReason: () => t("commands.hosts.check.noAccount"),
    run: async (ctx) => {
      const loaded = await runAction(t("commands.hosts.check.loadAction"), () => hostApi.accounts());
      if (!loaded.ok) return;
      ctx.queryClient.setQueryData(qk.hostAccounts, loaded.value);
      if (loaded.value.length === 0) {
        toast({ tone: "info", title: t("commands.hosts.check.noneTitle"), description: t("commands.hosts.check.noneText") });
        return;
      }
      for (const account of loaded.value) await checkAccount(account);
    },
  },
];
