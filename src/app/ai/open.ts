/** Opens Settings › AI (start-page entry, palette, notice; Teilpaket 1b opens its setup dialog from here). */
import { useAppStore } from "../store";

export function openAiSettings(): void {
  useAppStore.getState().openOverlay({ kind: "preferences", section: "ai" });
}
