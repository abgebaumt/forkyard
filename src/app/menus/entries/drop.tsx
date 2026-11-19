/** Menu after dropping a branch onto another one. */
import { ArrowUpFromLine, GitMerge, GitPullRequestArrow, ListOrdered, Milestone } from "lucide-react";
import type { Ref } from "../../../core";
import type { MenuEntry } from "../../../ui/Menu";
import { graphIndex, isAncestor } from "../../actions/ancestry";
import { clipMiddle } from "../../actions/context";
import { interactiveRebaseOnto, mergeInto, pushTo, rebaseBranchOnto } from "../../actions/drop";
import { hostLink, openPrCreate } from "../../actions/pullrequests";
import { t } from "../../../i18n";
import { type MenuBase, SEPARATOR, item, q, tidy, operationBlock } from "./shared";

export function dropMenu(ctx: MenuBase & { source: Ref; target: Ref }): MenuEntry[] {
  const { repoId, tabId, source, target } = ctx;
  const busy = operationBlock(repoId);
  const s = q(source.name, 26);
  const d = q(target.name, 26);
  const fullS = t("menus.quoted", { name: source.name });
  const fullT = t("menus.quoted", { name: target.name });
  const same = source.fullName === target.fullName ? t("menus.drop.sameBranch") : source.sha === target.sha ? t("menus.sameCommit") : null;
  const index = graphIndex(repoId);
  const merged = index ? isAncestor(index, source.sha, target.sha) : null;
  const ahead = index ? isAncestor(index, target.sha, source.sha) : null;
  const sourceLocal = source.kind === "local" ? null : t("menus.drop.onlyLocalRebase");
  const targetLocal =
    target.kind === "local" ? null : target.kind === "remote" ? t("menus.drop.targetMustBeLocal") : t("menus.drop.noMergeIntoTag");

  const entries: MenuEntry[] = [
    item(t("menus.mergeInto", { source: s, target: d }), GitMerge, () => void mergeInto(repoId, source, target, tabId), {
      tooltip: t("menus.mergeInto", { source: fullS, target: fullT }),
      hint:
        busy || same || targetLocal || merged
          ? undefined
          : target.isHead
            ? ahead
              ? t("menus.viaFastForward")
              : undefined
            : t("menus.drop.checksOutFirst", { name: clipMiddle(target.name, 20) }),
      blocked: busy ?? targetLocal ?? same ?? (merged ? t("menus.alreadyIn", { name: d }) : null),
    }),
    item(t("menus.rebaseTip", { name: s, target: d }), Milestone, () => void rebaseBranchOnto(repoId, source, target, tabId), {
      tooltip: t("menus.rebaseTip", { name: fullS, target: fullT }),
      hint:
        busy || same || sourceLocal || ahead || source.isHead
          ? undefined
          : t("menus.drop.checksOutFirst", { name: clipMiddle(source.name, 20) }),
      blocked: busy ?? sourceLocal ?? same ?? (ahead ? t("menus.drop.basedOn", { source: s, target: d }) : null),
    }),
    item(t("menus.interactiveOnto", { name: s, target: d }), ListOrdered, () => void interactiveRebaseOnto(repoId, source, target, tabId), {
      tooltip: t("menus.interactiveOntoTip", { name: fullS, target: fullT }),
      blocked: busy ?? sourceLocal ?? same ?? (merged ? t("menus.noOwnCommits", { name: s }) : null),
    }),
  ];
  if (target.kind === "remote") {
    entries.push(
      SEPARATOR,
      item(t("menus.drop.pushTo", { source: s, target: d }), ArrowUpFromLine, () => void pushTo(repoId, source, target, tabId), {
        tooltip: t("menus.drop.pushTo", { source: fullS, target: fullT }),
        hint: source.kind !== "local" || merged || source.upstream === target.name ? undefined : t("menus.drop.becomesUpstream"),
        blocked: source.kind !== "local" ? t("menus.drop.onlyLocalPush") : merged ? t("menus.nothingToPush") : null,
      }),
    );
  }
  // A pull request is created at the host (GitHub, GitLab). The entry is enabled as soon as an account
  // is connected for this repository's host (Preferences › Integrations); otherwise it is disabled and
  // says what is missing.
  const link = hostLink(repoId);
  const targetBranch =
    target.kind === "remote" && target.remote && target.name.startsWith(`${target.remote}/`)
      ? target.name.slice(target.remote.length + 1)
      : target.name;
  const prBlock =
    link.state !== "connected"
      ? t("menus.drop.needsHost")
      : source.kind !== "local"
        ? t("menus.drop.sourceMustBeLocal")
        : target.kind === "tag"
          ? t("menus.drop.targetMustBeBranch")
          : same;
  entries.push(
    SEPARATOR,
    // Short label so the reason fits next to it; both names are spelled out in the tooltip.
    item(t("menus.pr.create"), GitPullRequestArrow, () => openPrCreate(repoId, tabId, { source: source.name, target: targetBranch }), {
      tooltip:
        link.state === "connected"
          ? t("menus.drop.prTip", { source: fullS, target: t("menus.quoted", { name: targetBranch }) })
          : t("menus.drop.prTipNoAccount", { source: fullS, target: fullT }),
      blocked: prBlock,
    }),
  );
  return tidy(entries);
}
