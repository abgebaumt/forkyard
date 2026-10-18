import { describe, expect, it, vi } from "vitest";
import type { MenuAction } from "../../ui/Menu";
import type { LineRow } from "./model";
import { whyLineEntries } from "./whyLine";

const A = "a".repeat(40);
const line = (kind: LineRow["kind"], oldNo: number | null, newNo: number | null): LineRow => ({ type: "line", kind, oldNo, newNo, text: "INTERVALL_MINUTEN = 5", hunkOrd: 0, pos: 0 });

describe("whyLineEntries", () => {
  it("a removed line of a commit opens the history at the parent commit", () => {
    const open = vi.fn();
    const [entry] = whyLineEntries({ kind: "commit", sha: A }, { path: "src/station.py", oldPath: null }, line("remove", 3, null), false, open) as MenuAction[];
    expect(entry).toMatchObject({ label: "History of this line" });
    entry!.onSelect?.();
    expect(open).toHaveBeenCalledWith({ path: "src/station.py", line: 3, sha: `${A}^` });
  });

  it("an added line of the working directory is disabled with the reason", () => {
    const [entry] = whyLineEntries({ kind: "unstaged" }, { path: "src/station.py", oldPath: null }, line("add", null, 4), true, vi.fn()) as MenuAction[];
    expect(entry).toMatchObject({ label: "Why is this so?", disabled: true, hint: "the line is not committed yet" });
  });
});
