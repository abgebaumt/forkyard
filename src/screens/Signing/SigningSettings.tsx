/**
 * Commit signing: settings for the global Git configuration (`repoId: null`) or for a repository.
 * Format (OpenPGP, SSH, X.509), key (for SSH from the registered SSH keys), the switch itself and –
 * read-only – the program from the Git configuration.
 * Every change takes effect immediately; written are commit.gpgSign, gpg.format and user.signingKey.
 */
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff, Undo2 } from "lucide-react";
import { core, type Id, type SigningFormat, type SigningStatus, type SshKey } from "../../core";
import { queryClient, useSshKeys } from "../../app/queries";
import { runAction } from "../../app/run";
import { writesSettled } from "../../app/writeQueue";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { Badge, CommitText, GroupTitle, LoadError, Mono, SettingRow, SettingsSkeleton } from "../Preferences/parts";
import { enqueue } from "../Preferences/settings";
import { t } from "../../i18n";

export const signingKey = (repoId: Id | null) => (repoId ? (["repo", repoId, "signing"] as const) : (["app", "signing"] as const));

// Reads happen only once no change is in flight anymore (see src/app/writeQueue.ts).
export const useSigning = (repoId: Id | null) => useQuery({ queryKey: signingKey(repoId), queryFn: () => writesSettled().then(() => core.signingStatus({ repoId })) });

const formats: { value: SigningFormat; label: string }[] = [
  { value: "openpgp", label: "OpenPGP (GPG)" },
  { value: "ssh", label: "SSH" },
  { value: "x509", label: "X.509 (S/MIME)" },
];

const defaultProgram: Record<SigningFormat, string> = { openpgp: "gpg", ssh: "ssh-keygen", x509: "gpgsm" };
const programConfig: Record<SigningFormat, string> = { openpgp: "gpg.program", ssh: "gpg.ssh.program", x509: "gpg.x509.program" };

const slashes = (path: string) => path.replace(/\\/g, "/");
const sameFile = (a: string, b: string) => slashes(a).toLowerCase() === slashes(b).toLowerCase();
const NO_KEY = "none";

/** "ssh-ed25519 AAAA… comment" → "ED25519". */
function keyType(publicKey: string): string {
  const first = publicKey.trim().split(/\s+/)[0] ?? "";
  if (first.startsWith("ecdsa-")) return "ECDSA";
  if (first.startsWith("sk-")) return t("signing.securityKey");
  return first.replace(/^ssh-/, "").toUpperCase();
}

const keyLabel = (key: SshKey) => [key.label, key.publicKey ? keyType(key.publicKey) : null, key.missing ? t("signing.fileMissing") : null].filter(Boolean).join(" · ");

/** Writes the signing setting; the core's answer is then the state in the cache. */
function applySigning(repoId: Id | null, wanted: { enabled: boolean; format: SigningFormat | null; key: string | null }) {
  return enqueue(async () => {
    // A query already in flight read the state before this change: it no longer counts.
    await queryClient.cancelQueries({ queryKey: signingKey(repoId) });
    // The repository only holds what differs from the global setting: format and key that apply there
    // just the same stay inherited (null removes the entry) – a later change of the global key then
    // applies here too.
    const global = repoId ? queryClient.getQueryData<SigningStatus>(signingKey(null)) : undefined;
    const next = global
      ? {
          enabled: wanted.enabled,
          format: wanted.format !== null && wanted.format === global.format ? null : wanted.format,
          key: wanted.key !== null && global.key !== null && sameFile(wanted.key, global.key) ? null : wanted.key,
        }
      : wanted;
    const result = await runAction(t("signing.save"), () => core.signingSet({ repoId, ...next }));
    if (result.ok) queryClient.setQueryData(signingKey(repoId), result.value);
    else void queryClient.invalidateQueries({ queryKey: signingKey(repoId) });
    return result;
  });
}

const same = (a: SigningStatus, b: SigningStatus) => a.enabled === b.enabled && (a.format ?? "openpgp") === (b.format ?? "openpgp") && (a.key ?? "") === (b.key ?? "");

export function SigningSettings({ repoId }: { repoId: Id | null }) {
  const status = useSigning(repoId);
  const global = useSigning(null);
  const keys = useSshKeys();
  const scope = repoId ? "repo" : "global";

  const title = (
    <GroupTitle id={`signing-title-${scope}`} flush={!repoId}>
      {t("signing.title")}
    </GroupTitle>
  );
  if (status.isPending) {
    return (
      <section data-signing={scope} data-signing-state="loading" aria-labelledby={`signing-title-${scope}`} className={repoId ? undefined : "mt-6"}>
        {title}
        <SettingsSkeleton rows={3} />
      </section>
    );
  }
  if (status.isError) {
    return (
      <section data-signing={scope} data-signing-state="error" aria-labelledby={`signing-title-${scope}`} className={repoId ? undefined : "mt-6"}>
        {title}
        <LoadError title={t("signing.loadError")} error={status.error} onRetry={() => void status.refetch()} />
      </section>
    );
  }

  const current = status.data;
  const format: SigningFormat = current.format ?? "openpgp";
  const sshKeys = keys.data ?? [];
  const chosen = current.key ? sshKeys.find((key) => sameFile(key.publicKeyPath, current.key!)) : undefined;
  const keyMissing = format === "ssh" && !current.key;
  const blocked = keyMissing && !current.enabled ? t("signing.blocked") : null;
  const sshOptions = [
    ...(current.key ? [] : [{ value: NO_KEY, label: t("signing.noKey"), disabled: true }]),
    ...sshKeys.map((key) => ({ value: slashes(key.publicKeyPath), label: keyLabel(key), disabled: key.missing })),
    ...(current.key && !chosen ? [{ value: current.key, label: t("signing.fromGitConfig", { key: current.key.length > 48 ? `…${current.key.slice(-47)}` : current.key }) }] : []),
  ];
  const inherits = repoId !== null && global.data !== undefined && same(current, global.data);

  return (
    <section data-signing={scope} data-signing-state="ready" aria-labelledby={`signing-title-${scope}`} className={repoId ? undefined : "mt-6"}>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">{title}</div>
        {current.enabled ? (
          <Badge tone="success" icon={<ShieldCheck className="size-3.5" aria-hidden />}>
            {t("signing.on")}
          </Badge>
        ) : (
          <Badge icon={<ShieldOff className="size-3.5" aria-hidden />}>{t("signing.off")}</Badge>
        )}
      </div>
      <p className="text-sm text-text-muted">
        {repoId
          ? t("signing.repoIntro")
          : t("signing.globalIntro")}
        {inherits ? t("signing.sameAsGlobal") : ""}
      </p>

      <SettingRow title={t("signing.format.title")} description={t("signing.format.description")}>
        {(ids) => (
          <div className="w-56">
            <Select
              id={ids.id}
              value={format}
              options={formats}
              onValueChange={(value) => {
                if (value === format) return;
                // The old key does not match the new format; with SSH and no key, signing would stay broken.
                void applySigning(repoId, { enabled: value === "ssh" ? false : current.enabled, format: value, key: null });
              }}
            />
          </div>
        )}
      </SettingRow>

      {format === "ssh" ? (
        <SettingRow
          stacked
          title={t("signing.sshKey.title")}
          description={sshKeys.length === 0 && !current.key ? t("signing.sshKey.none") : t("signing.sshKey.description")}
        >
          {(ids) => (
            <Select
              id={ids.id}
              value={current.key ? (chosen ? slashes(chosen.publicKeyPath) : current.key) : NO_KEY}
              options={sshOptions}
              disabled={sshKeys.length === 0 && !current.key}
              onValueChange={(value) => {
                if (value !== NO_KEY) void applySigning(repoId, { enabled: current.enabled, format, key: value });
              }}
            />
          )}
        </SettingRow>
      ) : (
        <SettingRow
          stacked
          title={format === "x509" ? t("signing.certificate.title") : t("signing.keyId.title")}
          description={format === "x509" ? t("signing.certificate.description") : t("signing.keyId.description")}
        >
          {(ids) => (
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              mono
              placeholder={format === "x509" ? t("signing.certificate.placeholder") : t("signing.keyId.placeholder")}
              value={current.key ?? ""}
              validate={(value) => (/\s/.test(value) ? t("signing.noSpaces") : null)}
              onCommit={async (value) => ((await applySigning(repoId, { enabled: current.enabled, format, key: value || null })).ok ? null : t("signing.notSaved"))}
            />
          )}
        </SettingRow>
      )}

      <SettingRow
        title={t("signing.enable.title")}
        description={blocked ?? (format === "ssh" ? t("signing.enable.ssh") : t("signing.enable.other"))}
      >
        {(ids) => (
          <Switch
            id={ids.id}
            ariaDescribedBy={ids.descriptionId}
            checked={current.enabled}
            disabled={Boolean(blocked)}
            onCheckedChange={(checked) => void applySigning(repoId, { enabled: checked, format: current.format, key: current.key })}
          />
        )}
      </SettingRow>

      <SettingRow
        stacked
        group
        title={t("signing.program.title")}
        description={t("signing.program.description", { config: programConfig[format] })}
      >
        {(ids) => (
          <p aria-labelledby={ids.labelId} data-signing-program className="flex h-control-md items-center rounded-md border border-border bg-surface px-2">
            <Mono>{current.program ?? t("signing.program.default", { program: defaultProgram[format] })}</Mono>
          </p>
        )}
      </SettingRow>

      {repoId && global.data && !inherits ? (
        <div className="flex items-center gap-3 pt-3">
          <p className="min-w-0 flex-1 text-sm text-text-muted">
            {t(global.data.key ? "signing.global.summary" : "signing.global.summaryNoKey", {
              state: global.data.enabled ? t("signing.on") : t("signing.off"),
              format: formats.find((item) => item.value === (global.data.format ?? "openpgp"))?.label,
            })}
          </p>
          <Button
            size="sm"
            icon={<Undo2 className="size-3.5" aria-hidden />}
            data-action="signing-like-global"
            onClick={() => void applySigning(repoId, { enabled: global.data.enabled, format: null, key: null })}
          >
            {t("signing.global.likeGlobal")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
