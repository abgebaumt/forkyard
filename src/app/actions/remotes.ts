import { t } from "../../i18n";
import { core, type Id, type Remote } from "../../core";
import { confirm } from "../dialogs";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { useAppStore } from "../store";
import { cachedRefs, clip } from "./context";

/** Opens the remote dialog for editing name and URLs. */
export function editRemote(name: string): void {
  useAppStore.getState().openOverlay({ kind: "add_remote", edit: name });
}

/** Removes a remote after a prompt; says what disappears with it. */
export async function removeRemote(repoId: Id, remote: Pick<Remote, "name" | "fetchUrl">) {
  const refs = cachedRefs(repoId);
  const branches = refs?.remotes.filter((ref) => ref.remote === remote.name).length ?? 0;
  const following = refs?.locals.filter((ref) => ref.upstream?.startsWith(`${remote.name}/`)).map((ref) => ref.name) ?? [];
  const parts = [t("actions.remotes.remove.entry", { url: remote.fetchUrl })];
  if (branches) parts.push(t("actions.remotes.remove.branches", { count: branches }));
  const ok = await confirm({
    title: t("actions.remotes.remove.title", { name: clip(remote.name, 40) }),
    body: [
      `${parts.join("; ")}.`,
      t("actions.remotes.remove.serverUnchanged"),
      following.length ? t("actions.remotes.remove.losesUpstream", { count: following.length }) : null,
      t("actions.remotes.remove.undo"),
    ]
      .filter(Boolean)
      .join(" "),
    details: following.length > 1 ? following : undefined,
    detailsLabel: t("actions.remotes.remove.detailsLabel"),
    confirmLabel: t("actions.remotes.remove.action"),
    danger: true,
  });
  if (!ok) return null;
  const result = await runAction(t("actions.remotes.remove.action"), () => core.remoteRemove({ repoId, name: remote.name }), {
    busyKey: `${repoId}:remote`,
    success: t("actions.remotes.remove.done", { name: clip(remote.name) }),
  });
  if (result.ok) queryClient.setQueryData(qk.remotes(repoId), result.value);
  return result;
}
