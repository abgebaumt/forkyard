/**
 * Commands for pull requests: create, open the one of the checked-out branch, pick one from the list,
 * refresh, open at the host in the browser. So that menus and commands know immediately whether
 * the repository is linked to an account, this module keeps the active repository's state
 * in the cache (the app's accounts, the repository's host).
 */
import { t } from "../../i18n";
import type { Tab } from "../../core";
import { openInBrowser, runHostAction } from "../actions/hosts";
import { hostApi, hostKindLabels, type HostAccountInfo, type PrDetails } from "../actions/hostTypes";
import { cachedHostRepo, cachedPrForBranch, hostLink, openPr, openPrCreate, refreshPullRequests } from "../actions/pullrequests";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { pickFromList } from "../dialogs";
import { qk, queryClient } from "../queries";
import { toast } from "../../ui/Feedback";

const KEYWORDS = () => kw("commands.pr.keywords");

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);
const currentBranch = (ctx: CommandContext) => (ctx.status?.head.kind === "branch" ? ctx.status.head.branch : null);

/** Why pull requests don't work in this repository – or null. Unknown (not loaded yet) counts as possible. */
function hostBlock(ctx: CommandContext): string | null {
  if (!ctx.repoId) return null;
  const link = hostLink(ctx.repoId);
  if (link.state === "not_connected" && !link.repo?.kind) return t("commands.pr.noHost");
  return null;
}
const connected = (ctx: CommandContext) => Boolean(ctx.repoId && hostLink(ctx.repoId).state === "connected");
const viewedPr = (ctx: CommandContext) => (ctx.repoId && ctx.view?.center.kind === "pr" ? ctx.queryClient.getQueryData<PrDetails>(qk.pr(ctx.repoId, ctx.view.center.number)) : undefined);

/** Loads the open pull requests and lets the user pick one. */
async function pickPullRequest(ctx: CommandContext) {
  const repoId = ctx.repoId!;
  const loaded = await runHostAction(t("commands.pr.pick.loadAction"), () => hostApi.prList(repoId, "open", 1));
  if (!loaded.ok) return;
  if (loaded.value.items.length === 0) {
    toast({ tone: "info", title: t("commands.pr.pick.noneTitle"), description: t("commands.pr.pick.noneText") });
    return;
  }
  const picked = await pickFromList({
    title: t("commands.pr.pick.dialogTitle"),
    description: loaded.value.nextPage ? t("commands.pr.pick.descriptionMore") : t("commands.pr.pick.description"),
    label: t("commands.pr.pick.label"),
    items: loaded.value.items.map((pr) => ({
      key: String(pr.number),
      label: `#${pr.number} ${pr.title}`,
      description: `${pr.author?.name ?? pr.author?.login ?? t("commands.pr.pick.unknownAuthor")} · ${pr.sourceBranch} → ${pr.targetBranch}${pr.isDraft ? ` · ${t("commands.pr.pick.draft")}` : ""}`,
    })),
    confirmLabel: t("commands.pr.pick.confirm"),
  });
  if (picked && ctx.tabId) openPr(ctx.tabId, Number(picked));
}

export const commands: AppCommand[] = [
  {
    id: "pr.create",
    title: t("commands.pr.create.title"),
    group: "Remote",
    keywords: [...KEYWORDS(), ...kw("commands.pr.create.keywords")],
    when: (ctx) => hasRepo(ctx) && !hostBlock(ctx),
    disabledReason: (ctx) => (hasRepo(ctx) ? hostBlock(ctx) : null),
    run: (ctx) => openPrCreate(ctx.repoId!, ctx.tabId!, { source: currentBranch(ctx) }),
  },
  {
    id: "pr.openCurrent",
    title: t("commands.pr.openCurrent.title"),
    group: "Remote",
    keywords: [...KEYWORDS(), ...kw("commands.pr.openCurrent.keywords")],
    when: (ctx) => hasRepo(ctx) && Boolean(currentBranch(ctx) && cachedPrForBranch(ctx.repoId!, currentBranch(ctx)!)),
    disabledReason: (ctx) => (!hasRepo(ctx) ? null : (hostBlock(ctx) ?? (connected(ctx) ? t("commands.pr.openCurrent.none") : t("commands.pr.noAccount")))),
    run: (ctx) => {
      const pr = cachedPrForBranch(ctx.repoId!, currentBranch(ctx)!);
      if (pr) openPr(ctx.tabId!, pr.number);
    },
  },
  {
    id: "pr.pick",
    title: t("commands.pr.pick.title"),
    group: "Remote",
    keywords: [...KEYWORDS(), ...kw("commands.pr.pick.keywords")],
    when: (ctx) => hasRepo(ctx) && connected(ctx),
    disabledReason: (ctx) => (!hasRepo(ctx) ? null : (hostBlock(ctx) ?? t("commands.pr.noAccount"))),
    run: pickPullRequest,
  },
  {
    id: "pr.refresh",
    title: t("commands.pr.refresh.title"),
    group: "Remote",
    keywords: [...KEYWORDS(), ...kw("commands.pr.refresh.keywords")],
    when: (ctx) => hasRepo(ctx) && connected(ctx),
    disabledReason: (ctx) => (!hasRepo(ctx) ? null : (hostBlock(ctx) ?? t("commands.pr.noAccount"))),
    run: (ctx) => {
      void ctx.queryClient.invalidateQueries({ queryKey: qk.hostRepo(ctx.repoId!) });
      refreshPullRequests(ctx.repoId!);
    },
  },
  {
    id: "pr.openInBrowser",
    title: t("commands.pr.openInBrowser.title"),
    group: "Remote",
    keywords: [...KEYWORDS(), ...kw("commands.pr.openInBrowser.keywords")],
    when: (ctx) => hasRepo(ctx) && Boolean(viewedPr(ctx)?.webUrl),
    disabledReason: (ctx) => (hasRepo(ctx) ? t("commands.pr.openInBrowser.none") : null),
    run: (ctx) => openInBrowser(viewedPr(ctx)?.webUrl, t("commands.pr.page")),
  },
  {
    id: "pr.repoInBrowser",
    title: t("commands.pr.repoInBrowser.title"),
    group: "Remote",
    keywords: kw("commands.pr.repoInBrowser.keywords"),
    when: (ctx) => hasRepo(ctx) && Boolean(cachedHostRepo(ctx.repoId!)?.webUrl),
    disabledReason: (ctx) => (hasRepo(ctx) ? (hostBlock(ctx) ?? t("commands.pr.repoInBrowser.unknownUrl")) : null),
    run: (ctx) => {
      const repo = cachedHostRepo(ctx.repoId!);
      return openInBrowser(repo?.webUrl, repo?.kind ? t("commands.pr.pageAt", { host: hostKindLabels[repo.kind] }) : t("commands.pr.page"));
    },
  },
];

// ---------------------------------------------------------------------------
// Keeping the state in the cache
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  /** Loads accounts and the active repository's host as soon as the tabs change – once per repository. */
  const prefetchActive = () => {
    const tab = queryClient.getQueryData<Tab[]>(qk.tabs)?.find((item) => item.isActive);
    if (!tab?.repoId) return;
    const repoId = tab.repoId;
    if (queryClient.getQueryState(qk.hostRepo(repoId))) return;
    void (async () => {
      // Accounts first: the repository's host may name its account only as an ID.
      if (!queryClient.getQueryState(qk.hostAccounts)) await queryClient.prefetchQuery({ queryKey: qk.hostAccounts, queryFn: () => hostApi.accounts() });
      await queryClient.prefetchQuery({
        queryKey: qk.hostRepo(repoId),
        queryFn: () => hostApi.repoInfo(repoId, queryClient.getQueryData<HostAccountInfo[]>(qk.hostAccounts) ?? []),
        staleTime: 2 * 60_000,
      });
    })();
  };
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === "app" && event.query.queryKey[1] === "tabs") prefetchActive();
  });
  prefetchActive();
}
