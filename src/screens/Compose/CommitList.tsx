/**
 * "By commits": every commit with its inline message, reason, counts and dependency problems, its
 * units below; "Don't commit" at the end. One focusable element (the list, `aria-activedescendant`)
 * carries the keyboard; rows are selected by click, Ctrl/Cmd click and Shift click.
 *
 * Dragging uses pointer events (Tauri intercepts HTML5 drag and drop on Windows): it starts after a
 * few pixels, the group under the pointer lights up, Esc cancels. Selected units move together.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { ComposeNote } from "../../core";
import { Button } from "../../ui/Button";
import { cn, laneColor } from "../../ui/cn";
import { t } from "../../i18n";
import { SUMMARY_LIMIT } from "../../core/limits";
import { SKIP, brokenNeeds, commitProblems, peekOf, splitPath, unitDetail, type Arrangement, type Review, type Selection, type Units } from "./model";

/** Movement from which a press becomes a drag (CSS pixels). */
const DRAG_THRESHOLD = 4;

export const rowId = (listId: string, unit: string) => `${listId}-${unit.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

const fileOf = (path: string) => splitPath(path).name;

export interface CommitListProps {
  listId: string;
  listRef: RefObject<HTMLDivElement | null>;
  arrangement: Arrangement;
  units: Units;
  notes: ReadonlyMap<string, ComposeNote>;
  review: Review;
  unsure: ReadonlySet<string>;
  selection: Selection;
  /** Units that just moved (short highlight). */
  moved: ReadonlySet<string>;
  onSelect: (unit: string, mode: "one" | "toggle" | "range") => void;
  onDrop: (ids: string[], group: number) => void;
  onTitle: (index: number, title: string) => void;
  onMoveCommit: (index: number, delta: -1 | 1) => void;
  onMerge: (index: number) => void;
  onGoto: (unit: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

interface Drag {
  ids: string[];
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  over: number | null;
}

export function CommitList(props: CommitListProps) {
  const { listId, listRef, arrangement, units, selection, onDrop } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  useEffect(() => {
    if (!drag) return;
    const groupAt = (x: number, y: number): number | null => {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-compose-drop]");
      if (!element || !listRef.current?.contains(element)) return null;
      return Number(element.dataset.composeDrop);
    };
    const onMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const far = Math.abs(event.clientX - current.startX) > DRAG_THRESHOLD || Math.abs(event.clientY - current.startY) > DRAG_THRESHOLD;
      if (!current.active && !far) return;
      update({ ...current, active: true, over: groupAt(event.clientX, event.clientY) });
    };
    const onUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
      update(null);
      if (current.active && current.over !== null) onDrop(current.ids, current.over);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current?.active) {
        event.preventDefault();
        event.stopPropagation();
        update(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
    // The listeners read the drag from the ref; they only need to exist while one is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const onRowPointerDown = (event: ReactPointerEvent, unit: string) => {
    if (event.button !== 0 || units.get(unit)?.protected) return;
    const ids = selection.ids.includes(unit) ? selection.ids.filter((id) => !units.get(id)?.protected) : [unit];
    update({ ids, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, over: null });
  };

  const dragging = drag?.active ? new Set(drag.ids) : null;
  const groups = [...arrangement.commits.map((_, index) => index), SKIP];
  return (
    <div
      ref={listRef}
      role="group"
      tabIndex={0}
      aria-label={t("wip.compose.list")}
      aria-activedescendant={selection.cursor ? rowId(listId, selection.cursor) : undefined}
      data-compose-list=""
      data-dragging={drag?.active ? "" : undefined}
      onKeyDown={props.onKeyDown}
      className="min-h-0 flex-1 overflow-auto pb-3 outline-none"
    >
      {groups.map((group) => (
        <Group
          key={group === SKIP ? "skip" : arrangement.commits[group]!.key}
          group={group}
          props={props}
          over={drag?.active ? drag.over === group : false}
          dragging={dragging}
          startDrag={onRowPointerDown}
        />
      ))}
    </div>
  );
}

type StartDrag = (event: ReactPointerEvent, unit: string) => void;

function Group({ group, props, over, dragging, startDrag }: { group: number; props: CommitListProps; over: boolean; dragging: ReadonlySet<string> | null; startDrag: StartDrag }) {
  const { arrangement, units } = props;
  const commit = group === SKIP ? null : arrangement.commits[group]!;
  const ids = commit ? commit.units : arrangement.skip;
  const problems = commit ? commitProblems(arrangement, units, group) : [];
  const added = ids.reduce((sum, id) => sum + (units.get(id)?.added ?? 0), 0);
  const removed = ids.reduce((sum, id) => sum + (units.get(id)?.removed ?? 0), 0);
  const length = commit?.title.length ?? 0;
  const tooLong = length > SUMMARY_LIMIT;
  const why = !commit ? t("wip.compose.skipHint") : commit.origin === "user" ? t("wip.compose.byYouCommit") : commit.origin === "merged" ? t("wip.compose.merged") : commit.reason;
  const last = arrangement.commits.length - 1;
  return (
    <section
      data-compose-drop={String(group)}
      data-compose-group={commit ? String(group) : "skip"}
      aria-label={commit ? t("wip.compose.commit", { number: group + 1 }) : t("wip.compose.skip")}
      className={cn("group/commit border-b border-border", over && "bg-accent-surface")}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pt-3 pb-1">
        {commit ? (
          <span className="grid size-5.5 place-items-center rounded-full text-xs font-semibold text-on-lane" style={{ backgroundColor: laneColor(group) }} aria-hidden>
            {group + 1}
          </span>
        ) : (
          <span className="grid size-5.5 place-items-center rounded-full border border-dashed border-border-input text-xs font-semibold text-text-muted" aria-hidden>
            0
          </span>
        )}
        {commit ? (
          <input
            data-compose-subject={String(group)}
            value={commit.title}
            placeholder={t("wip.compose.messagePlaceholder")}
            aria-label={t("wip.compose.commitMessage", { number: group + 1 })}
            aria-invalid={tooLong || undefined}
            spellCheck={false}
            onChange={(event) => props.onTitle(group, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                props.listRef.current?.focus({ preventScroll: true });
              }
            }}
            className={cn(
              "-ml-1.5 h-control-sm min-w-0 flex-1 basis-48 rounded-sm border border-transparent bg-transparent px-1.5 text-base font-semibold outline-none",
              "placeholder:font-normal placeholder:text-text-disabled hover:border-border focus:border-border-input focus:bg-surface-raised",
              tooLong ? "text-danger" : "text-text",
            )}
          />
        ) : (
          <strong className="min-w-0 flex-1 text-base font-semibold text-text">{t("wip.compose.skip")}</strong>
        )}
        {commit ? (
          <span className="ml-auto flex shrink-0 gap-0.5 opacity-60 group-focus-within/commit:opacity-100 group-hover/commit:opacity-100">
            <Button size="sm" variant="ghost" title={t("wip.compose.earlierTip")} disabled={group === 0} onClick={() => props.onMoveCommit(group, -1)} className="text-text-muted">
              {t("wip.compose.earlier")}
            </Button>
            <Button size="sm" variant="ghost" title={t("wip.compose.laterTip")} disabled={group === last} onClick={() => props.onMoveCommit(group, 1)} className="text-text-muted">
              {t("wip.compose.later")}
            </Button>
            <Button size="sm" variant="ghost" data-compose-merge={String(group)} disabled={group === last} onClick={() => props.onMerge(group)} className="text-text-muted">
              {t("wip.compose.merge")}
            </Button>
          </span>
        ) : null}
      </div>
      {why ? <p className="m-0 mr-4 ml-12 text-sm text-text-muted">{why}</p> : null}
      {commit ? (
        <div className="mx-4 mt-0.5 mb-2 ml-12 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
          <span>
            {t("wip.compose.units", { count: ids.length })} · <span className="font-mono">{t("wip.compose.lines", { added, removed })}</span>
          </span>
          <span data-compose-length="" className={tooLong ? "text-danger" : undefined}>
            {t("wip.compose.length", { length })}
          </span>
          {problems.map((problem) => (
            <button
              key={`${problem.unit}-${problem.need}`}
              type="button"
              data-compose-problem={String(group)}
              onClick={() => props.onGoto(problem.unit)}
              className="rounded-sm text-warning underline-offset-2 hover:underline"
            >
              {problem.group === SKIP
                ? t("wip.compose.needsSkipped", { file: fileOf(units.get(problem.need)?.path ?? "") })
                : t("wip.compose.needsLater", { file: fileOf(units.get(problem.need)?.path ?? ""), number: problem.group + 1 })}
            </button>
          ))}
        </div>
      ) : null}
      <div role="listbox" aria-multiselectable aria-label={commit ? t("wip.compose.commit", { number: group + 1 }) : t("wip.compose.skip")} className="grid gap-0.5 pr-2 pb-2 pl-10">
        {ids.map((id) => (
          <UnitRow key={id} id={id} group={group} props={props} dragging={dragging?.has(id) ?? false} startDrag={startDrag} />
        ))}
      </div>
      {!commit && ids.length === 0 ? <div className="mx-2 mb-2 ml-12 rounded-md border border-dashed border-border p-2.5 text-sm text-text-muted">{t("wip.compose.skipEmpty")}</div> : null}
    </section>
  );
}

function UnitRow({ id, group, props, dragging, startDrag }: { id: string; group: number; props: CommitListProps; dragging: boolean; startDrag: StartDrag }) {
  const { units, arrangement, selection, review, unsure, moved, listId } = props;
  const unit = units.get(id);
  if (!unit) return null;
  const { dir, name } = splitPath(unit.path);
  const locked = Boolean(unit.protected);
  const selected = selection.ids.includes(id);
  const cursor = selection.cursor === id;
  const needs = brokenNeeds(arrangement, units, id);
  const peek = locked ? [] : peekOf(unit);
  const kind = unit.kind === "hunk" ? null : unitDetail(unit);
  return (
    <div
      id={rowId(listId, id)}
      role="option"
      aria-selected={selected}
      data-compose-unit=""
      data-path={unit.path}
      data-hunk={unit.hunkIndex === null ? "file" : String(unit.hunkIndex)}
      data-group={group === SKIP ? "skip" : String(group)}
      data-cursor={cursor ? "" : undefined}
      data-locked={locked ? "" : undefined}
      onPointerDown={(event) => startDrag(event, id)}
      onClick={(event) => {
        props.onSelect(id, event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "one");
        props.listRef.current?.focus({ preventScroll: true });
      }}
      className={cn(
        "grid cursor-default grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-md border border-transparent px-2 py-1.5 select-none",
        selected ? "border-accent/45 bg-accent-surface" : "hover:bg-surface",
        cursor && "outline-2 -outline-offset-2 outline-accent",
        dragging && "opacity-40",
        moved.has(id) && !selected && "bg-accent-surface",
      )}
    >
      <span className="truncate text-sm">
        <span className="text-text-muted">{dir}</span>
        <span className="text-text">{name}</span>
      </span>
      <span className="font-mono text-xs whitespace-nowrap">
        {locked ? null : (
          <>
            <span className="text-success">+{unit.added}</span> <span className="text-danger">−{unit.removed}</span>
          </>
        )}
      </span>
      {peek.length > 0 ? (
        <span className="col-span-2 grid overflow-hidden" data-compose-peek="">
          {peek.map((line, index) => (
            <span key={index} className="truncate font-mono text-xs whitespace-pre text-text-muted">
              <span className={line.kind === "add" ? "text-success" : "text-danger"}>{line.kind === "add" ? "+ " : "− "}</span>
              {line.text || t("wip.compose.emptyLine")}
            </span>
          ))}
        </span>
      ) : null}
      <Tags locked={locked} kind={kind} unsure={unsure.has(id)} byYou={review.pinned.has(id)} needs={needs} units={units} />
    </div>
  );
}

function Tags({ locked, kind, unsure, byYou, needs, units }: { locked: boolean; kind: string | null; unsure: boolean; byYou: boolean; needs: { need: string; group: number }[]; units: Units }) {
  if (!locked && !kind && !unsure && !byYou && needs.length === 0) return null;
  const tag = "rounded-pill px-1.5 text-xs";
  return (
    <span className="col-span-2 flex flex-wrap gap-1.5">
      {locked ? (
        <span data-compose-tag="protected" className={cn(tag, "bg-danger-surface text-danger")}>
          {t("wip.compose.tag.protected")}
        </span>
      ) : null}
      {kind && !locked ? (
        <span data-compose-tag="kind" className={cn(tag, "bg-surface text-text-muted")}>
          {kind}
        </span>
      ) : null}
      {unsure ? (
        <span data-compose-tag="unsure" className={cn(tag, "bg-warning-surface text-warning")}>
          {t("wip.compose.tag.unsure")}
        </span>
      ) : null}
      {byYou ? (
        <span data-compose-tag="by-you" className={cn(tag, "bg-accent-surface text-accent")}>
          {t("wip.compose.tag.byYou")}
        </span>
      ) : null}
      {needs.map((need) => (
        <span key={need.need} data-compose-tag="needs" className={cn(tag, "bg-warning-surface text-warning")}>
          {need.group === SKIP
            ? t("wip.compose.tag.needsSkipped", { file: fileOf(units.get(need.need)?.path ?? "") })
            : t("wip.compose.tag.needsLater", { file: fileOf(units.get(need.need)?.path ?? ""), number: need.group + 1 })}
        </span>
      ))}
    </span>
  );
}
