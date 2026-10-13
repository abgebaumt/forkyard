/**
 * The sections for the fields of `Settings`: globally appearance, diff and editor, external
 * programs, notifications; per profile the Git behaviour. Every change takes effect immediately.
 */
import { FolderOpen } from "lucide-react";
import { Trans } from "react-i18next";
import { core, type DateFormat, type DiffMode, type PullMode, type Settings, type Theme } from "../../../core";
import { pullModeHints } from "../../../app/actions/sync";
import { SystemNotificationsRow, systemIntro, useSystemNotificationState } from "../../../app/notifications/SystemRow";
import { formatDate } from "../../../app/format";
import { Button } from "../../../ui/Button";
import { SegmentedControl } from "../../../ui/Field";
import { NumberField } from "../../../ui/NumberField";
import { Select } from "../../../ui/Select";
import { Switch } from "../../../ui/Switch";
import { SigningSettings } from "../../Signing/SigningSettings";
import { isChanged, resetPatch } from "../defaults";
import { CommitText, SectionHeader, SettingRow, SettingsCard } from "../parts";
import { applySettings, checkBranchName, fieldError } from "../settings";
import { languageSetting, setLanguageSetting, t, type LanguageSetting } from "../../../i18n";

/** "Changed · Reset" while the field deviates from the default. */
function changedFor(settings: Settings, field: keyof Settings) {
  return isChanged(settings, field) ? { onReset: () => void applySettings(resetPatch(field)) } : undefined;
}

// `-?`: optional fields (network settings) would otherwise bring `undefined` into the keys.
type BooleanKey = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

function ToggleRow({ settings, field, title, description }: { settings: Settings; field: BooleanKey; title: string; description: string }) {
  return (
    <SettingRow title={title} description={description} changed={changedFor(settings, field)}>
      {(ids) => (
        <Switch
          id={ids.id}
          ariaDescribedBy={ids.descriptionId}
          checked={settings[field]}
          onCheckedChange={(checked) => void applySettings({ [field]: checked })}
        />
      )}
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Git behaviour (per profile)
// ---------------------------------------------------------------------------

const pullModes: { value: PullMode; label: string }[] = [
  { value: "ff", label: t("preferences.pullModes.ff") },
  { value: "ff_only", label: t("preferences.pullModes.ffOnly") },
  { value: "rebase", label: t("preferences.pullModes.rebase") },
];

export function GitSection({ settings }: { settings: Settings }) {
  return (
    <section>
      <SectionHeader title={t("preferences.git.title")}>{t("preferences.git.intro")}</SectionHeader>
      <SettingsCard title={t("preferences.git.fetchCard")}>
        <SettingRow
          title={t("preferences.git.autoFetch.title")}
          description={t("preferences.git.autoFetch.description")}
          changed={changedFor(settings, "autoFetchMinutes")}
        >
          {(ids) => (
            <NumberField
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              className="w-32"
              value={settings.autoFetchMinutes}
              min={0}
              max={60}
              largeStep={5}
              unit="min"
              onCommit={(value) => void applySettings({ autoFetchMinutes: value })}
            />
          )}
        </SettingRow>
        <ToggleRow
          settings={settings}
          field="autoPrune"
          title={t("preferences.git.autoPrune.title")}
          description={t("preferences.git.autoPrune.description")}
        />
        <SettingRow title={t("preferences.git.pullMode")} description={pullModeHints[settings.defaultPullMode]} changed={changedFor(settings, "defaultPullMode")}>
          {(ids) => (
            <div className="w-56">
              <Select id={ids.id} value={settings.defaultPullMode} options={pullModes} onValueChange={(value) => void applySettings({ defaultPullMode: value })} />
            </div>
          )}
        </SettingRow>
      </SettingsCard>
      <SettingsCard title={t("preferences.git.commitCard")}>
        <ToggleRow
          settings={settings}
          field="pushAfterCommit"
          title={t("preferences.git.pushAfterCommit.title")}
          description={t("preferences.git.pushAfterCommit.description")}
        />
        <ToggleRow
          settings={settings}
          field="squashOnMerge"
          title={t("preferences.git.squashOnMerge.title")}
          description={t("preferences.git.squashOnMerge.description")}
        />
        <ToggleRow
          settings={settings}
          field="deleteOrigFiles"
          title={t("preferences.git.deleteOrigFiles.title")}
          description={t("preferences.git.deleteOrigFiles.description")}
        />
      </SettingsCard>
      <SigningSettings repoId={null} />
      <SettingsCard title={t("preferences.git.repoCard")}>
        <SettingRow
          title={t("preferences.git.defaultBranch.title")}
          description={t("preferences.git.defaultBranch.description")}
          changed={changedFor(settings, "defaultBranchName")}
        >
          {(ids) => (
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              className="w-48"
              mono
              value={settings.defaultBranchName}
              validate={checkBranchName}
              onCommit={async (value) => fieldError(await applySettings({ defaultBranchName: value }, { atField: true }))}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("preferences.git.initialCommits.title")}
          description={t("preferences.git.initialCommits.description")}
          changed={changedFor(settings, "initialCommits")}
        >
          {(ids) => (
            <NumberField
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              className="w-32"
              value={settings.initialCommits}
              min={500}
              max={100000}
              step={500}
              largeStep={5000}
              onCommit={(value) => void applySettings({ initialCommits: value })}
            />
          )}
        </SettingRow>
        <ToggleRow
          settings={settings}
          field="lazyLoad"
          title={t("preferences.git.lazyLoad.title")}
          description={t("preferences.git.lazyLoad.description")}
        />
        <ToggleRow settings={settings} field="rememberTabs" title={t("preferences.git.rememberTabs.title")} description={t("preferences.git.rememberTabs.description")} />
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const themes: { value: Theme; label: string }[] = [
  { value: "dark", label: t("preferences.appearance.theme.dark") },
  { value: "light", label: t("preferences.appearance.theme.light") },
  { value: "system", label: t("preferences.appearance.theme.system") },
];

const dateFormats: { value: DateFormat; label: string }[] = [
  { value: "relative", label: t("preferences.appearance.dateFormat.relative") },
  { value: "local", label: t("preferences.appearance.dateFormat.local") },
  { value: "iso", label: t("preferences.appearance.dateFormat.iso") },
];

/** Language names are written in their own language, so they can be found without knowing the one currently shown. */
const languages: { value: LanguageSetting; label: string }[] = [
  { value: "system", label: t("preferences.appearance.language.system") },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

export function AppearanceSection({ settings }: { settings: Settings }) {
  const percent = Math.round(settings.zoom * 100);
  const example = formatDate(Date.now() - 3 * 3600 * 1000, settings.dateFormat);
  return (
    <section>
      <SectionHeader title={t("preferences.appearance.title")}>{t("preferences.appearance.intro")}</SectionHeader>
      <SettingsCard title={t("preferences.appearance.themeCard")}>
        <SettingRow group title={t("preferences.appearance.theme.title")} description={t("preferences.appearance.theme.description")} changed={changedFor(settings, "theme")}>
          {() => <SegmentedControl label={t("preferences.appearance.theme.title")} value={settings.theme} options={themes} onValueChange={(value) => void applySettings({ theme: value })} />}
        </SettingRow>
      </SettingsCard>
      <SettingsCard title={t("preferences.appearance.uiCard")}>
        <SettingRow group title={t("preferences.appearance.language.title")} description={t("preferences.appearance.language.description")}>
          {() => (
            <SegmentedControl
              label={t("preferences.appearance.language.title")}
              value={languageSetting()}
              options={languages}
              onValueChange={(value) => {
                if (value !== languageSetting()) setLanguageSetting(value);
              }}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("preferences.appearance.zoom.title")}
          description={t("preferences.appearance.zoom.description")}
          changed={percent === 100 ? undefined : { onReset: () => void applySettings({ zoom: 1 }) }}
        >
          {(ids) => (
            <NumberField
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              className="w-32"
              value={percent}
              min={80}
              max={200}
              step={10}
              largeStep={10}
              unit="%"
              onCommit={(value) => void applySettings({ zoom: value / 100 })}
            />
          )}
        </SettingRow>
        <SettingRow
          group
          title={t("preferences.appearance.dateFormat.title")}
          description={t("preferences.appearance.dateFormat.description", { example })}
          changed={changedFor(settings, "dateFormat")}>
          {() => (
            <SegmentedControl label={t("preferences.appearance.dateFormat.title")} value={settings.dateFormat} options={dateFormats} onValueChange={(value) => void applySettings({ dateFormat: value })} />
          )}
        </SettingRow>
        <ToggleRow settings={settings} field="toolbarLabels" title={t("preferences.appearance.toolbarLabels.title")} description={t("preferences.appearance.toolbarLabels.description")} />
      </SettingsCard>
      <SettingsCard title={t("preferences.appearance.authorsCard")}>
        <ToggleRow
          settings={settings}
          field="showInitials"
          title={t("preferences.appearance.showInitials.title")}
          description={t("preferences.appearance.showInitials.description")}
        />
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Diff and editor
// ---------------------------------------------------------------------------

const diffModes: { value: DiffMode; label: string }[] = [
  { value: "hunks", label: t("preferences.diff.mode.hunks") },
  { value: "inline", label: t("preferences.diff.mode.inline") },
  { value: "split", label: t("preferences.diff.mode.split") },
];

export function DiffSection({ settings }: { settings: Settings }) {
  return (
    <section>
      <SectionHeader title={t("preferences.diff.title")}>{t("preferences.diff.intro")}</SectionHeader>
      <SettingsCard title={t("preferences.diff.diffCard")}>
        <SettingRow group title={t("preferences.diff.mode.title")} description={t("preferences.diff.mode.description")} changed={changedFor(settings, "diffMode")}>
          {() => <SegmentedControl label={t("preferences.diff.mode.title")} value={settings.diffMode} options={diffModes} onValueChange={(value) => void applySettings({ diffMode: value })} />}
        </SettingRow>
        <ToggleRow settings={settings} field="diffWordWrap" title={t("preferences.diff.wordWrap.title")} description={t("preferences.diff.wordWrap.description")} />
        <ToggleRow
          settings={settings}
          field="diffIgnoreWhitespace"
          title={t("preferences.diff.ignoreWhitespace.title")}
          description={t("preferences.diff.ignoreWhitespace.description")}
        />
      </SettingsCard>
      <SettingsCard title={t("preferences.diff.textCard")}>
        <SettingRow title={t("preferences.diff.fontSize.title")} description={t("preferences.diff.fontSize.description")} changed={changedFor(settings, "editorFontSize")}>
          {(ids) => (
            <NumberField
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              className="w-32"
              value={settings.editorFontSize}
              min={8}
              max={40}
              largeStep={4}
              unit="px"
              onCommit={(value) => void applySettings({ editorFontSize: value })}
            />
          )}
        </SettingRow>
        <SettingRow title={t("preferences.diff.tabSize.title")} description={t("preferences.diff.tabSize.description")} changed={changedFor(settings, "editorTabSize")}>
          {(ids) => (
            <NumberField
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              className="w-32"
              value={settings.editorTabSize}
              min={1}
              max={16}
              largeStep={4}
              onCommit={(value) => void applySettings({ editorTabSize: value })}
            />
          )}
        </SettingRow>
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// External programs
// ---------------------------------------------------------------------------

type ToolKey = "externalEditor" | "externalTerminal" | "externalDiffTool" | "externalMergeTool";

const tools: {
  key: ToolKey;
  title: string;
  description: string;
  example: string;
  pickTitle: string;
  /** What the empty field shows; if not given, "System default". */
  placeholder?: string;
  /** Placeholders that "Browse" appends after the chosen program; if not given, {path}. */
  arguments?: string;
}[] = [
  {
    key: "externalEditor",
    title: t("preferences.external.editor.title"),
    description: t("preferences.external.editor.description"),
    example: "code --goto {path}",
    pickTitle: t("preferences.external.editor.pick"),
  },
  {
    key: "externalTerminal",
    title: t("preferences.external.terminal.title"),
    description: t("preferences.external.terminal.description"),
    example: "wt -d {path}",
    pickTitle: t("preferences.external.terminal.pick"),
  },
  {
    key: "externalDiffTool",
    title: t("preferences.external.diffTool.title"),
    description: t("preferences.external.diffTool.description"),
    example: "meld {local} {remote}",
    pickTitle: t("preferences.external.diffTool.pick"),
    placeholder: t("preferences.external.diffTool.placeholder"),
    arguments: "{local} {remote}",
  },
  {
    key: "externalMergeTool",
    title: t("preferences.external.mergeTool.title"),
    description: t("preferences.external.mergeTool.description"),
    example: "kdiff3 {base} {local} {remote} -o {merged}",
    pickTitle: t("preferences.external.mergeTool.pick"),
    placeholder: t("preferences.external.mergeTool.placeholder"),
    arguments: "{merged}",
  },
];

/** Turn a chosen program into a command line; paths with spaces are quoted. */
export function commandFor(program: string, placeholders = "{path}"): string {
  return `${/\s/.test(program) ? `"${program}"` : program} ${placeholders}`;
}

/** Unclosed quotes are already detected by the UI – otherwise the core would only reject the command when opening. */
function checkCommand(value: string): string | null {
  const quotes = (value.match(/"/g) ?? []).length;
  return quotes % 2 === 1 ? t("preferences.check.quote") : null;
}

export function ExternalSection({ settings }: { settings: Settings }) {
  return (
    <section>
      <SectionHeader title={t("preferences.external.title")}>
        <Trans i18nKey="preferences.external.intro" components={{ code: <code className="font-mono text-code text-text" /> }} />
      </SectionHeader>
      <SettingsCard title={t("preferences.external.card")}>
        {tools.map((tool) => (
          <SettingRow key={tool.key} stacked title={tool.title} description={t("preferences.external.example", { description: tool.description, example: tool.example })} changed={changedFor(settings, tool.key)}>
            {(ids) => (
              <div className="flex items-start gap-2">
                <CommitText
                  id={ids.id}
                  describedBy={ids.descriptionId}
                  className="min-w-0 flex-1"
                  mono
                  placeholder={tool.placeholder ?? t("preferences.external.systemDefault")}
                  value={settings[tool.key] ?? ""}
                  validate={checkCommand}
                  onCommit={async (value) => fieldError(await applySettings({ [tool.key]: value || null }, { atField: true }))}
                />
                <Button
                  icon={<FolderOpen className="size-icon" aria-hidden />}
                  aria-label={t("preferences.external.browseLabel", { tool: tool.title })}
                  onClick={async () => {
                    const picked = await core.pickFile({ title: tool.pickTitle });
                    if (picked) void applySettings({ [tool.key]: commandFor(picked, tool.arguments) });
                  }}
                >
                  {t("preferences.row.browse")}
                </Button>
              </div>
            )}
          </SettingRow>
        ))}
      </SettingsCard>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function NotificationsSection({ settings }: { settings: Settings }) {
  // The real state of system notifications (plugin in the Rust part), determined anew when the section opens.
  const system = useSystemNotificationState();
  return (
    <section data-system-notifications={system}>
      <SectionHeader title={t("preferences.notifications.title")}>
        {t("preferences.notifications.intro")}
        {systemIntro(system)}
      </SectionHeader>
      <SettingsCard title={t("preferences.notifications.card")}>
        <ToggleRow
          settings={settings}
          field="notifyOnFetch"
          title={t("preferences.notifications.onFetch.title")}
          description={t("preferences.notifications.onFetch.description")}
        />
        <ToggleRow
          settings={settings}
          field="notifyOnError"
          title={t("preferences.notifications.onError.title")}
          description={t("preferences.notifications.onError.description")}
        />
        <SystemNotificationsRow state={system} />
      </SettingsCard>
    </section>
  );
}
