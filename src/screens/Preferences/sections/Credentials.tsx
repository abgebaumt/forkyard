/** Remembered credentials: list without secrets and "Forget all". */
import { useEffect } from "react";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { core, type HostAccount } from "../../../core";
import { confirm } from "../../../app/dialogs";
import { formatDateTime, formatShortDate } from "../../../app/format";
import { qk, queryClient, useAppInfo, useCredentials } from "../../../app/queries";
import { runAction } from "../../../app/run";
import { Button } from "../../../ui/Button";
import { Banner, toast } from "../../../ui/Feedback";
import { Badge, GroupTitle, LoadError, SectionHeader } from "../parts";
import { t } from "../../../i18n";

const kindLabel: Record<HostAccount["kind"], string> = {
  password: t("preferences.credentials.kind.password"),
  passphrase: t("preferences.credentials.kind.passphrase"),
};

async function forgetAll(count: number) {
  const ok = await confirm({
    title: t("preferences.credentials.forget.title", { count }),
    body: t("preferences.credentials.forget.body"),
    confirmLabel: t("preferences.credentials.forget.confirm"),
    danger: true,
  });
  if (!ok) return;
  const result = await runAction(t("preferences.credentials.forget.action"), () => core.credentialsForgetAll());
  // Reload even after an error: part of it may already be deleted.
  await queryClient.invalidateQueries({ queryKey: qk.credentials });
  if (result.ok) {
    toast({
      tone: "success",
      title: result.value === 0 ? t("preferences.credentials.forget.none") : t("preferences.credentials.forget.done", { count: result.value }),
    });
  }
}

export function CredentialsSection() {
  const appInfo = useAppInfo();
  const credentials = useCredentials();
  // The core does not report when the remembered entries change: reload when the section opens.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: qk.credentials });
  }, []);
  const list = credentials.data ?? [];
  const keyring = appInfo.data?.keyringAvailable;

  return (
    <section>
      <SectionHeader
        title={t("preferences.credentials.title")}
        actions={
          <Button
            variant="secondary"
            className="hover:text-danger"
            icon={<Trash2 className="size-icon" aria-hidden />}
            disabled={list.length === 0}
            onClick={() => void forgetAll(list.length)}
          >
            {t("preferences.credentials.forgetAll")}
          </Button>
        }
      >
        {t("preferences.credentials.intro")}
      </SectionHeader>

      {keyring === false ? (
        <div className="mb-3 overflow-hidden rounded-md" data-state="no-keyring">
          <Banner tone="warning" title={t("preferences.credentials.noKeyring.title")}>
            {t("preferences.credentials.noKeyring.body")}
          </Banner>
        </div>
      ) : null}

      <GroupTitle id="prefs-credentials-list">{list.length ? t("preferences.credentials.listCount", { count: list.length }) : t("preferences.credentials.list")}</GroupTitle>

      {credentials.isPending ? (
        <div role="status" aria-label={t("preferences.credentials.loading")} className="animate-pulse overflow-hidden rounded-md border border-border">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex h-9 items-center gap-4 border-b border-border px-3 last:border-b-0">
              <div className="h-3 w-48 rounded-sm bg-surface-raised" />
              <div className="h-3 w-24 rounded-sm bg-surface-raised" />
            </div>
          ))}
        </div>
      ) : credentials.isError ? (
        <LoadError title={t("preferences.loadError.credentials")} error={credentials.error} onRetry={() => void credentials.refetch()} />
      ) : list.length === 0 ? (
        <div data-state="empty" className="flex items-start gap-3 rounded-md border border-dashed border-border-input px-4 py-4">
          <ShieldCheck className="mt-0.5 size-icon shrink-0 text-text-muted" aria-hidden />
          <div>
            <p className="text-md font-medium text-text">{t("preferences.credentials.empty.title")}</p>
            <p className="text-base text-text-muted">{t("preferences.credentials.empty.body")}</p>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table aria-labelledby="prefs-credentials-list" className="w-full table-fixed border-collapse text-left text-base">
            <thead>
              <tr className="h-row border-b border-border bg-surface-raised text-xs font-semibold tracking-wide text-text-muted uppercase">
                <th scope="col" className="px-3 font-semibold">
                  {t("preferences.credentials.columns.host")}
                </th>
                <th scope="col" className="w-40 px-3 font-semibold">
                  {t("preferences.credentials.columns.user")}
                </th>
                <th scope="col" className="w-44 px-3 font-semibold">
                  {t("preferences.credentials.columns.kind")}
                </th>
                <th scope="col" className="w-28 px-3 font-semibold">
                  {t("preferences.credentials.columns.saved")}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((account) => (
                <tr key={account.id} className="h-8 border-b border-border last:border-b-0">
                  <td className="px-3">
                    <span className="selectable block truncate font-mono text-code" title={account.host}>
                      {account.host}
                    </span>
                  </td>
                  <td className="px-3">
                    <span className="selectable block truncate" title={account.username}>
                      {account.username || <span className="text-text-muted">–</span>}
                    </span>
                  </td>
                  <td className="px-3">
                    <Badge icon={<KeyRound className="size-3" aria-hidden />}>{kindLabel[account.kind]}</Badge>
                  </td>
                  <td className="px-3 text-text-muted tabular-nums" title={formatDateTime(account.createdAt)}>
                    {formatShortDate(account.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
