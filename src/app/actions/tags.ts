import { t } from "../../i18n";
import { core, type Id, type Remote, type Sha } from "../../core";
import { toast } from "../../ui/Feedback";
import { askTag } from "../actionDialogs";
import { choose, confirm } from "../dialogs";
import { desktopNotify } from "../notify";
import { qk, queryClient } from "../queries";
import { newJobId, runAction } from "../run";
import { guardSecrets } from "./pushCheck";
import { refNameValidator } from "./branches";
import { cachedSettings, clip, loadRemotes, short } from "./context";
import { addRemote } from "./sync";

/**
 * Creates a tag. A dialog asks for the name and – optionally – the annotation: with text an
 * annotated tag is created, without one a lightweight tag. `sha: null` = HEAD; `annotated` requires the text.
 */
export async function createTag(repoId: Id, sha: Sha | null, annotated = false) {
  const input = await askTag({
    target: sha ? short(sha) : t("actions.tags.currentCommit"),
    annotated,
    validate: refNameValidator(repoId, "tag"),
  });
  if (!input) return null;
  const result = await runAction(t("actions.tags.create.label"), () => core.tagCreate({ repoId, name: input.name, sha, message: input.message }), {
    success: input.message ? t("actions.tags.create.doneAnnotated", { name: clip(input.name) }) : t("actions.tags.create.done", { name: clip(input.name) }),
  });
  if (result.ok) queryClient.setQueryData(qk.refs(repoId), result.value);
  return result;
}

/** Remote for a tag action: the only one, otherwise let the user pick. null = cancelled or none there. */
async function pickRemote(repoId: Id, title: string, description: string): Promise<string | null> {
  const remotes = await loadRemotes(repoId).catch(() => [] as Remote[]);
  if (remotes.length === 0) {
    toast({
      tone: "warning",
      sticky: true,
      title: t("actions.tags.noRemote"),
      description: t("actions.sync.noRemote.description"),
      action: { label: t("actions.sync.noRemote.action"), onClick: addRemote },
    });
    return null;
  }
  if (remotes.length === 1) return remotes[0]!.name;
  return choose({ title, description, options: remotes.map((remote) => ({ key: remote.name, label: remote.name, description: remote.pushUrl ?? remote.fetchUrl })) });
}

/**
 * Deletes a tag after a prompt. `remote: true` also deletes it on the remote (with several
 * it asks which one); a name deletes on exactly that one; null only locally.
 */
/**
 * What happens to the commits: they only remain as long as a branch or another tag still leads
 * to them. If only this tag holds them (and, for an annotated tag, its note), Git will
 * clean them up eventually – the prompt must not keep quiet about that.
 */
const TAG_COMMITS_NOTE = t("actions.tags.delete.commitsNote");

export async function deleteTag(repoId: Id, name: string, remote: string | true | null = null) {
  const target = remote === true ? await pickRemote(repoId, t("actions.tags.delete.pickRemote"), t("actions.tags.delete.pickRemoteDescription", { name: clip(name, 40) })) : remote;
  if (remote === true && !target) return null;
  const ok = await confirm({
    title: target ? t("actions.tags.delete.titleRemote", { name: clip(name, 40), remote: target }) : t("actions.tags.delete.title", { name: clip(name, 40) }),
    body: `${target ? t("actions.tags.delete.bodyRemote") : t("actions.tags.delete.body")} ${TAG_COMMITS_NOTE}`,
    confirmLabel: target ? t("actions.tags.delete.actionRemote") : t("actions.tags.delete.action"),
    danger: true,
  });
  if (!ok) return null;
  const result = await runAction(t("actions.tags.delete.action"), () => core.tagDelete({ repoId, name, remote: target }), {
    busyKey: `${repoId}:tag:${name}`,
    success: target ? t("actions.tags.delete.doneRemote", { name: clip(name), remote: target }) : t("actions.tags.delete.done", { name: clip(name) }),
  });
  if (result.ok) queryClient.setQueryData(qk.refs(repoId), result.value);
  return result;
}

/** Pushes a tag. Without `remote` it takes the only remote or lets the user pick. */
export async function pushTag(repoId: Id, name: string, remote?: string | null) {
  const target = remote ?? (await pickRemote(repoId, t("actions.tags.push.pickRemote"), t("actions.tags.push.pickRemoteDescription", { name: clip(name, 40) })));
  if (!target) return null;
  const result = await guardSecrets(repoId, (acceptedSecrets) => {
    const jobId = newJobId();
    return runAction(t("actions.tags.push.label"), () => core.tagPush({ repoId, jobId, name, remote: target, acceptedSecrets }), {
      busyKey: `${repoId}:tag:${name}`,
      job: { id: jobId, title: t("actions.tags.push.job", { name: clip(name, 32) }), repoId },
    });
  });
  void queryClient.invalidateQueries({ queryKey: qk.credentials });
  if (!result.ok) return result;
  if (result.value.status === "secrets_found") return result;
  if (result.value.status === "rejected") {
    toast({ tone: "danger", title: t("actions.tags.push.rejected", { name: clip(name) }), description: result.value.reason });
    desktopNotify(cachedSettings()?.notifyOnError, t("actions.tags.push.rejectedShort"), result.value.reason);
  } else if (result.value.status === "up_to_date") {
    toast({ tone: "info", title: t("actions.tags.push.upToDate", { name: clip(name), remote: target }) });
  } else {
    toast({ tone: "success", title: t("actions.tags.push.done", { name: clip(name), remote: target }) });
  }
  return result;
}
