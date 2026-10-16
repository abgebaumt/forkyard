/**
 * "Looks like a key" (v1.2, spec 6.2): the local secret scan stopped a push. Lists file:line, the
 * kind and the line with every value masked (only its last four characters). "Back" (and Escape)
 * pushes nothing, "Push anyway" pushes exactly these findings; "Don't report again" stores only a
 * hash of file + line content, at once.
 */
import { useState } from "react";
import { core, type Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { t } from "../../i18n";
import { acceptedIds, secretRows, secretsNotes, secretsTitle, type SecretsFound } from "./model";

function SecretDialog({ repoId, found, onDone }: { repoId: Id; found: SecretsFound; onDone: (accepted: string[] | null) => void }) {
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const rows = secretRows(found.findings);
  const ignore = async (id: string) => {
    setBusy(id);
    const result = await runAction(t("pushCheck.secrets.ignore"), () => core.pushScanIgnore({ repoId, ids: [id] }));
    setBusy(null);
    if (result.ok) setIgnored((before) => new Set([...before, id]));
  };
  return (
    <Dialog
      open
      size="lg"
      title={secretsTitle(found.findings.length)}
      description={t("pushCheck.secrets.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button data-autofocus data-action="secrets-back" onClick={() => onDone(null)}>
            {t("pushCheck.secrets.back")}
          </Button>
          <Button variant="danger" data-action="secrets-push" onClick={() => onDone(acceptedIds(found.findings))}>
            {t("pushCheck.secrets.pushAnyway")}
          </Button>
        </>
      }
    >
      <div data-screen="secret-scan" className="flex flex-col gap-3">
        <ul aria-label={t("pushCheck.secrets.listLabel")} className="m-0 flex max-h-80 list-none flex-col gap-2 overflow-auto p-0">
          {rows.map((row) => (
            <li key={row.id} data-finding={row.location} className="rounded-md border border-border bg-surface-sunken p-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-mono text-code break-all text-text">{row.location}</p>
                  <p className="m-0 text-sm text-text-muted">
                    {row.rule} · {t("pushCheck.secrets.inCommit", { sha: row.commit })}
                  </p>
                  <pre className="selectable m-0 mt-1 font-mono text-code break-words whitespace-pre-wrap text-text">{row.excerpt}</pre>
                </div>
                {ignored.has(row.id) ? (
                  <p className="m-0 text-sm text-text-muted" aria-live="polite">
                    {t("pushCheck.secrets.ignored")}
                  </p>
                ) : (
                  <Button size="sm" variant="ghost" loading={busy === row.id} onClick={() => void ignore(row.id)}>
                    {t("pushCheck.secrets.ignore")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {secretsNotes(found).map((note) => (
          <p key={note} className="m-0 text-sm text-text-muted">
            {note}
          </p>
        ))}
      </div>
    </Dialog>
  );
}

export function showSecretFindings(repoId: Id, found: SecretsFound): Promise<string[] | null> {
  return showDialog<string[]>((done) => <SecretDialog repoId={repoId} found={found} onDone={done} />);
}
