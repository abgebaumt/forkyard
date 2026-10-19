/**
 * Host accounts ("Integrations" section of the settings): the connected accounts at GitHub and
 * GitLab, each with its state, plus connect, check, replace token and disconnect.
 * Tokens never appear here – only the last characters, for recognition.
 */
import { useEffect } from "react";
import { CircleCheck, KeyRound, Link2Off, Plug, Plus, RefreshCw, Replace, ShieldAlert, TriangleAlert, Unplug } from "lucide-react";
import { accountHost, accountPerson, accountState, checkAccount, disconnectAccount, hostBusyKeys, type AccountState } from "../../app/actions/hosts";
import { describeHostError, hostKindLabels, type HostAccountInfo } from "../../app/actions/hostTypes";
import { describeError } from "../../app/errors";
import { qk, queryClient, useHostAccounts, useKeyringAvailable } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { Avatar } from "../../ui/Git";
import { Badge, GroupTitle, SectionHeader, type BadgeTone } from "../Preferences/parts";
import { t } from "../../i18n";
import { openConnectDialog } from "./ConnectDialog";

export { openConnectDialog } from "./ConnectDialog";

const stateBadge: Record<AccountState, { tone: BadgeTone; icon: typeof CircleCheck }> = {
  ok: { tone: "success", icon: CircleCheck },
  expired: { tone: "danger", icon: KeyRound },
  scopes: { tone: "warning", icon: ShieldAlert },
  error: { tone: "warning", icon: TriangleAlert },
};

function stateText(account: HostAccountInfo, state: AccountState): { label: string; detail: string | null } {
  const person = accountPerson(account);
  switch (state) {
    case "ok":
      return { label: person ? t("hosts.state.connectedAs", { person }) : t("hosts.state.connected"), detail: null };
    case "scopes":
      return {
        label: t("hosts.state.scopes"),
        detail: person ? t("hosts.state.scopesDetailPerson", { person }) : t("hosts.state.scopesDetail"),
      };
    case "expired":
      return { label: t("hosts.state.expired"), detail: account.lastError ?? t("hosts.state.expiredDetail") };
    case "error":
      return { label: t("hosts.state.error"), detail: account.lastError };
  }
}

function AccountRow({ account }: { account: HostAccountInfo }) {
  const busy = useBusy(hostBusyKeys.account(account.id));
  const state = accountState(account);
  const badge = stateBadge[state];
  const text = stateText(account, state);
  const person = accountPerson(account);
  const host = accountHost(account);
  const Icon = badge.icon;
  const name = `${hostKindLabels[account.kind]} – ${host}`;
  return (
    <li data-account={account.id} data-kind={account.kind} data-state={state} aria-label={`${name}: ${text.label}`} className="flex flex-col gap-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">{person ? <Avatar name={person} size={28} /> : <span className="flex size-7 items-center justify-center rounded-pill bg-surface-raised text-text-muted"><Link2Off className="size-icon" aria-hidden /></span>}</span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-md font-medium text-text">{hostKindLabels[account.kind]}</span>
            <span className="selectable min-w-0 truncate font-mono text-code text-text-muted" title={account.baseUrl ?? host}>
              {host}
            </span>
            <Badge tone={badge.tone} icon={<Icon className="size-3" aria-hidden />}>
              {text.label}
            </Badge>
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-text-muted">
            {account.user ? (
              <span className="selectable min-w-0 truncate" title={account.user.login}>
                {t("hosts.account.user", { login: account.user.login })}
              </span>
            ) : null}
            {account.username ? (
              <span className="selectable min-w-0 truncate" title={account.username}>
                {t("hosts.account.signIn", { name: account.username })}
              </span>
            ) : null}
            <span className="whitespace-nowrap">{account.tokenHint ? t("hosts.account.tokenEnds", { hint: account.tokenHint.replace(/^[•.*…\s]+/, "") }) : t("hosts.account.tokenInKeyring")}</span>
          </p>
          {text.detail ? (
            <p data-account-detail className="selectable mt-1 text-sm break-words text-text-muted">
              {text.detail}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" loading={busy} icon={<RefreshCw className="size-3.5" aria-hidden />} aria-label={t("hosts.account.checkLabel", { name })} onClick={() => void checkAccount(account)}>
          {t("hosts.account.check")}
        </Button>
        <Button size="sm" disabled={busy} icon={<Replace className="size-3.5" aria-hidden />} aria-label={t("hosts.account.replaceLabel", { name })} onClick={() => void openConnectDialog({ replace: account })}>
          {t("hosts.account.replace")}
        </Button>
        <Button size="sm" disabled={busy} className="hover:text-danger" icon={<Unplug className="size-3.5" aria-hidden />} aria-label={t("hosts.account.disconnectLabel", { name })} onClick={() => void disconnectAccount(account)}>
          {t("hosts.account.disconnect")}
        </Button>
      </div>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label={t("hosts.loading")} className="animate-pulse overflow-hidden rounded-md border border-border">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-b-0">
          <div className="size-7 rounded-pill bg-surface-raised" />
          <div className="flex-1">
            <div className="h-4 w-56 max-w-full rounded-sm bg-surface-raised" />
            <div className="mt-2 h-3 w-40 rounded-sm bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** "Integrations" section of the settings. */
export function HostsSection() {
  const accounts = useHostAccounts();
  const keyring = useKeyringAvailable();
  // Whether a token is still valid changes at the host, not here: reload when the section opens.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  }, []);
  const list = accounts.data ?? [];
  const failure = accounts.isError ? describeHostError(accounts.error) : null;

  return (
    <section data-screen="hosts" data-state={accounts.isPending ? "loading" : accounts.isError ? "error" : list.length ? "filled" : "empty"}>
      <SectionHeader
        title={t("hosts.section.title")}
        actions={
          <Button variant="primary" icon={<Plus className="size-icon" aria-hidden />} disabled={failure?.kind === "not_built"} onClick={() => void openConnectDialog()}>
            {t("hosts.section.connect")}
          </Button>
        }
      >
        {t("hosts.section.intro")}
      </SectionHeader>

      {keyring === false ? (
        <div className="mb-3 overflow-hidden rounded-md" data-state="no-keyring">
          <Banner tone="warning" title={t("hosts.section.noKeyringTitle")}>
            {t("hosts.section.noKeyring")}
          </Banner>
        </div>
      ) : null}

      <GroupTitle id="prefs-hosts-list">{list.length ? t("hosts.section.listCount", { count: list.length }) : t("hosts.section.list")}</GroupTitle>

      {accounts.isPending ? (
        <ListSkeleton />
      ) : accounts.isError ? (
        <div role="alert" data-hosts-error={failure!.kind} className="flex items-start gap-3 rounded-md border border-border bg-danger-surface p-3">
          <TriangleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-text">{t("hosts.section.loadError")}</p>
            <p className="selectable text-sm break-words text-text-muted">
              {failure!.kind === "other" ? describeError(accounts.error).text : `${failure!.title}. ${failure!.text}`} {failure!.hint}
            </p>
          </div>
          <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void accounts.refetch()}>
            {t("hosts.section.retry")}
          </Button>
        </div>
      ) : list.length === 0 ? (
        <div data-state="empty" className="flex items-start gap-3 rounded-md border border-dashed border-border-input px-4 py-4">
          <Plug className="mt-0.5 size-icon shrink-0 text-text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-md font-medium text-text">{t("hosts.section.emptyTitle")}</p>
            <p className="text-base text-text-muted">{t("hosts.section.empty")}</p>
            <div className="mt-2">
              <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => void openConnectDialog()}>
                {t("hosts.section.connect")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <ul aria-labelledby="prefs-hosts-list" className="overflow-hidden rounded-md border border-border">
          {list.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </ul>
      )}

      <p className="mt-3 text-sm text-text-muted">
        {t("hosts.section.footer")}
      </p>
    </section>
  );
}
