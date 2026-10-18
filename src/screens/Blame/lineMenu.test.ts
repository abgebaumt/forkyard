import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import { blameLineMenu, type BlameLineMenuInput } from "./lineMenu";
import type { BlameBlock } from "./model";

const A = "a".repeat(40);
const block = (patch: Partial<BlameBlock> = {}): BlameBlock => ({
  index: 0,
  sha: A,
  uncommitted: false,
  authorName: "Lena Hartmann",
  authorEmail: "lena@example.org",
  authoredAt: "2026-03-02T09:02:00.000Z",
  summary: "Messintervall auf fünf Minuten",
  startLine: 1,
  endLine: 4,
  color: "var(--gc-lane-1)",
  age: 0,
  ...patch,
});

const input = (patch: Partial<BlameLineMenuInput> = {}): BlameLineMenuInput => ({
  text: "INTERVALL_MINUTEN = 5",
  block: block(),
  parent: { sha: `${A}^`, path: "src/station.py" },
  why: { target: { path: "src/station.py", line: 3, sha: null } },
  aiVisible: true,
  copy: vi.fn(),
  reveal: vi.fn(),
  previous: vi.fn(),
  open: vi.fn(),
  ...patch,
});

const actions = (entries: MenuEntry[]) => entries.filter((entry): entry is MenuAction => !("type" in entry) || entry.type === "item");

describe("blameLineMenu", () => {
  it("offers copy, commit, previous version and “Why is this so?” in this order", () => {
    const entries = blameLineMenu(input());
    expect(entries.map((entry) => ("label" in entry ? entry.label : entry.type))).toEqual(["Copy line", "Show commit", "Blame of the previous version", "separator", "Why is this so?"]);
    expect(actions(entries).map((entry) => entry.shortcut ?? null)).toEqual([null, "Enter", "P", "W"]);
    expect(actions(entries).every((entry) => !entry.disabled)).toBe(true);
  });

  it("each entry calls its action for this line", () => {
    const given = input();
    const [copy, show, previous, why] = actions(blameLineMenu(given));
    copy!.onSelect?.();
    show!.onSelect?.();
    previous!.onSelect?.();
    why!.onSelect?.();
    expect(given.copy).toHaveBeenCalledWith("INTERVALL_MINUTEN = 5");
    expect(given.reveal).toHaveBeenCalledWith(given.block);
    expect(given.previous).toHaveBeenCalledTimes(1);
    expect(given.open).toHaveBeenCalledWith({ path: "src/station.py", line: 3, sha: null });
  });

  it("an uncommitted line shows its local changes and has no history, with the reason", () => {
    const entries = actions(
      blameLineMenu(input({ block: block({ uncommitted: true }), parent: { reason: t("blame.parent.noEarlier") }, why: { reason: t("blame.archaeology.notCommitted") }, aiVisible: false })),
    );
    expect(entries.map((entry) => [entry.label, Boolean(entry.disabled), entry.hint ?? null])).toEqual([
      ["Copy line", false, null],
      ["View local changes", false, null],
      ["Blame of the previous version", true, "no earlier state"],
      ["History of this line", true, "the line is not committed yet"],
    ]);
  });

  it("without a line nothing but copying is possible", () => {
    const entries = actions(blameLineMenu(input({ block: null, parent: { reason: t("blame.parent.noLine") }, why: { reason: t("blame.parent.noLine") } })));
    expect(entries.map((entry) => Boolean(entry.disabled))).toEqual([false, true, true, true]);
  });
});
