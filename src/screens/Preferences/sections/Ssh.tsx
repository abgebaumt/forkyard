/**
 * SSH keys: list, generate, register an existing one, copy the public key, set the default,
 * remove an entry, and the switch for the SSH agent.
 */
import { useEffect, useState } from "react";
import { Trans } from "react-i18next";
import { Check, Copy, FileKey, FileWarning, FolderOpen, KeyRound, Lock, LockOpen, Plus, Star, Trash2 } from "lucide-react";
import { core, type Settings, type SshKey } from "../../../core";
import { confirm, promptText } from "../../../app/dialogs";
import { qk, queryClient, useSshKeys } from "../../../app/queries";
import { runAction } from "../../../app/run";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { Banner, toast } from "../../../ui/Feedback";
import { TextField } from "../../../ui/Field";
import { Switch } from "../../../ui/Switch";
import { Badge, GroupTitle, LoadError, Mono, SectionHeader, SettingRow } from "../parts";
import { applySettings } from "../settings";
import { t } from "../../../i18n";

const setKeys = (keys: SshKey[]) => queryClient.setQueryData(qk.sshKeys, keys);

/** "ssh-ed25519 AAAA… comment" → "ED25519". */
export function keyType(publicKey: string): string | null {
  const first = publicKey.trim().split(/\s+/)[0] ?? "";
  if (!first) return null;
  if (first.startsWith("ecdsa-")) return "ECDSA";
  if (first.startsWith("sk-")) return t("preferences.ssh.securityKey");
  return first.replace(/^ssh-/, "").toUpperCase();
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

async function copyPublicKey(key: SshKey) {
  if (!key.publicKey) {
    toast({ tone: "warning", title: t("preferences.ssh.noPublicKey"), description: t("preferences.ssh.noPublicKeyHint", { path: key.publicKeyPath }) });
    return;
  }
  try {
    await navigator.clipboard.writeText(key.publicKey);
    toast({ tone: "success", title: t("preferences.ssh.copied"), description: t("preferences.ssh.copiedHint") });
  } catch {
    toast({ tone: "danger", title: t("preferences.ssh.copyFailed"), description: t("preferences.ssh.copyFailedHint") });
  }
}

async function importKey() {
  const privateKeyPath = await core.pickFile({ title: t("preferences.ssh.import.pickPrivate") });
  if (!privateKeyPath) return;
  const label = await promptText({
    title: t("preferences.ssh.import.title"),
    description: <Mono wrap>{privateKeyPath}</Mono>,
    label: t("preferences.ssh.import.label"),
    initial: baseName(privateKeyPath),
    confirmLabel: t("preferences.ssh.import.confirm"),
  });
  if (!label) return;
  let result = await runAction(t("preferences.ssh.import.action"), () => core.sshKeyImport({ label, privateKeyPath, publicKeyPath: null }), { quiet: ["path_not_found"] });
  if (!result.ok && result.error.code === "path_not_found") {
    // Usually only the .pub file next to the private key is missing: ask for it.
    const again = await confirm({
      title: t("preferences.ssh.import.askPublic"),
      body: result.error.message || t("preferences.ssh.import.noPub"),
      confirmLabel: t("preferences.ssh.import.pickFile"),
    });
    if (!again) return;
    const publicKeyPath = await core.pickFile({ title: t("preferences.ssh.import.pickPublic") });
    if (!publicKeyPath) return;
    result = await runAction(t("preferences.ssh.import.action"), () => core.sshKeyImport({ label, privateKeyPath, publicKeyPath }));
  }
  if (result.ok) {
    setKeys(result.value);
    toast({ tone: "success", title: t("preferences.ssh.import.done", { label }) });
  }
}

export function SshSection({ settings }: { settings: Settings }) {
  const keys = useSshKeys();
  const [generating, setGenerating] = useState(false);
  // Key files change outside the app (deleted, moved): look again when the section opens.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: qk.sshKeys });
  }, []);
  const list = keys.data ?? [];
  const hasDefault = list.some((key) => key.isDefault);

  const actions = (
    <>
      <Button icon={<FolderOpen className="size-icon" aria-hidden />} onClick={() => void importKey()}>
        {t("preferences.ssh.pickExisting")}
      </Button>
      <Button variant={list.length ? "secondary" : "primary"} icon={<Plus className="size-icon" aria-hidden />} onClick={() => setGenerating(true)}>
        {t("preferences.ssh.generate")}
      </Button>
    </>
  );

  return (
    <section>
      <SectionHeader title={t("preferences.ssh.title")}>{t("preferences.ssh.intro")}</SectionHeader>

      <SettingRow
        title={t("preferences.ssh.useAgent.title")}
        description={t("preferences.ssh.useAgent.description")}
      >
        {(ids) => (
          <Switch id={ids.id} ariaDescribedBy={ids.descriptionId} checked={settings.sshUseAgent} onCheckedChange={(checked) => void applySettings({ sshUseAgent: checked })} />
        )}
      </SettingRow>

      {!settings.sshUseAgent && list.length > 0 && !hasDefault ? (
        <div className="mt-3 overflow-hidden rounded-md">
          <Banner tone="warning" title={t("preferences.ssh.noDefault.title")}>
            {t("preferences.ssh.noDefault.body")}
          </Banner>
        </div>
      ) : null}

      <div className="mt-6 mb-2 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <GroupTitle flush id="prefs-ssh-list">
            {list.length ? t("preferences.ssh.listCount", { count: list.length }) : t("preferences.ssh.list")}
          </GroupTitle>
        </div>
        {actions}
      </div>

      {keys.isPending ? (
        <div role="status" aria-label={t("preferences.ssh.loading")} className="animate-pulse rounded-md border border-border p-3">
          <div className="h-4 w-40 rounded-sm bg-surface-raised" />
          <div className="mt-2 h-3 w-96 max-w-full rounded-sm bg-surface-raised" />
          <div className="mt-2 h-3 w-72 max-w-full rounded-sm bg-surface-raised" />
        </div>
      ) : keys.isError ? (
        <LoadError title={t("preferences.loadError.sshKeys")} error={keys.error} onRetry={() => void keys.refetch()} />
      ) : list.length === 0 ? (
        <div data-state="empty" className="rounded-md border border-dashed border-border-input px-4 py-5">
          <div className="flex items-center gap-2">
            <KeyRound className="size-icon text-text-muted" aria-hidden />
            <p className="text-md font-medium text-text">{t("preferences.ssh.empty.title")}</p>
          </div>
          <p className="mt-1 text-base text-text-muted">{t("preferences.ssh.empty.intro")}</p>
          <ol className="mt-2 flex flex-col gap-1 text-base text-text">
            <li className="flex gap-2">
              <StepNumber n={1} />
              <span>
                <Trans i18nKey="preferences.ssh.empty.step1" components={{ strong: <strong className="font-medium" /> }} />
              </span>
            </li>
            <li className="flex gap-2">
              <StepNumber n={2} />
              <span>
                <Trans i18nKey="preferences.ssh.empty.step2" components={{ strong: <strong className="font-medium" /> }} />
              </span>
            </li>
            <li className="flex gap-2">
              <StepNumber n={3} />
              <span>
                <Trans i18nKey="preferences.ssh.empty.step3" components={{ strong: <strong className="font-medium" /> }} />
              </span>
            </li>
          </ol>
        </div>
      ) : (
        <ul aria-labelledby="prefs-ssh-list" className="flex flex-col gap-2">
          {list.map((key) => (
            <KeyCard key={key.id} sshKey={key} agent={settings.sshUseAgent} />
          ))}
        </ul>
      )}

      {generating ? <GenerateDialog existing={list} onClose={() => setGenerating(false)} /> : null}
    </section>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-pill bg-surface-raised text-xs font-semibold text-text-muted">
      {n}
    </span>
  );
}

function KeyCard({ sshKey: key, agent }: { sshKey: SshKey; agent: boolean }) {
  const type = keyType(key.publicKey);

  const makeDefault = async () => {
    const result = await runAction(t("preferences.ssh.makeDefault.action"), () => core.sshKeySetDefault({ id: key.id }));
    if (result.ok) {
      setKeys(result.value);
      toast({
        tone: "success",
        title: t("preferences.ssh.makeDefault.done", { label: key.label }),
        description: agent ? t("preferences.ssh.makeDefault.doneAgent") : undefined,
      });
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t("preferences.ssh.remove.title", { label: key.label }),
      body: (
        <>
          {t("preferences.ssh.remove.body")}
          <Mono wrap className="mt-1 block">
            {key.privateKeyPath}
          </Mono>
        </>
      ),
      confirmLabel: t("preferences.ssh.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    const result = await runAction(t("preferences.ssh.remove.action"), () => core.sshKeyRemove({ id: key.id }), {
      success: t("preferences.ssh.remove.done", { label: key.label }),
    });
    if (result.ok) setKeys(result.value);
  };

  return (
    <li data-key={key.label} className="rounded-md border border-border bg-surface-raised p-3">
      <div className="flex items-center gap-2">
        <FileKey className="size-icon shrink-0 text-text-muted" aria-hidden />
        <p className="min-w-0 truncate text-md font-medium text-text" title={key.label}>
          {key.label}
        </p>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
          {key.isDefault ? (
            <Badge tone="accent" icon={<Star className="size-3" aria-hidden />}>
              {t("preferences.ssh.default")}
            </Badge>
          ) : null}
          {type ? <Badge>{type}</Badge> : null}
          {key.hasPassphrase ? (
            <Badge icon={<Lock className="size-3" aria-hidden />}>{t("preferences.ssh.withPassphrase")}</Badge>
          ) : (
            <Badge icon={<LockOpen className="size-3" aria-hidden />}>{t("preferences.ssh.withoutPassphrase")}</Badge>
          )}
          {key.missing ? (
            <Badge tone="danger" icon={<FileWarning className="size-3" aria-hidden />} title={t("preferences.ssh.fileMissingHint")}>
              {t("preferences.ssh.fileMissing")}
            </Badge>
          ) : null}
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-text-muted">{t("preferences.ssh.fingerprint")}</dt>
        <dd className="min-w-0">{key.fingerprint ? <Mono>{key.fingerprint}</Mono> : <span className="text-text-muted">{t("preferences.ssh.fingerprintUnknown")}</span>}</dd>
        <dt className="text-text-muted">{t("preferences.ssh.private")}</dt>
        <dd className="min-w-0">
          <Mono>{key.privateKeyPath}</Mono>
        </dd>
        <dt className="text-text-muted">{t("preferences.ssh.public")}</dt>
        <dd className="min-w-0">
          <Mono>{key.publicKeyPath}</Mono>
        </dd>
      </dl>

      {key.publicKey ? (
        <pre
          aria-label={t("preferences.ssh.publicKeyLabel", { label: key.label })}
          tabIndex={0}
          className="selectable mt-2 max-h-16 overflow-auto rounded-md border border-border bg-surface-sunken px-2 py-1 font-mono text-code break-all whitespace-pre-wrap text-text"
        >
          {key.publicKey}
        </pre>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" icon={<Copy className="size-3.5" aria-hidden />} disabled={!key.publicKey} onClick={() => void copyPublicKey(key)}>
          {t("preferences.ssh.copyPublic")}
        </Button>
        {key.isDefault ? null : (
          <Button size="sm" variant="ghost" icon={<Star className="size-3.5" aria-hidden />} disabled={key.missing} onClick={() => void makeDefault()}>
            {t("preferences.ssh.useAsDefault")}
          </Button>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="hover:text-danger" icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => void remove()}>
          {t("preferences.ssh.removeEntry")}
        </Button>
      </div>
    </li>
  );
}

function GenerateDialog({ existing, onClose }: { existing: SshKey[]; onClose: () => void }) {
  const taken = new Set(existing.map((key) => baseName(key.privateKeyPath).toLowerCase()));
  const [label, setLabel] = useState("");
  const [fileName, setFileName] = useState(() => {
    if (!taken.has("id_ed25519")) return "id_ed25519";
    let index = 2;
    while (taken.has(`id_ed25519_${index}`)) index++;
    return `id_ed25519_${index}`;
  });
  const [passphrase, setPassphrase] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ label?: string; fileName?: string; passphrase?: string; repeat?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const next: typeof errors = {};
    if (!label.trim()) next.label = t("preferences.ssh.dialog.labelMissing");
    if (!fileName.trim()) next.fileName = t("preferences.ssh.dialog.fileEmpty");
    else if (/[\\/:*?"<>|]/.test(fileName)) next.fileName = t("preferences.ssh.dialog.fileChars");
    else if (/\.pub$/i.test(fileName.trim())) next.fileName = t("preferences.ssh.dialog.filePub");
    if (passphrase && passphrase.length < 5) next.passphrase = t("preferences.ssh.dialog.passphraseShort");
    else if (passphrase !== repeat) next.repeat = t("preferences.ssh.dialog.repeatMismatch");
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length) return;

    setBusy(true);
    const result = await runAction(
      t("preferences.ssh.generate"),
      () => core.sshKeyGenerate({ label: label.trim(), fileName: fileName.trim(), passphrase: passphrase || null }),
      { quiet: ["path_exists", "invalid_name", "not_allowed", "unsupported", "io", "name_exists", "timeout"] },
    );
    setBusy(false);
    if (result.ok) {
      setKeys(result.value);
      toast({ tone: "success", title: t("preferences.ssh.dialog.done", { label: label.trim() }), description: t("preferences.ssh.dialog.doneHint") });
      onClose();
      return;
    }
    const { code, message } = result.error;
    if (code === "path_exists") setErrors({ fileName: t("preferences.ssh.dialog.fileExists") });
    else if (code === "invalid_name") setErrors(/Bezeichnung/.test(message) ? { label: message } : { fileName: message });
    else if (code === "not_allowed" && /Passphrase/.test(message)) setErrors({ passphrase: message });
    else setFailure(message || t("preferences.ssh.dialog.failed"));
  };

  return (
    <Dialog
      open
      size="md"
      title={t("preferences.ssh.dialog.title")}
      description={t("preferences.ssh.dialog.description")}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("preferences.ssh.dialog.cancel")}
          </Button>
          <Button variant="primary" loading={busy} icon={<Check className="size-icon" aria-hidden />} onClick={() => void submit()}>
            {t("preferences.ssh.generate")}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {failure ? (
          <div className="overflow-hidden rounded-md">
            <Banner tone="danger" title={t("preferences.ssh.dialog.notCreated")}>
              <span className="selectable">{failure}</span>
            </Banner>
          </div>
        ) : null}
        <TextField
          autoFocus
          data-autofocus
          label={t("preferences.ssh.dialog.label")}
          value={label}
          error={errors.label}
          hint={t("preferences.ssh.dialog.labelHint")}
          placeholder={t("preferences.ssh.dialog.labelPlaceholder")}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
        />
        <TextField
          label={t("preferences.ssh.dialog.fileName")}
          mono
          value={fileName}
          error={errors.fileName}
          hint={t("preferences.ssh.dialog.fileNameHint")}
          autoComplete="off"
          onChange={(event) => setFileName(event.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t("preferences.ssh.dialog.passphrase")}
            type="password"
            value={passphrase}
            error={errors.passphrase}
            hint={t("preferences.ssh.dialog.passphraseHint")}
            autoComplete="new-password"
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <TextField
            label={t("preferences.ssh.dialog.repeat")}
            type="password"
            value={repeat}
            error={errors.repeat}
            autoComplete="new-password"
            onChange={(event) => setRepeat(event.target.value)}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
