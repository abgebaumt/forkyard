/**
 * Lower part of the commit panel: the changed files of a source (commit, range, stash)
 * and – for a single commit – optionally all files of that revision with a filter.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardCopy, Eye, File, FileDiff, FileSearch, Search, X } from "lucide-react";
import type { CommitDetails, DiffSource, FileChange, Id, Sha } from "../../core";
import { fileMenu } from "../../app/menus";
import { useTree } from "../../app/queries";
import { useAppStore, useTabView } from "../../app/store";
import { FileLayoutSwitch, FileList, nextFileSelection, type FileListView } from "../../components/FileList";
import { Button, IconButton, Spinner } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { EmptyState, toast } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import type { MenuEntry } from "../../ui/Menu";
import { copyText, errorParts, LineCounts, PanelError, SectionLabel, SkeletonRows } from "./parts";
import { VirtualList } from "./VirtualList";
import { locale, t } from "../../i18n";

type FilesMode = "changed" | "all";

const VIEW_KEY = "gc.commitFiles.view";

function loadView(): FileListView {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "flat";
  } catch {
    return "flat";
  }
}

/** List or folder tree for the changed files; remembered across commits and restarts. */
function useFilesView(): [FileListView, (view: FileListView) => void] {
  const [view, setView] = useState(loadView);
  const change = (next: FileListView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // then it only applies until restart
    }
  };
  return [view, change];
}

export interface FilesSectionProps {
  repoId: Id;
  tabId: Id;
  /** Where the changed files come from; this way a click opens the matching diff. */
  source: DiffSource;
  details: CommitDetails | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Commit whose whole tree can be shown; null hides the toggle. */
  treeSha?: Sha | null;
  /** Hint above the list, e.g. for merge commits. */
  note?: ReactNode;
  emptyText: string;
  listLabel: string;
}

export function FilesSection({ repoId, tabId, source, details, loading, error, onRetry, treeSha = null, note, emptyText, listLabel }: FilesSectionProps) {
  const [mode, setMode] = useState<FilesMode>("changed");
  const files = details?.files ?? [];
  const showAll = mode === "all" && treeSha !== null;
  const [view, setView] = useFilesView();

  return (
    <section aria-label={t("commitDetails.files.section")} className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-border px-2">
        {treeSha !== null ? (
          <SegmentedControl<FilesMode>
            label={t("commitDetails.files.show")}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "changed", label: t("commitDetails.files.changed") },
              { value: "all", label: t("commitDetails.files.all") },
            ]}
          />
        ) : (
          <SectionLabel className="px-1">{t("commitDetails.files.changedFiles")}</SectionLabel>
        )}
        <span className="flex-1" />
        {!showAll && details ? (
          <span data-testid="files-summary" className="flex min-w-0 items-center gap-2 text-sm text-text-muted">
            <span className="truncate">{t("commitDetails.files.count", { count: files.length })}</span>
            <LineCounts added={details.added} removed={details.removed} />
          </span>
        ) : null}
        {!showAll ? (
          <FileLayoutSwitch value={view} onChange={setView} />
        ) : null}
      </div>
      {showAll && treeSha ? (
        <AllFiles repoId={repoId} tabId={tabId} sha={treeSha} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {note}
          {loading ? (
            <SkeletonRows label={t("commitDetails.files.loading")} />
          ) : error ? (
            <FilesError error={error} onRetry={onRetry} />
          ) : (
            <ChangedFiles
              // A new source starts with every folder closed again.
              key={JSON.stringify(source)}
              repoId={repoId}
              tabId={tabId}
              source={source}
              files={files}
              view={view}
              emptyText={emptyText}
              listLabel={listLabel}
            />
          )}
        </div>
      )}
    </section>
  );
}

function FilesError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { text, hint } = errorParts(error);
  return (
    <PanelError title={t("commitDetails.files.loadFailed")} detail={text} onRetry={onRetry}>
      {hint || undefined}
    </PanelError>
  );
}

// ---------------------------------------------------------------------------
// Changed files
// ---------------------------------------------------------------------------

const sameSource = (a: DiffSource, b: DiffSource) => JSON.stringify(a) === JSON.stringify(b);

/** SHA at whose revision a file of the source can be viewed (null = working directory). */
function viewSha(source: DiffSource): Sha | null | undefined {
  if (source.kind === "commit") return source.sha;
  if (source.kind === "range") return source.to;
  return undefined;
}

interface ChangedFilesProps {
  repoId: Id;
  tabId: Id;
  source: DiffSource;
  files: FileChange[];
  view: FileListView;
  emptyText: string;
  listLabel: string;
}

function ChangedFiles({ repoId, tabId, source, files, view, emptyText, listLabel }: ChangedFilesProps) {
  const center = useTabView(tabId).center;
  const store = useAppStore.getState;
  const openPath = center.kind === "diff" && sameSource(center.source, source) ? center.path : null;
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);

  // The file whose diff is in the middle is the marked one – even if it was opened from somewhere else.
  useEffect(() => {
    if (openPath) {
      setPicked((current) => (current.includes(openPath) ? current : [openPath]));
      anchor.current = openPath;
    }
  }, [openPath]);

  if (files.length === 0) {
    return (
      <p data-testid="files-empty" className="px-3 py-3 text-base text-text-muted">
        {emptyText}
      </p>
    );
  }

  const paths = files.map((file) => file.path);
  const selected = picked.filter((path) => paths.includes(path));

  const open = (path: string) => store().openDiff(tabId, path, source);

  const menuFor = (targets: FileChange[]): MenuEntry[] => {
    const shared = fileMenu({ repoId, tabId, files: targets, source });
    if (shared.length > 0) return shared;
    // As long as the shared file menu is empty: the bare essentials from this panel.
    const target = targets[targets.length - 1];
    if (!target) return [];
    const sha = viewSha(source);
    const single = targets.length === 1;
    return [
      { label: t("commitDetails.files.showDiff"), icon: <FileDiff className="size-icon" aria-hidden />, disabled: !single, onSelect: () => open(target.path) },
      {
        label: t("commitDetails.files.viewAtState"),
        icon: <Eye className="size-icon" aria-hidden />,
        disabled: !single || sha === undefined || target.status === "deleted",
        onSelect: () => {
          if (sha !== undefined) store().openFile(tabId, target.path, sha);
        },
      },
      { type: "separator" },
      {
        label: single ? t("commitDetails.files.copyPath") : t("commitDetails.files.copyPaths", { count: targets.length }),
        icon: <ClipboardCopy className="size-icon" aria-hidden />,
        onSelect: () => {
          void copyText(targets.map((file) => file.path).join("\n")).then((ok) => {
            toast(ok ? { tone: "success", title: single ? t("commitDetails.files.pathCopied") : t("commitDetails.files.pathsCopied") } : { tone: "danger", title: t("commitDetails.copyFailed") });
          });
        },
      },
    ];
  };

  return (
    <div data-testid="files-changed" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
      <FileList
        files={files}
        view={view}
        collapsed
        selected={selected}
        ariaLabel={listLabel}
        empty={emptyText}
        menuFor={menuFor}
        onActivate={(file) => open(file.path)}
        onSelect={(path, modifiers) => {
          const next = nextFileSelection(paths, selected, anchor.current, path, modifiers);
          anchor.current = next.anchor;
          setPicked(next.selected);
          // A single click shows the diff; the arrow keys only move the marker, Enter opens.
          if (modifiers.source !== "keyboard" && !modifiers.additive && !modifiers.range) open(path);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// All files of a commit
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function AllFiles({ repoId, tabId, sha }: { repoId: Id; tabId: Id; sha: Sha }) {
  const [text, setText] = useState("");
  const needle = useDebounced(text.trim(), 150);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useTree(repoId, sha, null);
  const filtered = useTree(repoId, sha, needle || null, needle.length > 0);
  const [active, setActive] = useState(-1);

  // While the next filtered list loads, the previous one stays (no flicker while typing).
  const lastShown = useRef<string[] | undefined>(undefined);
  const query = needle ? filtered : all;
  if (query.data) lastShown.current = query.data;
  const paths = query.data ?? (needle ? lastShown.current : undefined);
  const waiting = text.trim() !== needle || (query.isFetching && !query.data);

  useEffect(() => setActive(-1), [needle, sha]);

  const clear = () => {
    setText("");
    inputRef.current?.focus();
  };
  const open = (index: number) => {
    const path = paths?.[index];
    if (path) useAppStore.getState().openFile(tabId, path, sha);
  };

  const total = all.data?.length;
  const countText =
    paths === undefined
      ? ""
      : needle && total !== undefined
        ? t("commitDetails.files.filteredCount", { shown: paths.length.toLocaleString(locale()), count: total })
        : t("commitDetails.files.count", { count: paths.length });

  return (
    <div data-testid="files-all" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-text-muted" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={text}
            spellCheck={false}
            aria-label={t("commitDetails.files.filter")}
            placeholder={t("commitDetails.files.filter")}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && text) {
                event.preventDefault();
                event.stopPropagation();
                setText("");
              } else if (event.key === "ArrowDown" && paths?.length) {
                event.preventDefault();
                listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus();
              } else if (event.key === "Enter" && paths?.length === 1) {
                event.preventDefault();
                open(0);
              }
            }}
            className={cn(
              "h-control-md w-full rounded-md border border-border-input bg-surface-sunken pr-8 pl-7 text-base text-text",
              "placeholder:text-text-muted hover:border-text-muted focus-visible:border-accent",
            )}
          />
          <span className="absolute right-1 flex items-center">
            {waiting && text ? <Spinner label={t("commitDetails.files.filtering")} /> : null}
            {text ? <IconButton size="sm" label={t("commitDetails.files.clearFilter")} shortcut="Esc" icon={<X className="size-3.5" aria-hidden />} onClick={clear} /> : null}
          </span>
        </div>
        <p role="status" data-testid="tree-count" className="h-4 px-1 text-sm text-text-muted">
          {countText}
        </p>
      </div>
      <div ref={listRef} className="min-h-0 flex-1">
        {all.isError || (needle && filtered.isError) ? (
          <FilesError error={all.error ?? filtered.error} onRetry={() => void (all.isError ? all.refetch() : filtered.refetch())} />
        ) : paths === undefined ? (
          <SkeletonRows count={8} label={t("commitDetails.files.loading")} />
        ) : paths.length === 0 ? (
          needle ? (
            <EmptyState
              icon={<FileSearch className="size-6" aria-hidden />}
              title={t("commitDetails.files.noneFound")}
              action={
                <Button size="sm" onClick={clear}>
                  {t("commitDetails.files.clearFilter")}
                </Button>
              }
            >
              {t("commitDetails.files.noneFoundHint", { needle })}
            </EmptyState>
          ) : (
            <p className="px-3 py-3 text-base text-text-muted">{t("commitDetails.files.commitEmpty")}</p>
          )
        ) : (
          <VirtualList
            count={paths.length}
            active={active}
            onActiveChange={setActive}
            onActivate={open}
            activateOnClick
            ariaLabel={t("commitDetails.files.allOfCommit")}
            getKey={(index) => paths[index] ?? index}
            renderRow={(index) => <TreeRow path={paths[index] ?? ""} />}
          />
        )}
      </div>
    </div>
  );
}

function TreeRow({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <span title={path} className="flex min-w-0 flex-1 items-center gap-2 px-2 text-base">
      <File className="size-3.5 shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <span>{name}</span>
        {dir ? <span className="ml-2 text-sm text-text-muted">{dir}</span> : null}
      </span>
    </span>
  );
}
