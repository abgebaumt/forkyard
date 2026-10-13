/**
 * Dialogs for worktrees: "Create worktree" (pick a folder; new branch from a start point, existing
 * branch or detached) and "Lock" with an optional reason.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { core, type Id, type Ref, type Worktree } from "../../core";
import { normalizeRefName, refNameValidator } from "../../app/actions/branches";
import { addWorktree, folderName, openWorktree, samePath } from "../../app/actions/worktrees";
import { showDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { shortSha } from "../../app/format";
import { useRefs, useRepo, useWorktrees } from "../../app/queries";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner, toast } from "../../ui/Feedback";
import { Checkbox, SegmentedControl, TextField } from "../../ui/Field";
import { Select, type SelectOption } from "../../ui/Select";
import { t } from "../../i18n";
import { folderNameError, isAbsolutePath, joinPath, parentOf } from "../CloneDialog/paths";
import { WrappingPath } from "../CloneDialog/PathText";
import { branchBlock, suggestFolder } from "./model";

type Mode = "new" | "existing" | "detached";
type FieldName = "name" | "existing" | "parent" | "folder";

export interface WorktreePreset {
  /** Local branch in question (from the branch menu). */
  branch?: string;
}

const HEAD = "HEAD";
/** A select list shows no more entries than this; the rest is reachable by name in the "New branch" field. */
const MAX_OPTIONS = 400;

const modeHints: Record<Mode, string> = {
  new: t("worktrees.dialog.modeHint.new"),
  existing: t("worktrees.dialog.modeHint.existing"),
  detached: t("worktrees.dialog.modeHint.detached"),
};

function WorktreeDialog({ repoId, preset, onDone }: { repoId: Id; preset?: WorktreePreset; onDone: (value: true | null) => void }) {
  const formId = useId();
  const refs = useRefs(repoId);
  const worktrees = useWorktrees(repoId);
  const { data: repo } = useRepo(repoId);

  const main = worktrees.data?.find((item) => item.isMain);
  const basePath = main?.path ?? repo?.path ?? "";
  const repoName = basePath ? folderName(basePath) : (repo?.name ?? "");

  // The worktree list knows most precisely where a branch is checked out; the refs can be a moment older.
  const locals = useMemo(() => {
    const elsewhere = new Map((worktrees.data ?? []).filter((item) => item.branch && !item.isCurrent).map((item) => [item.branch!, item.path]));
    return (refs.data?.locals ?? []).map((ref) => (ref.worktreePath || ref.isHead || !elsewhere.has(ref.name) ? ref : { ...ref, worktreePath: elsewhere.get(ref.name)! }));
  }, [refs.data, worktrees.data]);
  const presetRef = preset?.branch ? locals.find((ref) => ref.name === preset.branch) : undefined;
  const presetFree = presetRef ? branchBlock(presetRef) === null : false;

  const [mode, setMode] = useState<Mode>(preset?.branch && presetFree ? "existing" : "new");
  const [name, setName] = useState("");
  const [start, setStart] = useState<string>(HEAD);
  const [existing, setExisting] = useState<string>(preset?.branch ?? "");
  const [detachedAt, setDetachedAt] = useState<string>(HEAD);
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const [openAfter, setOpenAfter] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [coreFailure, setCoreFailure] = useState<{ field: FieldName | null; text: string } | null>(null);
  const parentTouched = useRef(false);
  const folderTouched = useRef(false);
  const seeded = useRef(false);
  const check = useRef(0);

  // Defaults once the data is there: folder next to the main folder, start point from the branch menu.
  useEffect(() => {
    if (!parentTouched.current && basePath) setParent((current) => current || parentOf(basePath));
  }, [basePath]);
  useEffect(() => {
    if (seeded.current || !refs.data || !worktrees.data) return;
    seeded.current = true;
    if (presetRef && !presetFree) setStart(presetRef.fullName);
    if (!presetRef) {
      const firstFree = locals.find((ref) => branchBlock(ref) === null);
      if (firstFree) setExisting(firstFree.name);
    }
  }, [refs.data, worktrees.data, locals, presetRef, presetFree]);

  const allRefs = useMemo(() => [...(refs.data?.locals ?? []), ...(refs.data?.remotes ?? []), ...(refs.data?.tags ?? [])], [refs.data]);
  const byFullName = useMemo(() => new Map(allRefs.map((ref) => [ref.fullName, ref])), [allRefs]);
  const head = refs.data?.head;
  const headLabel = head
    ? head.kind === "branch"
      ? t("worktrees.dialog.head.branch", { branch: head.branch })
      : head.kind === "detached"
        ? t("worktrees.dialog.head.branch", { branch: shortSha(head.sha) })
        : t("worktrees.dialog.head.unborn")
    : t("worktrees.dialog.head.plain");
  const unborn = head?.kind === "unborn";

  const pointOptions = useMemo<SelectOption[]>(() => {
    const label = (ref: Ref) => (ref.kind === "tag" ? t("worktrees.dialog.tagOption", { name: ref.name }) : ref.kind === "remote" ? t("worktrees.dialog.remoteOption", { name: ref.name }) : ref.name);
    return [{ value: HEAD, label: headLabel }, ...allRefs.slice(0, MAX_OPTIONS).map((ref) => ({ value: ref.fullName, label: label(ref) }))];
  }, [allRefs, headLabel]);
  const existingOptions = useMemo<SelectOption[]>(
    () =>
      locals.slice(0, MAX_OPTIONS).map((ref) => {
        const blocked = branchBlock(ref);
        return { value: ref.name, label: blocked ? t("worktrees.dialog.blockedOption", { name: ref.name, reason: blocked }) : ref.name, disabled: Boolean(blocked) };
      }),
    [locals],
  );
  const freeBranches = locals.filter((ref) => branchBlock(ref) === null);
  const existingRef = locals.find((ref) => ref.name === existing);
  const existingBlocked = existingRef ? branchBlock(existingRef) : null;

  // The folder name follows what is checked out until it has been changed by hand.
  const targetLabel =
    mode === "new" ? name.trim() : mode === "existing" ? existing : detachedAt === HEAD ? (head && head.kind !== "unborn" ? shortSha(head.sha) : "") : (byFullName.get(detachedAt)?.name ?? "");
  useEffect(() => {
    if (!folderTouched.current) setFolder(suggestFolder(repoName, targetLabel));
  }, [repoName, targetLabel]);

  // Check the branch name while typing against Git's rules and existing names.
  const validate = useMemo(() => refNameValidator(repoId, "branch"), [repoId]);
  useEffect(() => {
    const id = ++check.current;
    const value = name.trim();
    if (mode !== "new" || !value) {
      setNameProblem(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void validate(value).then((reason) => {
        if (id === check.current) setNameProblem(reason);
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [name, mode, validate]);

  const target = parent.trim() && folder ? joinPath(parent, folder) : "";
  const taken = target ? worktrees.data?.find((item) => samePath(item.path, target)) : undefined;
  const failureAt = (field: FieldName) => (coreFailure?.field === field ? coreFailure.text : null);
  const errors: Record<FieldName, string | null> = {
    name: mode !== "new" ? null : name.trim() ? (nameProblem ?? failureAt("name")) : submitted ? t("worktrees.dialog.errors.nameRequired") : null,
    existing:
      mode !== "existing"
        ? null
        : existingBlocked
          ? t(existingRef?.isHead ? "worktrees.dialog.errors.checkedOutHere" : "worktrees.dialog.errors.checkedOutElsewhere", { name: existing })
          : !existing && submitted
            ? t("worktrees.dialog.errors.branchRequired")
            : failureAt("existing"),
    parent: parent.trim()
      ? isAbsolutePath(parent)
        ? failureAt("parent")
        : t("worktrees.dialog.errors.parentAbsolute")
      : submitted
        ? t("worktrees.dialog.errors.parentRequired")
        : null,
    folder: folder ? (folderNameError(folder) ?? (taken ? t("worktrees.dialog.errors.taken") : null) ?? failureAt("folder")) : submitted ? t("worktrees.dialog.errors.folderRequired") : null,
  };

  const clearFailure = (field: FieldName) => {
    if (coreFailure && (coreFailure.field === field || coreFailure.field === null)) setCoreFailure(null);
  };

  const browse = async () => {
    const picked = await core.pickFolder({ title: t("worktrees.dialog.pickTitle"), defaultPath: parent.trim() || undefined });
    if (!picked) return;
    parentTouched.current = true;
    setParent(picked);
    clearFailure("parent");
    clearFailure("folder");
  };

  const submit = async () => {
    if (busy || !refs.data) return;
    setSubmitted(true);
    const order: FieldName[] = ["name", "existing", "parent", "folder"];
    const missing: Record<FieldName, boolean> = {
      name: mode === "new" && !name.trim(),
      existing: mode === "existing" && !existing,
      parent: !parent.trim(),
      folder: !folder,
    };
    // A core message at the field does not block the next attempt (the folder may be empty by now).
    const firstBad = order.find((field) => missing[field] || (errors[field] !== null && errors[field] !== failureAt(field)));
    if (firstBad) {
      document.getElementById(`${formId}-${firstBad}`)?.focus();
      return;
    }
    if (mode === "new") {
      const reason = await validate(name.trim());
      if (reason) {
        setNameProblem(reason);
        document.getElementById(`${formId}-name`)?.focus();
        return;
      }
    }

    const point = (value: string) => (value === HEAD ? null : (byFullName.get(value) ?? null));
    const detachedRef = point(detachedAt);
    const detachedSha = detachedRef ? detachedRef.sha : head && head.kind !== "unborn" ? head.sha : null;
    if (mode === "detached" && !detachedSha) {
      setCoreFailure({ field: null, text: t("worktrees.dialog.errors.noCommit") });
      return;
    }
    const input =
      mode === "new"
        ? { path: target, branch: name.trim(), newBranch: true, start: point(start)?.fullName ?? null }
        : mode === "existing"
          ? { path: target, branch: existing, newBranch: false, start: null }
          : { path: target, branch: detachedSha!, newBranch: false, start: null };

    setBusy(true);
    setCoreFailure(null);
    const result = await addWorktree(repoId, input);
    setBusy(false);
    if (!result.ok) {
      const { code, message } = result.error;
      const text = message || describeError(result.error).text;
      const field: FieldName | null =
        code === "path_exists" ? "folder" : code === "path_not_found" ? "parent" : code === "invalid_name" || code === "name_exists" ? "name" : code === "not_allowed" && mode === "existing" ? "existing" : null;
      setCoreFailure({
        field,
        text: code === "path_exists" ? t("worktrees.dialog.errors.pathExists") : code === "path_not_found" ? t("worktrees.dialog.errors.pathNotFound") : text,
      });
      if (field) window.requestAnimationFrame(() => document.getElementById(`${formId}-${field}`)?.focus());
      return;
    }
    const created = result.value.find((item) => samePath(item.path, target)) ?? null;
    const label = folderName(target);
    onDone(true);
    if (created && openAfter) {
      toast({ tone: "success", title: t("worktrees.dialog.createdOpened", { name: label }) });
      void openWorktree(created);
    } else {
      toast({
        tone: "success",
        title: t("worktrees.dialog.created", { name: label }),
        action: created ? { label: t("worktrees.dialog.openInTab"), onClick: () => void openWorktree(created) } : undefined,
      });
    }
  };

  const loading = refs.isPending || worktrees.isPending;
  const loadError = refs.isError ? refs.error : worktrees.isError && !worktrees.data ? worktrees.error : null;

  return (
    <Dialog
      open
      size="md"
      title={t("worktrees.dialog.title")}
      description={t("worktrees.dialog.description")}
      onOpenChange={(open) => {
        if (!open && !busy) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)} disabled={busy}>
            {t("worktrees.dialog.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={loading || Boolean(loadError) || unborn}>
            {t("worktrees.dialog.title")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        data-screen="worktree"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {loading ? (
          <div role="status" aria-label={t("worktrees.dialog.loading")} className="flex animate-pulse flex-col gap-4">
            {[0, 1, 2].map((row) => (
              <div key={row}>
                <div className="h-3 w-24 rounded-sm bg-surface-raised" />
                <div className="mt-2 h-control-md rounded-md bg-surface-raised" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="overflow-hidden rounded-md">
            <Banner
              tone="danger"
              title={t("worktrees.dialog.loadError")}
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    void refs.refetch();
                    void worktrees.refetch();
                  }}
                >
                  {t("worktrees.dialog.retry")}
                </Button>
              }
            >
              <span className="selectable">{describeError(loadError).text}</span>
            </Banner>
          </div>
        ) : unborn ? (
          <div className="overflow-hidden rounded-md">
            <Banner tone="info" title={t("worktrees.dialog.unborn.title")}>
              {t("worktrees.dialog.unborn.text")}
            </Banner>
          </div>
        ) : (
          <>
            {coreFailure && coreFailure.field === null ? (
              <div className="overflow-hidden rounded-md" data-worktree-error>
                <Banner tone="danger" title={t("worktrees.dialog.failed")}>
                  <span className="selectable">{coreFailure.text}</span>
                </Banner>
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-text-muted">{t("worktrees.dialog.mode.label")}</span>
              <div>
                <SegmentedControl
                  label={t("worktrees.dialog.mode.label")}
                  value={mode}
                  options={[
                    { value: "new", label: t("worktrees.dialog.mode.new") },
                    { value: "existing", label: t("worktrees.dialog.mode.existing") },
                    { value: "detached", label: t("worktrees.dialog.mode.detached") },
                  ]}
                  onValueChange={(next) => {
                    setMode(next);
                    setCoreFailure(null);
                  }}
                />
              </div>
              <p className="text-sm text-text-muted">{modeHints[mode]}</p>
            </div>

            {mode === "new" ? (
              <div className="grid grid-cols-2 gap-3">
                <TextField
                  id={`${formId}-name`}
                  data-autofocus
                  autoFocus
                  label={t("worktrees.dialog.name.label")}
                  mono
                  value={name}
                  placeholder={t("worktrees.dialog.name.placeholder")}
                  error={errors.name ?? undefined}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => {
                    setName(normalizeRefName(event.target.value));
                    clearFailure("name");
                  }}
                />
                <Select label={t("worktrees.dialog.start")} value={byFullName.has(start) || start === HEAD ? start : HEAD} options={pointOptions} onValueChange={setStart} />
              </div>
            ) : mode === "existing" ? (
              freeBranches.length === 0 ? (
                <div className="overflow-hidden rounded-md">
                  <Banner tone="info" title={t("worktrees.dialog.noFree.title")}>
                    {t("worktrees.dialog.noFree.text")}
                  </Banner>
                </div>
              ) : (
                <Select
                  id={`${formId}-existing`}
                  label={t("worktrees.dialog.branch")}
                  value={existing}
                  options={existingOptions}
                  placeholder={t("worktrees.dialog.branchPlaceholder")}
                  error={errors.existing ?? undefined}
                  onValueChange={(value) => {
                    setExisting(value);
                    clearFailure("existing");
                  }}
                />
              )
            ) : (
              <Select
                label={t("worktrees.dialog.commitFrom")}
                value={byFullName.has(detachedAt) || detachedAt === HEAD ? detachedAt : HEAD}
                options={pointOptions}
                hint={t("worktrees.dialog.commitHint")}
                onValueChange={setDetachedAt}
              />
            )}

            <div className="flex items-start gap-2 border-t border-border pt-3">
              <div className="min-w-0 flex-1">
                <TextField
                  id={`${formId}-parent`}
                  label={t("worktrees.dialog.parent.label")}
                  mono
                  value={parent}
                  placeholder={t("worktrees.dialog.parent.placeholder")}
                  error={errors.parent ?? undefined}
                  autoComplete="off"
                  onChange={(event) => {
                    parentTouched.current = true;
                    setParent(event.target.value);
                    clearFailure("parent");
                    clearFailure("folder");
                  }}
                />
              </div>
              <Button className="mt-5" icon={<FolderOpen className="size-icon" aria-hidden />} onClick={() => void browse()}>
                {t("worktrees.dialog.browse")}
              </Button>
            </div>
            <TextField
              id={`${formId}-folder`}
              label={t("worktrees.dialog.folder.label")}
              mono
              value={folder}
              placeholder={t("worktrees.dialog.folder.placeholder")}
              error={errors.folder ?? undefined}
              autoComplete="off"
              onChange={(event) => {
                folderTouched.current = event.target.value !== "";
                setFolder(event.target.value);
                clearFailure("folder");
              }}
            />
            <p data-worktree-target className="text-sm text-text-muted">
              {target ? (
                <>
                  {t("worktrees.dialog.target")} <WrappingPath path={target} className="text-text" />
                </>
              ) : (
                t("worktrees.dialog.targetEmpty")
              )}
            </p>

            <div className="border-t border-border pt-3">
              <Checkbox label={t("worktrees.dialog.openAfter")} checked={openAfter} onCheckedChange={setOpenAfter} />
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}

/** Opens "Create worktree". Returns true if one was created. */
export function openWorktreeDialog(repoId: Id, preset?: WorktreePreset): Promise<boolean> {
  return showDialog<true>((done) => <WorktreeDialog repoId={repoId} preset={preset} onDone={done} />).then((value) => value === true);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function LockDialog({ worktree, onDone }: { worktree: Worktree; onDone: (value: { reason: string } | null) => void }) {
  const [reason, setReason] = useState(worktree.lockReason ?? "");
  const name = folderName(worktree.path);
  return (
    <Dialog
      open
      size="sm"
      title={worktree.isLocked ? t("worktrees.lock.titleChange", { name }) : t("worktrees.lock.title", { name })}
      description={t("worktrees.lock.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("worktrees.dialog.cancel")}</Button>
          <Button variant="primary" type="submit" form="worktree-lock-form">
            {worktree.isLocked ? t("worktrees.lock.saveReason") : t("worktrees.lock.lock")}
          </Button>
        </>
      }
    >
      <form
        id="worktree-lock-form"
        onSubmit={(event) => {
          event.preventDefault();
          onDone({ reason: reason.trim() });
        }}
      >
        <TextField
          autoFocus
          data-autofocus
          label={t("worktrees.lock.reason.label")}
          value={reason}
          placeholder={t("worktrees.lock.reason.placeholder")}
          hint={t("worktrees.lock.reason.hint")}
          maxLength={200}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setReason(event.target.value.replace(/[\r\n]+/g, " "))}
        />
      </form>
    </Dialog>
  );
}

/** Asks for the lock reason. null = cancelled; an empty text means "without reason". */
export function askLockReason(worktree: Worktree): Promise<{ reason: string } | null> {
  return showDialog<{ reason: string }>((done) => <LockDialog worktree={worktree} onDone={done} />);
}
