import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { core, type CoreError, type ErrorCode } from "../../core";
import { showOutput } from "../../app/dialogs";
import { errorInfo } from "../../app/errors";
import { qk, queryClient, useInitTemplates, useRepos, useSettings } from "../../app/queries";
import { runAction } from "../../app/run";
import { useBusy } from "../../app/store";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Banner, toast } from "../../ui/Feedback";
import { Checkbox, TextField } from "../../ui/Field";
import { Select, type SelectOption } from "../../ui/Select";
import { branchNameError, folderNameError, isAbsolutePath, joinPath, parentOf, pathKey, rememberParent, rememberedParent } from "../CloneDialog/paths";
import { WrappingPath } from "../CloneDialog/PathText";
import { clearInitPreset, peekInitPreset } from "./preset";
import { t } from "../../i18n";

export interface InitDialogProps {
  onClose: () => void;
}

type FieldName = "name" | "parent" | "branch";

const ALL_CODES = Object.keys(errorInfo) as ErrorCode[];
const NONE = "none";
const BUSY_KEY = "app:init";

/** Create a new repository. */
export function InitDialog({ onClose }: InitDialogProps) {
  const formId = useId();
  const [preset] = useState(peekInitPreset);
  useEffect(() => clearInitPreset, []);

  const { data: settings } = useSettings();
  const { data: repos } = useRepos();
  const templates = useInitTemplates();
  const busy = useBusy(BUSY_KEY);

  const [name, setName] = useState(preset?.name ?? "");
  const [parent, setParent] = useState(() => preset?.parent ?? rememberedParent());
  const parentTouched = useRef(parent !== "");
  const [branch, setBranch] = useState("");
  const branchTouched = useRef(false);
  const [gitignore, setGitignore] = useState(NONE);
  const [license, setLicense] = useState(NONE);
  const [readme, setReadme] = useState(true);

  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<CoreError | null>(null);
  const [fieldFailure, setFieldFailure] = useState<{ field: FieldName; text: string } | null>(null);

  // Default from the settings, as long as the field has not been touched.
  const defaultBranch = settings?.defaultBranchName;
  useEffect(() => {
    if (!branchTouched.current && defaultBranch) setBranch(defaultBranch);
  }, [defaultBranch]);

  const newestRepoPath = repos?.find((repo) => !repo.missing)?.path;
  useEffect(() => {
    if (parentTouched.current || !newestRepoPath) return;
    setParent((current) => current || parentOf(newestRepoPath));
  }, [newestRepoPath]);

  // Set focus only after rendering: fields that are just being (re)mounted would otherwise take focus back via autoFocus.
  const [focusRequest, setFocusRequest] = useState<{ field: FieldName; at: number } | null>(null);
  const focusField = (field: FieldName) => setFocusRequest({ field, at: Date.now() });
  useEffect(() => {
    if (focusRequest) document.getElementById(`${formId}-${focusRequest.field}`)?.focus();
  }, [focusRequest, formId]);
  const failureFor = (field: FieldName) => (fieldFailure?.field === field ? fieldFailure.text : null);

  const target = parent.trim() && name ? joinPath(parent, name) : "";
  const knownAtTarget = target ? repos?.find((repo) => pathKey(repo.path) === pathKey(target)) : undefined;

  const errors: Record<FieldName, string | null> = {
    name: name
      ? (folderNameError(name) ??
        (knownAtTarget ? t("clone.validation.repoAtTarget", { name: knownAtTarget.alias ?? knownAtTarget.name }) : null) ??
        failureFor("name"))
      : submitted
        ? t("init.validation.nameMissing")
        : null,
    parent: parent.trim()
      ? isAbsolutePath(parent)
        ? failureFor("parent")
        : t("clone.validation.parentNotAbsolute")
      : submitted
        ? t("init.validation.parentMissing")
        : null,
    branch: branch.trim() ? (branchNameError(branch.trim()) ?? failureFor("branch")) : submitted ? t("init.validation.branchMissing") : null,
  };

  const browse = async () => {
    const picked = await core.pickFolder({ title: t("init.pickFolderTitle"), defaultPath: parent.trim() || undefined });
    if (!picked) return;
    parentTouched.current = true;
    setParent(picked);
    setFieldFailure(null);
  };

  const submit = async () => {
    if (busy) return;
    setSubmitted(true);
    const required: Record<FieldName, boolean> = { name: !name, parent: !parent.trim(), branch: !branch.trim() };
    const order: FieldName[] = ["name", "parent", "branch"];
    const firstBad = order.find((field) => required[field] || (errors[field] !== null && errors[field] !== failureFor(field)));
    if (firstBad) {
      focusField(firstBad);
      return;
    }
    rememberParent(parent);
    setFailure(null);
    setFieldFailure(null);
    const result = await runAction(
      t("init.create"),
      () =>
        core.repoInit({
          options: {
            parentPath: parent.trim(),
            name,
            defaultBranch: branch.trim(),
            gitignoreTemplate: gitignore === NONE ? null : gitignore,
            licenseTemplate: license === NONE ? null : license,
            createReadme: readme,
          },
        }),
      // With a notice from the core (first commit missing) a warning appears instead of the success message.
      { busyKey: BUSY_KEY, quiet: ALL_CODES, success: (opened) => (opened.notice ? null : t("init.success", { name: opened.repo.name })) },
    );
    if (result.ok) {
      const { notice, repo } = result.value;
      if (notice) {
        const output = notice.output;
        toast({
          tone: "warning",
          sticky: true,
          title: t("init.noFirstCommit", { name: repo.name }),
          description: notice.message,
          action: output ? { label: t("init.showOutput"), onClick: () => void showOutput(t("init.firstCommitOutputTitle"), output) } : undefined,
        });
      }
      void queryClient.invalidateQueries({ queryKey: qk.tabs });
      void queryClient.invalidateQueries({ queryKey: qk.repos });
      onClose();
      return;
    }
    const error = result.error;
    if (error.code === "duplicate") return;
    if (error.code === "path_exists") {
      setFieldFailure({
        field: "name",
        text: t("init.validation.pathExists"),
      });
      focusField("name");
    } else if (error.code === "path_not_found") {
      setFieldFailure({ field: "parent", text: t("init.validation.pathNotFound") });
      focusField("parent");
    } else if (error.code === "invalid_name") {
      const field: FieldName = /branch/i.test(error.message) ? "branch" : "name";
      setFieldFailure({ field, text: error.message });
      focusField(field);
    } else {
      setFailure(error);
    }
  };

  const templateOptions = (list: { key: string; label: string }[] | undefined): SelectOption[] => [
    { value: NONE, label: t("init.templateNone") },
    ...(list ?? []).map((item) => ({ value: item.key, label: item.label })),
  ];

  const output = failure?.gitOutput?.trim();
  const nothingToCommit = !readme && gitignore === NONE && license === NONE;

  return (
    <Dialog
      open
      size="md"
      title={t("init.title")}
      description={t("init.description")}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("init.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {t("init.create")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        data-screen="init"
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {failure ? (
          <div className="overflow-hidden rounded-md" data-init-error={failure.code}>
            <Banner
              tone="danger"
              title={t("init.failed")}
              actions={
                output ? (
                  <Button size="sm" onClick={() => void showOutput(t("init.outputTitle"), output)}>
                    {t("init.showOutput")}
                  </Button>
                ) : undefined
              }
            >
              <span className="selectable">{failure.message || errorInfo[failure.code]?.text || errorInfo.unknown.text}</span>{" "}
              {errorInfo[failure.code]?.hint}
            </Banner>
          </div>
        ) : null}

        {preset?.existing && !fieldFailure && !failure ? (
          <div className="overflow-hidden rounded-md">
            <Banner tone="info" title={t("init.existing.title")}>
              {t("init.existing.body")}
            </Banner>
          </div>
        ) : null}

        <TextField
          id={`${formId}-name`}
          autoFocus
          label={t("init.name.label")}
          mono
          value={name}
          placeholder={t("init.name.placeholder")}
          hint={t("init.name.hint")}
          error={errors.name ?? undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => {
            setName(event.target.value);
            if (fieldFailure?.field === "name") setFieldFailure(null);
          }}
        />

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              id={`${formId}-parent`}
              label={t("init.parent.label")}
              mono
              value={parent}
              placeholder={t("init.parent.placeholder")}
              error={errors.parent ?? undefined}
              autoComplete="off"
              onChange={(event) => {
                parentTouched.current = true;
                setParent(event.target.value);
                setFieldFailure(null);
              }}
            />
          </div>
          <Button className="mt-5" icon={<FolderOpen className="size-icon" aria-hidden />} onClick={() => void browse()}>
            {t("init.browse")}
          </Button>
        </div>

        <p data-init-target className="text-sm text-text-muted">
          {target ? (
            <>
              {t("init.target")} <WrappingPath path={target} className="text-text" />
            </>
          ) : (
            t("init.targetHint")
          )}
        </p>

        <TextField
          id={`${formId}-branch`}
          label={t("init.branch.label")}
          mono
          value={branch}
          error={errors.branch ?? undefined}
          hint={t("init.branch.hint")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(event) => {
            branchTouched.current = true;
            setBranch(event.target.value.replace(/\s+/g, "-"));
            if (fieldFailure?.field === "branch") setFieldFailure(null);
          }}
        />

        {templates.isError ? (
          <div className="overflow-hidden rounded-md">
            <Banner
              tone="warning"
              title={t("init.templates.failed")}
              actions={
                <Button size="sm" icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void templates.refetch()}>
                  {t("init.templates.retry")}
                </Button>
              }
            >
              {t("init.templates.failedBody")}
            </Banner>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Select
              label={t("init.templates.gitignore")}
              value={gitignore}
              options={templateOptions(templates.data?.gitignore)}
              onValueChange={setGitignore}
              disabled={templates.isPending}
              hint={t("init.templates.gitignoreHint")}
            />
            <Select
              label={t("init.templates.license")}
              value={license}
              options={templateOptions(templates.data?.licenses)}
              onValueChange={setLicense}
              disabled={templates.isPending}
              hint={t("init.templates.licenseHint")}
            />
          </div>
        )}

        <Checkbox label={t("init.readme.label")} hint={t("init.readme.hint")} checked={readme} onCheckedChange={setReadme} />

        <p data-init-note className="text-sm text-text-muted">
          {nothingToCommit
            ? t("init.noteEmpty")
            : t("init.noteCommit")}
        </p>
      </form>
    </Dialog>
  );
}
