/**
 * "New work item" dialog (Azure DevOps): title and plain-text description. The core creates it at
 * the host (type "Issue", or "Bug" if the project's process has none); afterwards the list reloads
 * and the new item opens.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Id } from "../../core";
import { runHostAction } from "../../app/actions/hosts";
import { showDialog } from "../../app/dialogs";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { toast } from "../../ui/Feedback";
import { TextArea, TextField } from "../../ui/Field";
import { t } from "../../i18n";
import { issueApi, type IssueSummary } from "./api";
import { refreshIssues } from "./actions";
import { checkIssueTitle } from "./model";

const busyKey = (repoId: Id) => `${repoId}:issue:create`;

function CreateDialog({ repoId, where, onDone }: { repoId: Id; where: string; onDone: (created: IssueSummary | null) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useBusy(busyKey(repoId));

  const submit = async () => {
    if (busy) return;
    const problem = checkIssueTitle(title);
    if (problem) {
      setError(problem);
      return;
    }
    const result = await runHostAction(t("issues.create.label"), () => issueApi.create(repoId, title.trim(), body), { busyKey: busyKey(repoId) });
    if (!result.ok) return;
    await refreshIssues(repoId);
    toast({ tone: "success", title: t("issues.create.done", { key: result.value.key }) });
    onDone(result.value);
  };

  return (
    <Dialog
      open
      size="md"
      title={t("issues.create.title")}
      description={t("issues.create.description", { where })}
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      footer={
        <>
          <Button disabled={busy} onClick={() => onDone(null)}>
            {t("issues.create.cancel")}
          </Button>
          <Button variant="primary" loading={busy} icon={<Plus className="size-icon" aria-hidden />} onClick={() => void submit()}>
            {t("issues.create.submit")}
          </Button>
        </>
      }
    >
      <form
        data-screen="issue-create"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          name="title"
          label={t("issues.create.titleField")}
          value={title}
          data-autofocus=""
          autoComplete="off"
          error={error ?? undefined}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
        />
        <TextArea name="body" label={t("issues.create.body")} hint={t("issues.create.bodyHint")} rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Opens the dialog; returns the new work item, or null on cancel. */
export function openCreateIssueDialog(repoId: Id, where: string): Promise<IssueSummary | null> {
  return showDialog<IssueSummary>((done) => <CreateDialog repoId={repoId} where={where} onDone={done} />);
}
