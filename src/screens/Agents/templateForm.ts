/** Own agent templates in the settings: one argument per line in the form, lists in the settings. */
import type { AgentTemplate } from "../../core";
import { t } from "../../i18n";

export interface TemplateForm {
  id: string;
  name: string;
  program: string;
  args: string;
  unattendedArgs: string;
  resumeArgs: string;
  statusHook: boolean;
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const optional = (text: string): string[] | null => {
  const list = lines(text);
  return list.length ? list : null;
};

export const formFromTemplate = (template: AgentTemplate): TemplateForm => ({
  id: template.id,
  name: template.name,
  program: template.program,
  args: template.args.join("\n"),
  unattendedArgs: (template.unattendedArgs ?? []).join("\n"),
  resumeArgs: (template.resumeArgs ?? []).join("\n"),
  statusHook: template.statusHook,
});

export const templateFromForm = (form: TemplateForm): AgentTemplate => ({
  id: form.id,
  name: form.name.trim(),
  program: form.program.trim(),
  args: lines(form.args),
  unattendedArgs: optional(form.unattendedArgs),
  resumeArgs: optional(form.resumeArgs),
  statusHook: form.statusHook,
});

export const newTemplateForm = (id: string): TemplateForm => ({ id, name: t("agents.settings.newName"), program: "", args: "", unattendedArgs: "", resumeArgs: "", statusHook: false });
