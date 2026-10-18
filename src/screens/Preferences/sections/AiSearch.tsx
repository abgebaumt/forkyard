/**
 * Settings › AI › Search by meaning (spec 9.2, Entscheidung 7): an optional embedding provider on
 * this computer with address and model, the index of the open repository and "Delete index".
 */
import { core, type Id, type Settings } from "../../../core";
import { confirm } from "../../../app/dialogs";
import { queryClient, useAiSemanticStatus } from "../../../app/queries";
import { runAction } from "../../../app/run";
import { Button } from "../../../ui/Button";
import { toast } from "../../../ui/Feedback";
import { Select } from "../../../ui/Select";
import { CommitText, SettingRow, SettingsCard } from "../parts";
import { applySettings, fieldError } from "../settings";
import { EMBED_CHOICES, embedChoice, embedChoicePatch, embedModelPlaceholder, indexText, type EmbedChoice } from "../ai/searchModel";
import { t } from "../../../i18n";

const LOCAL_ADDRESSES: Record<Exclude<EmbedChoice, "main">, string> = { ollama: "http://127.0.0.1:11434", lmstudio: "http://127.0.0.1:1234/v1" };

export function AiSearchCard({ settings, repoId }: { settings: Settings; repoId: Id | null }) {
  const { data: status } = useAiSemanticStatus(repoId);
  const choice = embedChoice(settings);
  const options = EMBED_CHOICES.map((value) => ({ value: value as string, label: t(`ai.search.embedder.${value}`) }));

  const deleteIndex = async () => {
    const sure = await confirm({ title: t("ai.search.delete.confirmTitle"), body: t("ai.search.delete.confirmBody"), confirmLabel: t("ai.search.delete.button"), danger: true });
    if (!sure) return;
    const result = await runAction(t("ai.search.delete.button"), () => core.aiSemanticIndexDelete());
    if (!result.ok) return;
    toast({ tone: "success", title: t("ai.search.delete.done", { count: result.value }) });
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && query.queryKey[2] === "aiSemantic" });
  };

  return (
    <SettingsCard title={t("ai.search.card")}>
      <SettingRow title={t("ai.search.embedder.title")} description={t("ai.search.embedder.description")}>
        {(ids) => (
          <div className="w-72" data-ai-search-embedder>
            <Select<string> id={ids.id} value={choice} options={options} onValueChange={(value) => void applySettings(embedChoicePatch(value as EmbedChoice))} />
          </div>
        )}
      </SettingRow>
      {choice !== "main" ? (
        <SettingRow title={t("ai.search.baseUrl.title")} description={t("ai.search.baseUrl.description")}>
          {(ids) => (
            <CommitText
              id={ids.id}
              describedBy={ids.descriptionId}
              className="w-72"
              mono
              value={settings.aiSearchEmbedBaseUrl ?? ""}
              placeholder={LOCAL_ADDRESSES[choice]}
              onCommit={async (value) => fieldError(await applySettings({ aiSearchEmbedBaseUrl: value.trim() || null }, { atField: true }))}
            />
          )}
        </SettingRow>
      ) : null}
      <SettingRow title={t("ai.search.model.title")} description={t("ai.search.model.description")}>
        {(ids) => (
          <CommitText
            id={ids.id}
            describedBy={ids.descriptionId}
            className="w-72"
            mono
            value={settings.aiSearchEmbedModel ?? ""}
            placeholder={embedModelPlaceholder(settings)}
            onCommit={async (value) => fieldError(await applySettings({ aiSearchEmbedModel: value.trim() || null }, { atField: true }))}
          />
        )}
      </SettingRow>
      <SettingRow title={t("ai.search.index.title")} description={indexText(repoId ? status : null, repoId !== null)}>
        {() => null}
      </SettingRow>
      <SettingRow title={t("ai.search.delete.title")} description={t("ai.search.delete.description")}>
        {() => (
          <Button data-ai-index-delete onClick={() => void deleteIndex()}>
            {t("ai.search.delete.button")}
          </Button>
        )}
      </SettingRow>
    </SettingsCard>
  );
}
