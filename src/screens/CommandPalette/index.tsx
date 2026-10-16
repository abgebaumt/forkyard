/**
 * Command palette (Ctrl+P).
 *
 * Combobox pattern: the focus stays in the input, ↑/↓ move the selection in the list,
 * Enter runs, Tab opens the second level (more actions for branch, tag, file, commit),
 * Esc closes (or goes back from the second level).
 *
 * Sources: commands from the registry (with group and shortcut; disabled ones with a reason),
 * branches and tags, files of the working directory, repositories, commits via the core's search.
 * Prefixes narrow down: “>” commands, “@” branches and tags, “/” files, “#” commits, “~” repositories.
 * Empty: recently used commands and all available ones.
 */
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  CornerDownRight,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  MessageSquareText,
  RefreshCw,
  Search,
  SearchX,
  SquareChevronRight,
  Tag,
  TriangleAlert,
} from "lucide-react";
import type { PaletteMode } from "../../app/store";
import { buildCommandContext, isAvailable, useCommands } from "../../app/registry";
import { describeError } from "../../app/errors";
import { showError } from "../../app/run";
import { afterFocusReturn, useFocusReturn } from "../../app/focusReturn";
import { useActiveTab, useAiStatus, useCommitSearch, useRefs, useRepoSettings, useRepos, useStatus, useStashes, useRemotes, useTree } from "../../app/queries";
import { Kbd } from "../../ui/Kbd";
import { Spinner } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { fuzzyBest, fuzzyMatch, highlightParts, isWeakMatch, prepareQuery } from "./fuzzy";
import { readRecent } from "./recent";
import { locale, t } from "../../i18n";
import { askItem, changedFirst, commandItems, commitItems, fileItems, kindLabels, refItems, repoItems, type PaletteItem, type PaletteKind } from "./sources";
import { openAiSetup } from "../../app/ai/open";
import { askMode, askQuery, offerAskRow } from "./plan/model";
import { usePlanSession } from "./plan/usePlanSession";
import { PlanFooter, PlanPanel } from "./plan/PlanPanel";

export interface CommandPaletteProps {
  mode: PaletteMode;
  onClose: () => void;
}

type Scope = "all" | "commands" | "branches" | "files" | "commits" | "repos";

/** Prefix → scope; the order is also the order of the explanation in the empty state. */
const PREFIXES: { prefix: string; scope: Exclude<Scope, "all">; label: string }[] = [
  { prefix: ">", scope: "commands", label: t("palette.scope.commands") },
  { prefix: "@", scope: "branches", label: t("palette.scope.branches") },
  { prefix: "/", scope: "files", label: t("palette.scope.files") },
  { prefix: "#", scope: "commits", label: t("palette.scope.commits") },
  { prefix: "~", scope: "repos", label: t("palette.scope.repos") },
];

const modePrefix: Record<PaletteMode, string> = { all: "", commands: ">", branches: "@", files: "/", repos: "~" };

function parseQuery(raw: string): { scope: Scope; text: string } {
  const first = raw[0];
  const hit = PREFIXES.find((entry) => entry.prefix === first);
  return hit ? { scope: hit.scope, text: raw.slice(1).trim() } : { scope: "all", text: raw.trim() };
}

// Row heights in px – tokens.json › size: control-lg (match) and row (heading).
const OPTION_HEIGHT = 32;
const HEADER_HEIGHT = 24;
/** The list shows no more matches than this; whoever wants more types more precisely. */
const MAX_RESULTS = 500;
const COMMIT_LIMIT = 50;

type Row = { type: "header"; label: string } | { type: "option"; item: PaletteItem; positions: number[]; option: number };

interface Ranked {
  item: PaletteItem;
  score: number;
  positions: number[];
}

function rank(items: readonly PaletteItem[], query: string, { withBoost = true } = {}): Ranked[] {
  const folded = prepareQuery(query);
  const out: Ranked[] = [];
  for (const entry of items) {
    const match = entry.keywords?.length
      ? fuzzyBest(folded, entry.title, entry.keywords, { path: entry.path })
      : fuzzyMatch(folded, entry.title, { path: entry.path, foldedText: entry.folded });
    if (!match || isWeakMatch(match, folded.length)) continue;
    let score = match.score + (withBoost ? (entry.boost ?? 0) : 0);
    if (entry.disabledReason) score -= 1000;
    out.push({ item: entry, score, positions: match.positions });
  }
  out.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
  return out;
}

/** Only take over the value once typing has paused for a while (commit search queries the core). */
function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return current;
}

const kindIcons: Record<PaletteKind, ReactNode> = {
  command: <SquareChevronRight className="size-icon" aria-hidden />,
  branch: <GitBranch className="size-icon" aria-hidden />,
  remote: <Globe className="size-icon" aria-hidden />,
  tag: <Tag className="size-icon" aria-hidden />,
  file: <FileText className="size-icon" aria-hidden />,
  repo: <FolderGit2 className="size-icon" aria-hidden />,
  commit: <GitCommitHorizontal className="size-icon" aria-hidden />,
  action: <CornerDownRight className="size-icon" aria-hidden />,
  ask: <MessageSquareText className="size-icon" aria-hidden />,
};

function Highlighted({ text, positions, offset = 0 }: { text: string; positions: readonly number[]; offset?: number }) {
  const local = positions.filter((position) => position >= offset && position < offset + text.length).map((position) => position - offset);
  return (
    <>
      {highlightParts(text, local).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-sm bg-transparent font-semibold text-accent">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** File path: folder muted, file name normal – both with highlighting. */
function PathTitle({ path, positions }: { path: string; positions: readonly number[] }) {
  const cut = path.lastIndexOf("/") + 1;
  const dir = path.slice(0, cut);
  const base = path.slice(cut);
  return (
    <span className="min-w-0 truncate">
      <span className="text-text">
        <Highlighted text={base} positions={positions} offset={cut} />
      </span>
      {dir ? (
        <span className="ml-2 text-sm text-text-muted">
          <Highlighted text={dir.replace(/\/$/, "")} positions={positions} />
        </span>
      ) : null}
    </span>
  );
}

function OptionRow({
  row,
  id,
  active,
  onHover,
  onRun,
  onActions,
}: {
  row: Extract<Row, { type: "option" }>;
  id: string;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
  onActions: () => void;
}) {
  const { item, positions } = row;
  const disabled = Boolean(item.disabledReason);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      data-key={item.key}
      data-kind={item.kind}
      title={item.kind === "file" ? item.title : undefined}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
      className={cn(
        "group flex h-control-lg cursor-default items-center gap-2 rounded-md px-2 text-base",
        active ? "bg-accent-surface" : "hover:bg-surface-raised",
      )}
    >
      <span className={cn("shrink-0", active ? "text-accent" : "text-text-muted", disabled && "text-text-disabled")}>{kindIcons[item.kind]}</span>
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", disabled ? "text-text-disabled" : "text-text")}>
        {item.kind === "file" ? (
          <PathTitle path={item.title} positions={positions} />
        ) : (
          <span className={cn("min-w-0 shrink truncate", item.kind === "branch" || item.kind === "remote" || item.kind === "tag" ? "font-mono text-code" : null)}>
            <Highlighted text={item.title} positions={positions} />
          </span>
        )}
        {item.marker ? (
          <span className="shrink-0 rounded-sm border border-border px-1 text-xs font-medium text-text-muted">{item.marker}</span>
        ) : null}
        {item.detail && item.kind !== "command" ? <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{item.detail}</span> : null}
      </span>
      {disabled ? (
        <span className="max-w-60 shrink-0 truncate text-sm text-text-muted" title={item.disabledReason ?? undefined}>
          {item.disabledReason}
        </span>
      ) : item.shortcut ? (
        <Kbd className="shrink-0">{item.shortcut}</Kbd>
      ) : null}
      <span className="w-24 shrink-0 text-right text-xs font-medium text-text-muted" data-kind-label>
        {item.kind === "command" ? item.detail : kindLabels[item.kind]}
      </span>
      {item.actions ? (
        <span
          aria-hidden
          onClick={(event) => {
            event.stopPropagation();
            onActions();
          }}
          className={cn("-mr-1 flex size-control-sm shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface hover:text-text", active ? "visible" : "invisible group-hover:visible")}
        >
          <ChevronRight className="size-icon" />
        </span>
      ) : null}
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex h-control-lg items-center gap-2 px-2">
          <span className="size-icon rounded-sm bg-surface-raised" />
          <span className={cn("h-2.5 rounded-sm bg-surface-raised", index % 3 === 0 ? "w-2/3" : index % 3 === 1 ? "w-1/2" : "w-3/5")} />
        </div>
      ))}
    </div>
  );
}

/** command-palette – Command Palette. */
export function CommandPalette({ mode, onClose }: CommandPaletteProps) {
  const [raw, setRaw] = useState(modePrefix[mode]);
  const [stage, setStage] = useState<{ item: PaletteItem; previous: string } | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyboardMove = useRef(false);
  const listId = useId();
  const focusReturn = useFocusReturn();

  const tab = useActiveTab();
  const repoId = tab?.kind === "repo" ? tab.repoId : null;
  const tabId = tab?.id ?? null;
  const target = repoId && tabId ? { repoId, tabId } : null;

  // Git in plain language (v1.2): "?" asks, and so does the last row when nothing matched.
  const aiStatus = useAiStatus();
  const repoSettings = useRepoSettings(repoId);
  const ask = askMode(aiStatus.data, repoSettings.data?.aiOff ?? false, repoId !== null);
  const askEnabled = ask !== "hidden";
  const plan = usePlanSession(repoId, onClose, () => inputRef.current?.focus());
  const askText = stage || plan.active ? null : askQuery(raw, askEnabled);
  const startAsk = useRef<(request: string) => void>(() => undefined);
  startAsk.current = (request: string) => {
    // On, but no provider connected yet: the row leads to 1b's setup dialog instead of sending.
    if (ask === "setup") {
      onClose();
      afterFocusReturn(() => void openAiSetup());
      return;
    }
    void plan.start(request);
  };

  const parsed = parseQuery(stage ? "" : raw);
  const scope = parsed.scope;
  const text = stage ? raw.trim() : parsed.text;
  // Large lists (20 000 files) are re-scored with a delay so that typing stays smooth. When switching
  // into the second level or back the new text applies immediately – otherwise a wrong list would flash briefly.
  const staged = stage !== null;
  const deferred = useDeferredValue(useMemo(() => ({ text, staged }), [text, staged]));
  const deferredText = deferred.staged === staged ? deferred.text : text;

  // In the second level the source of the chosen entry stays active: its actions should follow the
  // current state (after a checkout a different branch is the checked-out one).
  const stageKind = stage?.item.kind ?? null;
  const wantsRefs = stage ? stageKind === "branch" || stageKind === "remote" || stageKind === "tag" : scope === "all" || scope === "branches";
  const wantsFiles = stage ? stageKind === "file" : scope === "all" || scope === "files";
  const wantsCommits = !stage && scope === "commits";

  const commands = useCommands();
  const status = useStatus(repoId);
  // For the availability of some commands (stash, remote) – also keeps the reasons fresh.
  useStashes(repoId);
  useRemotes(repoId);
  const refs = useRefs(wantsRefs ? repoId : null);
  const tree = useTree(repoId, null, null, wantsFiles && Boolean(repoId));
  const repos = useRepos();
  const commitQuery = useDebounced(wantsCommits ? text : "", 200);
  const commits = useCommitSearch(wantsCommits && commitQuery ? repoId : null, commitQuery, COMMIT_LIMIT);

  // --- Entries per source ----------------------------------------------------------------------
  const commandList = useMemo(() => {
    const ctx = buildCommandContext("palette");
    return commandItems(commands, ctx, (command) => isAvailable(command, ctx));
    // status: availability depends on the state of the repository
  }, [commands, status.data, tab?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refList = useMemo(() => (target && refs.data ? refItems(target, refs.data) : []), [target?.repoId, target?.tabId, refs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const fileList = useMemo(() => (target && tree.data ? fileItems(target, tree.data, status.data) : []), [target?.repoId, target?.tabId, tree.data, status.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const repoList = useMemo(() => repoItems(repos.data ?? [], repoId), [repos.data, repoId]);
  const commitList = useMemo(() => (target && commits.data ? commitItems(target, commits.data) : []), [target?.repoId, target?.tabId, commits.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageList = useMemo(() => {
    if (!stage) return [];
    const key = stage.item.key;
    const source = stage.item.kind === "file" ? fileList : stage.item.kind === "commit" ? [] : refList;
    const live = source.find((entry) => entry.key === key) ?? stage.item;
    return live.actions?.() ?? [];
  }, [stage, refList, fileList]);

  // --- Zeilen ------------------------------------------------------------------------------------
  const { rows, total } = useMemo(() => {
    const out: Row[] = [];
    let option = 0;
    const push = (item: PaletteItem, positions: number[] = []) => out.push({ type: "option", item, positions, option: option++ });
    const header = (label: string) => out.push({ type: "header", label });
    const q = deferredText;

    if (askText !== null) {
      if (askText) push(askItem(askText, () => startAsk.current(askText)));
      return { rows: out, total: option };
    }

    if (stage) {
      const list = q ? rank(stageList, q) : stageList.map((item) => ({ item, positions: [] as number[], score: 0 }));
      for (const entry of list) push(entry.item, entry.positions);
      return { rows: out, total: option };
    }

    const availableCommands = commandList.filter((item) => !item.disabledReason);
    if (!q) {
      switch (scope) {
        case "all":
        case "commands": {
          const recent = readRecent()
            .map((id) => availableCommands.find((item) => item.key === `command:${id}`))
            .filter((item): item is PaletteItem => Boolean(item));
          if (recent.length) {
            header(t("palette.header.recent"));
            for (const item of recent) push(item);
          }
          header(scope === "all" ? t("palette.scope.commands") : t("palette.header.allCommands"));
          const sorted = [...availableCommands].sort((a, b) => (a.detail ?? "").localeCompare(b.detail ?? "", locale()) || a.title.localeCompare(b.title, locale()));
          for (const item of sorted) if (!recent.includes(item)) push(item);
          break;
        }
        case "branches": {
          const groups: [string, PaletteKind][] = [
            [t("palette.header.localBranches"), "branch"],
            [t("palette.header.remoteBranches"), "remote"],
            [t("palette.header.tags"), "tag"],
          ];
          for (const [label, kind] of groups) {
            const list = refList.filter((item) => item.kind === kind);
            if (!list.length) continue;
            header(label);
            for (const item of list) push(item);
          }
          break;
        }
        case "files": {
          const sorted = changedFirst(fileList);
          const changed = sorted.filter((item) => item.marker);
          if (changed.length) {
            header(t("palette.header.changedFiles"));
            for (const item of changed) push(item);
          }
          if (sorted.length > changed.length) {
            header(t("palette.header.allFiles"));
            for (const item of sorted) if (!item.marker) push(item);
          }
          break;
        }
        case "repos":
          for (const item of repoList) push(item);
          break;
        case "commits":
          break;
      }
      return { rows: out, total: option };
    }

    let ranked: Ranked[] = [];
    switch (scope) {
      case "all":
        ranked = [...rank(commandList, q), ...rank(refList, q).slice(0, 100), ...rank(fileList, q).slice(0, 200), ...rank(repoList, q)];
        ranked.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
        if (offerAskRow(askEnabled, scope, q, ranked.length)) {
          push(askItem(q, () => startAsk.current(q)));
          return { rows: out, total: option };
        }
        break;
      case "commands":
        ranked = rank(commandList, q);
        break;
      case "branches":
        ranked = rank(refList, q);
        break;
      case "files":
        ranked = rank(fileList, q);
        break;
      case "repos":
        ranked = rank(repoList, q);
        break;
      case "commits":
        // The core searches and sorts (newest first); what is in the summary gets highlighted.
        ranked = commitList.map((item) => ({ item, score: 0, positions: fuzzyMatch(prepareQuery(q), item.title)?.positions ?? [] }));
        break;
    }
    for (const entry of ranked.slice(0, MAX_RESULTS)) push(entry.item, entry.positions);
    return { rows: out, total: Math.min(ranked.length, MAX_RESULTS) };
  }, [stage, stageList, deferredText, scope, commandList, refList, fileList, repoList, commitList, askText, askEnabled]);

  const options = useMemo(() => rows.filter((row): row is Extract<Row, { type: "option" }> => row.type === "option"), [rows]);
  const activeIndex = Math.max(
    0,
    options.findIndex((row) => row.item.key === activeKey),
  );
  const active = options[activeIndex] ?? null;
  const askRequest = options.find((row) => row.item.kind === "ask")?.item.request ?? null;

  // New matches: selection back to the top.
  useEffect(() => {
    setActiveKey(options[0]?.item.key ?? null);
    setNotice(null);
  }, [deferredText, scope, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Virtualisierung ---------------------------------------------------------------------------
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "header" ? HEADER_HEIGHT : OPTION_HEIGHT),
    overscan: 10,
  });
  const rowIndexOfActive = active ? rows.indexOf(active) : -1;
  useLayoutEffect(() => {
    if (!keyboardMove.current || rowIndexOfActive < 0) return;
    keyboardMove.current = false;
    // If there is a heading directly above, it should become visible too.
    const target = rows[rowIndexOfActive - 1]?.type === "header" && rowIndexOfActive - 1 === 0 ? 0 : rowIndexOfActive;
    virtualizer.scrollToIndex(target, { align: "auto" });
  }, [rowIndexOfActive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [deferredText, scope, stage]);

  // --- Run ---------------------------------------------------------------------------------------
  const close = () => onClose();
  const execute = (item: PaletteItem | null | undefined) => {
    if (!item) return;
    if (item.kind === "ask") {
      // The plan appears inside the palette; nothing closes.
      void item.run();
      return;
    }
    if (item.disabledReason) {
      setNotice(t("palette.notice", { title: item.title, reason: item.disabledReason }));
      return;
    }
    close();
    // Run only after closing (and returning the focus): a dialog opened by the action thus gets
    // the focus and afterwards returns it to the right place.
    afterFocusReturn(() => {
      void Promise.resolve()
        .then(() => item.run())
        .catch((error: unknown) => showError(item.title, error));
    });
  };

  const openStage = (item: PaletteItem | null | undefined) => {
    if (!item?.actions) return false;
    setStage({ item, previous: raw });
    setRaw("");
    return true;
  };
  const leaveStage = () => {
    if (!stage) return;
    setRaw(stage.previous);
    setActiveKey(stage.item.key);
    setStage(null);
  };

  const move = (delta: number, wrap = true) => {
    if (!options.length) return;
    let next = activeIndex + delta;
    if (wrap) next = (next + options.length) % options.length;
    else next = Math.min(options.length - 1, Math.max(0, next));
    keyboardMove.current = true;
    setActiveKey(options[next]!.item.key);
    setNotice(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (plan.active) {
      plan.onKeyDown(event);
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "PageDown":
        event.preventDefault();
        move(10, false);
        return;
      case "PageUp":
        event.preventDefault();
        move(-10, false);
        return;
      case "Enter":
        event.preventDefault();
        execute(active?.item);
        return;
      case "Tab":
        if (!event.shiftKey && openStage(active?.item)) event.preventDefault();
        return;
      case "ArrowRight": {
        const input = event.currentTarget;
        if (input.selectionStart === input.value.length && openStage(active?.item)) event.preventDefault();
        return;
      }
      case "Escape":
        // Radix only closes the topmost layer; if something lies above it (an error message), Esc would
        // not arrive here. If Radix already handled it, the event is marked as handled.
        if (!event.defaultPrevented) {
          event.preventDefault();
          if (stage) leaveStage();
          else close();
        }
        return;
      case "Backspace":
        if (stage && raw === "") {
          event.preventDefault();
          leaveStage();
        }
        return;
      case "p":
      case "P":
        // Ctrl+P with the palette open: move further down, like a second press of ↓.
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
        return;
    }
  };

  // --- States outside the list ---------------------------------------------------------------------
  const noRepo = !repoId && (scope === "branches" || scope === "files" || scope === "commits");
  const loading =
    !stage &&
    ((wantsFiles && Boolean(repoId) && tree.isPending) ||
      (scope === "branches" && Boolean(repoId) && refs.isPending) ||
      (wantsCommits && Boolean(text) && (commitQuery !== text || (Boolean(commitQuery) && commits.isFetching))));
  const failure = !stage ? (wantsFiles && tree.error) || (wantsRefs && refs.error) || (wantsCommits && commits.error) || null : null;
  const loadingLabel = wantsCommits ? t("palette.loading.commits") : scope === "branches" ? t("palette.loading.branches") : t("palette.loading.files");
  const retry = () => {
    if (wantsFiles && tree.error) void tree.refetch();
    if (wantsRefs && refs.error) void refs.refetch();
    if (wantsCommits && commits.error) void commits.refetch();
    inputRef.current?.focus();
  };

  const placeholder = stage
    ? t("palette.placeholder.action", { title: stage.item.title })
    : scope === "commands"
      ? t("palette.placeholder.commands")
      : scope === "branches"
        ? t("palette.placeholder.branches")
        : scope === "files"
          ? t("palette.placeholder.files")
          : scope === "commits"
            ? t("palette.placeholder.commits")
            : scope === "repos"
              ? t("palette.placeholder.repos")
              : t("palette.placeholder.all");

  let empty: ReactNode = null;
  if (!rows.length && !loading && !failure && !plan.active) {
    if (askText === "") {
      empty = (
        <PaletteEmpty icon={<MessageSquareText className="size-6" aria-hidden />} title={t("palette.ask.emptyTitle")}>
          {t("palette.ask.hint")}
        </PaletteEmpty>
      );
    } else if (noRepo) {
      empty = (
        <PaletteEmpty icon={<FolderGit2 className="size-6" aria-hidden />} title={t("palette.empty.noRepo")}>
          {scope === "files" ? t("palette.empty.noRepoFiles") : scope === "commits" ? t("palette.empty.noRepoCommits") : t("palette.empty.noRepoBranches")}
        </PaletteEmpty>
      );
    } else if (scope === "commits" && !text) {
      empty = (
        <PaletteEmpty icon={<GitCommitHorizontal className="size-6" aria-hidden />} title={t("palette.empty.commitsTitle")}>
          {t("palette.empty.commitsHint")}
        </PaletteEmpty>
      );
    } else if (text) {
      empty = (
        <PaletteEmpty icon={<SearchX className="size-6" aria-hidden />} title={t("palette.empty.nothingFound", { text })}>
          {scope === "all" ? t("palette.empty.tryPrefix") : t("palette.empty.tryFewer")}
        </PaletteEmpty>
      );
    } else {
      empty = (
        <PaletteEmpty icon={<Search className="size-6" aria-hidden />} title={t("palette.empty.nothingHere")}>
          {scope === "repos" ? t("palette.empty.noRepos") : t("palette.empty.listEmpty")}
        </PaletteEmpty>
      );
    }
  }

  const activeId = active ? `${listId}-o${active.option}` : undefined;
  const items = virtualizer.getVirtualItems();

  return (
    <RadixDialog.Root open onOpenChange={(open) => !open && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="animate-fade fixed inset-0 z-40 bg-surface-sunken/50" />
        <RadixDialog.Content
          data-screen="command-palette"
          data-state-loading={loading || undefined}
          aria-describedby={undefined}
          onCloseAutoFocus={focusReturn.onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const input = inputRef.current;
            if (input) {
              input.focus();
              // A pre-filled prefix stays, with the cursor behind it.
              input.setSelectionRange(input.value.length, input.value.length);
            }
          }}
          onEscapeKeyDown={(event) => {
            if (plan.active) {
              event.preventDefault();
              plan.escape();
              return;
            }
            if (stage) {
              event.preventDefault();
              leaveStage();
            }
          }}
          className="animate-pop fixed top-1/6 left-1/2 z-50 flex max-h-2/3 w-palette max-w-[calc(100vw/var(--zoom,1)-var(--spacing)*8)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface text-text shadow-dialog"
        >
          <RadixDialog.Title className="sr-only">{t("palette.title")}</RadixDialog.Title>
          <div className="flex h-toolbar shrink-0 items-center gap-2 border-b border-border px-3">
            {stage ? (
              <span className="flex max-w-60 shrink-0 items-center gap-1 rounded-sm bg-accent-surface py-0.5 pr-1 pl-1.5 text-sm font-medium text-accent" data-stage>
                <span className="shrink-0">{kindIcons[stage.item.kind]}</span>
                <span className="min-w-0 truncate">{stage.item.kind === "file" ? stage.item.title.split("/").pop() : stage.item.title}</span>
                <ChevronRight className="size-icon shrink-0" aria-hidden />
              </span>
            ) : (
              <Search className="size-icon shrink-0 text-text-muted" aria-hidden />
            )}
            <input
              ref={inputRef}
              role="combobox"
              aria-label={plan.active ? t("palette.plan.inputLabel", { text: plan.text }) : stage ? t("palette.inputAction", { title: stage.item.title }) : t("palette.input")}
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={plan.active ? plan.activeDescendant(listId) : activeId}
              autoComplete="off"
              spellCheck={false}
              value={raw}
              readOnly={plan.active}
              placeholder={placeholder}
              onChange={(event) => setRaw(event.target.value)}
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-md text-text placeholder:text-text-muted focus-visible:outline-none"
            />
            {loading ? <Spinner label={loadingLabel} /> : null}
            {stage ? (
              <span className="shrink-0 text-xs text-text-muted">
                <Kbd>Esc</Kbd> {t("palette.footer.back")}
              </span>
            ) : null}
          </div>

          {notice ? (
            <p role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-warning-surface px-3 py-1.5 text-sm text-text" data-notice>
              <TriangleAlert className="size-icon shrink-0 text-warning" aria-hidden />
              {notice}
            </p>
          ) : null}

          <div ref={scrollRef} className="max-h-palette-list min-h-0 overflow-y-auto overscroll-contain p-1" data-scroll>
            {plan.active ? <PlanPanel session={plan} idPrefix={listId} /> : null}
            {!plan.active && failure ? (
              <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-surface px-3 py-2 text-sm text-text" data-failure>
                <TriangleAlert className="mt-0.5 size-icon shrink-0 text-danger" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{wantsCommits ? t("palette.failure.search") : wantsFiles && tree.error ? t("palette.failure.files") : t("palette.failure.branches")}</span>{" "}
                  <span className="text-text-muted">{describeError(failure).text}</span>
                </span>
                <button
                  type="button"
                  onClick={retry}
                  className="inline-flex h-control-sm shrink-0 items-center gap-1 rounded-md border border-border bg-surface-raised px-2 text-sm font-medium hover:bg-surface"
                >
                  <RefreshCw className="size-icon" aria-hidden />
                  {t("palette.retry")}
                </button>
              </div>
            ) : null}
            <div
              id={listId}
              role="listbox"
              aria-label={stage ? t("palette.actions") : t("palette.results")}
              className={cn("relative w-full", plan.active && "hidden")}
              style={{ height: virtualizer.getTotalSize() }}
            >
              {items.map((virtual) => {
                const row = rows[virtual.index]!;
                return (
                  <div key={virtual.key} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${virtual.start}px)` }}>
                    {row.type === "header" ? (
                      <div role="presentation" className="flex h-row items-end px-2 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
                        {row.label}
                      </div>
                    ) : (
                      <OptionRow
                        row={row}
                        id={`${listId}-o${row.option}`}
                        active={row.option === activeIndex}
                        onHover={() => {
                          if (activeKey !== row.item.key) setActiveKey(row.item.key);
                        }}
                        onRun={() => execute(row.item)}
                        onActions={() => {
                          setActiveKey(row.item.key);
                          openStage(row.item);
                          inputRef.current?.focus();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {!plan.active && loading && !rows.length ? <SkeletonRows count={wantsCommits ? 5 : 6} /> : null}
            {!plan.active && loading && rows.length > 0 && wantsFiles ? (
              <p className="flex h-control-lg items-center gap-2 px-2 text-sm text-text-muted" data-loading-files>
                <Spinner label={loadingLabel} /> {loadingLabel}
              </p>
            ) : null}
            {empty}
          </div>

          <footer className="flex h-control-md shrink-0 items-center gap-3 border-t border-border bg-bg px-3 text-xs text-text-muted" data-footer>
            {plan.active ? (
              <PlanFooter session={plan} />
            ) : !stage && !raw ? (
              <span className="flex min-w-0 flex-1 items-center gap-3 truncate" data-prefix-help>
                {PREFIXES.map((entry) => (
                  <button
                    key={entry.prefix}
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setRaw(entry.prefix);
                      inputRef.current?.focus();
                    }}
                    className="inline-flex shrink-0 items-center gap-1 hover:text-text"
                  >
                    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-surface px-1 font-mono text-xs text-text">{entry.prefix}</kbd>
                    {entry.label}
                  </button>
                ))}
                {askEnabled ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    data-prefix="?"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setRaw("?");
                      inputRef.current?.focus();
                    }}
                    className="inline-flex shrink-0 items-center gap-1 hover:text-text"
                  >
                    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-surface px-1 font-mono text-xs text-text">?</kbd>
                    {t("palette.scope.ask")}
                  </button>
                ) : null}
              </span>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-3 truncate">
                <span className="inline-flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> {t("palette.footer.select")}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>Enter</Kbd> {t("palette.footer.run")}
                </span>
                {active?.item.actions ? (
                  <span className="inline-flex items-center gap-1">
                    <Kbd>Tab</Kbd> {t("palette.footer.moreActions")}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Kbd>Esc</Kbd> {stage ? t("palette.footer.back") : t("palette.footer.close")}
                </span>
                {askRequest !== null ? (
                  <button
                    type="button"
                    data-plan-what-is-sent
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void plan.whatIsSent(askRequest)}
                    className="inline-flex items-center hover:text-text hover:underline"
                  >
                    {t("palette.ask.whatIsSent")}
                  </button>
                ) : null}
              </span>
            )}
            <span className="shrink-0 tabular-nums" aria-live="polite" data-count>
              {loading || plan.active ? "" : t("palette.count", { count: total })}
              {!plan.active && total >= MAX_RESULTS ? t("palette.countMore") : ""}
            </span>
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function PaletteEmpty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center" data-empty>
      <span className="text-text-muted">{icon}</span>
      <p className="text-md font-medium text-text">{title}</p>
      <p className="max-w-96 text-base text-text-muted">{children}</p>
    </div>
  );
}
