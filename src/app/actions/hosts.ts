/**
 * Host accounts: connect, check, disconnect – and what all host actions need in common
 * (reporting errors, opening the host's pages in the browser).
 *
 * The token passes through the UI exactly once: from the password field into the call
 * `hostConnect`. It is never stored here, never logged and never shown in a message;
 * should it ever appear in an error text from the core, it is redacted before
 * display.
 */
import { t } from "../../i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ErrorCode, Id } from "../../core";
import { toast } from "../../ui/Feedback";
import { confirm } from "../dialogs";
import { errorInfo } from "../errors";
import { qk, queryClient } from "../queries";
import { runAction, showError, type ActionResult, type RunOptions } from "../run";
import { useAppStore } from "../store";
import { describeHostError, hostApi, hostErrorKind, hostKindLabels, type HostAccountInfo, type HostErrorText, type HostKind } from "./hostTypes";

/** Error codes of the host integration (the core adds them to `ErrorCode`). */
const HOST_CODES = ["host_not_connected", "host_auth_failed", "host_forbidden", "host_rate_limited", "host_not_found", "host_unsupported"] as unknown as ErrorCode[];
const ALL_CODES = [...(Object.keys(errorInfo) as ErrorCode[]), ...HOST_CODES];

export const hostBusyKeys = {
  connect: "app:host:connect",
  account: (accountId: Id) => `app:host:${accountId}`,
};

export const cachedHostAccounts = () => queryClient.getQueryData<HostAccountInfo[]>(qk.hostAccounts);

/** Settings › Integrations. */
export function openIntegrations(): void {
  useAppStore.getState().openOverlay({ kind: "preferences", section: "integrations" });
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** The public service per host; Azure DevOps has none (every organization has its own address). */
export const PUBLIC_HOSTS: Record<HostKind, string | null> = {
  github: "https://github.com",
  gitlab: "https://gitlab.com",
  gitea: "https://codeberg.org",
  bitbucket: "https://bitbucket.org",
  azure_devops: null,
};

/** Hosts that exist as self-hosted instances (address field in the connect dialog). */
export const hostHasInstances = (kind: HostKind): boolean => kind === "github" || kind === "gitlab" || kind === "gitea";

/** Where to create a token at the host. */
export function tokenPageUrl(kind: HostKind, baseUrl: string | null): string {
  const base = (baseUrl ?? PUBLIC_HOSTS[kind] ?? "https://dev.azure.com").replace(/\/+$/, "");
  switch (kind) {
    case "github":
      return `${base}/settings/tokens`;
    case "gitlab":
      return `${base}/-/user_settings/personal_access_tokens`;
    case "gitea":
      return `${base}/user/settings/applications`;
    case "bitbucket":
      return "https://id.atlassian.com/manage-profile/security/api-tokens";
    case "azure_devops":
      // Without an organization there is no token page yet – the sign-in leads there.
      return baseUrl ? `${base}/_usersSettings/tokens` : "https://dev.azure.com";
  }
}

/**
 * Validates the address of a self-hosted instance. http and https are allowed, without credentials
 * in the address; a trailing slash is dropped.
 */
export function parseBaseUrl(input: string): { url: string; error: null } | { url: null; error: string } {
  const value = input.trim();
  if (!value) return { url: null, error: t("actions.hosts.url.empty") };
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return { url: null, error: t("actions.hosts.url.invalid") };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { url: null, error: t("actions.hosts.url.scheme") };
  if (parsed.username || parsed.password) return { url: null, error: t("actions.hosts.url.credentials") };
  if (!parsed.hostname) return { url: null, error: t("actions.hosts.url.noHost") };
  // Otherwise the token would travel unencrypted over the network; the core only allows http:// to the local machine.
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname.startsWith("127.");
  if (parsed.protocol === "http:" && !loopback) return { url: null, error: t("actions.hosts.url.insecure") };
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, error: null };
}

export type ConnectField = "baseUrl" | "organization" | "username";

/** What the connect dialog holds besides the token. */
export interface ConnectFields {
  kind: HostKind;
  /** A self-hosted instance (only hosts with `hostHasInstances`). */
  own: boolean;
  address: string;
  /** Azure DevOps: the part after dev.azure.com/. */
  organization: string;
  /** Bitbucket: account e-mail or user name. */
  username: string;
}

export type ConnectTarget = { ok: true; baseUrl: string | null; username: string | null } | { ok: false; field: ConnectField; error: string };

/** The organization from an Azure DevOps address (`https://dev.azure.com/<org>`), otherwise "". */
export function organizationOf(baseUrl: string | null | undefined): string {
  return baseUrl?.match(/^https:\/\/dev\.azure\.com\/([^/?#]+)/i)?.[1] ?? "";
}

/** What "Connect" sends for the chosen host – address and user name – or the field that is wrong. */
export function connectTarget(fields: ConnectFields): ConnectTarget {
  if (fields.kind === "azure_devops") {
    const org = fields.organization.trim().replace(/^(?:https?:\/\/)?dev\.azure\.com\//i, "").split("/")[0] ?? "";
    if (!org) return { ok: false, field: "organization", error: t("actions.hosts.url.organization") };
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(org)) return { ok: false, field: "organization", error: t("actions.hosts.url.organizationInvalid") };
    return { ok: true, baseUrl: `https://dev.azure.com/${org.toLowerCase()}`, username: null };
  }
  let baseUrl: string | null = null;
  if (fields.own && hostHasInstances(fields.kind)) {
    const parsed = parseBaseUrl(fields.address);
    if (parsed.error !== null) return { ok: false, field: "baseUrl", error: parsed.error };
    baseUrl = parsed.url;
  }
  if (fields.kind !== "bitbucket") return { ok: true, baseUrl, username: null };
  const username = fields.username.trim();
  if (!username) return { ok: false, field: "username", error: t("actions.hosts.url.username") };
  if (/[\s:]/.test(username)) return { ok: false, field: "username", error: t("actions.hosts.url.usernameInvalid") };
  return { ok: true, baseUrl, username };
}

/** Which inputs the connect dialog shows besides the token. Replacing a token keeps host, address and user name. */
export function connectInputs(kind: HostKind, own: boolean, replacing: boolean): { instance: boolean; address: boolean; organization: boolean; username: boolean; gh: boolean } {
  return {
    instance: !replacing && hostHasInstances(kind),
    address: !replacing && own && hostHasInstances(kind),
    organization: !replacing && kind === "azure_devops",
    username: !replacing && kind === "bitbucket",
    gh: kind === "github",
  };
}

/** Opens a page in the system browser – never inside the app. Only http and https. */
export async function openInBrowser(url: string | null | undefined, what = t("actions.hosts.browser.page")): Promise<boolean> {
  if (!url || !/^https?:\/\//i.test(url)) {
    toast({ tone: "warning", title: t("actions.hosts.browser.noUrl", { what }) });
    return false;
  }
  const result = await runAction(t("actions.hosts.browser.open"), async () => {
    // For automated tests: no browser should start there (as with the links in the README preview).
    if (import.meta.env.DEV && window.__gcTestOpened) window.__gcTestOpened.push(url);
    else await openUrl(url);
  });
  return result.ok;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Replaces the token in a text – in case it ever did appear in a message. */
export function scrubSecret(text: string, secret: string): string {
  const value = secret.trim();
  if (value.length < 4) return text;
  return text.split(value).join("•••");
}

/** Message for a host integration error; for token and account problems with the way to the integrations. */
export function showHostError(label: string, error: unknown): HostErrorText {
  const info = describeHostError(error);
  // Not a host error (working directory in the way, Git error …): the usual message with hint and Git output.
  if (info.kind === "other") {
    showError(label, error);
    return info;
  }
  toast({
    tone: info.kind === "rate_limit" ? "warning" : "danger",
    title: t("actions.hosts.failed", { label }),
    description: info.hint ? `${info.text}\n${info.hint}` : info.text,
    action: info.kind === "auth" || info.kind === "not_connected" ? { label: t("actions.hosts.openIntegrations"), onClick: openIntegrations } : undefined,
    sticky: true,
  });
  if (info.kind === "auth") void queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  return info;
}

/**
 * Like `runAction`, for calls to the host: its errors (token expired, quota used up,
 * no permission …) get their own, understandable message.
 * With `inline` the caller shows the error itself (in the form) – then there is no message.
 */
export async function runHostAction<T>(label: string, fn: () => Promise<T>, options: RunOptions<T> & { inline?: boolean } = {}): Promise<ActionResult<T>> {
  const { inline, ...rest } = options;
  const result = await runAction(label, fn, { ...rest, quiet: ALL_CODES });
  if (!result.ok && !inline && result.error.code !== "cancelled" && result.error.code !== "duplicate") showHostError(label, result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AccountState = "ok" | "expired" | "scopes" | "error";

/** How to tell from the core's message that the token is the problem (and not the network). */
const TOKEN_TROUBLE = /token|401|abgelaufen|widerrufen|abgelehnt|unauthori|anmeld|expired|revoked|rejected/i;

/** State of an account in one word; the row adds text, icon and colour. */
export function accountState(account: HostAccountInfo): AccountState {
  if (account.lastError) return TOKEN_TROUBLE.test(account.lastError) ? "expired" : "error";
  if (!account.user) return "expired";
  return account.scopesOk ? "ok" : "scopes";
}

export const accountHost = (account: Pick<HostAccountInfo, "kind" | "baseUrl">) => (account.baseUrl ?? PUBLIC_HOSTS[account.kind] ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
export const accountPerson = (account: HostAccountInfo) => account.user?.name ?? account.user?.login ?? null;
export const accountTitle = (account: HostAccountInfo) => `${hostKindLabels[account.kind]} – ${accountHost(account)}`;

/** Reload everything that depends on the accounts: the accounts themselves, the repositories' hosts, pull requests. */
export function refreshHostData(): void {
  void queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "repo" && ["hostRepo", "prs", "pr", "prTemplate"].includes(String(query.queryKey[2])),
  });
}

export type ConnectResult = { ok: true; account: HostAccountInfo } | { ok: false; error: HostErrorText };

/**
 * Connects an account: the core checks the token against the host's API and stores it in the
 * system keychain. Errors go back to the dialog (without a message) – redacted.
 */
export async function connectAccount(input: { kind: HostKind; baseUrl: string | null; token: string; username?: string | null }): Promise<ConnectResult> {
  return finishConnect(await runHostAction(t("actions.hosts.connect.label"), () => hostApi.connect(input), { busyKey: hostBusyKeys.connect, inline: true }), input.token);
}

/** Connects GitHub with the login of the GitHub CLI; the token never passes through the UI. */
export async function connectWithGh(baseUrl: string | null): Promise<ConnectResult> {
  const result = await runHostAction(t("actions.hosts.connect.label"), () => hostApi.connectGh(baseUrl), { busyKey: hostBusyKeys.connect, inline: true });
  if (!result.ok) {
    // gh's own message says what to do (install it, `gh auth login`): no generic heading about a wrong token.
    const info = describeHostError(result.error);
    return { ok: false, error: { ...info, title: t("hosts.connect.gh.failed"), hint: "" } };
  }
  return finishConnect(result, "");
}

function finishConnect(result: ActionResult<HostAccountInfo>, token: string): ConnectResult {
  if (!result.ok) {
    const info = describeHostError(result.error);
    const kind = hostErrorKind(result.error);
    // When connecting, "rejected" means: this token is wrong – not "no longer valid".
    const text = token ? scrubSecret(info.text, token) : info.text;
    // Custom headings: when connecting, "rejected" is not an expired token, and everything else
    // (wrong address, keychain missing, token with spaces) is explained by the core's sentence.
    const title =
      kind === "auth"
        ? t("actions.hosts.connect.rejected")
        : kind === "permission"
          ? t("actions.hosts.connect.missingScopes")
          : kind === "offline" || kind === "rate_limit" || kind === "not_built"
            ? info.title
            : t("actions.hosts.connect.failed");
    const hint = kind === "auth" ? t("actions.hosts.connect.rejectedHint") : kind === "offline" || kind === "rate_limit" ? info.hint : "";
    return { ok: false, error: { ...info, title, text, hint } };
  }
  refreshHostData();
  const account = result.value;
  toast({
    tone: account.scopesOk ? "success" : "warning",
    title: accountPerson(account)
      ? t("actions.hosts.connect.doneAs", { host: hostKindLabels[account.kind], person: accountPerson(account) })
      : t("actions.hosts.connect.done", { host: hostKindLabels[account.kind] }),
    description: account.scopesOk ? t("actions.hosts.connect.inKeychain") : t("actions.hosts.connect.scopesMissing"),
  });
  return { ok: true, account };
}

/** Asks the host whether the token is still valid and shows the result. */
export async function checkAccount(account: HostAccountInfo, options: { silent?: boolean } = {}): Promise<HostAccountInfo | null> {
  const result = await runHostAction(t("actions.hosts.check.label"), () => hostApi.check(account.id), { busyKey: hostBusyKeys.account(account.id), inline: true });
  // The core records the result on the account (`lastError`); the list shows it.
  await queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  if (!result.ok) {
    if (!options.silent) {
      const info = describeHostError(result.error);
      toast({ tone: info.kind === "rate_limit" ? "warning" : "danger", title: `${accountTitle(account)}: ${info.title}`, description: info.hint ? `${info.text}\n${info.hint}` : info.text, sticky: true });
    }
    return null;
  }
  const next = result.value ?? cachedHostAccounts()?.find((item) => item.id === account.id) ?? null;
  if (next && !options.silent) {
    const state = accountState(next);
    const title = accountTitle(next);
    if (state === "ok") {
      const person = accountPerson(next);
      toast({ tone: "success", title: person ? t("actions.hosts.check.okAs", { account: title, person }) : t("actions.hosts.check.ok", { account: title }) });
    } else if (state === "scopes") {
      toast({ tone: "warning", title: t("actions.hosts.check.scopes", { account: title }), description: t("actions.hosts.check.scopesDescription") });
    } else {
      toast({
        tone: "danger",
        title: state === "expired" ? t("actions.hosts.check.expired", { account: title }) : t("actions.hosts.check.failed", { account: title }),
        description: next.lastError ?? undefined,
        sticky: true,
      });
    }
  }
  refreshHostData();
  return next;
}

/** Disconnects an account after a prompt: the token is deleted from the keychain. Nothing changes at the host. */
export async function disconnectAccount(account: HostAccountInfo): Promise<boolean> {
  const person = accountPerson(account);
  const ok = await confirm({
    title: t("actions.hosts.disconnect.title", { host: hostKindLabels[account.kind] }),
    body: t("actions.hosts.disconnect.body", { address: person ? `${accountHost(account)} (${person})` : accountHost(account) }),
    confirmLabel: t("actions.hosts.disconnect.action"),
    danger: true,
  });
  if (!ok) return false;
  const result = await runHostAction(t("actions.hosts.disconnect.action"), () => hostApi.disconnect(account.id), { busyKey: hostBusyKeys.account(account.id) });
  refreshHostData();
  if (result.ok) toast({ tone: "success", title: t("actions.hosts.disconnect.done", { host: hostKindLabels[account.kind] }), description: t("actions.hosts.disconnect.doneDescription") });
  return result.ok;
}

// ---------------------------------------------------------------------------
// Token expired in the middle of the session
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  let lastRefresh = 0;
  // If the host rejects a request because of the token, the account list should show it without anyone pressing "Check".
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    if (event.query.queryKey[0] !== "repo" || hostErrorKind(event.action.error) !== "auth") return;
    const now = Date.now();
    if (now - lastRefresh < 5000) return;
    lastRefresh = now;
    void queryClient.invalidateQueries({ queryKey: qk.hostAccounts });
  });
}
