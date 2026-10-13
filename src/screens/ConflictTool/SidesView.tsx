/**
 * The side-by-side view at the top of the conflict tool: the current side on the left, the
 * incoming side on the right, block by block at the same height in ONE scroll area (so both run
 * in sync). In a narrow window only one side is shown; a toggle switches.
 *
 * Usage: every conflict line and every block header is a checkbox. Exactly one of them is
 * reachable via Tab (roving tabindex); arrow keys move the focus, ←/→ switches the side,
 * Space or Enter toggles, T swaps the order when both sides are chosen.
 */
import { defaultRangeExtractor, useVirtualizer, type Range as VirtualRange } from "@tanstack/react-virtual";
import { ArrowDownUp, Check, Minus, WandSparkles } from "lucide-react";
import { forwardRef, memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LineToken, LineTokens } from "../../components/code/highlight";
import type { CodeSettings } from "../../components/code/settings";
import { IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { blockState, sideState, type BlockState, type Choice, type Chunk, type MergeModel, type Row, type RowModel, type Side } from "./model";
import type { SideTitles } from "./titles";
import { t } from "../../i18n";

export interface SidesViewHandle {
  /** Scrolls to the block and (optionally) puts the focus on its header. */
  revealChunk(chunk: number, options?: { focus?: boolean; side?: Side }): void;
  chunkAt(): { chunk: number; fraction: number } | null;
  scrollToChunk(chunk: number, fraction: number): void;
  focus(): void;
  scroller(): HTMLDivElement | null;
}

export interface SidesViewProps {
  model: MergeModel;
  rowModel: RowModel;
  choices: (Choice | null)[];
  manual: (string | null)[];
  titles: SideTitles;
  /** null: both sides next to each other; otherwise only this one. */
  single: Side | null;
  onSingleChange: (side: Side) => void;
  code: CodeSettings;
  tokens: { ours: LineTokens | null; theirs: LineTokens | null };
  onToggleSide: (chunk: number, side: Side) => void;
  onToggleLine: (chunk: number, side: Side, offset: number) => void;
  onSwap: (chunk: number) => void;
  /** The focus is in this conflict (sequence number). */
  onCurrentConflict: (conflict: number) => void;
  onScroll: () => void;
}

interface Item {
  row: number;
  side: Side;
  chunk: number;
  /** −1 = Block-Kopf. */
  offset: number;
}

/** Estimate for a block's header row above the row height; it is measured anyway. */
const HEAD_EXTRA = 10;

const itemKey = (row: number, side: Side) => `${row}:${side}`;

/** What the block's state means for ONE side – as text, not only as colour. */
function sideStatus(state: BlockState, checked: boolean | "mixed"): { text: string; className: string } {
  if (state === "open") return { text: t("conflict.block.open"), className: "bg-warning-surface text-text" };
  if (state === "manual") return { text: t("conflict.result.manual"), className: "bg-accent-surface text-text" };
  if (checked === true) return { text: t("conflict.block.taken"), className: "bg-success-surface text-text" };
  if (checked === "mixed") return { text: t("conflict.block.partly"), className: "bg-success-surface text-text" };
  return { text: t("conflict.block.notTaken"), className: "text-text-muted" };
}

/** Small checkbox in the style of the design system; the name is on the surrounding role. */
function Box({ state, muted }: { state: boolean | "mixed"; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        state ? "border-accent bg-accent text-on-accent" : "border-border-input bg-surface-sunken",
        muted && "opacity-60",
      )}
    >
      {state === "mixed" ? <Minus className="size-3" strokeWidth={3} /> : state ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

function CodeText({ text, tokens }: { text: string; tokens: LineToken[] | undefined }): ReactNode {
  if (text === "") return "​";
  if (!tokens || tokens.length === 0) return text;
  const parts: ReactNode[] = [];
  let position = 0;
  tokens.forEach((token, index) => {
    if (token.from > position) parts.push(text.slice(position, token.from));
    parts.push(
      <span key={index} className={token.className}>
        {text.slice(token.from, token.to)}
      </span>,
    );
    position = token.to;
  });
  if (position < text.length) parts.push(text.slice(position));
  return parts;
}

interface RowViewProps {
  row: Row;
  rowIndex: number;
  chunk: Chunk;
  choice: Choice | null;
  manual: string | null;
  sides: Side[];
  titles: SideTitles;
  focusKey: string;
  digits: number;
  tokens: { ours: LineTokens | null; theirs: LineTokens | null };
  onCell: (item: Item) => void;
  onSwap: (chunk: number) => void;
}

const RowView = memo(function RowView({ row, rowIndex, chunk, choice, manual, sides, titles, focusKey, digits, tokens, onCell, onSwap }: RowViewProps) {
  const state = choice ? blockState(choice, manual) : null;
  const gutter = { width: `${digits + 1}ch` };

  const cells = sides.map((side, column) => {
    const border = column > 0 ? "border-l border-border" : "";
    if (row.type === "head") {
      if (chunk.kind === "auto") {
        const changed = chunk.from === "both" || chunk.from === side;
        return (
          <div key={side} className={cn("flex h-row min-w-0 items-center gap-2 border-t border-border bg-surface px-2 font-sans text-xs text-text-muted", border)}>
            {changed ? (
              <>
                <WandSparkles className="size-3.5 shrink-0 text-accent" aria-hidden />
                <span className="truncate font-medium text-text">{chunk.from === "both" ? t("conflict.block.bothSame") : t("conflict.block.auto")}</span>
              </>
            ) : (
              <span className="truncate">{t("conflict.block.otherChanged")}</span>
            )}
          </div>
        );
      }
      if (!choice || !state) return null;
      const checked = sideState(chunk, choice, side);
      const position = choice.order.length === 2 ? choice.order.indexOf(side) : -1;
      const key = itemKey(rowIndex, side);
      const number = chunk.conflict + 1;
      const status = sideStatus(state, checked);
      return (
        <div key={side} className={cn("flex h-control-md min-w-0 items-center gap-1 border-t border-border bg-surface pr-1 font-sans", border)}>
          <div
            role="checkbox"
            aria-checked={checked}
            aria-label={t("conflict.block.takeLabel", { number, side: titles[side].heading })}
            aria-keyshortcuts={choice.order.length === 2 ? "T" : undefined}
            tabIndex={key === focusKey ? 0 : -1}
            data-focus-home={key === focusKey ? "" : undefined}
            data-item={key}
            data-conflict-head={chunk.conflict}
            data-side={side}
            onClick={() => onCell({ row: rowIndex, side, chunk: chunk.id, offset: -1 })}
            className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-sm pl-2 hover:bg-surface-raised"
          >
            <Box state={checked} muted={state === "manual"} />
            <span className="shrink-0 text-sm font-medium text-text">{t("conflict.block.title", { number })}</span>
            <span data-block-state={state} className={cn("truncate rounded-sm px-1.5 text-xs", status.className)}>
              {status.text}
            </span>
            {position >= 0 ? (
              <span className="shrink-0 rounded-sm border border-border px-1 text-xs text-text-muted" data-order={position + 1}>
                {position === 0 ? t("conflict.block.first") : t("conflict.block.then")}
              </span>
            ) : null}
            {chunk[side].length === 0 ? <span className="shrink-0 text-xs text-text-muted">{t("conflict.block.noLines")}</span> : null}
          </div>
          {choice.order.length === 2 && (sides.length === 1 || side === "theirs") ? (
            <IconButton
              size="sm"
              tabIndex={-1}
              label={t("conflict.block.swap")}
              shortcut="T"
              icon={<ArrowDownUp className="size-icon" aria-hidden />}
              onClick={(event) => {
                event.stopPropagation();
                onSwap(chunk.id);
              }}
            />
          ) : null}
        </div>
      );
    }

    const cell = row[side];
    if (!cell) return <div key={side} aria-hidden className={cn("gc-cf-filler min-w-0", border)} />;
    const lineTokens = tokens[side]?.[cell.line];
    const number = (
      <span className="shrink-0 pr-2 text-right text-text-muted tabular-nums select-none" style={gutter}>
        {cell.line + 1}
      </span>
    );
    const code = (
      <span className="min-w-0 flex-1 break-all whitespace-pre-wrap text-text" data-line-text="">
        <CodeText text={cell.text} tokens={lineTokens} />
      </span>
    );

    if (chunk.kind === "conflict" && choice && state) {
      const selected = choice[side][cell.offset] === true;
      const decided = state !== "open";
      const key = itemKey(rowIndex, side);
      return (
        <div
          key={side}
          role="checkbox"
          aria-checked={selected}
          aria-label={t("conflict.block.takeLine", { line: cell.line + 1, side: titles[side].heading })}
          tabIndex={key === focusKey ? 0 : -1}
          data-focus-home={key === focusKey ? "" : undefined}
          data-item={key}
          data-side={side}
          data-line={cell.line + 1}
          data-selected={selected || undefined}
          onClick={() => onCell({ row: rowIndex, side, chunk: chunk.id, offset: cell.offset })}
          className={cn(
            "flex min-w-0 cursor-default items-start gap-1.5 pl-2",
            border,
            state === "manual" ? "bg-surface" : selected ? "bg-success-surface" : decided ? "bg-surface" : "bg-warning-surface",
            !selected && decided && state !== "manual" && "gc-cf-dropped",
          )}
        >
          <span className="flex h-(--gc-code-line-height) items-center">
            <Box state={selected} muted={state === "manual"} />
          </span>
          {number}
          {code}
        </div>
      );
    }

    // Unchanged or taken automatically: display only.
    const taken = chunk.kind === "auto" && (chunk.from === "both" || chunk.from === side);
    const replaced = chunk.kind === "auto" && !taken;
    return (
      <div key={side} className={cn("flex min-w-0 items-start gap-1.5 pl-2", border, taken && "bg-accent-surface", replaced && "gc-cf-dropped")} data-side={side} data-line={cell.line + 1}>
        <span className="w-4 shrink-0" aria-hidden />
        {number}
        {code}
      </div>
    );
  });

  return <div className={cn("grid", sides.length === 2 ? "grid-cols-2" : "grid-cols-1")}>{cells}</div>;
});

export const SidesView = forwardRef<SidesViewHandle, SidesViewProps>(function SidesView(props, ref) {
  const { model, rowModel, choices, manual, titles, single, code, tokens } = props;
  const { rows, chunkStart } = rowModel;
  const scroller = useRef<HTMLDivElement>(null);
  const sides: Side[] = single ? [single] : ["ours", "theirs"];

  // --- Bedienbare Elemente in Lesereihenfolge ------------------------------------------
  const items = useMemo(() => {
    const list: Item[] = [];
    rows.forEach((row, index) => {
      const chunk = model.chunks[row.chunk]!;
      if (chunk.kind !== "conflict") return;
      for (const side of ["ours", "theirs"] as Side[]) {
        if (row.type === "head") list.push({ row: index, side, chunk: chunk.id, offset: -1 });
        else if (row[side]) list.push({ row: index, side, chunk: chunk.id, offset: row[side]!.offset });
      }
    });
    return list;
  }, [rows, model]);
  const bySide = useMemo(() => ({ ours: items.filter((item) => item.side === "ours"), theirs: items.filter((item) => item.side === "theirs") }), [items]);
  const byKey = useMemo(() => new Map(items.map((item) => [itemKey(item.row, item.side), item])), [items]);

  const firstItem = (side: Side) => bySide[side][0] ?? items[0] ?? null;
  const [focus, setFocus] = useState<Item | null>(() => firstItem(single ?? "ours"));
  // If the focus is on a side that is not visible right now, it moves along.
  const current = focus && (!single || focus.side === single) ? focus : focus && single ? nearest(bySide[single], focus.row) : focus;
  const focusKey = current ? itemKey(current.row, current.side) : "";

  const digits = useMemo(() => String(Math.max(1, ...model.chunks.map((chunk) => Math.max(chunk.oursStart + chunk.ours.length, chunk.theirsStart + chunk.theirs.length)))).length, [model]);

  // --- Virtualisierung -----------------------------------------------------------------
  const lineHeight = code.lineHeight;
  const focusRow = current?.row ?? -1;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (rows[index]?.type === "head" ? lineHeight + HEAD_EXTRA : lineHeight),
    overscan: 20,
    rangeExtractor: useCallback(
      (range: VirtualRange) => {
        const indexes = defaultRangeExtractor(range);
        if (focusRow >= 0 && !indexes.includes(focusRow)) {
          indexes.push(focusRow);
          indexes.sort((a, b) => a - b);
        }
        return indexes;
      },
      [focusRow],
    ),
  });

  // Row height or width change the wrapping: measure again.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, lineHeight, single]);

  const focusItem = useCallback(
    (item: Item | null, options: { scroll?: boolean } = {}) => {
      if (!item) return;
      setFocus(item);
      if (single && item.side !== single) props.onSingleChange(item.side);
      const chunk = model.chunks[item.chunk];
      if (chunk) props.onCurrentConflict(chunk.conflict);
      if (options.scroll !== false) virtualizer.scrollToIndex(item.row, { align: "auto" });
      const key = itemKey(item.row, item.side);
      // The element only exists after painting.
      const apply = (tries: number) => {
        const element = scroller.current?.querySelector<HTMLElement>(`[data-item="${key}"]`);
        if (element) element.focus({ preventScroll: true });
        else if (tries > 0) requestAnimationFrame(() => apply(tries - 1));
      };
      requestAnimationFrame(() => apply(5));
    },
    [model, props, single, virtualizer],
  );

  const onCell = useCallback(
    (item: Item) => {
      setFocus(item);
      const chunk = model.chunks[item.chunk];
      if (chunk) props.onCurrentConflict(chunk.conflict);
      if (item.offset < 0) props.onToggleSide(item.chunk, item.side);
      else props.onToggleLine(item.chunk, item.side, item.offset);
    },
    [model, props],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current || event.ctrlKey || event.metaKey || event.altKey) return;
    const side = current.side;
    const list = bySide[side];
    const at = list.findIndex((item) => item.row === current.row);
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        focusItem(list[Math.min(list.length - 1, at + 1)] ?? null);
        break;
      case "ArrowUp":
        focusItem(list[Math.max(0, at - 1)] ?? null);
        break;
      case "PageDown":
        focusItem(list[Math.min(list.length - 1, at + 12)] ?? null);
        break;
      case "PageUp":
        focusItem(list[Math.max(0, at - 12)] ?? null);
        break;
      case "Home":
        focusItem(list[0] ?? null);
        break;
      case "End":
        focusItem(list[list.length - 1] ?? null);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const target: Side = event.key === "ArrowLeft" ? "ours" : "theirs";
        if (target === side) {
          handled = !single;
          break;
        }
        const sameRow = bySide[target].find((item) => item.row === current.row);
        const sameChunk = bySide[target].filter((item) => item.chunk === current.chunk);
        focusItem(sameRow ?? nearest(sameChunk, current.row) ?? nearest(bySide[target], current.row));
        break;
      }
      case " ":
      case "Enter":
        onCell(current);
        break;
      case "t":
      case "T":
        if (event.shiftKey && event.key === "t") handled = false;
        else if (choices[current.chunk]?.order.length === 2) props.onSwap(current.chunk);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  useImperativeHandle(
    ref,
    (): SidesViewHandle => ({
      revealChunk: (chunk, options = {}) => {
        const start = chunkStart[chunk];
        if (start === undefined) return;
        const side = options.side ?? single ?? current?.side ?? "ours";
        const head = bySide[side].find((item) => item.row === start) ?? items.find((item) => item.row === start);
        virtualizer.scrollToIndex(start, { align: "start" });
        if (head) {
          if (options.focus) focusItem(head, { scroll: false });
          else setFocus(head);
        }
      },
      chunkAt: () => {
        const element = scroller.current;
        if (!element || rows.length === 0) return null;
        const item = virtualizer.getVirtualItemForOffset(element.scrollTop);
        if (!item) return null;
        const row = rows[item.index];
        if (!row) return null;
        const box = chunkBox(row.chunk);
        if (!box) return null;
        const fraction = box.height > 0 ? Math.min(1, Math.max(0, (element.scrollTop - box.top) / box.height)) : 0;
        return { chunk: row.chunk, fraction };
      },
      scrollToChunk: (chunk, fraction) => {
        const element = scroller.current;
        const box = chunkBox(chunk);
        if (!element || !box) return;
        element.scrollTop = box.top + fraction * box.height;
      },
      focus: () => focusItem(current, { scroll: true }),
      scroller: () => scroller.current,
    }),
  );

  /** Position of a block in the scroll content (estimated as long as it is not measured). */
  function chunkBox(chunk: number): { top: number; height: number } | null {
    const first = chunkStart[chunk];
    if (first === undefined) return null;
    const last = (chunkStart[chunk + 1] ?? rows.length) - 1;
    const cache = virtualizer.measurementsCache;
    const top = cache[first]?.start;
    const bottom = cache[last]?.end;
    if (top === undefined || bottom === undefined) return null;
    return { top, height: bottom - top };
  }

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        role="group"
        aria-label={single ? t("conflict.sides.single", { side: titles[single].heading }) : t("conflict.sides.both", { ours: titles.ours.heading, theirs: titles.theirs.heading })}
        tabIndex={items.length === 0 ? 0 : undefined}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          // The focus can also come from outside (Tab, F6, click): the roving marker follows.
          const item = byKey.get((event.target as HTMLElement).dataset.item ?? "");
          if (!item || (current && item.row === current.row && item.side === current.side)) return;
          setFocus(item);
          const chunk = model.chunks[item.chunk];
          if (chunk) props.onCurrentConflict(chunk.conflict);
        }}
        onScroll={props.onScroll}
        data-sides=""
        data-single={single ?? undefined}
        className="gc-code relative min-h-0 flex-1 overflow-y-auto bg-surface-sunken"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualItems.map((virtual) => {
            const row = rows[virtual.index];
            if (!row) return null;
            const chunk = model.chunks[row.chunk]!;
            return (
              <div
                key={virtual.key}
                ref={virtualizer.measureElement}
                data-index={virtual.index}
                data-row={virtual.index}
                data-chunk={row.chunk}
                data-kind={row.type === "head" ? `${chunk.kind}-head` : chunk.kind}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${virtual.start}px)` }}
              >
                <RowView
                  row={row}
                  rowIndex={virtual.index}
                  chunk={chunk}
                  choice={choices[row.chunk] ?? null}
                  manual={manual[row.chunk] ?? null}
                  sides={sides}
                  titles={titles}
                  focusKey={focusKey}
                  digits={digits}
                  tokens={tokens}
                  onCell={onCell}
                  onSwap={props.onSwap}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

function nearest(list: Item[], row: number): Item | null {
  let best: Item | null = null;
  for (const item of list) {
    if (!best || Math.abs(item.row - row) < Math.abs(best.row - row)) best = item;
  }
  return best;
}

