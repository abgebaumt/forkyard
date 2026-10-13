/**
 * Open the init dialog with a specific folder – e.g. when "Open …" hit a folder that is not a
 * repository. The dialog reads the preset when opening and clears it when closing.
 */
import { useAppStore } from "../../app/store";
import { baseName, parentOf } from "../CloneDialog/paths";

export interface InitPreset {
  parent: string;
  name: string;
  /** The folder already exists (it was just selected). */
  existing: boolean;
}

let preset: InitPreset | null = null;

/** Opens "Create new" for exactly this folder: location = parent folder, name = folder name. */
export function openInitDialogAt(folder: string): void {
  preset = { parent: parentOf(folder), name: baseName(folder), existing: true };
  useAppStore.getState().openOverlay({ kind: "init" });
}

export const peekInitPreset = (): InitPreset | null => preset;

export function clearInitPreset(): void {
  preset = null;
}
