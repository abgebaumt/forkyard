/**
 * Right side of "Compose commits": for one unit its file, the AI's reason (or "moved by you"),
 * "Looks right" for an unsure placement, where it can go (1–9, 0, N) and its diff; for several
 * selected units the shared move buttons; for a protected unit why it stays out.
 */
import type { ComposeNote, ComposeUnit } from "../../core";
import { Button } from "../../ui/Button";
import { DiffHunk, type DiffLine as UiDiffLine } from "../../ui/Diff";
import { Kbd } from "../../ui/Kbd";
import { laneColor } from "../../ui/cn";
import { t } from "../../i18n";
import { SKIP, groupOf, splitPath, unitDetail, type Arrangement, type Review, type Selection, type Units } from "./model";

function toUiLines(unit: ComposeUnit): UiDiffLine[] {
  return unit.lines.map((line) => ({ kind: line.kind, oldNo: line.oldNo ?? undefined, newNo: line.newNo ?? undefined, segments: [{ text: line.text }] }));
}

export interface DetailProps {
  arrangement: Arrangement;
  units: Units;
  notes: ReadonlyMap<string, ComposeNote>;
  review: Review;
  unsure: ReadonlySet<string>;
  selection: Selection;
  onMove: (target: number | "new") => void;
  onConfirm: (unit: string) => void;
}

function MoveButtons({ arrangement, current, onMove }: { arrangement: Arrangement; current: number | null; onMove: (target: number | "new") => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-compose-move="">
      <span className="mr-1 text-xs text-text-muted">{t("wip.compose.belongsIn")}</span>
      {arrangement.commits.map((commit, index) => (
        <Button key={commit.key} size="sm" data-compose-move-to={String(index)} aria-current={current === index || undefined} onClick={() => onMove(index)} className="aria-[current]:border-accent aria-[current]:bg-accent-surface aria-[current]:text-accent">
          <span className="size-2 rounded-full" style={{ backgroundColor: laneColor(index) }} aria-hidden />
          {t("wip.compose.commit", { number: index + 1 })}
          {index < 9 ? <Kbd>{String(index + 1)}</Kbd> : null}
        </Button>
      ))}
      <Button size="sm" data-compose-move-to="skip" aria-current={current === SKIP || undefined} onClick={() => onMove(SKIP)} className="aria-[current]:border-accent aria-[current]:bg-accent-surface aria-[current]:text-accent">
        {t("wip.compose.skip")}
        <Kbd>0</Kbd>
      </Button>
      <Button size="sm" data-compose-move-to="new" onClick={() => onMove("new")}>
        {t("wip.compose.newCommit")}
        <Kbd>N</Kbd>
      </Button>
    </div>
  );
}

export function Detail({ arrangement, units, notes, review, unsure, selection, onMove, onConfirm }: DetailProps) {
  if (selection.ids.length > 1) {
    return (
      <div className="grid gap-3 p-4" data-compose-detail="multi">
        <strong className="text-base text-text">{t("wip.compose.selected", { count: selection.ids.length })}</strong>
        <p className="m-0 text-sm text-text-muted">{t("wip.compose.selectedHint")}</p>
        <MoveButtons arrangement={arrangement} current={null} onMove={onMove} />
      </div>
    );
  }
  const id = selection.cursor;
  const unit = id ? units.get(id) : undefined;
  if (!id || !unit) return null;
  if (unit.protected) {
    const file = splitPath(unit.path).name;
    return (
      <div className="grid gap-2 p-4 text-sm text-text-muted" data-compose-detail="protected">
        <strong className="text-base text-text">{t("wip.compose.protectedTitle", { file })}</strong>
        <span>{t("wip.compose.protectedText")}</span>
      </div>
    );
  }
  const group = groupOf(arrangement, id);
  const reason = review.pinned.has(id) ? t("wip.compose.movedByYou") : notes.get(id)?.reason || t("wip.compose.noReason");
  return (
    <div className="grid content-start" data-compose-detail="unit">
      <div className="grid gap-2 border-b border-border px-4 pt-3 pb-2.5">
        <div className="text-base font-semibold [overflow-wrap:anywhere] text-text">
          {unit.path} <span className="font-mono text-code font-normal text-text-muted">{unitDetail(unit)}</span>
        </div>
        <div className="text-sm text-text-muted" data-compose-reason="">
          <strong className="font-medium text-text">{group === SKIP || group === null ? t("wip.compose.whySkip") : t("wip.compose.whyCommit", { number: group + 1 })}</strong> {reason}
        </div>
        {unsure.has(id) ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning-surface px-3 py-2 text-sm text-warning" data-compose-unsure-note="">
            <span className="min-w-0 flex-1">{t("wip.compose.unsureNote")}</span>
            <Button size="sm" variant="secondary" data-compose-confirm="" onClick={() => onConfirm(id)}>
              {t("wip.compose.confirm")}
              <Kbd>Enter</Kbd>
            </Button>
          </div>
        ) : null}
        <MoveButtons arrangement={arrangement} current={group} onMove={onMove} />
      </div>
      <div className="p-3" data-compose-hunk="">
        {unit.lines.length > 0 ? <DiffHunk header={unit.header || unitDetail(unit)} lines={toUiLines(unit)} /> : <p className="m-0 text-sm text-text-muted">{unitDetail(unit)}</p>}
        {unit.linesCut ? <p className="m-0 mt-2 text-sm text-text-muted">{t("wip.compose.cut", { count: unit.lines.length })}</p> : null}
      </div>
    </div>
  );
}
