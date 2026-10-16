/** Project › AI and agents: "AI off for this repository" (later packages add their fields here). */
import { useEffect, useState } from "react";
import type { Id } from "../../../core";
import { useRepoSettings } from "../../../app/queries";
import { TextArea } from "../../../ui/Field";
import { Switch } from "../../../ui/Switch";
import { LoadError, SectionHeader, SettingRow, SettingsCard, SettingsSkeleton } from "../parts";
import { applyRepoSettings, fieldError } from "../settings";
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
        <CommitInstructionRow repoId={repoId} value={value.aiCommitInstruction} />
      </SettingsCard>
    </section>
  );
}

/** Own instruction for AI commit messages (spec 1.3, 3.1): saved when the field is left; the core trims and limits it. */
function CommitInstructionRow({ repoId, value }: { repoId: Id; value: string | null }) {
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value ?? ""), [value]);
  const save = async () => {
    const next = draft.trim();
    if (next === (value ?? "")) return;
    setError(fieldError(await applyRepoSettings(repoId, { aiCommitInstruction: next || null }, { atField: true })));
  };
  return (
    <SettingRow stacked title={t("ai.project.commitInstruction.title")} description={t("ai.project.commitInstruction.description")}>
      {(ids) => (
        <TextArea
          id={ids.id}
          data-ai-commit-instruction=""
          aria-describedby={ids.descriptionId}
          rows={3}
          value={draft}
          error={error ?? undefined}
          placeholder={t("ai.project.commitInstruction.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
        />
      )}
    </SettingRow>
  );
}
