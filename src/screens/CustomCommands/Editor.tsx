/** Dialog for one custom command: title, kind, the command line with placeholders, where it appears, its inputs. */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CustomCommandCwd, CustomCommandDef, CustomCommandScope } from "../../core";
import { showDialog } from "../../app/dialogs";
import { Button, IconButton } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, SegmentedControl, TextArea, TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { t } from "../../i18n";
import { draftErrors, fromDraft, hasErrors, INPUT_TYPES, KINDS, newDraft, SCOPES, toDraft, type Draft, type DraftErrors, type DraftInput } from "./model";

const NO_ERRORS: DraftErrors = { inputs: {} };

function Editor({ initial, others, isNew, onDone }: { initial: Draft; others: CustomCommandDef[]; isNew: boolean; onDone: (value: CustomCommandDef | null) => void }) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors = draftErrors(draft, others);
  const shown = tried ? errors : NO_ERRORS;
  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));
  const patchInput = (index: number, next: Partial<DraftInput>) =>
    setDraft((current) => ({ ...current, inputs: current.inputs.map((input, position) => (position === index ? { ...input, ...next } : input)) }));
  const toggleScope = (scope: CustomCommandScope, on: boolean) =>
    setDraft((current) => ({ ...current, scope: on ? [...current.scope, scope] : current.scope.filter((item) => item !== scope) }));
  const addInput = () =>
    setDraft((current) => ({ ...current, inputs: [...current.inputs, { id: `input_${current.inputs.length + 1}`, label: "", type: "text", default: "", options: "" }] }));
  const removeInput = (index: number) => setDraft((current) => ({ ...current, inputs: current.inputs.filter((_, position) => position !== index) }));
  return (
    <Dialog
      open
      size="lg"
      title={isNew ? t("customCommands.editor.newTitle") : t("customCommands.editor.editTitle", { title: initial.title })}
      description={t("customCommands.editor.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("customCommands.editor.cancel")}</Button>
          <Button variant="primary" type="submit" form="custom-command-editor">
            {t("customCommands.editor.save")}
          </Button>
        </>
      }
    >
      <form
        id="custom-command-editor"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (!hasErrors(errors)) onDone(fromDraft(draft));
        }}
      >
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <TextField data-autofocus label={t("customCommands.editor.title")} value={draft.title} error={shown.title} autoComplete="off" onChange={(event) => patch({ title: event.target.value })} />
          </div>
          <div className="min-w-0 flex-1">
            <TextField label={t("customCommands.editor.id")} mono value={draft.id} error={shown.id} hint={t("customCommands.editor.idHint")} autoComplete="off" onChange={(event) => patch({ id: event.target.value })} />
          </div>
        </div>
        <SegmentedControl label={t("customCommands.editor.kind")} value={draft.kind} options={KINDS.map((kind) => ({ value: kind, label: t(`customCommands.kinds.${kind}`) }))} onValueChange={(kind) => patch({ kind })} />
        <TextField label={t(`customCommands.editor.run.${draft.kind}`)} mono value={draft.run} error={shown.run} hint={t("customCommands.editor.runHint")} autoComplete="off" onChange={(event) => patch({ run: event.target.value })} />
        {draft.kind === "shell" ? (
          <Select<CustomCommandCwd>
            label={t("customCommands.editor.cwd")}
            value={draft.cwd}
            options={[
              { value: "worktree", label: t("customCommands.editor.cwdWorktree") },
              { value: "repo", label: t("customCommands.editor.cwdRepo") },
            ]}
            onValueChange={(cwd) => patch({ cwd })}
          />
        ) : null}
        <div className="flex flex-col gap-2">
          <Checkbox label={t("customCommands.editor.confirm")} checked={draft.confirm} onCheckedChange={(confirm) => patch({ confirm })} />
          {draft.kind === "shell" ? <Checkbox label={t("customCommands.editor.shell")} hint={t("customCommands.editor.shellHint")} checked={draft.shell} onCheckedChange={(shell) => patch({ shell })} /> : null}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-text-muted">{t("customCommands.editor.scope")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {SCOPES.map((scope) => (
              <Checkbox key={scope} label={t(`customCommands.scopes.${scope}`)} checked={draft.scope.includes(scope)} onCheckedChange={(on) => toggleScope(scope, on)} />
            ))}
          </div>
          {shown.scope ? (
            <p role="alert" className="text-sm text-danger">
              {shown.scope}
            </p>
          ) : null}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-text-muted">{t("customCommands.editor.inputs")}</legend>
          {draft.inputs.map((input, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField label={t("customCommands.editor.inputId")} mono value={input.id} autoComplete="off" onChange={(event) => patchInput(index, { id: event.target.value })} />
                </div>
                <div className="min-w-0 flex-1">
                  <TextField label={t("customCommands.editor.inputLabel")} value={input.label} autoComplete="off" onChange={(event) => patchInput(index, { label: event.target.value })} />
                </div>
                <div className="min-w-0 flex-1">
                  <Select
                    label={t("customCommands.editor.inputType")}
                    value={input.type}
                    options={INPUT_TYPES.map((type) => ({ value: type, label: t(`customCommands.inputTypes.${type}`) }))}
                    onValueChange={(type) => patchInput(index, { type })}
                  />
                </div>
                <IconButton label={t("customCommands.editor.removeInput")} icon={<Trash2 className="size-icon" aria-hidden />} onClick={() => removeInput(index)} />
              </div>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <TextField label={t("customCommands.editor.inputDefault")} value={input.default} autoComplete="off" onChange={(event) => patchInput(index, { default: event.target.value })} />
                </div>
                {input.type === "choice" || input.type === "checkbox" ? (
                  <div className="min-w-0 flex-1">
                    <TextArea
                      label={input.type === "choice" ? t("customCommands.editor.inputOptions") : t("customCommands.editor.inputChecked")}
                      rows={2}
                      value={input.options}
                      onChange={(event) => patchInput(index, { options: event.target.value })}
                    />
                  </div>
                ) : null}
              </div>
              {shown.inputs[index] ? (
                <p role="alert" className="text-sm text-danger">
                  {shown.inputs[index]}
                </p>
              ) : null}
            </div>
          ))}
          <div>
            <Button size="sm" icon={<Plus className="size-icon" aria-hidden />} onClick={addInput}>
              {t("customCommands.editor.addInput")}
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

/** Opens the editor for a new (`command: null`) or an existing command; null = cancelled. `others`: the other commands. */
export function editCommand(command: CustomCommandDef | null, others: CustomCommandDef[]): Promise<CustomCommandDef | null> {
  const initial = command ? toDraft(command) : newDraft(others);
  return showDialog<CustomCommandDef>((done) => <Editor initial={initial} others={others} isNew={command === null} onDone={done} />);
}
