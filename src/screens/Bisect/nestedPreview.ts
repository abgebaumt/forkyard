/**
 * "What is sent?" inside a dialog: the dialog host shows one dialog at a time, so a preview queued
 * through `showAiPreview` would wait behind the autopilot dialog (and a confirmation would hang).
 * The asker shows the preview nested in the surrounding dialog instead; `ask` fits `confirmSend`'s
 * `show` argument. A second ask answers the first one with `null`.
 */
import type { AiPreview } from "../../core";
import type { PreviewChoice } from "../../app/ai/PreviewDialog";

export interface NestedPreviewState {
  preview: AiPreview;
  mode: "look" | "confirm";
}

export interface NestedPreview {
  ask(preview: AiPreview, mode: "look" | "confirm"): Promise<PreviewChoice | null>;
  close(choice: PreviewChoice | null): void;
}

export function nestedPreview(show: (state: NestedPreviewState | null) => void): NestedPreview {
  let answer: ((choice: PreviewChoice | null) => void) | null = null;
  return {
    ask(preview, mode) {
      answer?.(null);
      return new Promise<PreviewChoice | null>((resolve) => {
        answer = resolve;
        show({ preview, mode });
      });
    },
    close(choice) {
      const resolve = answer;
      answer = null;
      show(null);
      resolve?.(choice);
    },
  };
}
