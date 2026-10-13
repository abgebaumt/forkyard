import { useId, useState } from "react";
import { Trans } from "react-i18next";
import { Copy, KeyRound, Server } from "lucide-react";
import { core, type CredentialKind, type CredentialRequest } from "../../core";
import { Button, IconButton } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { Checkbox, TextField } from "../../ui/Field";
import { copyText } from "../actions/clipboard";
import { toCoreError } from "../errors";
import { qk, queryClient } from "../queries";
import { showError } from "../run";
import { useAppStore } from "../store";
import { t } from "../../i18n";

/** Answer the core expects as consent for `host_key`. */
export const HOST_KEY_ACCEPT = "yes";

const titles: Record<CredentialKind, string> = {
  username: t("shell.credential.title.username"),
  password: t("shell.credential.title.password"),
  passphrase: t("shell.credential.title.passphrase"),
  host_key: t("shell.credential.title.hostKey"),
};

const fieldLabels: Record<Exclude<CredentialKind, "host_key">, string> = {
  username: t("shell.credential.field.username"),
  password: t("shell.credential.field.password"),
  passphrase: t("shell.credential.field.passphrase"),
};

/**
 * Answers prompts from Git and SSH (credential:request) one after another: username, password,
 * passphrase, host fingerprint. Cancel sends `value: null`; "remember" is only offered if the
 * keychain is reachable.
 */
export function CredentialHost() {
  const request = useAppStore((state) => state.credentialQueue[0]);
  const waiting = useAppStore((state) => state.credentialQueue.length);
  if (!request) return null;
  return <CredentialDialog key={request.requestId} request={request} waiting={waiting - 1} />;
}

function CredentialDialog({ request, waiting }: { request: CredentialRequest; waiting: number }) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [sending, setSending] = useState(false);
  const resolve = useAppStore((state) => state.resolveCredential);
  const fieldName = useId();

  const answer = async (answerValue: string | null) => {
    if (sending) return;
    setSending(true);
    try {
      await core.credentialAnswer({ requestId: request.requestId, value: answerValue, remember: answerValue !== null && remember && request.canRemember });
      // Remembered only after a successful sign-in; the list in the preferences then reloads.
      if (answerValue !== null && remember) void queryClient.invalidateQueries({ queryKey: qk.credentials });
    } catch (error) {
      // Orphaned: Git has given up in the meantime (timeout, cancelled). Then there is nothing left to answer.
      if (toCoreError(error).code !== "not_found") showError(t("shell.credential.answerAction"), error);
    } finally {
      resolve(request.requestId);
    }
  };

  const hostKey = request.kind === "host_key";
  const secret = request.kind === "password" || request.kind === "passphrase";
  const host = request.host.trim();
  const queue = waiting > 0 ? ` ${t("shell.credential.queue", { count: waiting })}` : "";
  const strong = <strong className="font-medium text-text" />;
  const hostPart = host ? strong : <span />;
  const hostName = host || t("shell.credential.theRemote");

  const description = hostKey ? (
    <>
      <Trans i18nKey="shell.credential.desc.hostKey" values={{ host: host || t("shell.credential.thisHost") }} components={{ host: strong }} />
      {queue}
    </>
  ) : request.kind === "passphrase" ? (
    <>
      {t("shell.credential.desc.passphrase")}
      {queue}
    </>
  ) : request.kind === "username" ? (
    <>
      <Trans i18nKey="shell.credential.desc.username" values={{ host: hostName }} components={{ host: hostPart }} />
      {queue}
    </>
  ) : (
    <>
      <Trans
        i18nKey={request.username ? "shell.credential.desc.passwordUser" : "shell.credential.desc.password"}
        values={{ host: hostName, user: request.username }}
        components={{ host: hostPart, user: strong }}
      />
      {queue}
    </>
  );

  // The core delivers the fingerprint in `detail`; if it is missing (newer ssh versions phrase the question
  // differently), it is in the question itself. Only if none is found there either, ssh's full text appears.
  const hostKeyText = request.detail ?? request.prompt;
  const fingerprint = /\b(?:SHA256|MD5):[A-Za-z0-9+/=:]+/.exec(hostKeyText)?.[0] ?? hostKeyText;
  const hostKeyType = /\b([A-Z][A-Z0-9-]+) key fingerprint/.exec(request.prompt)?.[1] ?? null;
  // For the key file the name matters; the folder before it may be truncated.
  const keyFile = request.kind === "passphrase" && request.detail ? /^(.*[\\/])([^\\/]+)$/.exec(request.detail) : null;

  return (
    <Dialog
      open
      size="sm"
      title={titles[request.kind]}
      description={description}
      onOpenChange={(open) => {
        if (!open) void answer(null);
      }}
      footer={
        hostKey ? (
          <>
            {/* Focus is on "Cancel": Enter never accidentally trusts a foreign host. */}
            <Button autoFocus data-autofocus disabled={sending} onClick={() => void answer(null)}>
              {t("ui.cancel")}
            </Button>
            <Button variant="danger" loading={sending} onClick={() => void answer(HOST_KEY_ACCEPT)}>
              {t("shell.credential.trustHost")}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={sending} onClick={() => void answer(null)}>
              {t("ui.cancel")}
            </Button>
            <Button variant="primary" loading={sending} disabled={!value} onClick={() => void answer(value)}>
              {request.kind === "username" ? t("shell.credential.next") : t("shell.credential.signIn")}
            </Button>
          </>
        )
      }
    >
      {hostKey ? (
        <div data-credential="host_key" className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-md">
            <Banner tone="warning" title={t("shell.credential.compareTitle")}>
              {t("shell.credential.compareText")}
            </Banner>
          </div>
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-text-muted">
              <Server className="size-3.5" aria-hidden />
              {t("shell.credential.fingerprintOf", { host: host || t("shell.credential.theHost") })}
              {hostKeyType ? <span className="font-normal">· {hostKeyType}</span> : null}
            </span>
            <div className="flex items-start gap-1">
              <code data-fingerprint className="selectable block min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-2 py-1.5 font-mono text-code break-all text-text">
                {fingerprint}
              </code>
              <IconButton size="md" label={t("shell.credential.copyFingerprint")} icon={<Copy className="size-icon" aria-hidden />} onClick={() => void copyText(fingerprint, t("shell.credential.fingerprint"))} />
            </div>
          </div>
        </div>
      ) : (
        <form
          data-credential={request.kind}
          className="flex flex-col gap-3"
          // No browser password manager, no history: credentials belong only in the system keychain.
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (value) void answer(value);
          }}
        >
          {request.kind === "passphrase" && request.detail ? (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <KeyRound className="size-icon shrink-0" aria-hidden />
              <span className="selectable flex min-w-0 font-mono text-code" title={request.detail}>
                {keyFile ? (
                  <>
                    <span className="truncate">{keyFile[1]}</span>
                    <span className="shrink-0 font-medium text-text">{keyFile[2]}</span>
                  </>
                ) : (
                  <span className="truncate">{request.detail}</span>
                )}
              </span>
            </div>
          ) : null}
          <TextField
            autoFocus
            data-autofocus
            type={secret && !reveal ? "password" : "text"}
            name={`gc-${fieldName}`}
            label={fieldLabels[request.kind as Exclude<CredentialKind, "host_key">]}
            value={value}
            mono={secret && reveal}
            autoComplete={secret ? "new-password" : "off"}
            autoCorrect="off"
            autoCapitalize="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            disabled={sending}
            onChange={(event) => setValue(event.target.value)}
            hint={request.prompt && request.prompt !== request.host ? t("shell.credential.gitAsks", { prompt: request.prompt }) : undefined}
          />
          {secret ? <Checkbox label={t("shell.credential.reveal")} checked={reveal} onCheckedChange={setReveal} /> : null}
          {request.canRemember ? (
            <Checkbox
              label={t("shell.credential.remember")}
              checked={remember}
              onCheckedChange={setRemember}
              hint={t("shell.credential.rememberHint")}
            />
          ) : null}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
