/**
 * Settings › Project › Ticket links: host links on/off, trackers (Jira, Linear, YouTrack,
 * Redmine), own rules with a test field, and the rules from `.forkyard/links.json` (read-only).
 * The core checks every change; its reason appears at the form.
 */
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CustomLinkRule, Id, LinkPreset, LinkPresetKind, LinkRules, LinkRulesConfig } from "../../../core";
import { qk, queryClient, useLinkRules, useRepoSettings } from "../../../app/queries";
import { newRuleId, splitKeys, tryRule, type RuleTest } from "../../../app/ticketLinks";
import { Button, IconButton } from "../../../ui/Button";
import { TextField } from "../../../ui/Field";
import { Select } from "../../../ui/Select";
import { Switch } from "../../../ui/Switch";
import { LoadError, Mono, SettingRow, SettingsCard, SettingsSkeleton } from "../parts";
import { applyRepoSettings, fieldError } from "../settings";
import { Intro } from "./ProjectSections";
import { t } from "../../../i18n";

const PRESET_KINDS: LinkPresetKind[] = ["jira", "linear", "youtrack", "redmine"];
const PRESET_LABELS: Record<LinkPresetKind, string> = { jira: "Jira", linear: "Linear", youtrack: "YouTrack", redmine: "Redmine" };
const PRESET_PLACEHOLDERS: Record<LinkPresetKind, string> = {
  jira: "https://example.atlassian.net",
  linear: "https://linear.app/example",
  youtrack: "https://example.youtrack.cloud",
  redmine: "https://redmine.example.com",
};

type Save = (next: LinkRulesConfig) => Promise<string | null>;

/** Saves the whole config; DB-only settings send no repo:changed, so the effective rules are reloaded here. */
async function saveLinks(repoId: Id, next: LinkRulesConfig): Promise<string | null> {
  const result = await applyRepoSettings(repoId, { linkRules: next }, { atField: true });
  void queryClient.invalidateQueries({ queryKey: qk.linkRules(repoId) });
  return fieldError(result);
}

function FormError({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-sm text-danger">
      {text}
    </p>
  ) : null;
}

function PresetsCard({ config, onSave }: { config: LinkRulesConfig; onSave: Save }) {
  const [kind, setKind] = useState<LinkPresetKind>("jira");
  const [baseUrl, setBaseUrl] = useState("");
  const [keys, setKeys] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    const preset: LinkPreset = { kind, baseUrl: baseUrl.trim(), keys: kind === "redmine" ? [] : splitKeys(keys) };
    const problem = await onSave({ ...config, presets: [...config.presets, preset] });
    setBusy(false);
    setError(problem);
    if (!problem) {
      setBaseUrl("");
      setKeys("");
    }
  };

  return (
    <SettingsCard title={t("preferences.project.links.presetsCard")}>
      {config.presets.map((preset, index) => (
        <div key={`${preset.kind}-${index}`} data-link-preset={preset.kind} className="flex items-center gap-3 border-b border-border py-3">
          <div className="min-w-0 flex-1">
            <p className="text-base font-medium text-text">{PRESET_LABELS[preset.kind]}</p>
            <Mono className="text-text-muted">{preset.baseUrl}</Mono>
            {preset.keys.length > 0 ? <p className="text-sm text-text-muted">{t("preferences.project.links.keysList", { keys: preset.keys.join(", ") })}</p> : null}
          </div>
          <IconButton
            size="sm"
            label={t("preferences.project.links.removePreset", { name: PRESET_LABELS[preset.kind] })}
            icon={<Trash2 className="size-icon" aria-hidden />}
            onClick={() => void onSave({ ...config, presets: config.presets.filter((_, at) => at !== index) })}
          />
        </div>
      ))}
      <div className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-36">
            <Select label={t("preferences.project.links.tracker")} value={kind} options={PRESET_KINDS.map((value) => ({ value, label: PRESET_LABELS[value] }))} onValueChange={setKind} />
          </div>
          <div className="min-w-48 flex-1">
            <TextField label={t("preferences.project.links.baseUrl")} mono value={baseUrl} placeholder={PRESET_PLACEHOLDERS[kind]} onChange={(event) => setBaseUrl(event.target.value)} />
          </div>
          {kind !== "redmine" ? (
            <div className="w-40">
              <TextField label={t("preferences.project.links.keys")} mono value={keys} placeholder="ABC, OPS" onChange={(event) => setKeys(event.target.value)} />
            </div>
          ) : null}
          <Button icon={<Plus className="size-icon" aria-hidden />} loading={busy} disabled={!baseUrl.trim()} onClick={() => void add()}>
            {t("preferences.project.links.add")}
          </Button>
        </div>
        <p className="text-sm text-text-muted">{kind === "redmine" ? t("preferences.project.links.redmineHint") : t("preferences.project.links.keysHint")}</p>
        <FormError text={error} />
      </div>
    </SettingsCard>
  );
}

function TestResult({ result }: { result: RuleTest }) {
  if (result.kind === "invalid") return <p className="text-sm text-danger">{t("preferences.project.links.testInvalid")}</p>;
  if (result.kind === "nested") return <p className="text-sm text-danger">{t("preferences.project.links.testNested")}</p>;
  if (result.links.length === 0) return <p className="text-sm text-text-muted">{t("preferences.project.links.testNone")}</p>;
  return (
    <ul aria-label={t("preferences.project.links.testResult")} className="flex flex-col gap-1 text-sm">
      {result.links.map((link, index) => (
        <li key={index} className="flex min-w-0 gap-2">
          <span className="font-mono text-code text-text">{link.text}</span>
          <span aria-hidden className="text-text-muted">
            →
          </span>
          <span className="min-w-0 truncate font-mono text-code text-text-muted">{link.url ?? t("preferences.project.links.testNoUrl")}</span>
        </li>
      ))}
    </ul>
  );
}

function CustomRulesCard({ config, onSave }: { config: LinkRulesConfig; onSave: Save }) {
  const [pattern, setPattern] = useState("");
  const [url, setUrl] = useState("");
  const [sample, setSample] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const result = pattern && sample ? tryRule(pattern, url, sample) : null;

  const add = async () => {
    setBusy(true);
    const rule: CustomLinkRule = { id: newRuleId(config.custom), pattern, url: url.trim() };
    const problem = await onSave({ ...config, custom: [...config.custom, rule] });
    setBusy(false);
    setError(problem);
    if (!problem) {
      setPattern("");
      setUrl("");
      setSample("");
    }
  };

  return (
    <SettingsCard title={t("preferences.project.links.customCard")}>
      {config.custom.map((rule) => (
        <div key={rule.id} data-link-rule={rule.id} className="flex items-center gap-3 border-b border-border py-3">
          <div className="min-w-0 flex-1">
            <Mono>{rule.pattern}</Mono>
            <Mono className="text-text-muted">{rule.url}</Mono>
          </div>
          <IconButton
            size="sm"
            label={t("preferences.project.links.removeRule", { pattern: rule.pattern })}
            icon={<Trash2 className="size-icon" aria-hidden />}
            onClick={() => void onSave({ ...config, custom: config.custom.filter((other) => other.id !== rule.id) })}
          />
        </div>
      ))}
      <div className="flex flex-col gap-2 py-3">
        <TextField
          label={t("preferences.project.links.pattern")}
          mono
          maxLength={200}
          value={pattern}
          placeholder="OPS-(\d+)"
          hint={t("preferences.project.links.patternHint")}
          onChange={(event) => setPattern(event.target.value)}
        />
        <TextField
          label={t("preferences.project.links.url")}
          mono
          value={url}
          placeholder="https://tracker.example.com/ticket/$1"
          hint={t("preferences.project.links.urlHint")}
          onChange={(event) => setUrl(event.target.value)}
        />
        <TextField
          label={t("preferences.project.links.test")}
          maxLength={500}
          value={sample}
          placeholder={t("preferences.project.links.testPlaceholder")}
          onChange={(event) => setSample(event.target.value)}
        />
        {result ? <TestResult result={result} /> : null}
        <FormError text={error} />
        <div>
          <Button icon={<Plus className="size-icon" aria-hidden />} loading={busy} disabled={!pattern || !url.trim()} onClick={() => void add()}>
            {t("preferences.project.links.addRule")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

function RepoFileCard({ data, failed }: { data: LinkRules | undefined; failed: boolean }) {
  const fileRules = data?.rules.filter((rule) => rule.source === "repo_file") ?? [];
  const origin =
    data?.file === "worktree" ? t("preferences.project.links.fileFromWorktree") : data?.file === "head" ? t("preferences.project.links.fileFromHead") : t("preferences.project.links.fileNone");
  return (
    <SettingsCard title={t("preferences.project.links.fileCard")}>
      <div data-link-file={data?.file ?? "none"} className="flex flex-col gap-2 py-3">
        {failed ? <FormError text={t("preferences.project.links.fileError")} /> : <p className="text-sm text-text-muted">{origin}</p>}
        {fileRules.map((rule) => (
          <div key={rule.id} data-link-file-rule={rule.id} className="min-w-0">
            <Mono>{rule.pattern}</Mono>
            <Mono className="text-text-muted">{rule.url}</Mono>
          </div>
        ))}
        {data && data.problems.length > 0 ? (
          <ul aria-label={t("preferences.project.links.problems")} className="flex flex-col gap-1 text-sm text-warning">
            {data.problems.map((problem, index) => (
              <li key={index}>{problem.index === null ? problem.message : t("preferences.project.links.problemAt", { n: problem.index + 1, message: problem.message })}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </SettingsCard>
  );
}

export function TicketLinksSection({ repoId }: { repoId: Id }) {
  const repoSettings = useRepoSettings(repoId);
  const effective = useLinkRules(repoId);
  if (!repoSettings.data) {
    if (repoSettings.isError) return <LoadError title={t("preferences.loadError.repoSettings")} error={repoSettings.error} onRetry={() => void repoSettings.refetch()} />;
    return <SettingsSkeleton rows={4} />;
  }
  const config = repoSettings.data.linkRules;
  const save: Save = (next) => saveLinks(repoId, next);
  const noHost = config.hostRules && effective.data !== undefined && !effective.data.rules.some((rule) => rule.source === "host");

  return (
    <section>
      <Intro repoId={repoId}>{t("preferences.project.links.title")}</Intro>
      <SettingsCard title={t("preferences.project.links.hostCard")}>
        <SettingRow title={t("preferences.project.links.host")} description={noHost ? t("preferences.project.links.noHost") : t("preferences.project.links.hostDescription")}>
          {(ids) => <Switch id={ids.id} ariaDescribedBy={ids.descriptionId} checked={config.hostRules} onCheckedChange={(checked) => void save({ ...config, hostRules: checked })} />}
        </SettingRow>
      </SettingsCard>
      <PresetsCard config={config} onSave={save} />
      <CustomRulesCard config={config} onSave={save} />
      <RepoFileCard data={effective.data} failed={effective.isError} />
    </section>
  );
}
