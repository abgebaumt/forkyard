import { useCallback, useEffect, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ArrowDownToLine, CloudDownload, Ellipsis, ExternalLink, FolderGit2, FolderOpen, FolderSearch, FolderX, PanelTop, PencilLine, Star, StarOff, Tags, Trash2, TriangleAlert, Ungroup, X } from "lucide-react";
import type { Id, Repo } from "../../core";
import { openExternal } from "../../app/actions/files";
import { formatDateTime, formatRelative } from "../../app/format";
import { IconButton } from "../../ui/Button";
import { cn, laneColor } from "../../ui/cn";
import { ContextMenu, DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { splitForDisplay } from "../CloneDialog/paths";
import { openRepoCleanup } from "../RepoCleanup";
import { openGroupSync } from "./GroupSync";
import { REPO_COLORS, assignGroup, clearAlias, clearGroup, displayName, dissolveGroup, editAlias, relocateRepo, renameGroup, setColor, setFavorite } from "./repoActions";
import { t } from "../../i18n";

export type ListItem =
  /** `group`: heading of a named group – it gets the batch actions. */
  | { kind: "header"; key: string; label: string; count: number; group?: string }
  | { kind: "repo"; key: string; repo: Repo };

export interface RepoListHandle {
  /** Focus on the entry (or the first one if it no longer exists). */
  focusRow: (id: Id | null) => void;
}

export interface RepoListProps {
  items: ListItem[];
  selectedId: Id | null;
  onSelect: (id: Id) => void;
  /** Click or Enter. */
  onOpen: (repo: Repo) => void;
  /** Ctrl+Enter or context menu. */
  onOpenInTab: (repo: Repo) => void;
  /** Delete or context menu; asks for confirmation itself. */
  onRemove: (repo: Repo) => void;
  /** Existing group names, as help when assigning. */
  groups: string[];
  /** All repositories of a group – including those a filter currently hides. */
  groupMembers: (group: string) => Repo[];
  /** The group is already in the heading and does not need to go on every row. */
  showGroup: boolean;
  handle?: Ref<RepoListHandle>;
}

// Row heights for virtualisation; they correspond to the classes h-11 and h-7 below.
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 28;

function PathText({ path }: { path: string }) {
  const { head, tail } = splitForDisplay(path);
  return (
    <span className="flex min-w-0 text-sm text-text-muted" title={path}>
      {head ? <span className="min-w-8 shrink-100 truncate">{head}</span> : null}
      <span className="min-w-0 truncate">{tail}</span>
    </span>
  );
}

function ColorDot({ color }: { color: number }) {
  return <span className="size-2.5 rounded-pill" style={{ background: laneColor(color - 1) }} />;
}

/**
 * Context menu entries. `run` performs the action after the menu has closed and returned focus –
 * otherwise the closing menu would take focus away from a dialog the action opens.
 */
/**
 * Actions for a whole group: fetch all, pull all, rename, dissolve. The same entries are on the
 * group heading's button and – for the keyboard – in the context menu of every member.
 */
function groupMenu(group: string, members: Repo[], existing: string[], run: (work: () => unknown) => void): MenuEntry[] {
  const count = members.length;
  const none = count === 0 ? t("repos.groupMenu.empty") : undefined;
  return [
    {
      label: count === 1 ? t("repos.groupMenu.fetchOne") : t("repos.groupMenu.fetchAll", { count }),
      icon: <CloudDownload className="size-icon" />,
      hint: none ?? t("repos.groupMenu.fetchHint"),
      disabled: count === 0,
      onSelect: () => run(() => openGroupSync(group, members, "fetch")),
    },
    {
      label: count === 1 ? t("repos.groupMenu.pullOne") : t("repos.groupMenu.pullAll", { count }),
      icon: <ArrowDownToLine className="size-icon" />,
      hint: none ?? t("repos.groupMenu.pullHint"),
      disabled: count === 0,
      onSelect: () => run(() => openGroupSync(group, members, "pull")),
    },
    { type: "separator" },
    { label: t("repos.groupMenu.rename"), icon: <PencilLine className="size-icon" />, onSelect: () => run(() => renameGroup(group, members, existing)) },
    { label: t("repos.groupMenu.dissolve"), icon: <Ungroup className="size-icon" />, danger: true, onSelect: () => run(() => dissolveGroup(group, members)) },
  ];
}

function repoMenu(repo: Repo, props: Pick<RepoListProps, "onOpen" | "onOpenInTab" | "onRemove" | "groups" | "groupMembers">, run: (work: () => unknown) => void): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (repo.missing) {
    entries.push({ label: t("repos.menu.relocate"), icon: <FolderSearch className="size-icon" />, onSelect: () => run(() => relocateRepo(repo)) });
  } else {
    entries.push(
      { label: t("repos.menu.open"), icon: <FolderOpen className="size-icon" />, shortcut: "Enter", onSelect: () => run(() => props.onOpen(repo)) },
      { label: t("repos.menu.openInTab"), icon: <PanelTop className="size-icon" />, shortcut: "Mod+Enter", onSelect: () => run(() => props.onOpenInTab(repo)) },
    );
  }
  entries.push(
    { type: "separator" },
    repo.isFavorite
      ? { label: t("repos.menu.favoriteRemove"), icon: <StarOff className="size-icon" />, shortcut: "F", onSelect: () => run(() => setFavorite(repo, false)) }
      : { label: t("repos.menu.favoriteAdd"), icon: <Star className="size-icon" />, shortcut: "F", onSelect: () => run(() => setFavorite(repo, true)) },
    { label: repo.alias ? t("repos.menu.aliasChange") : t("repos.menu.aliasSet"), icon: <PencilLine className="size-icon" />, shortcut: "F2", onSelect: () => run(() => editAlias(repo)) },
  );
  if (repo.alias) entries.push({ label: t("repos.menu.aliasRemove"), onSelect: () => run(() => clearAlias(repo)) });
  entries.push({ label: repo.groupName ? t("repos.menu.groupChange") : t("repos.menu.groupAssign"), icon: <Tags className="size-icon" />, onSelect: () => run(() => assignGroup(repo, props.groups)) });
  if (repo.groupName) {
    const group = repo.groupName;
    entries.push(
      { label: t("repos.menu.groupLeave", { group }), onSelect: () => run(() => clearGroup(repo)) },
      { label: t("repos.menu.groupSubmenu", { group }), icon: <Tags className="size-icon" />, children: groupMenu(group, props.groupMembers(group), props.groups, run) },
    );
  }
  entries.push({ type: "separator" }, { type: "label", label: t("repos.menu.color") });
  for (const color of REPO_COLORS) {
    entries.push({ label: color.label, icon: <ColorDot color={color.value} />, checked: repo.color === color.value, onSelect: () => run(() => setColor(repo, color.value)) });
  }
  if (repo.color !== null) entries.push({ label: t("repos.menu.noColor"), icon: <X className="size-icon" />, onSelect: () => run(() => setColor(repo, null)) });
  entries.push(
    { type: "separator" },
    // Resolves when the dialog closes, so the focus goes back to the row only then.
    { label: t("repos.menu.cleanup"), disabled: repo.missing, onSelect: () => run(() => openRepoCleanup(repo.id)) },
    { label: t("repos.menu.showInFileManager"), icon: <ExternalLink className="size-icon" />, disabled: repo.missing, onSelect: () => run(() => openExternal(repo.id, "file_manager")) },
    { type: "separator" },
    { label: t("repos.menu.remove"), icon: <Trash2 className="size-icon" />, shortcut: "Delete", danger: true, onSelect: () => run(() => props.onRemove(repo)) },
  );
  return entries;
}

interface RowProps extends Pick<RepoListProps, "onOpen" | "onOpenInTab" | "onRemove" | "groups" | "groupMembers" | "showGroup" | "onSelect"> {
  /** After an action with a dialog: focus back on the row if it got lost. */
  onSettled: (id: Id) => void;
  repo: Repo;
  selected: boolean;
  tabbable: boolean;
  position: number;
  total: number;
  onMove: (event: KeyboardEvent, repo: Repo) => boolean;
}

function RepoRow({ repo, selected, tabbable, position, total, onMove, onSettled, ...props }: RowProps) {
  const name = displayName(repo);
  const settle = (work: unknown) => void Promise.resolve(work).finally(() => window.setTimeout(() => onSettled(repo.id), 80));
  const runFromMenu = (work: () => unknown) => window.setTimeout(() => settle(work()), 60);
  const opened = repo.lastOpenedAt ? formatRelative(repo.lastOpenedAt) : t("repos.list.neverOpened");

  const onKeyDown = (event: KeyboardEvent) => {
    // Keys from the buttons in the row belong to the buttons.
    if (event.target !== event.currentTarget) return;
    if (onMove(event, repo)) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) props.onOpenInTab(repo);
      else props.onOpen(repo);
    } else if (event.key === "Delete" && plain) {
      event.preventDefault();
      props.onRemove(repo);
    } else if (event.key === "F2" && plain) {
      event.preventDefault();
      settle(editAlias(repo));
    } else if ((event.key === "f" || event.key === "F") && plain) {
      event.preventDefault();
      settle(setFavorite(repo, !repo.isFavorite));
    }
  };

  return (
    <ContextMenu entries={repoMenu(repo, props, runFromMenu)}>
      <div
        role="option"
        aria-selected={selected}
        aria-posinset={position}
        aria-setsize={total}
        aria-label={`${name}${repo.isFavorite ? t("repos.list.ariaFavorite") : ""}${repo.missing ? t("repos.list.ariaMissing") : ""}, ${repo.path}`}
        tabIndex={tabbable ? 0 : -1}
        data-repo-id={repo.id}
        data-missing={repo.missing || undefined}
        data-favorite={repo.isFavorite || undefined}
        className={cn(
          "group flex h-11 items-center gap-2.5 pr-2 pl-3 -outline-offset-2",
          selected ? "bg-accent-surface" : "hover:bg-surface-raised",
        )}
        onClick={() => props.onOpen(repo)}
        onFocus={(event) => {
          if (event.target === event.currentTarget) props.onSelect(repo.id);
        }}
        onPointerMove={() => {
          if (!selected) props.onSelect(repo.id);
        }}
        onContextMenu={() => props.onSelect(repo.id)}
        onKeyDown={onKeyDown}
      >
        <span
          aria-hidden
          data-color={repo.color ?? undefined}
          className="h-6 w-1 shrink-0 rounded-pill"
          style={repo.color ? { background: laneColor(repo.color - 1) } : undefined}
        />
        {repo.missing ? (
          <FolderX className="size-icon shrink-0 text-warning" aria-hidden />
        ) : (
          <FolderGit2 className="size-icon shrink-0 text-text-muted" aria-hidden />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-12 truncate font-medium", repo.missing && "text-text-muted")} title={name}>
              {name}
            </span>
            {repo.alias ? (
              <span className="min-w-0 shrink-100 truncate text-sm text-text-muted" title={t("repos.list.folderTitle", { name: repo.name })}>
                {repo.name}
              </span>
            ) : null}
            {props.showGroup && repo.groupName ? (
              <span className="max-w-1/4 min-w-0 shrink-100 truncate rounded-sm border border-border px-1 text-xs text-text-muted" title={t("repos.list.groupTitle", { group: repo.groupName })}>
                {repo.groupName}
              </span>
            ) : null}
            {repo.missing ? (
              <span className="flex shrink-0 items-center gap-1 text-sm text-warning">
                <TriangleAlert className="size-3.5" aria-hidden />
                {t("repos.list.missing")}
              </span>
            ) : null}
          </span>
          <PathText path={repo.path} />
        </span>
        {repo.missing ? (
          // Clicks on the buttons do not open the row.
          <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
            <IconButton size="sm" tabIndex={-1} label={t("repos.menu.relocate")} icon={<FolderSearch className="size-icon" aria-hidden />} onClick={() => void relocateRepo(repo)} />
            <IconButton size="sm" tabIndex={-1} label={t("repos.menu.remove")} icon={<Trash2 className="size-icon" aria-hidden />} onClick={() => props.onRemove(repo)} />
          </span>
        ) : (
          <span className="shrink-0 text-sm text-text-muted" title={repo.lastOpenedAt ? t("repos.list.lastOpened", { date: formatDateTime(repo.lastOpenedAt) }) : undefined}>
            {opened}
          </span>
        )}
        <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
          <IconButton
            size="sm"
            tabIndex={-1}
            label={repo.isFavorite ? t("repos.menu.favoriteRemove") : t("repos.menu.favoriteAdd")}
            shortcut="F"
            aria-pressed={repo.isFavorite}
            className={cn(repo.isFavorite ? "text-warning hover:text-warning" : "opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100 focus-visible:opacity-100")}
            icon={<Star className={cn("size-icon", repo.isFavorite && "fill-current")} aria-hidden />}
            onClick={() => void setFavorite(repo, !repo.isFavorite)}
          />
        </span>
      </div>
    </ContextMenu>
  );
}

/**
 * Buttons on a group's heading. Deliberately without their own tab stop (the list has exactly
 * one): by keyboard the same actions are in the context menu of every repository in the group.
 */
function GroupActions({ group, members, existing }: { group: string; members: Repo[]; existing: string[] }) {
  // Only once the menu is closed, so the dialog afterwards gets focus.
  const later = (work: () => unknown) => window.setTimeout(() => void work(), 60);
  const count = members.length;
  return (
    <span data-group-actions={group} className="flex shrink-0 items-center">
      <IconButton
        size="sm"
        tabIndex={-1}
        label={t("repos.groupMenu.fetchGroup", { group })}
        disabled={count === 0}
        icon={<CloudDownload className="size-icon" aria-hidden />}
        onClick={() => void openGroupSync(group, members, "fetch")}
      />
      <IconButton
        size="sm"
        tabIndex={-1}
        label={t("repos.groupMenu.pullGroup", { group })}
        disabled={count === 0}
        icon={<ArrowDownToLine className="size-icon" aria-hidden />}
        onClick={() => void openGroupSync(group, members, "pull")}
      />
      <DropdownMenu align="end" entries={groupMenu(group, members, existing, later)}>
        <IconButton size="sm" tabIndex={-1} label={t("repos.groupMenu.more", { group })} icon={<Ellipsis className="size-icon" aria-hidden />} />
      </DropdownMenu>
    </span>
  );
}

/** Virtualised listbox of the known repositories, with subheadings. */
export function RepoList({ items, selectedId, onSelect, handle, ...props }: RepoListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<Id | null>(null);

  const repoIndexes = items.flatMap((item, index) => (item.kind === "repo" ? [index] : []));
  const total = repoIndexes.length;
  const selectedIndex = items.findIndex((item) => item.kind === "repo" && item.repo.id === selectedId);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : (repoIndexes[0] ?? -1);

  // The selected row always stays in the DOM, otherwise keyboard focus would get lost while scrolling.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (tabbableIndex >= 0 && !indexes.includes(tabbableIndex)) {
        indexes.push(tabbableIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [tabbableIndex],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 8,
    rangeExtractor,
  });

  const tryFocus = useCallback(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-repo-id="${CSS.escape(id)}"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  }, []);

  // After every render: is a focus request pending and is the row there by now?
  useEffect(tryFocus);

  const focusIndex = (index: number) => {
    const item = items[index];
    if (!item || item.kind !== "repo") return;
    pendingFocus.current = item.repo.id;
    onSelect(item.repo.id);
    virtualizer.scrollToIndex(index, { align: "auto" });
    // Above a subheading: scroll far enough that it is visible too.
    if (index > 0 && items[index - 1]?.kind === "header") virtualizer.scrollToIndex(index - 1, { align: "auto" });
    tryFocus();
  };

  useImperativeHandle(handle, () => ({
    focusRow(id) {
      const index = id ? items.findIndex((item) => item.kind === "repo" && item.repo.id === id) : -1;
      focusIndex(index >= 0 ? index : (repoIndexes[0] ?? -1));
    },
  }));

  const onMove = (event: KeyboardEvent, repo: Repo): boolean => {
    const at = repoIndexes.findIndex((index) => (items[index] as Extract<ListItem, { kind: "repo" }>).repo.id === repo.id);
    if (at < 0) return false;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_HEIGHT * 8) / ROW_HEIGHT) - 1);
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(total - 1, at + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = total - 1;
    else if (event.key === "PageDown") next = Math.min(total - 1, at + page);
    else if (event.key === "PageUp") next = Math.max(0, at - page);
    else return false;
    event.preventDefault();
    const target = repoIndexes[next];
    if (target !== undefined && next !== at) focusIndex(target);
    return true;
  };

  let position = 0;
  const positions = new Map<number, number>();
  for (const index of repoIndexes) positions.set(index, ++position);

  return (
    <div ref={scrollRef} data-repo-scroll className="min-h-0 flex-1 overflow-y-auto pb-2">
      <div role="listbox" aria-label={t("repos.list.label")} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtual) => {
          const item = items[virtual.index];
          if (!item) return null;
          return (
            <div key={virtual.key} role="presentation" className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${virtual.start}px)` }}>
              {item.kind === "header" ? (
                <div role="presentation" className="flex h-7 items-end pr-2">
                  <div role="presentation" data-repo-section={item.label} className="flex min-w-0 flex-1 items-end gap-2 px-4 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="font-medium">{item.count}</span>
                  </div>
                  {item.group ? <GroupActions group={item.group} members={props.groupMembers(item.group)} existing={props.groups} /> : null}
                </div>
              ) : (
                <RepoRow
                  repo={item.repo}
                  selected={item.repo.id === selectedId}
                  tabbable={virtual.index === tabbableIndex}
                  position={positions.get(virtual.index) ?? 1}
                  total={total}
                  onMove={onMove}
                  onSelect={onSelect}
                  onSettled={(id) => {
                    if (document.activeElement === document.body || document.activeElement === null) focusIndex(items.findIndex((entry) => entry.kind === "repo" && entry.repo.id === id));
                  }}
                  {...props}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
