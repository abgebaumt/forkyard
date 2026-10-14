/**
 * "Merge pull request" dialog: choose the method, delete or keep the branch afterwards. The merge
 * happens at the host; locally nothing changes until the next fetch – the dialog says so. Only the
 * methods the host accepts are offered (`HostCapabilities`).
 */
import { useState } from "react";
import { GitMerge } from "lucide-react";
import type { Id } from "../../core";
import type { HostCapabilities, MergeMethod, PrDetails } from "../../app/actions/hostTypes";
import { mergeMethodHints, mergeMethodLabels, mergePr, prBusyKeys } from "../../app/actions/pullrequests";
import { showDialog } from "../../app/dialogs";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Checkbox } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { t } from "../../i18n";

const METHOD_KEY = "gc.prMergeMethod";

/** The last chosen method – if the host knows it; otherwise a merge commit (every host has it). */
function rememberedMethod(allowed: MergeMethod[]): MergeMethod {
  try {
    const stored = localStorage.getItem(METHOD_KEY) as MergeMethod | null;
    if (stored && allowed.includes(stored)) return stored;
  } catch {
    // no localStorage: default
  }
  return allowed.includes("merge") ? "merge" : (allowed[0] ?? "merge");
}

function MergeDialog({ repoId, pr, methods, canDeleteBranch, onDone }: { repoId: Id; pr: PrDetails; methods: MergeMethod[]; canDeleteBranch: boolean; onDone: (merged: boolean | null) => void }) {
  const [method, setMethod] = useState<MergeMethod>(() => rememberedMethod(methods));
  const [deleteBranch, setDeleteBranch] = useState(false);
  const busy = useBusy(prBusyKeys.write(repoId, pr.number));

  const submit = async () => {
    if (busy) return;
    try {
      localStorage.setItem(METHOD_KEY, method);
    } catch {
      // then applies only this once
    }
    const merged = await mergePr(repoId, pr, method, canDeleteBranch && deleteBranch);
    // After an error the dialog stays open: the message names the reason, the choice stays.
    if (merged) onDone(true);
  };

  return (
    <Dialog
      open
      size="sm"
      title={t("pullRequest.view.merge.title", { number: pr.number })}
      description={<>{t("pullRequest.view.merge.description", { source: pr.sourceBranch, target: pr.targetBranch })}</>}
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      footer={
        <>
          <Button data-autofocus disabled={busy} onClick={() => onDone(null)}>
            {t("pullRequest.view.merge.cancel")}
          </Button>
          <Button variant="primary" loading={busy} icon={<GitMerge className="size-icon" aria-hidden />} onClick={() => void submit()}>
            {t("pullRequest.view.merge.submit")}
          </Button>
        </>
      }
    >
      <div data-screen="pr-merge" className="flex flex-col gap-3">
        <Select label={t("pullRequest.view.merge.method")} value={method} options={methods.map((value) => ({ value, label: mergeMethodLabels[value] }))} hint={mergeMethodHints[method]} onValueChange={setMethod} />
        {canDeleteBranch ? (
          <Checkbox
            label={t("pullRequest.view.merge.deleteBranch", { branch: pr.sourceBranch })}
            hint={t("pullRequest.view.merge.deleteBranchHint")}
            checked={deleteBranch}
            onCheckedChange={setDeleteBranch}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** Opens the dialog; true if merged. */
export async function openMergeDialog(repoId: Id, pr: PrDetails, capabilities: Pick<HostCapabilities, "mergeMethods" | "deleteSourceBranch">): Promise<boolean> {
  return (await showDialog<boolean>((done) => <MergeDialog repoId={repoId} pr={pr} methods={capabilities.mergeMethods} canDeleteBranch={capabilities.deleteSourceBranch} onDone={done} />)) === true;
}
