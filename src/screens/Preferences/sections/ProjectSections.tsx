/**
 * Settings that only apply to the repository in the active tab. What the profile specifies is
 * inherited by the project until it sets an own value ("Override", "Reset").
 */
import { FolderOpen } from "lucide-react";
import { Trans } from "react-i18next";
import { core, type Id, type PullMode, type RepoSettings } from "../../../core";
import { pullModeHints } from "../../../app/actions/sync";
import { useHostRepo, useProfiles, useRepo, useRepoSettings, useSettings, useSshKeys } from "../../../app/queries";
import { Button } from "../../../ui/Button";
import { Select } from "../../../ui/Select";
import { Switch } from "../../../ui/Switch";
import { LfsPanel } from "../../Lfs/LfsPanel";
import { SigningSettings } from "../../Signing/SigningSettings";
import { inheritedValue, overridePatch, resetPatch, type InheritContext, type InheritKey } from "../inherit";
import { CommitText, GroupTitle, InheritRow, LoadError, Mono, SectionHeader, SettingRow, SettingsCard, SettingsSkeleton } from "../parts";
import { applyRepoSettings, checkEmail, fieldError } from "../settings";
import { t } from "../../../i18n";

/** Common encodings; the core accepts every name the Encoding Standard knows. */
const ENCODINGS: { value: string; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
  { value: "windows-1252", label: t("preferences.project.encodings.windows1252") },
  { value: "iso-8859-1", label: "ISO 8859-1 (Latin-1)" },
  { value: "iso-8859-15", label: "ISO 8859-15 (Latin-9)" },
  { value: "windows-1250", label: t("preferences.project.encodings.windows1250") },
  { value: "windows-1251", label: t("preferences.project.encodings.windows1251") },
  { value: "ibm866", label: t("preferences.project.encodings.ibm866") },
  { value: "shift_jis", label: t("preferences.project.encodings.shiftJis") },
  { value: "euc-jp", label: t("preferences.project.encodings.eucJp") },
  { value: "gbk", label: t("preferences.project.encodings.gbk") },
  { value: "big5", label: t("preferences.project.encodings.big5") },
  { value: "euc-kr", label: t("preferences.project.encodings.eucKr") },
];

const pullLabels: Record<PullMode, string> = {
  ff: t("preferences.pullModes.ff"),
  ff_only: t("preferences.pullModes.ffOnly"),
  rebase: t("preferences.pullModes.rebase"),
};

/** Repo settings and everything the inheritance depends on; null while something loads (then placeholders). */
function useProject(repoId: Id) {
  const repoSettings = useRepoSettings(repoId);
  const { data: settings } = useSettings();
  const { data: profiles } = useProfiles();
  const { data: keys } = useSshKeys();
  const profile = profiles?.find((candidate) => candidate.isActive);
  const ctx: InheritContext | null =
    settings && profile ? { profile, settings, defaultKeyId: settings.sshUseAgent ? null : (keys?.find((key) => key.isDefault)?.id ?? null) } : null;
  return { repoSettings, ctx, keys: keys ?? [] };
}

function Loading({ repoSettings }: { repoSettings: ReturnType<typeof useRepoSettings> }) {
  if (repoSettings.isError) return <LoadError title={t("preferences.loadError.repoSettings")} error={repoSettings.error} onRetry={() => void repoSettings.refetch()} />;
  return <SettingsSkeleton rows={4} />;
}

/** Inheritance, override and reset of a field – for `InheritRow`. */
function inherit(repoId: Id, key: InheritKey, repo: RepoSettings, ctx: InheritContext) {
  const value = inheritedValue(key, repo, ctx);
  return {
    own: value.own,
    source: ctx.profile.name,
    onOverride: () => void applyRepoSettings(repoId, overridePatch(key, ctx)),
    onReset: () => void applyRepoSettings(repoId, resetPatch(key)),
  };
}

export function Intro({ repoId, children }: { repoId: Id; children: string }) {
  const { data: repo } = useRepo(repoId);
  return (
    <>
      <SectionHeader title={children}>
        <Trans
          i18nKey="preferences.project.intro"
          values={{ repo: repo?.alias ?? repo?.name ?? t("preferences.project.openRepo") }}
          components={{ strong: <strong className="font-medium text-text" /> }}
        />
      </SectionHeader>
      {repo ? <Mono className="-mt-1 mb-2 text-text-muted">{repo.path}</Mono> : null}
    </>
  );
}

export function ProjectIdentitySection({ repoId }: { repoId: Id }) {
  const { repoSettings, ctx, keys } = useProject(repoId);
  const { data: hostRepo } = useHostRepo(repoId);
  if (!repoSettings.data || !ctx) return <Loading repoSettings={repoSettings} />;
  const repo = repoSettings.data;
  const text = (field: "authorName" | "authorEmail") => async (value: string) => fieldError(await applyRepoSettings(repoId, { [field]: value || null }, { atField: true }));
  const keyName = (id: unknown) => keys.find((key) => key.id === id)?.label ?? t("preferences.project.identity.agentFallback");
  const account = hostRepo?.account;

  return (
    <section>
      <Intro repoId={repoId}>{t("preferences.project.identity.title")}</Intro>
      <SettingsCard title={t("preferences.project.identity.commitCard")}>
        <InheritRow
          title={t("preferences.profiles.authorName.title")}
          description={t("preferences.project.identity.authorName")}
          inherited={ctx.profile.authorName || t("preferences.project.notSet")}
          {...inherit(repoId, "authorName", repo, ctx)}
        >
          {(ids) => <CommitText id={ids.id} describedBy={ids.descriptionId} className="w-64" value={repo.authorName ?? ""} onCommit={text("authorName")} />}
        </InheritRow>
        <InheritRow
          title={t("preferences.profiles.email.title")}
          description={t("preferences.project.identity.authorEmail")}
          inherited={ctx.profile.authorEmail || t("preferences.project.notSet")}
          {...inherit(repoId, "authorEmail", repo, ctx)}
        >
          {(ids) => (
            <CommitText id={ids.id} describedBy={ids.descriptionId} className="w-64" type="email" value={repo.authorEmail ?? ""} validate={checkEmail} onCommit={text("authorEmail")} />
          )}
        </InheritRow>
      </SettingsCard>
      <SettingsCard title={t("preferences.project.identity.accessCard")}>
        <InheritRow
          title={t("preferences.project.identity.sshKeyTitle")}
          description={t("preferences.project.identity.sshKey")}
          inherited={keyName(inheritedValue("sshKeyId", repo, ctx).inherited)}
          {...inherit(repoId, "sshKeyId", repo, ctx)}
          // Without a default key (SSH agent) there is nothing to adopt: then the profile's first one.
          onOverride={() => {
            const first = ctx.defaultKeyId ?? keys[0]?.id;
            if (first) void applyRepoSettings(repoId, { sshKeyId: first });
          }}
          overrideDisabled={keys.length === 0 ? t("preferences.project.identity.noKeys") : undefined}
        >
          {(ids) => (
            <div className="w-64">
              <Select
                id={ids.id}
                value={repo.sshKeyId ?? ""}
                options={keys.map((key) => ({ value: key.id, label: key.missing ? t("preferences.project.identity.keyMissing", { label: key.label }) : key.label }))}
                onValueChange={(value) => void applyRepoSettings(repoId, { sshKeyId: value })}
              />
            </div>
          )}
        </InheritRow>
        <SettingRow
          title={t("preferences.project.identity.account")}
          description={t("preferences.project.identity.accountDescription")}
        >
          {() => <span className="text-sm text-text-muted">{account
                ? t("preferences.project.identity.accountFromProfile", { account: account.user?.login ?? account.baseUrl })
                : t("preferences.project.identity.noAccount")}</span>}
        </SettingRow>
      </SettingsCard>
      <SigningSettings repoId={repoId} />
    </section>
  );
}

export function ProjectGitSection({ repoId }: { repoId: Id }) {
  const { repoSettings, ctx } = useProject(repoId);
  if (!repoSettings.data || !ctx) return <Loading repoSettings={repoSettings} />;
  const repo = repoSettings.data;
  const minutes = ctx.settings.autoFetchMinutes;

  return (
    <section>
      <Intro repoId={repoId}>{t("preferences.project.git.title")}</Intro>
      <SettingsCard title={t("preferences.project.git.card")}>
        <InheritRow
          title={t("preferences.project.git.pullMode")}
          description={repo.defaultPullMode ? pullModeHints[repo.defaultPullMode] : t("preferences.project.git.pullModeDescription")}
          inherited={pullLabels[ctx.settings.defaultPullMode]}
          {...inherit(repoId, "defaultPullMode", repo, ctx)}
        >
          {(ids) => (
            <div className="w-64">
              <Select
                id={ids.id}
                value={repo.defaultPullMode ?? ctx.settings.defaultPullMode}
                options={(Object.keys(pullLabels) as PullMode[]).map((mode) => ({ value: mode, label: pullLabels[mode] }))}
                onValueChange={(value) => void applyRepoSettings(repoId, { defaultPullMode: value })}
              />
            </div>
          )}
        </InheritRow>
        <InheritRow
          title={t("preferences.git.autoFetch.title")}
          description={minutes === 0 ? t("preferences.project.git.autoFetchOffInProfile") : t("preferences.project.git.autoFetchDescription")}
          inherited={minutes === 0 ? t("preferences.project.git.off") : t("preferences.project.git.every", { minutes })}
          {...inherit(repoId, "autoFetch", repo, ctx)}
        >
          {(ids) => (
            <Switch id={ids.id} ariaDescribedBy={ids.descriptionId} checked={repo.autoFetch} onCheckedChange={(checked) => void applyRepoSettings(repoId, { autoFetch: checked })} />
          )}
        </InheritRow>
        <SettingRow title={t("submoduleSync.setting.title")} description={t("submoduleSync.setting.description")}>
          {(ids) => (
            <Switch
              id={ids.id}
              ariaDescribedBy={ids.descriptionId}
              checked={repo.submodulesAutoUpdate}
              onCheckedChange={(checked) => void applyRepoSettings(repoId, { submodulesAutoUpdate: checked })}
            />
          )}
        </SettingRow>
      </SettingsCard>
    </section>
  );
}

export function ProjectFilesSection({ repoId }: { repoId: Id }) {
  const repoSettings = useRepoSettings(repoId);
  const { data: repo } = useRepo(repoId);
  if (!repoSettings.data) return <Loading repoSettings={repoSettings} />;
  const settings = repoSettings.data;
  const encoding = settings.encoding.toLowerCase();
  const encodings = ENCODINGS.some((item) => item.value === encoding) ? ENCODINGS : [...ENCODINGS, { value: encoding, label: settings.encoding }];
  const text = (field: "hooksPath" | "commitTemplate") => async (value: string) => fieldError(await applyRepoSettings(repoId, { [field]: value || null }, { atField: true }));

  return (
    <section>
      <Intro repoId={repoId}>{t("preferences.project.files.title")}</Intro>
      <SettingsCard title={t("preferences.project.files.card")}>
        <SettingRow title={t("preferences.project.files.encoding")} description={t("preferences.project.files.encodingDescription")}>
          {(ids) => (
            <div className="w-64">
              <Select id={ids.id} value={encoding} options={encodings} onValueChange={(value) => void applyRepoSettings(repoId, { encoding: value })} />
            </div>
          )}
        </SettingRow>
        <SettingRow stacked title={t("preferences.project.files.hooks")} description={t("preferences.project.files.hooksDescription")}>
          {(ids) => (
            <div className="flex items-start gap-2">
              <CommitText id={ids.id} describedBy={ids.descriptionId} className="min-w-0 flex-1" mono placeholder=".git/hooks" value={settings.hooksPath ?? ""} onCommit={text("hooksPath")} />
              <Button
                icon={<FolderOpen className="size-icon" aria-hidden />}
                aria-label={t("preferences.project.files.hooksBrowse")}
                onClick={async () => {
                  const picked = await core.pickFolder({ title: t("preferences.project.files.hooksPick"), defaultPath: repo?.path });
                  if (picked) void applyRepoSettings(repoId, { hooksPath: picked });
                }}
              >
                {t("preferences.row.browse")}
              </Button>
            </div>
          )}
        </SettingRow>
        <SettingRow stacked title={t("preferences.project.files.template")} description={t("preferences.project.files.templateDescription")}>
          {(ids) => (
            <div className="flex items-start gap-2">
              <CommitText
                id={ids.id}
                describedBy={ids.descriptionId}
                className="min-w-0 flex-1"
                mono
                placeholder={t("preferences.project.files.templatePlaceholder")}
                value={settings.commitTemplate ?? ""}
                onCommit={text("commitTemplate")}
              />
              <Button
                icon={<FolderOpen className="size-icon" aria-hidden />}
                aria-label={t("preferences.project.files.templateBrowse")}
                onClick={async () => {
                  const picked = await core.pickFile({ title: t("preferences.project.files.templatePick"), defaultPath: repo?.path });
                  if (picked) void applyRepoSettings(repoId, { commitTemplate: picked });
                }}
              >
                {t("preferences.row.browse")}
              </Button>
            </div>
          )}
        </SettingRow>
      </SettingsCard>
      <GroupTitle id="repo-lfs">Git LFS</GroupTitle>
      <LfsPanel repoId={repoId} />
    </section>
  );
}
