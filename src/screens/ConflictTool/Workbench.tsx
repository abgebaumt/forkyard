/**
 * The workbench of the conflict tool: both sides next to each other at the top, the result below.
 *
 * Who leads? The editor at the bottom holds the text. The selection (checkboxes) lives in the state
 * here; every change to it replaces exactly the range of its block in the editor. When the user
 * types, each block is compared to check whether the text still matches what the selection would
 * produce – if not, the block counts as “edited by hand”.
 */
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, Link2, Link2Off, RotateCcw, Save, Search } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { ConflictFile, Id } from "../../core";
import { choose, confirm } from "../../app/dialogs";
import { setCenterGuard, useBusy, type CenterGuard } from "../../app/store";
import { useLineTokens } from "../../components/code/highlight";
import { codeVars, useCodeSettings } from "../../components/code/settings";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { SegmentedControl } from "../../ui/Field";
import { Tip } from "../../ui/Tooltip";
import { resolveBusyKey, resolveConflict } from "./actions";
import {
  buildModel,
  buildRows,
  chunkText,
  detectEol,
  emptyChoice,
  finalizeText,
  isResolved,
  markerLines,
  sideState,
  swapOrder,
  toggleLine,
  toggleSide,
  worktreeMatches,
  type Choice,
  type Eol,
  type Side,
} from "./model";
import { Divider, Strip, Tag, ToolHeader, splitPath } from "./parts";
import { ResultEditor, type ChunkLook, type ResultEditorHandle } from "./ResultEditor";
import { dropSession, loadSession, saveSession } from "./session";
import { SidesView, type SidesViewHandle } from "./SidesView";
import type { SideTitles } from "./titles";
import { t } from "../../i18n";

export interface WorkbenchHandle {
  goToConflict(direction: 1 | -1): void;
  save(): void;
  openSearch(): void;
}

export interface WorkbenchProps {
  repoId: Id;
  tabId: Id;
  path: string;
  file: ConflictFile;
  ours: string;
  theirs: string;
  titles: SideTitles;
  /** Additions in the header (encoding …). */
  tags?: ReactNode;
  /** Switching between the conflict files. */
  fileNav?: ReactNode;
  onClose: () => void;
}

/** Below this width of the view only one side is shown, with a toggle. */
const SIDE_BY_SIDE_MIN = 640;
const SPLIT_KEY = "gc.conflictSplit";
const SPLIT_MIN = 0.2;
const SPLIT_MAX = 0.8;

const clampSplit = (value: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));

function storedSplit(): number {
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(value) && value > 0 ? clampSplit(value) : 0.5;
  } catch {
    return 0.5;
  }
}

const eolNames: Record<Eol, string> = { lf: "LF", crlf: "CRLF" };

export const Workbench = forwardRef<WorkbenchHandle, WorkbenchProps>(function Workbench({ repoId, tabId, path, file, ours, theirs, titles, tags, fileNav, onClose }, ref) {
  const code = useCodeSettings();
  const name = splitPath(path).name;
  const base = file.base;

  // --- Modell -------------------------------------------------------------------------
  const model = useMemo(() => buildModel(base, ours, theirs), [base, ours, theirs]);
  const rowModel = useMemo(() => buildRows(model), [model]);
  const labels = useMemo(() => ({ ours: file.oursLabel.trim() || "ours", theirs: file.theirsLabel.trim() || "theirs" }), [file.oursLabel, file.theirsLabel]);
  const known = model.knownMarkerLines;
  const total = model.conflicts.length;
  const autoCount = useMemo(() => model.chunks.filter((chunk) => chunk.kind === "auto").length, [model]);
  // The file in the working directory counts too: with autocrlf the versions in the index have LF.
  const eol: Eol = model.eol === "crlf" || detectEol(file.merged) === "crlf" ? "crlf" : "lf";
  const oursEol = detectEol(ours);
  const theirsEol = detectEol(theirs);
  const mixedEol = oursEol !== null && theirsEol !== null && oursEol !== theirsEol;
  // With mixed line endings Git reports the whole file as a conflict – comparing with its file then tells nothing.
  const handEdited = useMemo(() => !mixedEol && !worktreeMatches(model, file.merged), [mixedEol, model, file.merged]);

  // --- Initial state (new or from the started session) ----------------------------------
  const [initial] = useState(() => {
    const session = loadSession(repoId, path, file);
    if (session && session.bounds.length === model.chunks.length + 1 && session.choices.length === model.chunks.length) {
      return { choices: session.choices, doc: session.doc, bounds: session.bounds, restored: true };
    }
    const choices = model.chunks.map((chunk) => (chunk.kind === "conflict" ? emptyChoice(chunk) : null));
    const texts = model.chunks.map((chunk, index) => chunkText(chunk, choices[index] ?? null, labels));
    const bounds = [0];
    for (const text of texts) bounds.push(bounds[bounds.length - 1]! + text.length);
    return { choices, doc: texts.join(""), bounds, restored: false };
  });

  const [choices, setChoices] = useState<(Choice | null)[]>(initial.choices);
  const choicesRef = useRef(choices);
  /** What every block would produce without manual editing – only recomputed when the selection changes. */
  const expected = useRef<string[]>([]);
  if (expected.current.length === 0 && model.chunks.length > 0) expected.current = model.chunks.map((chunk, index) => chunkText(chunk, initial.choices[index] ?? null, labels));

  interface Derived {
    manual: (string | null)[];
    markers: number[];
  }
  const derive = useCallback(
    (texts: string[], doc: string): Derived => ({
      manual: texts.map((text, index) => (text === expected.current[index] ? null : text)),
      markers: markerLines(doc, known),
    }),
    [known],
  );
  const [derived, setDerived] = useState<Derived>(() => derive(initial.bounds.slice(0, -1).map((from, index) => initial.doc.slice(from, initial.bounds[index + 1])), initial.doc));
  const { manual, markers } = derived;
  const manualRef = useRef(manual);
  manualRef.current = manual;

  const sides = useRef<SidesViewHandle>(null);
  const editor = useRef<ResultEditorHandle>(null);
  const snapshot = useRef({ doc: initial.doc, bounds: initial.bounds });
  /** Saved or deliberately discarded: keep nothing when leaving. */
  const finished = useRef(false);

  const recompute = useCallback(() => {
    const handle = editor.current;
    if (!handle || !handle.view()) return;
    const doc = handle.text();
    snapshot.current = { doc, bounds: handle.bounds() };
    setDerived(derive(handle.chunkTexts(), doc));
  }, [derive]);
  const frame = useRef(0);
  const onDocChange = useCallback(
    (fromUser: boolean) => {
      if (!fromUser) return; // Replacements from the selection recompute right away themselves.
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(recompute);
    },
    [recompute],
  );
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // --- Zustand je Block -----------------------------------------------------------------
  const resolvedFlags = useMemo(() => model.conflicts.map((id) => isResolved(choices[id]!, manual[id] ?? null, known)), [model, choices, manual, known]);
  const resolved = resolvedFlags.filter(Boolean).length;
  const manualBlocks = model.conflicts.filter((id) => manual[id] != null).length;
  const editedElsewhere = manual.some((text, index) => text !== null && model.chunks[index]?.kind !== "conflict");
  const dirty = manual.some((text) => text !== null) || choices.some((choice) => choice !== null && choice.order.length > 0);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const looks = useMemo<ChunkLook[]>(
    () => model.chunks.map((chunk, index) => (chunk.kind === "same" ? "plain" : chunk.kind === "auto" ? "auto" : isResolved(choices[index]!, manual[index] ?? null, known) ? "done" : "open")),
    [model, choices, manual, known],
  );
  const [initialLooks] = useState(looks);
  useEffect(() => {
    editor.current?.setLooks(looks);
  }, [looks]);

  // --- Change selection -----------------------------------------------------------------
  const apply = useCallback(
    (changes: { chunk: number; choice: Choice }[]) => {
      if (changes.length === 0) return;
      const next = choicesRef.current.slice();
      const edits: { chunk: number; text: string }[] = [];
      for (const change of changes) {
        const chunk = model.chunks[change.chunk];
        if (!chunk) continue;
        next[change.chunk] = change.choice;
        const text = chunkText(chunk, change.choice, labels);
        expected.current[change.chunk] = text;
        edits.push({ chunk: change.chunk, text });
      }
      choicesRef.current = next;
      setChoices(next);
      editor.current?.replaceChunks(edits);
      recompute();
    },
    [model, labels, recompute],
  );

  const onToggleSide = useCallback(
    (id: number, side: Side) => {
      const chunk = model.chunks[id];
      const choice = choicesRef.current[id];
      if (!chunk || !choice) return;
      // After a manual edit the first click restores the selection (with this side).
      const on = manualRef.current[id] != null ? true : sideState(chunk, choice, side) !== true;
      apply([{ chunk: id, choice: toggleSide(chunk, choice, side, on) }]);
    },
    [model, apply],
  );
  const onToggleLine = useCallback(
    (id: number, side: Side, offset: number) => {
      const chunk = model.chunks[id];
      const choice = choicesRef.current[id];
      if (!chunk || !choice) return;
      const on = manualRef.current[id] != null ? true : !choice[side][offset];
      apply([{ chunk: id, choice: toggleLine(chunk, choice, side, offset, on) }]);
    },
    [model, apply],
  );
  const onSwap = useCallback(
    (id: number) => {
      const choice = choicesRef.current[id];
      if (choice && choice.order.length === 2) apply([{ chunk: id, choice: swapOrder(choice) }]);
    },
    [apply],
  );

  const takeAll = async (side: Side) => {
    const edited = model.conflicts.filter((id) => manualRef.current[id] != null).length;
    if (edited > 0) {
      const ok = await confirm({
        title: t("conflict.takeAll.title", { all: titles[side].all }),
        body: t("conflict.takeAll.body", { count: edited, side: titles[side].heading }),
        confirmLabel: titles[side].all,
        danger: true,
      });
      if (!ok) return;
    }
    apply(model.conflicts.map((id) => ({ chunk: id, choice: toggleSide(model.chunks[id]!, emptyChoice(model.chunks[id]!), side, true) })));
  };

  const reset = async () => {
    if (!dirtyRef.current) return;
    const ok = await confirm({
      title: t("conflict.reset.title", { name }),
      body: t("conflict.reset.body"),
      confirmLabel: t("conflict.reset.confirm"),
      danger: true,
    });
    if (!ok) return;
    const fresh = model.chunks.map((chunk) => (chunk.kind === "conflict" ? emptyChoice(chunk) : null));
    choicesRef.current = fresh;
    expected.current = model.chunks.map((chunk, index) => chunkText(chunk, fresh[index] ?? null, labels));
    setChoices(fresh);
    editor.current?.replaceChunks(expected.current.map((text, chunk) => ({ chunk, text })));
    recompute();
    dropSession(repoId, path);
    setRestored(false);
    sides.current?.focus();
  };
  const [restored, setRestored] = useState(initial.restored);

  // --- Navigation -----------------------------------------------------------------------
  const [current, setCurrent] = useState(total > 0 ? 0 : -1);
  /**
   * Against feedback loops in coupled scrolling: when one side sets the other's position, it
   * remembers the value it set – the scroll event with exactly this value is not played back.
   * When jumping (target not yet known) a short pause applies instead.
   */
  const echo = useRef<{ sides: number | null; result: number | null; pauseUntil: number }>({ sides: null, result: null, pauseUntil: 0 });
  const reveal = useCallback(
    (index: number, focus: boolean) => {
      const id = model.conflicts[index];
      if (id === undefined) return;
      setCurrent(index);
      const inEditor = editor.current?.hasFocus() ?? false;
      echo.current.pauseUntil = performance.now() + 400;
      sides.current?.revealChunk(id, { focus: focus && !inEditor });
      if (inEditor) editor.current?.selectChunk(id);
      else editor.current?.scrollToChunk(id);
    },
    [model],
  );
  const goToConflict = useCallback(
    (direction: 1 | -1) => {
      if (total === 0) return;
      const next = current < 0 ? (direction === 1 ? 0 : total - 1) : Math.min(total - 1, Math.max(0, current + direction));
      reveal(next, true);
    },
    [current, total, reveal],
  );

  // --- Gekoppeltes Scrollen -------------------------------------------------------------
  const [linked, setLinked] = useState(true);
  const isEcho = (which: "sides" | "result", top: number) => {
    const expectedTop = echo.current[which];
    echo.current[which] = null;
    return performance.now() < echo.current.pauseUntil || (expectedTop !== null && Math.abs(top - expectedTop) <= 2);
  };
  const onSidesScroll = useCallback(() => {
    const top = sides.current?.scroller()?.scrollTop ?? 0;
    if (isEcho("sides", top) || !linked) return;
    const position = sides.current?.chunkAt();
    const handle = editor.current;
    if (!position || !handle) return;
    handle.scrollToFraction(position.chunk, position.fraction);
    echo.current.result = handle.scrollTop();
  }, [linked]);
  const onResultScroll = useCallback(() => {
    const handle = editor.current;
    if (!handle) return;
    const top = handle.scrollTop();
    if (isEcho("result", top) || !linked) return;
    const position = handle.chunkAt(top);
    if (!position) return;
    sides.current?.scrollToChunk(position.chunk, position.fraction);
    echo.current.sides = sides.current?.scroller()?.scrollTop ?? null;
  }, [linked]);

  // --- Speichern ------------------------------------------------------------------------
  const busy = useBusy(resolveBusyKey(repoId, path));
  const open = total - resolved;
  const blocked: string | null =
    markers.length === 0
      ? null
      : open > 0
        ? t("conflict.save.blockedOpen", { count: open })
        : t("conflict.save.blockedMarker", { line: markers[0] });
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const save = useCallback(async () => {
    const handle = editor.current;
    if (!handle || busy) return;
    if (blockedRef.current) {
      // Instead of silently doing nothing: jump to the first open conflict.
      const firstOpen = model.conflicts.findIndex((id) => !isResolved(choicesRef.current[id]!, manualRef.current[id] ?? null, known));
      if (firstOpen >= 0) reveal(firstOpen, true);
      return;
    }
    const content = finalizeText(handle.text(), { eol, finalNewline: model.finalNewline });
    finished.current = true;
    const status = await resolveConflict(repoId, tabId, path, { content });
    if (!status) finished.current = false;
  }, [busy, model, known, reveal, eol, repoId, tabId, path]);

  useImperativeHandle(ref, () => ({ goToConflict, save: () => void save(), openSearch: () => editor.current?.openSearch() }), [goToConflict, save]);

  /** The file was resolved outside (editor, external merge tool): save and stage exactly this state. */
  const worktreeClean = handEdited && file.merged !== null && markerLines(file.merged, known).length === 0;
  const takeWorktree = async () => {
    if (file.merged === null || busy) return;
    if (dirtyRef.current) {
      const ok = await confirm({
        title: t("conflict.takeWorktree.title"),
        body: t("conflict.takeWorktree.body"),
        confirmLabel: t("conflict.takeWorktree.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    finished.current = true;
    const status = await resolveConflict(repoId, tabId, path, { content: file.merged });
    if (!status) finished.current = false;
  };

  // --- Guard when leaving, keep the session ---------------------------------------------
  useEffect(() => {
    const guard: CenterGuard = {
      dirty: () => dirtyRef.current && !finished.current,
      confirmLeave: async () => {
        const answer = await choose({
          title: t("conflict.leave.title", { name }),
          description: t("conflict.leave.body"),
          options: [
            { key: "keep", label: t("conflict.leave.keep"), description: t("conflict.leave.keepBody") },
            { key: "discard", label: t("conflict.leave.discard"), description: t("conflict.leave.discardBody"), danger: true },
          ],
        });
        if (answer === "discard") {
          finished.current = true;
          dropSession(repoId, path);
        }
        return answer !== null;
      },
    };
    setCenterGuard(tabId, guard);
    return () => {
      setCenterGuard(tabId, null, guard);
      if (dirtyRef.current && !finished.current) {
        saveSession(repoId, path, { base, ours, theirs, choices: choicesRef.current, doc: snapshot.current.doc, bounds: snapshot.current.bounds });
      }
    };
  }, [repoId, tabId, path, name, base, ours, theirs]);

  // --- Breite, Teilung ------------------------------------------------------------------
  const container = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= SIDE_BY_SIDE_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [shownSide, setShownSide] = useState<Side>("ours");
  const single: Side | null = wide ? null : shownSide;

  const [split, setSplitState] = useState(storedSplit);
  const setSplit = (value: number) => {
    const next = clampSplit(value);
    setSplitState(next);
    try {
      window.localStorage.setItem(SPLIT_KEY, String(next));
    } catch {
      // Without storage the split only lasts until closing.
    }
  };
  const onGripKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowUp") setSplit(split - 0.05);
    else if (event.key === "ArrowDown") setSplit(split + 0.05);
    else if (event.key === "Home") setSplit(SPLIT_MIN);
    else if (event.key === "End") setSplit(SPLIT_MAX);
    else if (event.key === "Enter") setSplit(0.5);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onGripPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1 || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = container.current?.getBoundingClientRect();
    if (box && box.height > 0) setSplit((event.clientY - box.top) / box.height);
  };

  // On opening, the focus is on the first conflict – unless it is somewhere else in the window right
  // now (e.g. in the file list, which is being browsed with the arrow keys).
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || container.current?.closest("[data-screen]")?.contains(active)) sides.current?.focus();
  }, []);

  const tokens = { ours: useLineTokens(path, ours), theirs: useLineTokens(path, theirs) };

  // --- Darstellung ----------------------------------------------------------------------
  const allDone = total > 0 && open === 0;
  const counter =
    total === 0 ? t("conflict.counter.none") : t("conflict.counter.resolved", { resolved, count: total });

  const sideHeading = (side: Side, withButton: boolean) => (
    <div className="flex h-control-lg min-w-0 items-center gap-2 pr-1 pl-3" data-side-heading={side}>
      <Tip label={titles[side].hint}>
        <h3 className="m-0 flex min-w-0 flex-1 items-baseline gap-1.5 text-sm font-normal">
          <span className="shrink-0 font-medium text-text">{titles[side].role}</span>
          {titles[side].name ? <span className="min-w-0 truncate font-mono text-code text-text-muted">({titles[side].name})</span> : null}
        </h3>
      </Tip>
      {withButton ? (
        <Button size="sm" variant="ghost" disabled={total === 0} data-take-all={side} onClick={() => void takeAll(side)}>
          {titles[side].all}
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <ToolHeader
        path={path}
        middle={tags}
        end={fileNav}
        onClose={onClose}
        toolbar={
          <div role="toolbar" aria-label={t("conflict.toolbar")} className="flex h-control-lg items-center gap-1 border-t border-border pr-1 pl-3">
            <p role="status" data-conflict-counter="" data-resolved={resolved} data-total={total} className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-sm">
              {allDone || total === 0 ? <CircleCheck className="size-icon shrink-0 text-success" aria-hidden /> : <CircleAlert className="size-icon shrink-0 text-warning" aria-hidden />}
              <span className="shrink-0 font-medium text-text">{counter}</span>
              {autoCount > 0 ? <span className="min-w-0 truncate text-text-muted">· {t("conflict.counter.auto", { count: autoCount })}</span> : null}
            </p>
            <div role="group" aria-label={t("conflict.nav.switch")} className="flex shrink-0 items-center">
              <IconButton size="sm" label={t("conflict.nav.prev")} shortcut="Shift+F7" disabled={total === 0 || current <= 0} icon={<ChevronUp className="size-icon" aria-hidden />} onClick={() => goToConflict(-1)} />
              <span className="min-w-8 px-0.5 text-center text-xs text-text-muted tabular-nums" data-conflict-position="" aria-label={current >= 0 ? t("conflict.nav.position", { index: current + 1, total }) : undefined}>
                {total === 0 ? "–" : current < 0 ? `${total}` : `${current + 1}/${total}`}
              </span>
              <IconButton size="sm" label={t("conflict.nav.next")} shortcut="F7" disabled={total === 0 || current >= total - 1} icon={<ChevronDown className="size-icon" aria-hidden />} onClick={() => goToConflict(1)} />
            </div>
            <Divider />
            <IconButton
              size="sm"
              label={linked ? t("conflict.linkedOn") : t("conflict.linkedOff")}
              active={linked}
              aria-pressed={linked}
              icon={linked ? <Link2 className="size-icon" aria-hidden /> : <Link2Off className="size-icon" aria-hidden />}
              onClick={() => setLinked(!linked)}
            />
            <IconButton size="sm" label={t("conflict.reset.tip")} disabled={!dirty} data-action="reset" icon={<RotateCcw className="size-icon" aria-hidden />} onClick={() => void reset()} />
          </div>
        }
      />

      {restored ? <Strip id="restored">{t("conflict.restored")}</Strip> : null}
      {handEdited ? (
        <Strip
          id="hand-edited"
          tone="warning"
          action={
            worktreeClean ? (
              <Button size="sm" data-action="take-worktree" loading={busy} onClick={() => void takeWorktree()}>
                {t("conflict.takeWorktree.confirm")}
              </Button>
            ) : undefined
          }
        >
          {worktreeClean
            ? t("conflict.handEdited.clean")
            : t("conflict.handEdited.dirty")}
        </Strip>
      ) : null}
      {mixedEol ? (
        <Strip id="mixed-eol">
          {t("conflict.mixedEol", { ours: titles.ours.role, oursEol: eolNames[oursEol!], theirs: titles.theirs.role, theirsEol: eolNames[theirsEol!], eol: eolNames[eol] })}
        </Strip>
      ) : null}
      {!model.hasBase ? <Strip id="no-base">{t("conflict.noBase")}</Strip> : null}

      <div ref={container} style={codeVars(code)} className="flex min-h-0 flex-1 flex-col">
        <div style={{ flex: `${split} 1 0%` }} className="flex min-h-24 min-w-0 flex-col" data-pane="sides">
          {single ? (
            <div className="flex min-h-control-lg shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-surface py-0.5 pr-1 pl-3">
              <SegmentedControl
                label={t("conflict.shownSide")}
                value={single}
                options={[
                  { value: "ours", label: titles.ours.role },
                  { value: "theirs", label: titles.theirs.role },
                ]}
                onValueChange={setShownSide}
              />
              <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-normal text-text-muted" data-side-heading={single}>
                <span className="sr-only">{titles[single].role} </span>
                {titles[single].name ? <span className="font-mono text-code">({titles[single].name})</span> : null}
              </h3>
              <Button size="sm" variant="ghost" disabled={total === 0} data-take-all="ours" onClick={() => void takeAll("ours")}>
                {titles.ours.all}
              </Button>
              <Button size="sm" variant="ghost" disabled={total === 0} data-take-all="theirs" onClick={() => void takeAll("theirs")}>
                {titles.theirs.all}
              </Button>
            </div>
          ) : (
            <div className="grid shrink-0 grid-cols-2 border-b border-border bg-surface">
              {sideHeading("ours", true)}
              <div className="min-w-0 border-l border-border">{sideHeading("theirs", true)}</div>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <SidesView
              ref={sides}
              model={model}
              rowModel={rowModel}
              choices={choices}
              manual={manual}
              titles={titles}
              single={single}
              onSingleChange={setShownSide}
              code={code}
              tokens={tokens}
              onToggleSide={onToggleSide}
              onToggleLine={onToggleLine}
              onSwap={onSwap}
              onCurrentConflict={(conflict) => {
                if (conflict >= 0) setCurrent(conflict);
              }}
              onScroll={onSidesScroll}
            />
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("conflict.splitter")}
          aria-valuenow={Math.round(split * 100)}
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round(SPLIT_MAX * 100)}
          tabIndex={0}
          data-grip=""
          className="gc-cf-grip relative h-2 shrink-0 cursor-row-resize touch-none border-y border-border bg-surface"
          onKeyDown={onGripKey}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={onGripPointer}
          onDoubleClick={() => setSplit(0.5)}
        />

        <div style={{ flex: `${1 - split} 1 0%` }} className="flex min-h-24 min-w-0 flex-col" data-pane="result">
          <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border bg-surface pr-1 pl-3">
            <h3 className="m-0 flex min-w-0 flex-1 items-baseline gap-1.5 text-sm font-normal">
              <span className="shrink-0 font-medium text-text">{t("conflict.result.title")}</span>
              <span className="min-w-0 truncate text-text-muted">{t("conflict.result.subtitle")}</span>
            </h3>
            {manualBlocks > 0 || editedElsewhere ? (
              <Tag data="manual" title={t("conflict.result.manualTip")}>
                {manualBlocks > 0 ? t("conflict.result.manualBlocks", { count: manualBlocks }) : t("conflict.result.manual")}
              </Tag>
            ) : null}
            {eol === "crlf" ? (
              <Tag data="eol" title={t("conflict.result.eolTip")}>
                CRLF
              </Tag>
            ) : null}
            {!model.finalNewline ? (
              <Tag data="no-final-newline" title={t("conflict.result.noFinalNewlineTip")}>
                {t("conflict.result.noFinalNewline")}
              </Tag>
            ) : null}
            <IconButton size="sm" label={t("conflict.result.search")} shortcut="Mod+F" icon={<Search className="size-icon" aria-hidden />} onClick={() => editor.current?.openSearch()} />
          </div>
          <div className="min-h-0 flex-1">
            <ResultEditor
              ref={editor}
              initialDoc={initial.doc}
              initialBounds={initial.bounds}
              kinds={model.chunks.map((chunk) => chunk.kind)}
              looks={initialLooks}
              path={path}
              code={code}
              ariaLabel={t("conflict.result.editorLabel", { path })}
              onDocChange={onDocChange}
              onScroll={onResultScroll}
            />
          </div>
        </div>
      </div>

      <footer className="flex min-h-control-lg shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-border bg-surface px-3 py-1.5" data-conflict-footer="">
        <p id={`conflict-save-reason-${tabId}`} role="status" data-save-reason={blocked ? "blocked" : "ready"} className={cn("m-0 min-w-0 flex-1 text-sm", blocked ? "text-text-muted" : "text-text")}>
          {blocked ?? (total === 0 ? t("conflict.save.readyNone") : t("conflict.save.ready"))}
        </p>
        <Tip label={blocked ?? t("conflict.save.tip")} shortcut="Mod+S" side="top">
          <Button
            variant="primary"
            data-action="save"
            loading={busy}
            aria-disabled={blocked ? true : undefined}
            aria-describedby={`conflict-save-reason-${tabId}`}
            className={blocked ? "bg-surface-raised text-text-disabled hover:brightness-100 active:brightness-100" : undefined}
            icon={<Save className="size-icon" aria-hidden />}
            onClick={() => void save()}
          >
            {t("conflict.save.label")}
          </Button>
        </Tip>
      </footer>
    </>
  );
});
