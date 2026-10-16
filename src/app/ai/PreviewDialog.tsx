/**
 * "What is sent?": the exact text, the files left out and – before sending – the reasons why
 * Forkyard asks. Shown through `showDialog`, so focus handling knows it (src/app/viewFocus.ts).
 */
import { useState } from "react";
import type { AiPreview } from "../../core";
import { showDialog } from "../dialogs";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Checkbox } from "../../ui/Field";
import { t } from "../../i18n";
import { askLines, formatUsd, offersDontAskAgain, omittedReason, sizeLine } from "./preview";

export interface PreviewChoice {
  send: boolean;
  dontAskAgain: boolean;
}

function PreviewDialog({ preview, mode, onDone }: { preview: AiPreview; mode: "look" | "confirm"; onDone: (choice: PreviewChoice | null) => void }) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const asks = mode === "confirm" ? askLines(preview) : [];
  return (
    <Dialog
      open
      size="lg"
      title={t("ai.preview.title")}
      description={mode === "confirm" ? t("ai.preview.confirmIntro") : t("ai.preview.lookIntro")}
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      footer={
        mode === "confirm" ? (
          <>
            {offersDontAskAgain(preview.asks) ? (
              <div className="mr-auto">
                <Checkbox label={t("ai.preview.dontAskAgain")} checked={dontAskAgain} onCheckedChange={setDontAskAgain} />
              </div>
            ) : null}
            <Button data-autofocus onClick={() => onDone(null)}>
              {t("ai.preview.cancel")}
            </Button>
            <Button variant="primary" onClick={() => onDone({ send: true, dontAskAgain })}>
              {t("ai.preview.send")}
            </Button>
          </>
        ) : (
          <Button variant="primary" data-autofocus onClick={() => onDone(null)}>
            {t("ai.preview.close")}
          </Button>
        )
      }
    >
      <div data-ai-preview className="flex min-h-0 flex-col gap-3">
        {asks.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-text">
            {asks.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-sm text-text-muted">
          {sizeLine(preview)}
          {preview.estimatedCostUsd !== null ? ` · ${t("ai.preview.cost", { cost: formatUsd(preview.estimatedCostUsd) })}` : ""}
        </p>
        {preview.omitted.length ? (
          <div>
            <p className="text-sm font-medium text-text">{t("ai.preview.omittedTitle")}</p>
            <ul data-ai-omitted className="flex flex-col gap-0.5 text-sm text-text-muted">
              {preview.omitted.map((item) => (
                <li key={`${item.reason}:${item.path}`}>
                  <span className="font-mono text-code text-text">{item.path}</span> – {omittedReason(item.reason)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.shortened.length ? <p className="text-sm text-text-muted">{t("ai.preview.shortened", { files: preview.shortened.join(", ") })}</p> : null}
        <pre data-ai-preview-text className="selectable max-h-96 overflow-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-code break-words whitespace-pre-wrap text-text">
          {preview.text}
        </pre>
      </div>
    </Dialog>
  );
}

/** `look`: only shows (Close). `confirm`: Send / Cancel and, for size and cost, "Don't ask again". */
export function showAiPreview(preview: AiPreview, mode: "look" | "confirm"): Promise<PreviewChoice | null> {
  return showDialog<PreviewChoice>((done) => <PreviewDialog preview={preview} mode={mode} onDone={done} />);
}
