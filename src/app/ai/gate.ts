/**
 * The send gate of every AI element: if the preview of a request has triggers, the dialog asks,
 * and "Send" approves exactly this text in the core (`aiPreviewConfirm`). The core refuses
 * unconfirmed requests itself; this is the friendly way there.
 */
import { core, type AiFeature, type AiInput, type AiPreview, type Id } from "../../core";
import { locale, t } from "../../i18n";
import { runAction } from "../run";
import { showAiPreview, type PreviewChoice } from "./PreviewDialog";

/**
 * `show` presents the preview. The dialog host shows one dialog at a time, so a caller that sits
 * inside a dialog itself passes its own nested dialog here instead of queueing one behind itself.
 */
export async function confirmSend(
  repoId: Id | null,
  feature: AiFeature,
  preview: AiPreview,
  show: (preview: AiPreview, mode: "confirm") => Promise<PreviewChoice | null> = showAiPreview,
): Promise<boolean> {
  if (preview.asks.length === 0) return true;
  const choice = await show(preview, "confirm");
  if (!choice?.send) return false;
  const result = await runAction(t("ai.preview.confirmAction"), () =>
    core.aiPreviewConfirm({ repoId, feature, fingerprint: preview.fingerprint, triggers: preview.asks, dontAskAgain: choice.dontAskAgain }),
  );
  return result.ok;
}

/** "What is sent?" without sending: the text `input` builds (default: the staged changes of the repository). */
export async function showWhatIsSent(repoId: Id, feature: AiFeature, input: AiInput = { kind: "staged_changes" }): Promise<void> {
  const result = await runAction(t("ai.preview.loading"), () => core.aiPreview({ repoId, feature, input, locale: locale() }));
  if (result.ok) await showAiPreview(result.value, "look");
}
