/**
 * Before merge, rebase, cherry-pick or revert from menus, palette and drag and drop: what the
 * conflict preview found, and for a rebase the branches that can move along. Only shown when there
 * is something to say; the action stays possible either way. Opened while the check still runs, it
 * shows “Checking for conflicts…” and closes on its own if the answer has nothing to say.
 */
import { useEffect, useState } from "react";
import { showDialog } from "../../app/dialogs";
import { shortSha } from "../../app/format";
import { Button, Spinner } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { Checkbox } from "../../ui/Field";
import { t } from "../../i18n";
import { conflictFiles, needsDialog, type PreflightFacts } from "./model";

export interface PreflightChoice {
  updateRefs: boolean;
}

/** The facts, or the promise of them while the check still runs. */
type FactsSource = PreflightFacts | Promise<PreflightFacts>;

function PreflightDialog({ title, confirmLabel, source, onDone }: { title: string; confirmLabel: string; source: FactsSource; onDone: (value: PreflightChoice | null) => void }) {
  const [updateRefs, setUpdateRefs] = useState(false);
  const [facts, setFacts] = useState<PreflightFacts | null>(source instanceof Promise ? null : source);
  useEffect(() => {
    if (!(source instanceof Promise)) return;
    let live = true;
    void source.then((answer) => {
      if (!live) return;
      // Nothing to say after all: the action runs as if no dialog had been needed.
      if (!needsDialog(answer)) onDone({ updateRefs: false });
      else setFacts(answer);
    });
    return () => {
      live = false;
    };
  }, [source, onDone]);
  const checking = facts === null;
  const files = conflictFiles(facts?.preview ?? null);
  const atCommit = facts?.preview?.status === "conflicts" ? facts.preview.atCommit : null;
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
          <Button variant="primary" data-action="preflight-run" disabled={checking} onClick={() => onDone({ updateRefs })}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-screen="preflight" aria-busy={checking || undefined}>
        {checking ? (
          <p className="m-0 flex items-center gap-2 text-text-muted" data-state="checking">
            <Spinner label={t("conflictPreview.checking")} />
            <span aria-hidden>{t("conflictPreview.checking")}</span>
          </p>
        ) : null}
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
        {facts && facts.dependents.length > 0 ? (
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

/** `facts` may still be a promise: then the dialog shows the checking state until it settles. */
export function openPreflightDialog(options: { title: string; confirmLabel: string; facts: FactsSource }): Promise<PreflightChoice | null> {
  return showDialog<PreflightChoice>((done) => <PreflightDialog title={options.title} confirmLabel={options.confirmLabel} source={options.facts} onDone={done} />);
}
