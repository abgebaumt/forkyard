/**
 * Before merge, rebase, cherry-pick or revert from menus, palette and drag and drop: what the
 * conflict preview found, and for a rebase the branches that can move along. Only shown when there
 * is something to say; the action stays possible either way.
 */
import { useState } from "react";
import { showDialog } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { Checkbox } from "../../ui/Field";
import { t } from "../../i18n";
import { conflictFiles, type PreflightFacts } from "./model";

export interface PreflightChoice {
  updateRefs: boolean;
}

function PreflightDialog({ title, confirmLabel, facts, onDone }: { title: string; confirmLabel: string; facts: PreflightFacts; onDone: (value: PreflightChoice | null) => void }) {
  const [updateRefs, setUpdateRefs] = useState(false);
  const files = conflictFiles(facts.preview);
  const atCommit = facts.preview?.status === "conflicts" ? facts.preview.atCommit : null;
  return (
    <Dialog
      open
      size="sm"
      title={title}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("app.common.cancel")}</Button>
          <Button variant="primary" data-action="preflight-run" onClick={() => onDone({ updateRefs })}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-screen="preflight">
        {files.length > 0 ? (
          <>
            <div className="shrink-0 overflow-hidden rounded-md">
              <Banner tone="warning" title={t("preflight.conflictsTitle", { count: files.length })}>
                {atCommit ? t("preflight.conflictsFromBody", { sha: shortSha(atCommit) }) : t("preflight.conflictsBody")}
              </Banner>
            </div>
            <ul aria-label={t("preflight.filesLabel")} className="m-0 flex max-h-36 list-none flex-col overflow-auto rounded-md border border-border bg-surface-sunken p-2 font-mono text-code text-text">
              {files.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {facts.dependents.length > 0 ? (
          <Checkbox
            label={t("preflight.updateRefs")}
            checked={updateRefs}
            onCheckedChange={setUpdateRefs}
            hint={t("preflight.updateRefsHint", { branches: facts.dependents.join(", ") })}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

export function openPreflightDialog(options: { title: string; confirmLabel: string; facts: PreflightFacts }): Promise<PreflightChoice | null> {
  return showDialog<PreflightChoice>((done) => <PreflightDialog title={options.title} confirmLabel={options.confirmLabel} facts={options.facts} onDone={done} />);
}
