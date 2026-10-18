/**
 * Applies the chosen targets of release notes in a fixed order – CHANGELOG.md, host release,
 * clipboard – and stops at the first one that fails or is declined. The host release leaves this
 * computer: it is confirmed on its own, pushes the tag to the host's remote first (so the release
 * belongs to the same annotated tag) and cannot be undone.
 */
import { core, type Id } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { copyText } from "../../app/actions/clipboard";
import { hostApi, hostKindLabels, type HostAccountInfo } from "../../app/actions/hostTypes";
import { openInBrowser, runHostAction } from "../../app/actions/hosts";
import { pushTag } from "../../app/actions/tags";
import { confirm } from "../../app/dialogs";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { localDate, TARGET_ORDER, type ReleaseTarget } from "./model";

export interface ApplyInput {
  repoId: Id;
  /** The tag the notes belong to; null for a commit (then only the clipboard works). */
  tag: string | null;
  notes: string;
  targets: ReleaseTarget[];
}

export async function applyReleaseTargets(input: ApplyInput): Promise<ReleaseTarget[]> {
  const done: ReleaseTarget[] = [];
  for (const target of TARGET_ORDER) {
    if (!input.targets.includes(target)) continue;
    if (!(await applyOne(target, input))) break;
    done.push(target);
  }
  return done;
}

async function applyOne(target: ReleaseTarget, { repoId, tag, notes }: ApplyInput): Promise<boolean> {
  if (target === "clipboard") return copyText(notes, t("actions.tags.releaseNotes.done.clipboard"));
  if (!tag) return false;
  if (target === "changelog") {
    const result = await runAction(t("actions.tags.releaseNotes.changelogLabel"), () => core.changelogInsert({ repoId, version: tag, date: localDate(new Date()), notes }));
    if (result.ok) {
      const { path, created } = result.value;
      toast({ tone: "success", title: created ? t("actions.tags.releaseNotes.done.changelogCreated", { path }) : t("actions.tags.releaseNotes.done.changelog", { path }) });
    }
    return result.ok;
  }
  const host = await queryClient.fetchQuery({
    queryKey: qk.hostRepo(repoId),
    queryFn: () => hostApi.repoInfo(repoId, queryClient.getQueryData<HostAccountInfo[]>(qk.hostAccounts) ?? []),
    staleTime: 60_000,
  });
  if (!host?.kind || !host.remote || !host.account || !host.capabilities.releases) return false;
  const hostName = hostKindLabels[host.kind];
  const remote = host.remote;
  const ok = await confirm({
    title: t("actions.tags.releaseNotes.confirmRelease.title", { host: hostName }),
    body: t("actions.tags.releaseNotes.confirmRelease.body", { tag, remote }),
    confirmLabel: t("actions.tags.releaseNotes.confirmRelease.action"),
    danger: true,
  });
  if (!ok) return false;
  const pushed = await pushTag(repoId, tag, remote);
  if (!pushed?.ok || pushed.value.status === "rejected") return false;
  const created = await runHostAction(t("actions.tags.releaseNotes.releaseLabel"), () => core.releaseCreate({ repoId, tag, name: tag, body: notes, prerelease: false, remote }));
  if (created.ok) {
    const url = created.value.webUrl;
    toast({
      tone: "success",
      title: t("actions.tags.releaseNotes.done.release", { tag, host: hostName }),
      action: url ? { label: t("actions.tags.releaseNotes.done.openRelease"), onClick: () => void openInBrowser(url) } : undefined,
    });
  }
  return created.ok;
}
