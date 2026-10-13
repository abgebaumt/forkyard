/**
 * "Apply patch": paste text or pick a file, Git checks immediately whether it applies (without
 * changing anything), and only then can it be applied. If it does not apply, each file says why.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { ClipboardPaste, FileUp, Loader2, X } from "lucide-react";
import { core, type CoreError, type Id } from "../../core";
import { undo } from "../../app/actions/undo";
import { describeError, toCoreError } from "../../app/errors";
import { qk, queryClient, useRepo, useStatus } from "../../app/queries";
import { withStatus } from "../../app/statusCache";
import { useAppStore } from "../../app/store";
import { Button, IconButton } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner, toast } from "../../ui/Feedback";
import { TextArea } from "../../ui/Field";
import { locale, t } from "../../i18n";
import { formatSize, parseApplyErrors, parsePatch } from "./model";
import { PatchFileList } from "./parts";

/** The dialog rejects larger files – a patch of that size is almost always a mistake. */
const MAX_BYTES = 20 * 1024 * 1024;
const CHECK_DELAY_MS = 350;

type Check =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; text: string }
  | { state: "failed"; text: string; error: CoreError };

export function ApplyPatchDialog({ repoId, tabId, onClose }: { repoId: Id; tabId: Id | null; onClose: () => void }) {
  const { data: repo } = useRepo(repoId);
  const { data: status } = useStatus(repoId);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [inputNote, setInputNote] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [applying, setApplying] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const areaId = useId();
  const focusArea = () => document.getElementById(areaId)?.focus();
  const run = useRef(0);

  const hasText = text.trim().length > 0;
  const info = useMemo(() => (hasText ? parsePatch(text) : null), [text, hasText]);
  const conflicts = status?.conflicted.length ?? 0;

  // Check as soon as the text has been still for a moment. Git changes nothing doing so (`checkOnly`).
  useEffect(() => {
    const id = ++run.current;
    if (!hasText) {
      setCheck({ state: "idle" });
      return;
    }
    setCheck({ state: "checking" });
    const timer = window.setTimeout(() => {
      core.patchApply({ repoId, text, checkOnly: true }).then(
        () => {
          if (id === run.current) setCheck({ state: "ok", text });
        },
        (error: unknown) => {
          if (id === run.current) setCheck({ state: "failed", text, error: toCoreError(error) });
        },
      );
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [repoId, text, hasText]);

  const take = (next: string, name: string | null) => {
    setText(next);
    setFileName(name);
    setInputNote(null);
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setInputNote(t("patches.apply.tooLarge", { name: file.name, size: formatSize(file.size), max: formatSize(MAX_BYTES) }));
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.includes(0)) {
        setInputNote(t("patches.apply.notText", { name: file.name }));
        return;
      }
      take(new TextDecoder("utf-8").decode(bytes), file.name);
    } catch {
      setInputNote(t("patches.apply.unreadable", { name: file.name }));
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) setInputNote(t("patches.apply.clipboardEmpty"));
      else take(clip, null);
    } catch {
      setInputNote(t("patches.apply.clipboardFailed"));
      focusArea();
    }
  };

  const apply = async () => {
    if (check.state !== "ok" || check.text !== text || applying) return;
    setApplying(true);
    try {
      await withStatus(repoId, () => core.patchApply({ repoId, text, checkOnly: false }))();
      void queryClient.invalidateQueries({ queryKey: qk.diffAll(repoId) });
      if (tabId) useAppStore.getState().selectWip(tabId);
      const count = info?.files.length ?? 0;
      // If the core creates an undo step for applying, the toast offers it right away.
      const undoState = await core.undoPeek({ repoId }).catch(() => null);
      if (undoState) queryClient.setQueryData(qk.undo(repoId), undoState);
      toast({
        tone: "success",
        title: t("patches.apply.applied"),
        description: t("patches.apply.appliedText", { count }),
        action: undoState?.undo && /Patch/i.test(undoState.undo.label) ? { label: t("patches.apply.undo"), onClick: () => void undo(repoId) } : undefined,
      });
      onClose();
    } catch (error) {
      // Something changed between check and apply: the result is now shown in the dialog.
      setCheck({ state: "failed", text, error: toCoreError(error) });
    } finally {
      setApplying(false);
    }
  };

  const reasons = useMemo(() => (check.state === "failed" ? parseApplyErrors(check.error.gitOutput) : undefined), [check]);
  const failedCount = reasons && info ? info.files.filter((file) => reasons.has(file.path) || (file.oldPath !== null && reasons.has(file.oldPath))).length : 0;
  const current = (check.state === "ok" || check.state === "failed") && check.text === text;
  const applyBlocked = !hasText
    ? t("patches.apply.blocked.empty")
    : check.state === "checking" || !current
      ? t("patches.apply.blocked.checking")
      : check.state === "failed"
        ? t("patches.apply.blocked.failed")
        : null;

  return (
    <Dialog
      open
      size="lg"
      title={t("patches.apply.title")}
      description={
        <Trans
          i18nKey="patches.apply.description"
          values={{ repo: repo?.alias ?? repo?.name ?? t("patches.apply.thisRepo") }}
          components={{ strong: <strong className="font-medium text-text" /> }}
        />
      }
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{t("patches.apply.cancel")}</Button>
          <Button
            variant="primary"
            loading={applying}
            data-action="patch-apply"
            aria-disabled={applyBlocked ? true : undefined}
            title={applyBlocked ?? undefined}
            className="aria-disabled:cursor-default aria-disabled:bg-surface-raised aria-disabled:text-text-disabled aria-disabled:hover:brightness-100"
            onClick={() => void apply()}
          >
            {t("patches.apply.submit")}
          </Button>
        </>
      }
    >
      <form
        data-screen="patch-apply"
        data-check-state={current || check.state === "idle" ? check.state : "checking"}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        {conflicts > 0 ? (
          <div className="shrink-0 overflow-hidden rounded-md">
            <Banner tone="warning" title={t("patches.apply.conflicts.title")}>
              {t("patches.apply.conflicts.text")}
            </Banner>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<FileUp className="size-icon" aria-hidden />} onClick={() => fileInput.current?.click()}>
            {t("patches.apply.chooseFile")}
          </Button>
          <Button icon={<ClipboardPaste className="size-icon" aria-hidden />} onClick={() => void pasteFromClipboard()}>
            {t("patches.apply.fromClipboard")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".patch,.diff,.txt,text/plain"
            aria-label={t("patches.apply.fileInput")}
            tabIndex={-1}
            className="sr-only"
            data-patch-file-input
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {fileName ? (
            <span className="flex min-w-0 items-center gap-1 rounded-sm border border-border bg-surface-raised pl-2 text-sm text-text" data-patch-file-name>
              <span className="truncate font-mono text-code" title={fileName}>
                {fileName}
              </span>
              <IconButton
                size="xs"
                label={t("patches.apply.clearFile")}
                icon={<X className="size-3.5" aria-hidden />}
                onClick={() => {
                  take("", null);
                  focusArea();
                }}
              />
            </span>
          ) : null}
        </div>
        {inputNote ? (
          <p role="alert" className="text-sm text-danger" data-patch-input-note>
            {inputNote}
          </p>
        ) : null}

        <TextArea
          id={areaId}
          label={t("patches.apply.textLabel")}
          data-autofocus
          rows={9}
          value={text}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
          placeholder={t("patches.apply.placeholder")}
          className="resize-none! font-mono text-code"
          onChange={(event) => take(event.target.value, null)}
          onPaste={(event) => {
            // If the paste replaces the whole content, the text stays unchanged (including Windows line endings,
            // which a text field would otherwise normalise – the patch would then no longer fit CRLF files).
            const field = event.currentTarget;
            const pasted = event.clipboardData.getData("text/plain");
            if (pasted && field.selectionStart === 0 && field.selectionEnd === field.value.length) {
              event.preventDefault();
              take(pasted, null);
            }
          }}
        />

        <div aria-live="polite" data-patch-result className="flex min-h-10 flex-col gap-2">
          {check.state === "idle" ? <p className="text-sm text-text-muted">{t("patches.apply.idle")}</p> : null}
          {check.state === "checking" || (check.state !== "idle" && !current) ? (
            <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 className="size-icon animate-spin" aria-hidden />
              {t("patches.apply.checking")}
            </p>
          ) : null}
          {check.state === "ok" && current && info ? (
            <>
              <div className="shrink-0 overflow-hidden rounded-md">
                <Banner tone="success" title={t("patches.apply.fits", { count: info.files.length })}>
                  <span className="font-mono">
                    +{info.added.toLocaleString(locale())} −{info.removed.toLocaleString(locale())}
                  </span>
                  {info.subject ? (
                    <>
                      {" "}
                      · {t("patches.apply.fromCommit", { subject: info.subject })}
                      {info.author ? t("patches.apply.byAuthor", { author: info.author.replace(/\s*<[^>]*>$/, "") }) : ""}
                      {t("patches.apply.noCommit")}
                    </>
                  ) : null}
                </Banner>
              </div>
              <PatchFileList files={info.files} checked label={t("patches.apply.filesLabel")} className="max-h-36 shrink-0" />
            </>
          ) : null}
          {check.state === "failed" && current ? (
            <>
              <div className="shrink-0 overflow-hidden rounded-md">
                <Banner
                  tone="danger"
                  title={
                    info && info.files.length > 0 && failedCount > 0
                      ? t("patches.apply.notFitting", { failed: failedCount, count: info.files.length })
                      : t("patches.apply.cannotApply")
                  }
                >
                  <span className="selectable" data-patch-error>
                    {describeError(check.error).text}
                  </span>{" "}
                  {t("patches.apply.nothingChanged")}
                </Banner>
              </div>
              {info && info.files.length > 0 ? <PatchFileList files={info.files} reasons={reasons} checked label={t("patches.apply.resultLabel")} className="max-h-36 shrink-0" /> : null}
            </>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}
