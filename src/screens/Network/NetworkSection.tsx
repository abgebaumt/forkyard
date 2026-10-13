/**
 * Network: proxy (general and per host), a custom CA bundle and – as a deliberate per-host
 * exception – disabled certificate verification. Applies only to this app's network calls; the
 * user's Git configuration stays untouched. Every change takes effect immediately.
 */
import { useId, useState, type ReactNode } from "react";
import { FolderOpen, Plus, ShieldAlert, ShieldCheck, ShieldOff, X } from "lucide-react";
import { core, type Settings } from "../../core";
import { confirm } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { Button, IconButton } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { TextField } from "../../ui/Field";
import { CommitText, GroupTitle, Mono, SectionHeader, SettingRow } from "../Preferences/parts";
import { applySettings } from "../Preferences/settings";
import { t } from "../../i18n";

const PROXY_SCHEMES = /^(https?|socks4a?|socks5h?):\/\/\S+$/i;

/** Rough pre-check; the core has the final word. */
function checkProxy(value: string): string | null {
  if (!value) return null;
  if (/\s/.test(value)) return t("network.check.proxySpaces");
  return PROXY_SCHEMES.test(value) ? null : t("network.check.proxyFormat");
}

function checkHost(value: string): string | null {
  if (!value) return t("network.check.hostEmpty");
  if (/\s/.test(value)) return t("network.check.hostSpaces");
  if (value.includes("*")) return t("network.check.hostWildcard");
  return null;
}

/** Do not spell out credentials contained in a proxy address. */
const maskProxy = (value: string) => value.replace(/\/\/([^/@:]+)(?::[^/@]*)?@/, "//$1:•••@");

/** Core error as a sentence for the field; null on success. */
async function save(patch: Partial<Settings>): Promise<string | null> {
  try {
    await applyQuiet(patch);
    return null;
  } catch (error) {
    return describeError(error).text;
  }
}

/** Like `applySettings`, but the error goes to the caller instead of a toast – it belongs at the field. */
async function applyQuiet(patch: Partial<Settings>): Promise<void> {
  const result = await applySettings(patch, { atField: true, quiet: ["not_allowed", "invalid_name", "name_exists", "path_not_found", "io"] });
  if (!result.ok) throw result.error;
}

function HostList({ label, children, empty }: { label: string; children: ReactNode[]; empty: string }) {
  if (children.length === 0) {
    return (
      <p className="py-2 text-sm text-text-muted" data-network-empty>
        {empty}
      </p>
    );
  }
  return (
    <ul aria-label={label} className="my-2 max-h-40 overflow-auto rounded-md border border-border bg-surface-sunken py-1">
      {children}
    </ul>
  );
}

/** Small form for adding: one or two fields and a button; errors appear at the field. */
function AddForm({
  fields,
  submitLabel,
  icon,
  danger,
  onSubmit,
  name,
}: {
  fields: { key: string; label: string; placeholder: string; check: (value: string) => string | null }[];
  submitLabel: string;
  icon: ReactNode;
  danger?: boolean;
  name: string;
  /** Error text for the field, null on success, false if the user cancelled (the input then stays). */
  onSubmit: (values: Record<string, string>) => Promise<string | null | false>;
}) {
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const trimmed = Object.fromEntries(fields.map((field) => [field.key, (values[field.key] ?? "").trim()]));
    const problem = fields.map((field) => field.check(trimmed[field.key] ?? "")).find(Boolean) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    const failure = await onSubmit(trimmed);
    setBusy(false);
    if (failure === false) return;
    setError(failure);
    if (!failure) setValues({});
  };
  return (
    <form
      data-network-form={name}
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-end gap-2">
        {fields.map((field) => (
          <div key={field.key} className="min-w-0 flex-1">
            <TextField
              id={`${base}-${field.key}`}
              label={field.label}
              mono
              value={values[field.key] ?? ""}
              placeholder={field.placeholder}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field.key]: event.target.value }));
                if (error) setError(null);
              }}
            />
          </div>
        ))}
        <Button type="submit" variant={danger ? "danger" : "secondary"} loading={busy} icon={icon}>
          {submitLabel}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function NetworkSection({ settings }: { settings: Settings }) {
  const proxyByHost = settings.proxyByHost ?? [];
  const noVerify = settings.sslNoVerifyHosts ?? [];

  return (
    <section data-screen="network">
      <SectionHeader title={t("network.title")}>
        {t("network.intro")}
      </SectionHeader>

      {noVerify.length > 0 ? (
        <div className="mb-2 overflow-hidden rounded-md" data-network-warning>
          <Banner tone="danger" title={t("network.warning", { count: noVerify.length })}>
            {t("network.warningBody")}
          </Banner>
        </div>
      ) : null}

      <SettingRow
        stacked
        title={t("network.proxy.title")}
        description={t("network.proxy.description")}
      >
        {(ids) => (
          <CommitText
            id={ids.id}
            describedBy={ids.descriptionId}
            mono
            placeholder={t("network.proxy.placeholder")}
            value={settings.proxyUrl ?? ""}
            validate={checkProxy}
            onCommit={(value) => save({ proxyUrl: value || null })}
          />
        )}
      </SettingRow>

      <GroupTitle id="network-proxy-hosts">{t("network.perHost.title")}</GroupTitle>
      <p className="text-sm text-text-muted">{t("network.perHost.intro")}</p>
      <HostList label={t("network.perHost.list")} empty={t("network.perHost.empty")}>
        {proxyByHost.map((entry) => (
          <li key={entry.host} data-network-proxy-host={entry.host} className="flex h-control-lg items-center gap-2 px-2">
            <Mono className="min-w-0 flex-1">{entry.host}</Mono>
            <span className="max-w-1/2 shrink-0 truncate text-sm text-text-muted" title={entry.proxy ? maskProxy(entry.proxy) : undefined}>
              {entry.proxy ? t("network.perHost.via", { proxy: maskProxy(entry.proxy) }) : t("network.perHost.noProxy")}
            </span>
            <IconButton
              size="sm"
              danger
              label={t("network.perHost.remove", { host: entry.host })}
              icon={<X className="size-icon" aria-hidden />}
              onClick={() => void applySettings({ proxyByHost: proxyByHost.filter((item) => item.host !== entry.host) })}
            />
          </li>
        ))}
      </HostList>
      <AddForm
        name="proxy-host"
        submitLabel={t("network.perHost.add")}
        icon={<Plus className="size-icon" aria-hidden />}
        fields={[
          { key: "host", label: t("network.perHost.host"), placeholder: t("network.perHost.hostPlaceholder"), check: checkHost },
          { key: "proxy", label: t("network.perHost.proxy"), placeholder: t("network.perHost.noProxy"), check: checkProxy },
        ]}
        onSubmit={(values) => save({ proxyByHost: [...proxyByHost.filter((item) => item.host !== values.host), { host: values.host ?? "", proxy: values.proxy ?? "" }] })}
      />

      <GroupTitle id="network-certificates">{t("network.certificates")}</GroupTitle>
      <SettingRow
        stacked
        title={t("network.caBundle.title")}
        description={t("network.caBundle.description")}
      >
        {(ids) => (
          <div className="flex items-start gap-2">
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              className="min-w-0 flex-1"
              mono
              placeholder={t("network.caBundle.placeholder")}
              value={settings.sslCaFile ?? ""}
              onCommit={(value) => save({ sslCaFile: value || null })}
            />
            <Button
              icon={<FolderOpen className="size-icon" aria-hidden />}
              aria-label={t("network.caBundle.browseLabel")}
              onClick={async () => {
                const picked = await core.pickFile({ title: t("network.caBundle.pick") });
                if (picked) void applySettings({ sslCaFile: picked });
              }}
            >
              {t("network.caBundle.browse")}
            </Button>
          </div>
        )}
      </SettingRow>

      <GroupTitle id="network-no-verify">{t("network.noVerify.title")}</GroupTitle>
      <p className="text-sm text-text-muted">{t("network.noVerify.intro")}</p>
      <HostList label={t("network.noVerify.list")} empty={t("network.noVerify.empty")}>
        {noVerify.map((host) => (
          <li key={host} data-network-no-verify={host} className="flex h-control-lg items-center gap-2 px-2">
            <ShieldAlert className="size-icon shrink-0 text-danger" aria-hidden />
            <Mono className="min-w-0 flex-1">{host}</Mono>
            <span className="shrink-0 text-sm font-medium text-danger">{t("network.noVerify.unverified")}</span>
            <Button
              size="sm"
              icon={<ShieldCheck className="size-3.5" aria-hidden />}
              aria-label={t("network.noVerify.verifyLabel", { host })}
              onClick={() => void applySettings({ sslNoVerifyHosts: noVerify.filter((item) => item !== host) })}
            >
              {t("network.noVerify.verify")}
            </Button>
          </li>
        ))}
      </HostList>
      <AddForm
        name="no-verify"
        danger
        submitLabel={t("network.noVerify.submit")}
        icon={<ShieldOff className="size-icon" aria-hidden />}
        fields={[{ key: "host", label: t("network.perHost.host"), placeholder: t("network.noVerify.hostPlaceholder"), check: checkHost }]}
        onSubmit={async (values) => {
          const host = values.host ?? "";
          const ok = await confirm({
            title: t("network.noVerify.confirmTitle", { host }),
            body: t("network.noVerify.confirmBody"),
            confirmLabel: t("network.noVerify.confirm"),
            danger: true,
          });
          if (!ok) return false;
          return save({ sslNoVerifyHosts: [...noVerify.filter((item) => item !== host), host] });
        }}
      />
    </section>
  );
}
