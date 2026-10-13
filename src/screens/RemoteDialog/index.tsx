/**
 * Add or edit a remote. Name and fetch URL, optionally a separate push URL, then fetch right away
 * if wanted. When editing, the remote can also be removed.
 */
import { useEffect, useState } from "react";
import { Cloud, FolderClosed, Globe, Trash2 } from "lucide-react";
import { core, type Id, type Remote, type RemoteHost } from "../../core";
import { fetchAll } from "../../app/actions/sync";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { qk, queryClient, useRemotes } from "../../app/queries";
import { runAction } from "../../app/run";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner, toast } from "../../ui/Feedback";
import { Checkbox, TextField } from "../../ui/Field";
import { describeError } from "../../app/errors";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Detect the host from the URL (only for the badge at the field; the core is authoritative)
// ---------------------------------------------------------------------------

const hostNames: Record<Exclude<RemoteHost, "other">, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
};

export interface DetectedHost {
  kind: RemoteHost | "local";
  /** Badge text, e.g. "GitHub" or the server name. */
  label: string;
}

/** `https://github.com/a/b.git`, `ssh://git@host:22/a`, `git@host:a/b.git`, `C:\pfad`, `/pfad`, `file:///pfad`. */
export function detectHost(url: string): DetectedHost | null {
  const text = url.trim();
  if (!text) return null;
  if (/^file:\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^[\\/.~]/.test(text)) return { kind: "local", label: t("remotes.host.localPath") };
  let host: string | null = null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^/:\s]+)/i.exec(text);
  if (withScheme) host = withScheme[1] ?? null;
  else {
    const scpLike = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)/.exec(text);
    if (scpLike) host = scpLike[1] ?? null;
  }
  if (!host || !host.includes(".")) return null;
  const name = host.toLowerCase();
  if (name === "github.com" || name.endsWith(".github.com")) return { kind: "github", label: hostNames.github };
  if (name === "gitlab.com" || name.startsWith("gitlab.")) return { kind: "gitlab", label: hostNames.gitlab };
  if (name === "bitbucket.org" || name.startsWith("bitbucket.")) return { kind: "bitbucket", label: hostNames.bitbucket };
  if (name === "dev.azure.com" || name.endsWith(".dev.azure.com") || name.endsWith(".visualstudio.com")) return { kind: "azure", label: hostNames.azure };
  return { kind: "other", label: host };
}

function HostBadge({ host }: { host: DetectedHost | null }) {
  if (!host) return null;
  const Icon = host.kind === "local" ? FolderClosed : host.kind === "other" ? Globe : Cloud;
  return (
    <span
      data-host={host.kind}
      title={host.kind === "other" ? t("remotes.host.server", { host: host.label }) : host.kind === "local" ? t("remotes.host.local") : t("remotes.host.detected", { host: host.label })}
      className="inline-flex h-4 max-w-40 shrink-0 items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 text-xs font-medium text-text-muted"
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{host.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Checks before submitting
// ---------------------------------------------------------------------------

function checkName(name: string, others: string[]): string | null {
  if (!name) return t("remotes.validation.nameMissing");
  if (/\s/.test(name)) return t("remotes.validation.nameSpaces");
  if (/\.\.|[~^:?*[\\]|@\{/.test(name)) return t("remotes.validation.nameChars");
  if (/^[-/.]|[/.]$|\.lock$|\/\//.test(name)) return t("remotes.validation.nameEdges");
  if (others.includes(name)) return t("remotes.validation.nameExists", { name });
  return null;
}

function checkUrl(url: string): string | null {
  if (!url) return t("remotes.validation.urlMissing");
  if (/\s/.test(url) && !detectLocal(url)) return t("remotes.validation.urlSpaces");
  return null;
}

const detectLocal = (url: string) => detectHost(url)?.kind === "local";

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function RemoteDialog({ repoId, edit, onClose }: { repoId: Id; edit?: string; onClose: () => void }) {
  const remotes = useRemotes(repoId);
  const original = edit ? remotes.data?.find((remote) => remote.name === edit) : undefined;
  const ready = remotes.isSuccess && (!edit || Boolean(original));

  const [name, setName] = useState(edit ?? "");
  const [fetchUrl, setFetchUrl] = useState("");
  const [usePush, setUsePush] = useState(false);
  const [pushUrl, setPushUrl] = useState("");
  const [fetchAfter, setFetchAfter] = useState(!edit);
  const [errors, setErrors] = useState<{ name?: string; fetchUrl?: string; pushUrl?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [filled, setFilled] = useState(false);

  // Fill the fields once the remotes are there: when editing with their values, otherwise with "origin" if free.
  useEffect(() => {
    if (filled || !remotes.isSuccess) return;
    if (edit) {
      if (!original) return;
      setName(original.name);
      setFetchUrl(original.fetchUrl);
      setUsePush(original.pushUrl !== null);
      setPushUrl(original.pushUrl ?? "");
    } else if (!remotes.data.some((remote) => remote.name === "origin")) {
      setName("origin");
    }
    setFilled(true);
  }, [filled, remotes.isSuccess, remotes.data, edit, original]);

  const others = (remotes.data ?? []).map((remote) => remote.name).filter((other) => other !== edit);
  const title = edit ? t("remotes.editTitle", { name: edit }) : t("remotes.add");
  const masked = fetchUrl.includes("***") || (usePush && pushUrl.includes("***"));

  const setRemotes = (list: Remote[]) => queryClient.setQueryData(qk.remotes(repoId), list);

  const submit = async () => {
    if (busy || !ready) return;
    const cleanName = name.trim();
    const cleanFetch = fetchUrl.trim();
    const cleanPush = usePush ? pushUrl.trim() : "";
    const next: typeof errors = {};
    const nameProblem = checkName(cleanName, others);
    if (nameProblem) next.name = nameProblem;
    const urlProblem = checkUrl(cleanFetch);
    if (urlProblem) next.fetchUrl = urlProblem;
    if (usePush) {
      const pushProblem = cleanPush ? checkUrl(cleanPush) : t("remotes.validation.pushMissing");
      if (pushProblem) next.pushUrl = pushProblem;
    }
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length) return;

    setBusy("save");
    const push = cleanPush && cleanPush !== cleanFetch ? cleanPush : null;
    const result = await runAction(
      edit ? t("remotes.save") : t("remotes.add"),
      () => (edit ? core.remoteEdit({ repoId, name: edit, newName: cleanName, fetchUrl: cleanFetch, pushUrl: push }) : core.remoteAdd({ repoId, name: cleanName, fetchUrl: cleanFetch, pushUrl: push })),
      { quiet: ["invalid_name", "name_exists", "not_allowed", "not_found"] },
    );
    setBusy(null);
    if (!result.ok) {
      const { code, message } = result.error;
      if (code === "invalid_name" || code === "name_exists") setErrors({ name: message || describeError(result.error).text });
      else if (code === "not_allowed" && !usePush) setErrors({ fetchUrl: message || t("remotes.validation.urlRejected") });
      else if (code === "not_allowed" || code === "not_found") setFailure(message || describeError(result.error).text);
      return;
    }
    setRemotes(result.value);
    toast({ tone: "success", title: edit ? t("remotes.saved", { name: cleanName }) : t("remotes.added", { name: cleanName }) });
    onClose();
    if (fetchAfter) void fetchAll(repoId, cleanName);
  };

  const remove = async () => {
    if (!edit || busy) return;
    const ok = await confirm({
      title: t("remotes.remove.title", { name: edit }),
      body: t("remotes.remove.body", { name: edit }),
      confirmLabel: t("remotes.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    setBusy("remove");
    const result = await runAction(t("remotes.remove.confirm"), () => core.remoteRemove({ repoId, name: edit }));
    setBusy(null);
    if (!result.ok) return;
    setRemotes(result.value);
    void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
    void queryClient.invalidateQueries({ queryKey: qk.refs(repoId) });
    toast({ tone: "success", title: t("remotes.remove.done", { name: edit }), action: { label: t("remotes.remove.undo"), onClick: () => void undo(repoId) } });
    onClose();
  };

  return (
    <Dialog
      open
      size="md"
      title={title}
      description={edit ? t("remotes.editDescription") : t("remotes.addDescription")}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      footer={
        <div className="flex w-full items-center gap-2" data-screen="remote-dialog">
          {edit ? (
            <Button
              variant="ghost"
              className="text-danger"
              icon={<Trash2 className="size-icon" aria-hidden />}
              disabled={!ready || busy === "save"}
              loading={busy === "remove"}
              onClick={() => void remove()}
            >
              {t("remotes.remove.confirm")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button onClick={onClose} disabled={Boolean(busy)}>
            {t("remotes.cancel")}
          </Button>
          <Button variant="primary" disabled={!ready || busy === "remove"} loading={busy === "save"} onClick={() => void submit()}>
            {edit ? t("remotes.saveButton") : t("remotes.add")}
          </Button>
        </div>
      }
    >
      {remotes.isPending ? (
        <div role="status" aria-label={t("remotes.loading")} className="flex animate-pulse flex-col gap-4">
          {[0, 1].map((row) => (
            <div key={row}>
              <div className="h-3 w-24 rounded-sm bg-surface-raised" />
              <div className="mt-2 h-control-md rounded-md bg-surface-raised" />
            </div>
          ))}
        </div>
      ) : remotes.isError ? (
        <div className="overflow-hidden rounded-md">
          <Banner tone="danger" title={t("remotes.loadFailed")} actions={<Button size="sm" onClick={() => void remotes.refetch()}>{t("remotes.retry")}</Button>}>
            <span className="selectable">{describeError(remotes.error).text}</span>
          </Banner>
        </div>
      ) : edit && !original ? (
        <div className="overflow-hidden rounded-md">
          <Banner tone="warning" title={t("remotes.gone.title", { name: edit })}>
            {t("remotes.gone.body")}
          </Banner>
        </div>
      ) : (
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
              <Banner tone="danger" title={edit ? t("remotes.notSaved") : t("remotes.notAdded")}>
                <span className="selectable">{failure}</span>
              </Banner>
            </div>
          ) : null}
          <TextField
            autoFocus
            data-autofocus
            label={t("remotes.name.label")}
            mono
            value={name}
            error={errors.name}
            hint={edit ? undefined : t("remotes.name.hint")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value.replace(/\s+/g, "-"));
              if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
          />
          <div className="relative">
            <TextField
              label={t("remotes.fetchUrl.label")}
              mono
              value={fetchUrl}
              error={errors.fetchUrl}
              hint={t("remotes.fetchUrl.hint")}
              placeholder={t("remotes.fetchUrl.placeholder")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => {
                setFetchUrl(event.target.value);
                if (errors.fetchUrl) setErrors((current) => ({ ...current, fetchUrl: undefined }));
              }}
            />
            <div className="absolute top-0 right-0">
              <HostBadge host={detectHost(fetchUrl)} />
            </div>
          </div>
          <Checkbox
            label={t("remotes.pushUrl.toggle")}
            hint={t("remotes.pushUrl.toggleHint")}
            checked={usePush}
            onCheckedChange={(checked) => {
              setUsePush(checked);
              if (!checked) setErrors((current) => ({ ...current, pushUrl: undefined }));
            }}
          />
          {usePush ? (
            <div className="relative ml-6">
              <TextField
                label={t("remotes.pushUrl.label")}
                mono
                value={pushUrl}
                error={errors.pushUrl}
                placeholder={t("remotes.fetchUrl.placeholder")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(event) => {
                  setPushUrl(event.target.value);
                  if (errors.pushUrl) setErrors((current) => ({ ...current, pushUrl: undefined }));
                }}
              />
              <div className="absolute top-0 right-0">
                <HostBadge host={detectHost(pushUrl)} />
              </div>
            </div>
          ) : null}
          {masked ? (
            <p className="text-sm text-text-muted">
              {t("remotes.masked")}
            </p>
          ) : null}
          <div className="border-t border-border pt-3">
            <Checkbox
              label={edit ? t("remotes.fetchAfterSave") : t("remotes.fetchAfterAdd")}
              hint={t("remotes.fetchAfterHint")}
              checked={fetchAfter}
              onCheckedChange={setFetchAfter}
            />
          </div>
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
