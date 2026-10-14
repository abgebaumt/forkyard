/** The form of a custom command's inputs, shown before it runs. */
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { core, type CustomCommandDef } from "../../core";
import { showDialog } from "../../app/dialogs";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Checkbox, TextField } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { t } from "../../i18n";
import { initialValues, inputErrors, type InputValues } from "./model";

function InputsDialog({ command, onDone }: { command: CustomCommandDef; onDone: (values: InputValues | null) => void }) {
  const [values, setValues] = useState<InputValues>(() => initialValues(command));
  const [tried, setTried] = useState(false);
  const errors = inputErrors(command, values);
  const set = (id: string, value: string) => setValues((current) => ({ ...current, [id]: value }));
  return (
    <Dialog
      open
      size="md"
      title={command.title}
      description={t("customCommands.inputs.description")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        <>
          <Button onClick={() => onDone(null)}>{t("customCommands.inputs.cancel")}</Button>
          <Button variant="primary" type="submit" form="custom-command-inputs">
            {t("customCommands.inputs.run")}
          </Button>
        </>
      }
    >
      <form
        id="custom-command-inputs"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (Object.keys(inputErrors(command, values)).length === 0) onDone(values);
        }}
      >
        {command.inputs.map((input, index) => {
          const error = tried ? errors[input.id] : undefined;
          const value = values[input.id] ?? "";
          if (input.type === "checkbox") {
            return <Checkbox key={input.id} label={input.label} checked={value === "true"} onCheckedChange={(checked) => set(input.id, checked ? "true" : "false")} />;
          }
          if (input.type === "choice") {
            return <Select key={input.id} label={input.label} value={value} error={error} options={input.options.map((option) => ({ value: option, label: option }))} onValueChange={(next) => set(input.id, next)} />;
          }
          if (input.type === "file") {
            return (
              <div key={input.id} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField data-autofocus={index === 0 ? true : undefined} label={input.label} mono value={value} error={error} onChange={(event) => set(input.id, event.target.value)} />
                </div>
                <Button
                  icon={<FolderOpen className="size-icon" aria-hidden />}
                  onClick={async () => {
                    const picked = await core.pickFile({ title: input.label });
                    if (picked) set(input.id, picked);
                  }}
                >
                  {t("customCommands.inputs.browse")}
                </Button>
              </div>
            );
          }
          return <TextField key={input.id} data-autofocus={index === 0 ? true : undefined} label={input.label} value={value} error={error} autoComplete="off" onChange={(event) => set(input.id, event.target.value)} />;
        })}
      </form>
    </Dialog>
  );
}

/** Asks for the inputs; null = cancelled. */
export function askInputs(command: CustomCommandDef): Promise<InputValues | null> {
  return showDialog<InputValues>((done) => <InputsDialog command={command} onDone={done} />);
}
