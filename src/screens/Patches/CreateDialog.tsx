/**
 * "Create patch": shows what is in the patch (files, lines, preview), names the files that are
 * missing (binary or not UTF-8), and puts it on the clipboard or into a file.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trans } from "react-i18next";
import { ClipboardCopy, FileDiff, RefreshCw, Save } from "lucide-react";
import { core, EMPTY_TREE_SHA, type DiffSource, type Id } from "../../core";
import { openExternal } from "../../app/actions/files";
import { describeError } from "../../app/errors";
import { useAppInfo, useRepo, useStatus } from "../../app/queries";
import { showError } from "../../app/run";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner, EmptyState, toast } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { DetailList } from "../../app/dialogs";
import { locale, t } from "../../i18n";
import { formatSize, parsePatch, suggestFileName } from "./model";
import { PatchFileList, PatchPreview, PatchSkeleton } from "./parts";
import { savePatchFile } from "./save";

export interface PatchRequest {
  /** What the patch is made from. With `wip` the dialog itself chooses between staged, unstaged and both. */
  source: DiffSource | "wip";
  /** Only these files; null = everything. */
  paths: string[] | null;
  /** What this is, as a phrase for the header: "Commit a1b2c3d · Fix typo". */
  what: string;
  /** For the file name: the commit's summary, the stash's name, the branch. */
  nameHint: string | null;
}

type Scope = "unstaged" | "staged" | "all";

const scopeLabels: Record<Scope, string> = { unstaged: t("patches.create.scope.unstaged"), staged: t("patches.create.scope.staged"), all: t("patches.create.scope.all") };

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CreatePatchDialog({ repoId, request, onClose }: { repoId: Id; request: PatchRequest; onClose: () => void }) {
  const { data: status } = useStatus(repoId);
  const { data: repo } = useRepo(repoId);
  const { data: appInfo } = useAppInfo();
  const wip = request.source === "wip";
  const unstaged = status?.unstaged.length ?? 0;
  const staged = status?.staged.length ?? 0;
  const untracked = status?.unstaged.filter((file) => file.status === "untracked").length ?? 0;
  const head = status?.head;

  const [chosen, setChosen] = useState<Scope | null>(null);
  const scope: Scope = chosen ?? (unstaged > 0 && staged > 0 ? "all" : staged > 0 ? "staged" : "unstaged");
  const source: DiffSource | null = useMemo(() => {
    if (request.source !== "wip") return request.source;
    if (!status) return null;
    if (scope === "all") return { kind: "range", from: head && head.kind !== "unborn" ? head.sha : EMPTY_TREE_SHA, to: null };
    return { kind: scope };
  }, [request.source, scope, status, head]);

  const patch = useQuery({
    queryKey: ["repo", repoId, "patch", source, request.paths] as const,
    queryFn: () => core.patchCreate({ repoId, source: source!, paths: request.paths }),
    enabled: source !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const info = useMemo(() => (patch.data ? parsePatch(patch.data.text) : null), [patch.data]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);

  const text = patch.data?.text ?? "";
  const skipped = patch.data?.skipped ?? [];
  const ready = patch.isSuccess && text.length > 0 && !patch.isFetching;
  const blocked = patch.isPending || patch.isFetching ? t("patches.create.blocked.loading") : patch.isError ? t("patches.create.blocked.error") : text.length === 0 ? t("patches.create.blocked.empty") : null;
  const state = patch.isPending || patch.isFetching ? "loading" : patch.isError ? "error" : text.length === 0 ? "empty" : "ready";

  const copy = async () => {
    if (!ready) return;
    if (await copyToClipboard(text)) {
      toast({ tone: "success", title: t("patches.create.copied"), description: `${t("patches.create.files", { count: info?.files.length ?? 0 })} · ${formatSize(new Blob([text]).size)}` });
      onClose();
    } else {
      setNote({ title: t("patches.create.notCopied"), text: t("patches.create.notCopiedText") });
    }
  };

  const saveFile = async () => {
    if (!ready || !repo || saving) return;
    setSaving(true);
    setNote(null);
    try {
      const outcome = await savePatchFile({
        repoId,
        repoPath: repo.path,
        text,
        fileName: suggestFileName(source ?? { kind: "unstaged" }, request.nameHint),
        windows: appInfo?.platform === "windows",
      });
      if (outcome.status === "refused") setNote({ title: t("patches.create.notSaved"), text: outcome.reason });
      else if (outcome.status === "saved") {
        toast({
          tone: "success",
          title: t("patches.create.saved"),
          description: outcome.path,
          action: { label: t("patches.create.showInFileManager"), onClick: () => void openExternal(repoId, "file_manager", outcome.relative) },
        });
        onClose();
      }
    } catch (error) {
      showError(t("patches.save.title"), error);
    } finally {
      setSaving(false);
    }
  };

  const showScope = wip && unstaged > 0 && staged > 0;
  const size = text ? formatSize(new Blob([text]).size) : null;

  return (
    <Dialog
      open
      size="lg"
      title={t("patches.create.title")}
      description={
        <>
          <Trans i18nKey="patches.create.from" values={{ what: request.what }} components={{ strong: <strong className="font-medium text-text" /> }} />
          {request.paths ? (request.paths.length === 1 ? t("patches.create.onlyThisFile") : t("patches.create.onlyFiles", { count: request.paths.length })) : ""}
        </>
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{t("patches.create.close")}</Button>
          <Button
            icon={<Save className="size-icon" aria-hidden />}
            loading={saving}
            data-action="patch-save"
            aria-disabled={blocked ? true : undefined}
            title={blocked ?? undefined}
            className="aria-disabled:cursor-default aria-disabled:text-text-disabled"
            onClick={() => void saveFile()}
          >
            {t("patches.create.saveAs")}
          </Button>
          <Button
            variant="primary"
            icon={<ClipboardCopy className="size-icon" aria-hidden />}
            data-autofocus
            data-action="patch-copy"
            aria-disabled={blocked ? true : undefined}
            title={blocked ?? undefined}
            className="aria-disabled:cursor-default aria-disabled:bg-surface-raised aria-disabled:text-text-disabled aria-disabled:hover:brightness-100"
            onClick={() => void copy()}
          >
            {t("patches.create.copy")}
          </Button>
        </>
      }
    >
      <div data-screen="patch-create" data-patch-state={state} className="flex flex-col gap-3">
        {showScope ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <SegmentedControl
              label={t("patches.create.scope.label")}
              value={scope}
              options={(["all", "unstaged", "staged"] as Scope[]).map((key) => ({
                value: key,
                label: key === "all" ? scopeLabels.all : t("patches.create.scope.withCount", { label: scopeLabels[key], count: key === "unstaged" ? unstaged : staged }),
              }))}
              onValueChange={(value) => {
                setChosen(value);
                setNote(null);
              }}
            />
            {scope === "all" && untracked > 0 ? (
              <p className="text-sm text-text-muted" data-patch-untracked-note>
                {t("patches.create.untracked", { count: untracked })}
              </p>
            ) : null}
          </div>
        ) : null}

        {state === "loading" ? <PatchSkeleton /> : null}

        {state === "error" ? (
          <Banner
            tone="danger"
            title={t("patches.create.error")}
            actions={
              <Button size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => void patch.refetch()}>
                {t("patches.create.retry")}
              </Button>
            }
          >
            <span className="selectable">{describeError(patch.error).text}</span>
          </Banner>
        ) : null}

        {state === "empty" ? (
          <EmptyState icon={<FileDiff className="size-6" aria-hidden />} title={skipped.length ? t("patches.create.noText") : t("patches.create.nothing")}>
            {skipped.length
              ? t("patches.create.noTextHint")
              : t("patches.create.nothingHint")}
          </EmptyState>
        ) : null}

        {state === "ready" && info ? (
          <>
            <p className="flex flex-wrap items-center gap-x-2 text-base text-text" data-patch-summary>
              <FileDiff className="size-icon text-text-muted" aria-hidden />
              <span className="font-medium">{t("patches.create.files", { count: info.files.length })}</span>
              <span className="font-mono text-sm">
                <span className="text-success">+{info.added.toLocaleString(locale())}</span> <span className="text-danger">−{info.removed.toLocaleString(locale())}</span>
              </span>
              <span className="text-text-muted">
                · {t("patches.create.lines", { count: info.lines.length })} · {size}
              </span>
              {info.subject ? <span className="text-text-muted">{t("patches.create.withAuthor")}</span> : null}
            </p>
            <PatchFileList files={info.files} label={t("patches.create.filesLabel")} className="max-h-28 shrink-0" />
          </>
        ) : null}

        {skipped.length > 0 ? (
          <div data-patch-skipped className="shrink-0 overflow-hidden rounded-md">
            <Banner tone="warning" title={t("patches.create.skipped", { count: skipped.length })}>
              {t("patches.create.skippedText")}
              <DetailList items={skipped} className="mt-2" />
            </Banner>
          </div>
        ) : null}

        {state === "ready" && info ? <PatchPreview info={info} className="max-h-64" /> : null}

        {note ? (
          <div data-patch-note className="shrink-0 overflow-hidden rounded-md">
            <Banner tone="warning" title={note.title}>
              {note.text}
            </Banner>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
