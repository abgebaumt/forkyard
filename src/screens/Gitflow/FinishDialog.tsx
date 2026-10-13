/**
 * "Finish feature / release / hotfix": says what will happen (merge, tag, merge back, delete
 * branch), lets the user pick the options and stays locked, with a reason, while the working
 * directory is not clean.
 */
import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Trans } from "react-i18next";
import type { GitflowKind, Id } from "../../core";
import { finishGitflow, gitflowBusyKey, kindLabels } from "../../app/actions/gitflow";
import { operationNames } from "../../app/actions/merge";
import { useRemotes, useStatus } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { Checkbox, TextArea, TextField } from "../../ui/Field";
import { refNameSyntaxError } from "../../app/actionDialogs";
import { useGitflow } from "./GitflowDialog";
import { t } from "../../i18n";

export interface FinishTarget {
  kind: GitflowKind;
  name: string;
  branch: string;
}

export function FinishDialog({ repoId, tabId, target, onClose }: { repoId: Id; tabId: Id | null; target: FinishTarget; onClose: () => void }) {
  const { data: gitflow } = useGitflow(repoId);
  const { data: status } = useStatus(repoId);
  const { data: remotes } = useRemotes(repoId);
  const busy = useBusy(gitflowBusyKey(repoId));
  const tagged = target.kind !== "feature";
  const defaultTag = `${gitflow?.prefixes.versionTag ?? ""}${target.name}`;

  const [deleteBranch, setDeleteBranch] = useState(true);
  const [withTag, setWithTag] = useState(true);
  const [tag, setTag] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [push, setPush] = useState(false);

  const tagName = (tag ?? defaultTag).trim();
  const tagMessage = message ?? `${kindLabels[target.kind]} ${target.name}`;
  const main = gitflow?.main ?? "main";
  const develop = gitflow?.develop ?? "develop";
  const changes = (status?.unstaged.length ?? 0) + (status?.staged.length ?? 0);
  const conflicts = status?.conflicted.length ?? 0;
  const noRemote = remotes !== undefined && remotes.length === 0;
  const tagError = tagged && withTag ? (!tagName ? t("gitflow.finish.tagMissing") : refNameSyntaxError(tagName)) : null;

  const blocked = conflicts
    ? t("gitflow.finish.conflicts")
    : status?.operation
      ? t("gitflow.finish.operation", { operation: operationNames[status.operation.kind] })
      : changes
        ? t("gitflow.finish.changes", { count: changes })
        : tagError;

  const submit = async () => {
    if (blocked || busy) return;
    const result = await finishGitflow(repoId, tabId, target.kind, target.name, {
      deleteBranch,
      push: push && !noRemote,
      ...(tagged ? { noTag: !withTag, tag: withTag && tagName !== defaultTag ? tagName : null, message: withTag ? tagMessage.trim() || null : null } : {}),
    });
    // On an error the dialog stays open (the message names the reason); otherwise it is done.
    if (result.ok) onClose();
  };

  return (
    <Dialog
      open
      size="md"
      title={t("gitflow.finish.title", { kind: kindLabels[target.kind], name: target.name })}
      description={
        <Trans
          i18nKey={tagged ? "gitflow.finish.taggedDescription" : "gitflow.finish.featureDescription"}
          values={{ branch: target.branch, main, develop }}
          components={{ branch: <span className="font-mono text-code text-text" />, main: <span className="font-mono text-code text-text" />, develop: <span className="font-mono text-code text-text" /> }}
        />
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button data-autofocus onClick={onClose}>
            {t("gitflow.finish.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<GitMerge className="size-icon" aria-hidden />}
            data-action="gitflow-finish"
            aria-disabled={blocked ? true : undefined}
            title={blocked ?? undefined}
            className="aria-disabled:cursor-default aria-disabled:bg-surface-raised aria-disabled:text-text-disabled aria-disabled:hover:brightness-100"
            onClick={() => void submit()}
          >
            {t("gitflow.finish.submit", { kind: kindLabels[target.kind] })}
          </Button>
        </>
      }
    >
      <form
        data-screen="gitflow-finish"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {blocked && !tagError ? (
          <div className="overflow-hidden rounded-md" data-gitflow-blocked>
            <Banner tone="warning" title={t("gitflow.finish.blocked")}>
              {blocked}
            </Banner>
          </div>
        ) : null}
        <Checkbox label={t("gitflow.finish.deleteBranch")} hint={t("gitflow.finish.deleteBranchHint", { branch: target.branch })} checked={deleteBranch} onCheckedChange={setDeleteBranch} />
        {tagged ? (
          <>
            <Checkbox label={t("gitflow.finish.tag")} hint={t("gitflow.finish.tagHint", { main })} checked={withTag} onCheckedChange={setWithTag} />
            {withTag ? (
              <div className="flex flex-col gap-3 pl-6">
                <TextField label={t("gitflow.finish.tagName")} mono value={tag ?? defaultTag} error={tagError ?? undefined} autoComplete="off" onChange={(event) => setTag(event.target.value.replace(/\s/g, "-"))} />
                <TextArea label={t("gitflow.finish.tagMessage")} rows={2} value={tagMessage} spellCheck={false} className="resize-none!" onChange={(event) => setMessage(event.target.value)} />
              </div>
            ) : null}
          </>
        ) : null}
        <Checkbox
          label={t("gitflow.finish.push")}
          hint={noRemote ? t("gitflow.finish.noRemote") : tagged ? t("gitflow.finish.pushTagged", { main, develop }) : t("gitflow.finish.pushFeature", { develop })}
          checked={push && !noRemote}
          disabled={noRemote}
          onCheckedChange={setPush}
        />
        <p className="text-sm text-text-muted">{t("gitflow.finish.undoNote")}</p>
      </form>
    </Dialog>
  );
}
