/**
 * Settings › Coding agents (global): the built-in templates with where their program was found, and
 * the user's own templates (name, program, arguments with placeholders, arguments for “without
 * prompts” and “Resume”, whether it reports its status). The core checks them on saving – a bypass
 * switch is refused with its name. Plus the project row “Test command for coding agents”.
 */
import { useEffect, useState } from "react";
import type { AgentTemplateInfo, Id, Settings } from "../../core";
import { useAgentTemplates, useRepoSettings } from "../../app/queries";
import { Button } from "../../ui/Button";
import { Checkbox, TextArea, TextField } from "../../ui/Field";
import { t } from "../../i18n";
import { CommitText, SectionHeader, SettingRow, SettingsCard } from "../Preferences/parts";
import { applyRepoSettings, applySettings, fieldError } from "../Preferences/settings";
import { templateLoginWord } from "./model";
import { formFromTemplate, newTemplateForm, templateFromForm, type TemplateForm } from "./templateForm";

function OwnTemplate({ form, onChange, onRemove }: { form: TemplateForm; onChange: (next: TemplateForm) => void; onRemove: () => void }) {
  return (
    <div data-agent-template={form.id} className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="grid grid-cols-2 gap-2">
        <TextField label={t("agents.settings.name")} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
        <TextField label={t("agents.settings.program")} hint={t("agents.settings.programHint")} mono value={form.program} onChange={(event) => onChange({ ...form, program: event.target.value })} />
      </div>
      <TextArea label={t("agents.settings.args")} hint={t("agents.settings.argsHint")} rows={3} value={form.args} onChange={(event) => onChange({ ...form, args: event.target.value })} />
      <div className="grid grid-cols-2 gap-2">
        <TextArea label={t("agents.settings.unattendedArgs")} hint={t("agents.settings.unattendedArgsHint")} rows={2} value={form.unattendedArgs} onChange={(event) => onChange({ ...form, unattendedArgs: event.target.value })} />
        <TextArea label={t("agents.settings.resumeArgs")} hint={t("agents.settings.resumeArgsHint")} rows={2} value={form.resumeArgs} onChange={(event) => onChange({ ...form, resumeArgs: event.target.value })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Checkbox label={t("agents.settings.statusHook")} hint={t("agents.settings.statusHookHint")} checked={form.statusHook} onCheckedChange={(statusHook) => onChange({ ...form, statusHook })} />
        <Button variant="ghost" size="sm" onClick={onRemove}>
          {t("agents.settings.remove")}
        </Button>
      </div>
    </div>
  );
}

/** Version, path and sign-in of a built-in template (spec 2a). */
function builtInDescription(item: AgentTemplateInfo): string {
  if (!item.path) return t("agents.settings.missing");
  const found = item.version ? t("agents.settings.found", { version: item.version, path: item.path }) : t("agents.settings.foundNoVersion", { path: item.path });
  const login = templateLoginWord(item);
  return login ? t("agents.settings.foundLogin", { found, login }) : found;
}

export function AgentTemplatesSection({ settings }: { settings: Settings }) {
  const templates = useAgentTemplates();
  const [forms, setForms] = useState<TemplateForm[]>(() => settings.agentTemplates.map(formFromTemplate));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForms(settings.agentTemplates.map(formFromTemplate)), [settings.agentTemplates]);
  const next = forms.map(templateFromForm);
  const dirty = JSON.stringify(next) !== JSON.stringify(settings.agentTemplates);
  const builtIn = (templates.data ?? []).filter((item) => item.kind !== "custom");

  const save = async () => {
    const result = await applySettings({ agentTemplates: next }, { atField: true });
    setError(fieldError(result));
  };

  return (
    <section data-settings-section="agents">
      <SectionHeader title={t("agents.settings.title")}>{t("agents.settings.intro")}</SectionHeader>
      <SettingsCard title={t("agents.settings.builtIn")}>
        {builtIn.map((item) => (
          <SettingRow key={item.id} title={item.name} description={builtInDescription(item)}>
            {() => null}
          </SettingRow>
        ))}
      </SettingsCard>
      <SettingsCard title={t("agents.settings.own")}>
        {forms.map((form, index) => (
          <OwnTemplate
            key={form.id}
            form={form}
            onChange={(changed) => setForms((list) => list.map((item, i) => (i === index ? changed : item)))}
            onRemove={() => setForms((list) => list.filter((_, i) => i !== index))}
          />
        ))}
        <div className="flex items-center gap-2 py-3">
          <Button size="sm" onClick={() => setForms((list) => [...list, newTemplateForm(`custom:${crypto.randomUUID()}`)])}>
            {t("agents.settings.add")}
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void save()} data-action="save-agent-templates">
            {t("agents.settings.save")}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsCard>
    </section>
  );
}

/** Project setting: the test command an agent's worktree runs when the agent is done. */
export function TestCommandRow({ repoId }: { repoId: Id }) {
  const repoSettings = useRepoSettings(repoId);
  if (!repoSettings.data) return null;
  return (
    <SettingRow title={t("agents.settings.testCommand")} description={t("agents.settings.testCommandHint")} stacked>
      {(ids) => (
        <CommitText
          id={ids.id}
          describedBy={ids.descriptionId}
          mono
          value={repoSettings.data.testCommand ?? ""}
          placeholder="npm test"
          onCommit={async (value) => fieldError(await applyRepoSettings(repoId, { testCommand: value.trim() ? value.trim() : null }, { atField: true }))}
        />
      )}
    </SettingRow>
  );
}
