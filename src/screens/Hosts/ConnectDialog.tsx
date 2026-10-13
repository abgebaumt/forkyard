/**
 * "Connect account" dialog: pick the host, for a self-hosted instance its address, paste the token.
 * Above that it says exactly where to create the token at the host and which permissions it needs.
 *
 * The token lives only in the password field (no value in UI state, no `value` attribute in the
 * document). "Connect" passes it to the core; the field is cleared immediately in every case.
 */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, KeyRound, ShieldAlert } from "lucide-react";
import { accountHost, connectAccount, hostBusyKeys, openInBrowser, parseBaseUrl, tokenPageUrl } from "../../app/actions/hosts";
import { hostKindLabels, type HostAccountInfo, type HostErrorText, type HostKind } from "../../app/actions/hostTypes";
import { showDialog } from "../../app/dialogs";
import { useAppInfo } from "../../app/queries";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner } from "../../ui/Feedback";
import { SegmentedControl, TextField } from "../../ui/Field";
import { instanceLabels, tokenGuides } from "./model";
import { t } from "../../i18n";

export interface ConnectPreset {
  kind?: HostKind;
  /** Address of a self-hosted instance; null = the public service. */
  baseUrl?: string | null;
  /** Replace the token of an existing account: host and instance are fixed. */
  replace?: HostAccountInfo;
}

function Guide({ kind, baseUrl }: { kind: HostKind; baseUrl: string | null }) {
  const guide = tokenGuides[kind];
  const page = tokenPageUrl(kind, baseUrl);
  return (
    <section aria-label={t("hosts.guide.title")} data-token-guide={kind} className="rounded-md border border-border bg-surface-sunken p-3">
      <h3 className="text-base font-medium text-text">{t("hosts.guide.title")}</h3>
      <p className="mt-1 text-sm text-text-muted">
        {t("hosts.guide.path", { host: hostKindLabels[kind], path: guide.path.join(" › ") })}
      </p>
      {guide.variants.map((variant) => (
        <div key={variant.title} className="mt-2">
          <p className="text-sm font-medium text-text">{variant.title}</p>
          <p className="text-sm text-text-muted">{variant.intro}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {variant.permissions.map((permission) => (
              <li key={permission.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <code className="selectable rounded-sm bg-surface-raised px-1 font-mono text-code text-text">{permission.name}</code>
                <span className="min-w-0 text-text-muted">{permission.why}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {guide.notes.map((note) => (
        <p key={note} className="mt-2 text-sm text-text-muted">
          {note}
        </p>
      ))}
      <div className="mt-2">
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />} onClick={() => void openInBrowser(page, t("hosts.guide.tokenPage"))}>
          {t("hosts.guide.openTokenPage")}
        </Button>
      </div>
    </section>
  );
}

function ConnectDialog({ preset, onDone }: { preset: ConnectPreset; onDone: (account: HostAccountInfo | null) => void }) {
  const replace = preset.replace ?? null;
  const [kind, setKind] = useState<HostKind>(replace?.kind ?? preset.kind ?? "github");
  const presetBase = replace ? replace.baseUrl : (preset.baseUrl ?? null);
  const [own, setOwn] = useState(presetBase !== null);
  const [address, setAddress] = useState(presetBase ?? "");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [failure, setFailure] = useState<HostErrorText | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const busy = useBusy(hostBusyKeys.connect);
  const keyring = useAppInfo().data?.keyringAvailable;
  const labels = instanceLabels[kind];

  const tokenField = () => form.current?.elements.namedItem("token") as HTMLInputElement | null;

  // Focus starts at the first field (the host choice), not on the close button. One frame later,
  // because the dialog's focus trap focuses once more itself when mounting.
  useEffect(() => {
    if (replace) return;
    const frame = requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="radio"][data-state="on"]')?.focus());
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const parsedBase = own ? parseBaseUrl(address) : { url: null, error: null };
  const guideBase = own ? parsedBase.url : null;

  const submit = async () => {
    if (busy) return;
    const field = tokenField();
    const token = field?.value.trim() ?? "";
    setFailure(null);
    let baseUrl: string | null = null;
    if (own) {
      const parsed = parseBaseUrl(address);
      if (parsed.error !== null) {
        setAddressError(parsed.error);
        form.current?.querySelector<HTMLInputElement>('input[name="baseUrl"]')?.focus();
        return;
      }
      baseUrl = parsed.url;
    }
    if (!token) {
      setTokenError(t("hosts.connect.pasteToken"));
      field?.focus();
      return;
    }
    // The field is cleared immediately: afterwards the token is nowhere in the UI anymore.
    if (field) field.value = "";
    setHasToken(false);
    const result = await connectAccount({ kind, baseUrl, token });
    if (result.ok) {
      onDone(result.account);
      return;
    }
    setFailure(result.error);
    tokenField()?.focus();
  };

  return (
    <Dialog
      open
      size="md"
      title={replace ? t("hosts.connect.replaceTitle") : t("hosts.connect.title")}
      description={
        replace
          ? t("hosts.connect.replaceDescription", { host: `${hostKindLabels[replace.kind]} – ${accountHost(replace)}` })
          : t("hosts.connect.description")
      }
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      footer={
        <>
          <Button disabled={busy} onClick={() => onDone(null)}>
            {t("hosts.connect.cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {busy ? t("hosts.connect.checking") : replace ? t("hosts.connect.replace") : t("hosts.connect.submit")}
          </Button>
        </>
      }
    >
      <form
        ref={form}
        data-screen="hosts-connect"
        className="flex flex-col gap-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {keyring === false ? (
          <div className="overflow-hidden rounded-md" data-state="no-keyring">
            <Banner tone="warning" title={t("hosts.section.noKeyringTitle")}>
              {t("hosts.connect.noKeyring")}
            </Banner>
          </div>
        ) : null}

        {replace ? null : (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-text-muted">{t("hosts.connect.host")}</span>
              <SegmentedControl
                label={t("hosts.connect.host")}
                value={kind}
                options={[
                  { value: "github", label: "GitHub" },
                  { value: "gitlab", label: "GitLab" },
                ]}
                onValueChange={(next) => {
                  setKind(next);
                  setFailure(null);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-text-muted">{t("hosts.connect.instance")}</span>
              <SegmentedControl
                label={t("hosts.connect.instance")}
                value={own ? "own" : "public"}
                options={[
                  { value: "public", label: labels.public },
                  { value: "own", label: labels.own },
                ]}
                onValueChange={(next) => {
                  setOwn(next === "own");
                  setAddressError(null);
                  setFailure(null);
                }}
              />
            </div>
          </div>
        )}

        {own && !replace ? (
          <TextField
            name="baseUrl"
            label={t("hosts.connect.address")}
            value={address}
            mono
            placeholder={labels.placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            hint={labels.ownHint}
            error={addressError ?? undefined}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
          />
        ) : null}

        <Guide kind={kind} baseUrl={guideBase} />

        {/* Uncontrolled and without a value in state: React would also write a controlled field's value into the document as an attribute. */}
        <TextField
          name="token"
          type="password"
          label={t("hosts.connect.token")}
          mono
          // Without the WebView's "reveal" button: the token must not become readable even while typing.
          className="[&::-ms-clear]:hidden [&::-ms-reveal]:hidden"
          data-autofocus={replace ? "" : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={hasToken ? undefined : t("hosts.connect.tokenPlaceholder")}
          hint={t("hosts.connect.tokenHint")}
          error={tokenError ?? undefined}
          onChange={(event) => {
            setHasToken(event.target.value.length > 0);
            setTokenError(null);
          }}
        />

        {failure ? (
          <div
            // The dialog scrolls and the message sits below the long instructions: bring it into view after the click.
            ref={(node) => node?.scrollIntoView({ block: "nearest" })}
            role="alert"
            data-connect-error={failure.kind}
            className="flex items-start gap-2 rounded-md border border-border bg-danger-surface p-3"
          >
            {failure.kind === "auth" ? <KeyRound className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden /> : <ShieldAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />}
            <div className="min-w-0">
              <p className="font-medium text-text">{failure.title}</p>
              <p className="selectable text-sm break-words text-text-muted">{failure.hint ? `${failure.text} ${failure.hint}` : failure.text}</p>
            </div>
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** Opens the dialog; returns the connected account, or null on cancel. */
export function openConnectDialog(preset: ConnectPreset = {}): Promise<HostAccountInfo | null> {
  return showDialog<HostAccountInfo>((done) => <ConnectDialog preset={preset} onDone={done} />);
}
