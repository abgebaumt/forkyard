/** The diff line menu's entry “Why is this so?” / “History of this line”. */
import type { DiffSource } from "../../core";
import type { ArchaeologyTarget } from "../../app/store";
import type { MenuEntry } from "../../ui/Menu";
import { diffLineTarget, whyEntry } from "../Archaeology/model";
import type { LineRow } from "./model";

export function whyLineEntries(
  source: DiffSource,
  file: { path: string; oldPath: string | null },
  row: LineRow,
  aiVisible: boolean,
  open: (target: ArchaeologyTarget) => void,
): MenuEntry[] {
  return [whyEntry(diffLineTarget(source, file, row), aiVisible, open)];
}
