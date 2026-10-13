/**
 * Blame. The file with a column on the left: for each block of consecutive lines from the same
 * commit, avatar, summary and age once, the author in the second line; a coloured bar – either
 * per author or by age of the commit (toggle and legend in the header). Uncommitted lines are
 * shown as “Not committed yet”, dashed.
 *
 * Mouse: hovering shows the full commit as a card, clicking shows it in the graph.
 * Keyboard: move through the text with the arrows; the bar at the bottom shows the commit of the
 * current line. I: card with the full commit on/off (it follows the cursor) · Enter: show in the
 * graph · P: blame of the parent revision (“What was here before?”) · Ctrl+F: search ·
 * Esc: close the card, otherwise go back.
 */
import { Prec } from "@codemirror/state";
import { EditorView, keymap, type BlockInfo } from "@codemirror/view";
import { ChevronDown, Crosshair, Eye, FileQuestion, FileWarning, History, Info, RefreshCw, Undo2, UserSearch } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileHistoryEntry, Id, Sha } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError, toCoreError } from "../../app/errors";
import { formatDateTime, formatRelative, shortSha } from "../../app/format";
import { hasOpenMenu } from "../../app/menus/host";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { useBlame, useFileHistory } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { CodeEditor } from "../../components/code";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { SegmentedControl } from "../../ui/Field";
import { DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { Notice } from "../DiffView/OtherKinds";
import { goBack, showInGraph } from "../FileView/nav";
import { BackButton, CodeSkeleton, Divider, FileTitle, isPlainEscape, ownsKey } from "../FileView/parts";
import "./blame.css";
import { AGE_STEPS, ageColor, blameGutter, buildModel, initials, type BlameBlock, type BlameColorMode } from "./model";
import { locale, t } from "../../i18n";

export interface BlameViewProps {
  repoId: Id;
  tabId: Id;
  path: string;
  /** null = Arbeitsverzeichnis. */
  sha: Sha | null;
}

/** Counts the blame models; the editor's key is derived from it. */
let modelCounter = 0;

/** Line the next blame of this tab should jump to (parent revision, reload). */
const pendingLine = new Map<Id, number>();

/** What the bar is coloured by – remembered for all files (a preference of the view, not a repository setting). */
const COLOR_MODE_KEY = "gc.blame.color";
function storedColorMode(): BlameColorMode {
  try {
    return window.localStorage.getItem(COLOR_MODE_KEY) === "age" ? "age" : "author";
  } catch {
    return "author";
  }
}

const colorOf = (block: BlameBlock, mode: BlameColorMode) => (mode === "age" && !block.uncommitted ? ageColor(block.age) : block.color);

const CARD_ID = "gc-blame-card";

/** How a revision is named in the header: working directory, short SHA, “before abc1234”. */
export function standLabel(sha: Sha | null): string {
  if (sha === null) return t("blame.stand.worktree");
  if (sha === "HEAD") return t("blame.stand.head");
  if (sha.endsWith("^")) return t("blame.stand.before", { sha: shortSha(sha.slice(0, -1)) });
  return shortSha(sha);
}

/** Blame. */
export function BlameView({ repoId, tabId, path, sha }: BlameViewProps) {
  const store = useAppStore.getState;
  const query = useBlame(repoId, path, sha);
  const history = useFileHistory(repoId, path, 200);
  const model = useMemo(() => (query.data ? buildModel(query.data) : null), [query.data]);

  const [currentLine, setCurrentLine] = useState(1);
  const lineRef = useRef(1);
  lineRef.current = currentLine;
  const current: BlameBlock | null = model ? (model.blocks[model.blockOfLine[currentLine - 1] ?? 0] ?? null) : null;

  // --- Colour: per author or by age --------------------------------------------------------------
  const [colorMode, setColorModeState] = useState<BlameColorMode>(storedColorMode);
  const setColorMode = useCallback((mode: BlameColorMode) => {
    setColorModeState(mode);
    try {
      window.localStorage.setItem(COLOR_MODE_KEY, mode);
    } catch {
      // Without storage the choice lasts until restart.
    }
  }, []);

  // --- Elternstand -----------------------------------------------------------------------------
  const historyOf = useCallback((commitSha: string): FileHistoryEntry | undefined => history.data?.find((entry) => entry.commit.sha === commitSha), [history.data]);

  const parentOf = useCallback(
    (block: BlameBlock | null): { sha: string; path: string } | { reason: string } => {
      if (!block) return { reason: t("blame.parent.noLine") };
      if (block.uncommitted) {
        if (sha !== null) return { reason: t("blame.parent.noEarlier") };
        return history.data && history.data.length === 0 ? { reason: t("blame.parent.neverCommitted") } : { sha: "HEAD", path };
      }
      const entry = historyOf(block.sha);
      if (entry?.status === "added" && !entry.oldPath) return { reason: t("blame.parent.createdHere") };
      if (entry && entry.commit.parents.length === 0) return { reason: t("blame.parent.firstCommit") };
      return { sha: `${block.sha}^`, path: entry?.oldPath ?? entry?.path ?? path };
    },
    [history.data, historyOf, path, sha],
  );

  const goToParent = useCallback(
    (block: BlameBlock | null) => {
      const target = parentOf(block);
      if (!("sha" in target)) return;
      pendingLine.set(tabId, lineRef.current);
      store().openBlame(tabId, target.path, target.sha);
    },
    [parentOf, store, tabId],
  );

  const reveal = useCallback((block: BlameBlock | null) => {
    if (block) showInGraph(tabId, block.uncommitted ? null : block.sha);
  }, [tabId]);

  // --- Hover: full commit as a card -------------------------------------------------------------
  const [hover, setHover] = useState<{ block: BlameBlock; top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverBlock = useRef<BlameBlock | null>(null);
  const onHover = useCallback((block: BlameBlock | null, view: EditorView, line: BlockInfo | null) => {
    if (block === hoverBlock.current) return;
    hoverBlock.current = block;
    window.clearTimeout(hoverTimer.current);
    if (!block || !line) {
      setHover(null);
      return;
    }
    const startLine = view.state.doc.line(block.startLine);
    const coords = view.coordsAtPos(startLine.from) ?? view.coordsAtPos(line.from);
    const gutterRect = view.dom.querySelector(".gc-blame-gutter")?.getBoundingClientRect();
    hoverTimer.current = window.setTimeout(() => {
      if (hoverBlock.current !== block) return;
      setHover({ block, top: Math.max(coords?.top ?? 0, view.scrollDOM.getBoundingClientRect().top), left: gutterRect?.right ?? 0 });
    }, 400);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // --- Keyboard: the same card for the current line (I toggles it on and off) -----------------------
  const viewRef = useRef<EditorView | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  const cardOpenRef = useRef(cardOpen);
  cardOpenRef.current = cardOpen;
  const [keyCard, setKeyCard] = useState<{ block: BlameBlock; top: number; left: number } | null>(null);
  const placeKeyCard = useCallback(() => {
    const view = viewRef.current;
    if (!view || !cardOpenRef.current || !handlers.current.current) {
      setKeyCard(null);
      return;
    }
    const block = handlers.current.current;
    const line = view.state.doc.line(Math.min(lineRef.current, view.state.doc.lines));
    const frame = view.scrollDOM.getBoundingClientRect();
    const coords = view.coordsAtPos(line.from);
    const gutterRect = view.dom.querySelector(".gc-blame-gutter")?.getBoundingClientRect();
    // Below the current line so that the line itself stays readable; the card then moves itself into the window.
    const top = Math.min(Math.max(coords?.bottom ?? frame.top, frame.top), frame.bottom);
    setKeyCard((before) => (before && before.block === block && before.top === top ? before : { block, top, left: gutterRect?.right ?? frame.left }));
  }, []);
  const toggleCard = useCallback(() => {
    setHover(null);
    setCardOpen((open) => !open);
  }, []);

  // --- Editor ----------------------------------------------------------------------------------
  const handlers = useRef({ reveal, goToParent, current, toggleCard, placeKeyCard });
  handlers.current = { reveal, goToParent, current, toggleCard, placeKeyCard };
  // The card follows the cursor: reposition when it opens, the line changes or a new blame arrives.
  useEffect(() => {
    placeKeyCard();
  }, [cardOpen, currentLine, model, placeKeyCard]);
  const extensions = useMemo(() => {
    if (!model) return [];
    return [
      blameGutter(model, { onActivate: (block) => handlers.current.reveal(block), onHover }),
      Prec.high(
        keymap.of([
          { key: "Enter", run: () => (handlers.current.reveal(handlers.current.current), true) },
          { key: "p", run: () => (handlers.current.goToParent(handlers.current.current), true) },
          { key: "P", run: () => (handlers.current.goToParent(handlers.current.current), true) },
          { key: "i", run: () => (handlers.current.toggleCard(), true) },
          { key: "I", run: () => (handlers.current.toggleCard(), true) },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet && !update.docChanged) return;
        const line = update.state.doc.lineAt(update.state.selection.main.head).number;
        setCurrentLine((before) => (before === line ? before : line));
      }),
      EditorView.domEventHandlers({
        scroll: () => {
          setHover(null);
          // The keyboard card stays at its line.
          requestAnimationFrame(() => handlers.current.placeKeyCard());
        },
      }),
    ];
  }, [model, onHover]);

  // The editor is only rebuilt when the blame really changed: a reload with the same result
  // delivers the same data (and thus the same model) – scroll position and cursor stay.
  const modelId = useMemo(() => ++modelCounter, [model]);
  const editorKey = `${path}|${sha ?? ""}|${modelId}`;
  const onView = useCallback(
    (view: EditorView | null) => {
      viewRef.current = view;
      if (!view) return;
      const wanted = pendingLine.get(tabId) ?? lineRef.current;
      pendingLine.delete(tabId);
      const number = Math.min(Math.max(1, wanted), view.state.doc.lines);
      const line = view.state.doc.line(number);
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: number > 1 ? "center" : "start" }) });
      setCurrentLine(number);
      // The text gets the focus: arrows, Enter and P work right away.
      if (viewMayTakeFocus()) view.focus();
    },
    [tabId],
  );

  // --- Esc -------------------------------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscape(event)) return;
      if (!ownsKey(event, hasOpenDialog() || hasOpenMenu() || Boolean(useAppStore.getState().overlay))) return;
      event.preventDefault();
      // Close the card first, then the view.
      if (cardOpenRef.current) setCardOpen(false);
      else goBack(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabId]);

  // --- Choose revision ---------------------------------------------------------------------------
  const standEntries: MenuEntry[] = [
    { label: t("blame.stand.worktree"), checked: sha === null, hint: t("blame.stand.worktreeHint"), onSelect: () => store().openBlame(tabId, path, null) },
    { type: "separator" },
    { type: "label", label: history.data?.length ? t("blame.stand.commitsLabel") : history.isPending ? t("blame.stand.historyLoading") : t("blame.stand.noCommits") },
    ...(history.data ?? [])
      .filter((entry) => entry.status !== "deleted")
      .slice(0, 60)
      .map(
        (entry): MenuEntry => ({
          label: `${shortSha(entry.commit.sha)}  ${entry.commit.summary}`,
          tooltip: `${entry.commit.summary} – ${entry.commit.author.name}, ${formatDateTime(entry.commit.authoredAt)}`,
          hint: formatRelative(entry.commit.authoredAt),
          checked: sha === entry.commit.sha,
          onSelect: () => store().openBlame(tabId, entry.path, entry.commit.sha),
        }),
      ),
  ];

  // --- Inhalt ----------------------------------------------------------------------------------
  const name = path.slice(path.lastIndexOf("/") + 1);
  let body: ReactNode;
  if (query.isPending) {
    body = <CodeSkeleton label={t("blame.loading", { name })} gutter />;
  } else if (query.isError || !model) {
    const error = toCoreError(query.error);
    const kind = error.code === "not_found" ? "gone" : error.code === "unsupported" ? "unsupported" : "error";
    body = (
      <Notice
        id={kind}
        tone={kind === "error" ? "danger" : "muted"}
        icon={kind === "gone" ? <FileQuestion className="size-8" aria-hidden /> : <FileWarning className="size-8" aria-hidden />}
        title={kind === "gone" ? (sha === null ? t("blame.error.goneWorktree") : t("blame.error.goneStand", { stand: standLabel(sha) })) : kind === "unsupported" ? t("blame.error.unsupported") : t("blame.error.failed")}
        action={
          <>
            {kind === "error" ? (
              <Button icon={<RefreshCw className="size-icon" aria-hidden />} loading={query.isFetching} onClick={() => void query.refetch()}>
                {t("blame.error.retry")}
              </Button>
            ) : (
              <Button icon={<History className="size-icon" aria-hidden />} onClick={() => store().openHistory(tabId, path)}>
                {t("blame.error.showHistory")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => goBack(tabId)}>
              {t("blame.error.back")}
            </Button>
          </>
        }
      >
        {describeError(error).text}
      </Notice>
    );
  } else if (model.blocks.length === 0) {
    body = (
      <Notice id="empty" icon={<FileQuestion className="size-8" aria-hidden />} title={t("blame.empty.title")}>
        {t("blame.empty.body")}
      </Notice>
    );
  } else {
    body = (
      <div className="gc-blame-host @container/blame h-full min-h-0">
        <CodeEditor key={editorKey} value={model.text} path={path} readOnly ariaLabel={t("blame.ariaLabel", { path })} extensions={extensions} onView={onView} />
      </div>
    );
  }

  const parent = parentOf(current);
  return (
    <section aria-label={t("blame.ariaLabel", { path })} data-screen="blame" data-stand={sha ?? "worktree"} data-blame-color={colorMode} className="@container flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <header className="shrink-0 border-b border-border bg-surface">
        <div className="flex h-control-lg items-center gap-2 pr-1 pl-3">
          <FileTitle path={path} icon={<UserSearch className="size-icon" aria-hidden />} prefix={t("blame.prefix")} />
          <DropdownMenu entries={standEntries} align="end">
            <button
              type="button"
              aria-label={t("blame.stand.pickerLabel", { stand: standLabel(sha) })}
              data-stand-picker=""
              className="inline-flex h-control-sm shrink-0 items-center gap-1 rounded-md border border-border px-2 text-sm text-text hover:border-border-input hover:bg-surface-raised"
            >
              <span className="text-text-muted">{t("blame.stand.label")}</span>
              <span className={cn("font-medium", sha && sha !== "HEAD" && !sha.endsWith("^") && "font-mono text-code")}>{standLabel(sha)}</span>
              <ChevronDown className="size-3.5 text-text-muted" aria-hidden />
            </button>
          </DropdownMenu>
          <Divider />
          <Button size="sm" variant="ghost" icon={<History className="size-icon" aria-hidden />} onClick={() => store().openHistory(tabId, path)}>
            <span className="hidden @3xl:inline">{t("blame.history")}</span>
            <span className="sr-only @3xl:hidden">{t("blame.history")}</span>
          </Button>
          <Button size="sm" variant="ghost" icon={<Eye className="size-icon" aria-hidden />} onClick={() => store().openFile(tabId, path, sha, "view")}>
            <span className="hidden @3xl:inline">{t("blame.file")}</span>
            <span className="sr-only @3xl:hidden">{t("blame.viewFile")}</span>
          </Button>
          <Divider />
          <BackButton tabId={tabId} />
        </div>
        {model && model.blocks.length > 0 ? <Legend model={model} mode={colorMode} onMode={setColorMode} /> : null}
      </header>
      <div className="relative min-h-0 flex-1">{body}</div>
      {model && current ? (
        <footer data-blame-info="" className="@container flex h-control-lg shrink-0 items-center gap-2 border-t border-border bg-surface pr-2 pl-3 text-sm">
          <span className="shrink-0 text-xs text-text-muted tabular-nums" data-blame-line={currentLine}>
            {t("blame.line", { line: currentLine.toLocaleString(locale()) })}
          </span>
          <span aria-hidden data-blame-swatch="" className="h-4 w-1 shrink-0 rounded-pill" style={{ background: colorOf(current, colorMode) }} />
          {current.uncommitted ? (
            <span className="min-w-0 flex-1 truncate text-text-muted italic">{t("blame.uncommitted")}</span>
          ) : (
            <>
              <span className="shrink-0 font-mono text-code text-text-muted" data-blame-sha={current.sha}>
                {shortSha(current.sha)}
              </span>
              <span className="min-w-0 flex-1 truncate text-text">{current.summary}</span>
              <span className="hidden shrink-0 text-text-muted @2xl:inline">
                {current.authorName} · {formatRelative(current.authoredAt)}
              </span>
            </>
          )}
          <Tip label={cardOpen ? t("blame.card.close") : t("blame.card.open")} shortcut="I">
            <Button
              size="sm"
              variant="ghost"
              data-action="commit-card"
              icon={<Info className="size-icon" aria-hidden />}
              aria-label={t("blame.card.ariaLabel")}
              aria-expanded={cardOpen}
              aria-describedby={cardOpen && keyCard ? CARD_ID : undefined}
              onClick={toggleCard}
            >
              <span className="hidden @3xl:inline">{t("blame.card.short")}</span>
            </Button>
          </Tip>
          <Tip label={current.uncommitted ? t("blame.reveal.local") : t("blame.reveal.commit")} shortcut="Enter">
            <Button size="sm" variant="ghost" icon={<Crosshair className="size-icon" aria-hidden />} onClick={() => reveal(current)} aria-label={t("blame.reveal.ariaLabel")}>
              <span className="hidden @3xl:inline">{t("blame.reveal.short")}</span>
            </Button>
          </Tip>
          <Tip label={"sha" in parent ? t("blame.parent.tip") : t("blame.parent.tipDisabled", { reason: parent.reason })} shortcut="P">
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-icon" aria-hidden />} disabled={!("sha" in parent)} onClick={() => goToParent(current)} aria-label={t("blame.parent.label")}>
              <span className="hidden @3xl:inline">{t("blame.parent.label")}</span>
            </Button>
          </Tip>
        </footer>
      ) : null}
      {hover ? (
        <HoverCard block={hover.block} top={hover.top} left={hover.left} mode={colorMode} />
      ) : cardOpen && keyCard ? (
        <HoverCard block={keyCard.block} top={keyCard.top} left={keyCard.left} mode={colorMode} keyboard />
      ) : null}
    </section>
  );
}

const dateRange = (newest: string | null, oldest: string | null) => {
  if (!newest || !oldest) return t("blame.legend.noLines");
  const from = formatRelative(oldest);
  const to = formatRelative(newest);
  return from === to ? to : t("blame.legend.range", { from, to });
};

function Legend({ model, mode, onMode }: { model: NonNullable<ReturnType<typeof buildModel>>; mode: BlameColorMode; onMode: (mode: BlameColorMode) => void }) {
  const lines = model.blockOfLine.length;
  const shown = model.authors.slice(0, 6);
  const rest = model.authors.slice(6);
  return (
    <div data-blame-legend={mode} className="flex h-control-lg items-center gap-3 overflow-hidden border-t border-border pr-2 pl-3 text-xs text-text-muted">
      <span className="shrink-0 tabular-nums">
        {t("blame.legend.lines", { count: lines, formatted: lines.toLocaleString(locale()) })} · {t("blame.legend.commits", { count: model.commitCount, formatted: model.commitCount.toLocaleString(locale()) })}
      </span>
      <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
      <span className="shrink-0">{t("blame.legend.colorBy")}</span>
      <span className="shrink-0">
        <SegmentedControl
          label={t("blame.legend.colorByLabel")}
          value={mode}
          options={[
            { value: "author", label: t("blame.legend.author") },
            { value: "age", label: t("blame.legend.age") },
          ]}
          onValueChange={onMode}
        />
      </span>
      {mode === "author" ? (
        // When space gets tight the line is cut off – the full list is then in the tooltip (mouse and focus).
        <Tip
          label={
            <span className="flex flex-col gap-0.5">
              {model.authors.map((author) => (
                <span key={author.key} className="flex items-center gap-1.5">
                  <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", author.uncommitted && "border border-dashed border-text-muted")} style={author.uncommitted ? undefined : { background: author.color }} />
                  <span className="min-w-0 flex-1 truncate">{author.uncommitted ? t("blame.uncommitted") : author.name}</span>
                  <span className="tabular-nums">{t("blame.legend.lines", { count: author.lines, formatted: author.lines.toLocaleString(locale()) })}</span>
                </span>
              ))}
            </span>
          }
        >
          <ul aria-label={t("blame.legend.authorsLabel")} tabIndex={0} className="flex min-w-0 items-center gap-3 overflow-hidden rounded-sm">
            {shown.map((author) => (
              <li key={author.key} className="flex shrink-0 items-center gap-1.5" data-legend-author={author.uncommitted ? "uncommitted" : author.name}>
                <span aria-hidden className={cn("size-2.5 shrink-0 rounded-sm", author.uncommitted && "border border-dashed border-text-muted")} style={author.uncommitted ? undefined : { background: author.color }} />
                <span className={cn("text-text", author.uncommitted && "italic")}>{author.uncommitted ? t("blame.uncommitted") : author.name}</span>
                <span className="tabular-nums">{author.lines.toLocaleString(locale())}</span>
              </li>
            ))}
            {rest.length ? <li className="shrink-0 underline decoration-dotted">{t("blame.legend.more", { count: rest.length })}</li> : null}
          </ul>
        </Tip>
      ) : (
        // By age: five steps from “new” (strong) to “old” (pale). The time ranges are in the tooltip; the date is shown on every block anyway.
        <Tip
          label={
            <span className="flex flex-col gap-0.5">
              {model.uncommittedLines > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-sm border border-dashed border-text-muted" />
                  <span className="min-w-0 flex-1">{t("blame.uncommitted")}</span>
                  <span className="tabular-nums">{t("blame.legend.lines", { count: model.uncommittedLines, formatted: model.uncommittedLines.toLocaleString(locale()) })}</span>
                </span>
              ) : null}
              {model.ages.map((age) => (
                <span key={age.step} className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: ageColor(age.step) }} />
                  <span className="min-w-0 flex-1">{dateRange(age.newest, age.oldest)}</span>
                  <span className="tabular-nums">{t("blame.legend.lines", { count: age.lines, formatted: age.lines.toLocaleString(locale()) })}</span>
                </span>
              ))}
            </span>
          }
        >
          <span tabIndex={0} role="img" data-age-scale="" aria-label={t("blame.legend.ageScaleLabel", { newest: model.newest ? formatRelative(model.newest) : "–", oldest: model.oldest ? formatRelative(model.oldest) : "–" })} className="flex min-w-0 items-center gap-1.5 rounded-sm">
            <span className="shrink-0 text-text">{t("blame.legend.new")}</span>
            <span className="shrink-0 tabular-nums">{model.newest ? formatRelative(model.newest) : "–"}</span>
            <span aria-hidden className="flex shrink-0 overflow-hidden rounded-sm">
              {Array.from({ length: AGE_STEPS }, (_, step) => (
                <span key={step} data-age-step={step} className="h-2.5 w-4" style={{ background: ageColor(step) }} />
              ))}
            </span>
            <span className="shrink-0 text-text">{t("blame.legend.old")}</span>
            <span className="min-w-0 truncate tabular-nums">{model.oldest ? formatRelative(model.oldest) : "–"}</span>
          </span>
        </Tip>
      )}
    </div>
  );
}

function HoverCard({ block, top, left, mode, keyboard = false }: { block: BlameBlock; top: number; left: number; mode: BlameColorMode; keyboard?: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top, left });
  // Keep it in the window: after the first paint, move it using the card's real size.
  useLayoutEffect(() => {
    const rect = card.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ top: Math.max(0, Math.min(top, window.innerHeight - rect.height)), left: Math.max(0, Math.min(left, window.innerWidth - rect.width)) });
  }, [block, left, top]);
  return (
    <div
      ref={card}
      id={keyboard ? CARD_ID : undefined}
      role="tooltip"
      data-blame-card={keyboard ? "keyboard" : "hover"}
      data-block={block.index}
      className="animate-pop pointer-events-none fixed z-50 mx-2 flex w-96 flex-col gap-1.5 rounded-lg border border-border bg-surface-raised p-3 text-sm text-text shadow-pop"
      style={position}
    >
      {/* For screen readers: the card is announced when it opens via key or changes with the cursor. */}
      {keyboard ? <span className="sr-only" aria-live="polite">{block.uncommitted ? t("blame.uncommitted") : t("blame.card.announce", { sha: shortSha(block.sha), summary: block.summary, author: block.authorName, when: formatRelative(block.authoredAt) })}</span> : null}
      {block.uncommitted ? (
        <>
          <span className="font-medium">{t("blame.uncommitted")}</span>
          <span className="text-text-muted">{keyboard ? t("blame.card.uncommittedKeyboard") : t("blame.card.uncommittedMouse")}</span>
        </>
      ) : (
        <>
          <span className="font-medium break-words">{block.summary || t("blame.noMessage")}</span>
          <span className="flex items-center gap-2 text-text-muted">
            {mode === "age" ? <span aria-hidden className="h-4 w-1 shrink-0 rounded-pill" style={{ background: colorOf(block, mode) }} /> : null}
            <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-pill text-xs font-semibold text-on-lane" style={{ background: block.color }}>
              {initials(block.authorName)}
            </span>
            <span className="min-w-0 truncate">
              {block.authorName} {block.authorEmail ? `<${block.authorEmail}>` : ""}
            </span>
          </span>
          <span className="text-text-muted">
            {formatDateTime(block.authoredAt)} · {formatRelative(block.authoredAt)}
          </span>
          <span className="font-mono text-code break-all text-text-muted">{block.sha}</span>
          <span className="border-t border-border pt-1.5 text-xs text-text-muted">
            {block.startLine === block.endLine ? t("blame.line", { line: block.startLine.toLocaleString(locale()) }) : t("blame.lineRange", { from: block.startLine.toLocaleString(locale()), to: block.endLine.toLocaleString(locale()) })} · {keyboard ? t("blame.card.hintKeyboard") : t("blame.card.hintMouse")}
          </span>
        </>
      )}
    </div>
  );
}
