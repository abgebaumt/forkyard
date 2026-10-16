/** Project › AI and agents: "AI off for this repository" (later packages add their fields here). */
import type { Id } from "../../../core";
import { useRepoSettings } from "../../../app/queries";
import { Switch } from "../../../ui/Switch";
import { LoadError, SectionHeader, SettingRow, SettingsCard, SettingsSkeleton } from "../parts";
import { applyRepoSettings } from "../settings";
import { t } from "../../../i18n";

export function ProjectAiSection({ repoId }: { repoId: Id }) {
  const repoSettings = useRepoSettings(repoId);
  if (repoSettings.isPending) return <SettingsSkeleton rows={1} />;
  if (repoSettings.isError) return <LoadError title={t("preferences.loadError.settings")} error={repoSettings.error} onRetry={() => void repoSettings.refetch()} />;
  const value = repoSettings.data;
  return (
    <section data-ai-project>
      <SectionHeader title={t("ai.project.title")}>{t("ai.project.intro")}</SectionHeader>
      <SettingsCard title={t("ai.project.card")}>
        <SettingRow title={t("ai.project.off.title")} description={t("ai.project.off.description")}>
          {(ids) => <Switch id={ids.id} ariaDescribedBy={ids.descriptionId} checked={value.aiOff} onCheckedChange={(checked) => void applyRepoSettings(repoId, { aiOff: checked })} />}
        </SettingRow>
      </SettingsCard>
    </section>
  );
}
